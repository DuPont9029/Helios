// Gestione di una partita. Entrambi i peer eseguono lo stesso core con lo
// stesso seed e gli stessi mazzi (lockstep): sulla rete viaggiano solo le
// risposte del giocatore di turno, più un checksum per scoprire divergenze.
import { DATA_URL, db, getCard } from "../data/db.js";
import { SimpleAI, PassAI } from "../core/ai.js";
import { DuelView } from "../ui/duel/view.js";
import { confirmModal, toast } from "../ui/modal.js";
import { MSG, DUEL, IDLE } from "../core/constants.js";
import { DuelClock, TIMER_PRESETS } from "./clock.js";
import { applySleeves } from "../data/sleeve.js";
import { recordGame, seriesLabel } from "./series.js";
import { h } from "../ui/dom.js";

// Risposte arrivate prima di questa soglia sono automatiche (es. catena saltata): non contano come azione.
const AUTO_RESPONSE_MS = 60;
// Margine per la latenza prima di dichiarare scaduto il tempo dell'avversario remoto.
const REMOTE_GRACE_MS = 8000;

const AUTOPLAY = (() => {
  try {
    return localStorage.getItem("ygoweb.autoplay") === "1";
  } catch {
    return false;
  }
})();

class EngineClient {
  constructor() {
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (error) p?.reject(new Error(error));
      else p?.resolve(result);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "Engine worker error"));
      this.pending.clear();
    };
  }

  call(cmd, args) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd, args });
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

/** Coda dei messaggi in arrivo dall'avversario. */
class Inbox {
  constructor() {
    this.items = [];
    this.waiters = [];
  }
  push(msg) {
    const w = this.waiters.shift();
    if (w) w(msg);
    else this.items.push(msg);
  }
  next() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((r) => this.waiters.push(r));
  }
}

// Summon e Set annullabili finché non si sceglie la zona: l'azione resta "in sospeso" (non va
// all'avversario) mentre il core chiede costi, zona e posizione; "Back" ricostruisce lo stato di prima.
const UNDOABLE_ACTIONS = new Set([IDLE.SUMMON, IDLE.SPSUMMON, IDLE.MSET, IDLE.SSET]);
const UNDOABLE_PROMPTS = new Set([MSG.SELECT_PLACE, MSG.SELECT_POSITION, MSG.SELECT_CARD, MSG.SELECT_TRIBUTE, MSG.SELECT_SUM, MSG.SELECT_UNSELECT_CARD]);
// Richieste in cui compare "Back" (le scelte delle carte solo quando si fanno sul campo).
const BACK_PROMPTS = new Set([MSG.SELECT_PLACE, MSG.SELECT_POSITION, MSG.SELECT_CARD, MSG.SELECT_TRIBUTE, MSG.SELECT_SUM, MSG.SELECT_UNSELECT_CARD]);
// La summon/il set è avvenuto: non si torna più indietro.
const DONE_MSGS = new Set([MSG.SUMMONING, MSG.SPSUMMONING, MSG.SET, MSG.FLIPSUMMONING]);

export class DuelSession {
  /**
   * @param cfg {
   *   controllers: ["local"|"ai"|"remote"|"pass", ...] per giocatore del core (0 = chi inizia);
   *     "pass" = avversario passivo del duello di prova senza mazzo (chiude subito il turno),
   *   me: indice del core visto in basso, names: [n0, n1], reveal,
   *   duel: { flags, seed, lp, hand, draw, decks },
   *   timer: chiave di TIMER_PRESETS ("omega" | "off"),
   *   sleeves: [immagine del giocatore 0, del giocatore 1] (data URL o null),
   *   mux: LinkMux (solo P2P),
   *   onRematch(session): solo P2P, chiamata (in modo sincrono) quando entrambi hanno chiesto la rivincita,
   *   onExit()
   * }
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.engine = new EngineClient();
    this.inbox = new Inbox();
    this.seq = 0;
    this.history = []; // tutte le risposte date al core, in ordine (per ricostruire lo stato)
    this.pending = null; // summon/set in sospeso: { player, seq, histLen, logMark, outbox }
    this.over = false;
    this.ai = new SimpleAI({ getCard, allCards: db.list });
    this.passer = cfg.controllers.includes("pass") ? new PassAI({ getCard, allCards: db.list }) : null;
    // Rivincita (solo P2P): chi l'ha chiesta tra noi e l'avversario.
    this.rematch = { me: false, opp: false, oppLeft: false, started: false, ui: null };
    const p2p = cfg.controllers.includes("remote");
    this.view = new DuelView({
      me: cfg.me,
      names: cfg.names,
      reveal: cfg.reveal,
      // Master Rule 3: zone Pendulum separate; altrimenti sono la prima e l'ultima zona Magie/Trappole.
      separatePz: (BigInt(cfg.duel.flags ?? 0) & DUEL.SEPARATE_PZONE) !== 0n,
      onChat: p2p ? (text) => this.send({ t: "chat", text }) : null,
      onSurrender: () => this.surrender(),
      onLeave: () => this.leave(),
    });
    this.view.startLP = cfg.duel.lp;
    if (cfg.match?.bestOf > 1) this.view.setMatchInfo(cfg.match);
    this.clearSleeves = applySleeves(cfg.sleeves);
    const preset = TIMER_PRESETS[cfg.timer ?? "off"];
    this.clock = preset ? new DuelClock(preset) : null;
    if (this.clock) this.tick = setInterval(() => this.renderClock(), 200);
    if (p2p) this.bindLink(cfg.mux);
  }

  // ---------------------------------------------------------------- timer

  /** Giocatori il cui tempo viene misurato (la CPU non ha timer). */
  timed(p) {
    return this.clock && (this.cfg.controllers[p] === "local" || this.cfg.controllers[p] === "remote");
  }

  renderClock() {
    if (!this.clock || this.over) return;
    const now = performance.now();
    for (const p of [0, 1]) this.view.setClock(p, this.timed(p) ? this.clock.view(p, now) : null);
  }

  /** Fa partire il tempo di `p` e programma la sconfitta allo scadere. */
  startClock(p, grace = 0) {
    if (!this.timed(p)) return;
    const now = performance.now();
    this.clock.start(p, now);
    clearTimeout(this.timeout);
    const arm = () => {
      const ms = this.clock.msToTimeout(performance.now());
      this.timeout = setTimeout(() => {
        if (this.over || this.clock.running?.player !== p) return;
        if (this.clock.msToTimeout(performance.now()) > 0) return arm();
        // Il tempo remoto si dichiara scaduto solo dopo un margine per la latenza.
        if (grace) this.timeout = setTimeout(() => !this.over && this.clock.running?.player === p && this.timeUp(p), grace);
        else this.timeUp(p);
      }, ms + 20);
    };
    arm();
    this.renderClock();
  }

  stopClock(p, acted) {
    if (!this.timed(p)) return;
    clearTimeout(this.timeout);
    const now = performance.now();
    if (acted) this.clock.act(p, now);
    else this.clock.pause(now);
    this.renderClock();
  }

  timeUp(p) {
    if (this.over) return;
    this.clock.pause(performance.now());
    this.clock.left[p] = 0;
    this.renderClock();
    this.send({ t: "timeout", player: p });
    this.finish({ winner: 1 - p, sub: `${this.cfg.names[p]} ran out of time` });
  }

  bindLink(mux) {
    this.mux = mux;
    const opp = () => this.cfg.names[1 - this.cfg.me];
    mux.on("resp", (m) => this.inbox.push(m));
    mux.on("chat", (m) => this.view.addChat(opp(), String(m.text).slice(0, 300)));
    mux.on("surrender", () => this.finish({ winner: this.cfg.me, text: "Your opponent surrendered" }));
    mux.on("timeout", (m) => {
      const p = m.player === 0 || m.player === 1 ? m.player : 1 - this.cfg.me;
      if (this.clock) {
        this.clock.pause(performance.now());
        this.clock.left[p] = 0;
        this.renderClock();
      }
      this.finish({ winner: 1 - p, sub: `${this.cfg.names[p]} ran out of time` });
    });
    mux.on("bye", () => {
      this.opponentLeft("Your opponent left");
      this.finish({ winner: this.cfg.me, text: "Your opponent left the Duel", rematch: false });
    });
    mux.on("rematch", () => {
      this.rematch.opp = true;
      this.updateRematch();
    });
    this.offClose = mux.onClose((reason) => {
      this.opponentLeft("Connection closed: your opponent left");
      if (!this.over) this.finish({ winner: null, text: "Connection lost", sub: reason, rematch: false });
    });
  }

  send(obj) {
    this.mux?.send(obj);
  }

  async start(container) {
    container.append(this.view.el);
    // Il collegamento può essersi chiuso durante l'accordo (es. rivincita abbandonata).
    if (this.mux?.closed) return this.finish({ winner: null, text: "Connection lost", rematch: false });
    this.view.setStatus("Starting engine...");
    try {
      await this.engine.call("init", { dataUrl: DATA_URL });
      this.view.setStatus("Loading card scripts...");
      let res = await this.engine.call("start", this.cfg.duel);
      this.view.setStatus("");
      this.view.lp = [this.cfg.duel.lp, this.cfg.duel.lp];
      await this.loop(res);
    } catch (err) {
      if (this.over) return;
      console.error(err);
      this.view.setStatus("Error: " + err.message);
      toast("Engine error: " + err.message, { kind: "error", ms: 8000 });
    }
  }

  async loop(res) {
    for (;;) {
      if (this.over) return;
      for (const l of res.logs) console.warn("[script]", l.text);
      await this.view.playMessages(res.messages);
      if (this.over) return;
      this.view.render(res.snapshot);
      if (this.clock && res.messages.some((m) => m.type === MSG.NEW_TURN)) this.clock.newTurn();
      // Summon in sospeso: diventa definitiva appena avviene o il core chiede altro (anche all'avversario).
      const next = res.prompt;
      if (this.pending && (res.ended || !next || res.messages.some((m) => DONE_MSGS.has(m.type)) || next.player !== this.pending.player || !UNDOABLE_PROMPTS.has(next.type))) this.commitPending();
      if (res.ended) {
        const win = res.messages.find((m) => m.type === MSG.WIN);
        this.finish({ winner: win?.player ?? res.snapshot.winner, reason: win?.reason });
        return;
      }
      const prompt = res.prompt;
      let who = this.cfg.controllers[prompt.player];
      // Flag di test: il giocatore locale viene pilotato dall'IA (localStorage "ygoweb.autoplay").
      if (who === "local" && AUTOPLAY) who = "ai";
      let response;
      if (who === "local") {
        if (this.cfg.reveal) this.view.setStatus(`${this.cfg.names[prompt.player]}'s move`);
        const asked = performance.now();
        this.startClock(prompt.player);
        this.view.prompter.back = this.pending && BACK_PROMPTS.has(prompt.type) ? true : null;
        // Dentro una summon i materiali si scelgono sul campo (vedi Prompter.fieldKeys).
        this.view.prompter.summoning = !!this.pending;
        response = await this.view.prompter.ask(prompt);
        this.view.prompter.back = null;
        this.view.prompter.summoning = false;
        this.stopClock(prompt.player, performance.now() - asked >= AUTO_RESPONSE_MS);
        this.view.setStatus("");
        if (this.over) return;
        if (response?.back) {
          res = await this.undoPending();
          continue;
        }
        if (prompt.type === MSG.SELECT_IDLECMD && UNDOABLE_ACTIONS.has(response.action) && !this.pending) {
          this.pending = { player: prompt.player, seq: this.seq, histLen: this.history.length, logMark: this.view.logMark(), outbox: [] };
        }
        const clock = this.timed(prompt.player) ? { left: this.clock.left[prompt.player], bonus: this.clock.bonus[prompt.player] } : undefined;
        const out = { t: "resp", seq: this.seq, response, sum: res.checksum, clock };
        if (this.pending) this.pending.outbox.push(out);
        else if (this.mux) this.send(out);
      } else if (who === "pass") {
        response = this.passer.respond(prompt, { turn: res.snapshot.turn });
      } else if (who === "ai") {
        if (prompt.type === MSG.SELECT_IDLECMD || prompt.type === MSG.SELECT_BATTLECMD) await this.view.wait(350);
        response = this.ai.respond(prompt, { turn: res.snapshot.turn });
        if (this.mux && this.cfg.controllers[prompt.player] === "local") this.send({ t: "resp", seq: this.seq, response, sum: res.checksum });
      } else {
        this.view.setStatus("Waiting for opponent...");
        this.startClock(prompt.player, REMOTE_GRACE_MS);
        const m = await this.inbox.next();
        this.view.setStatus("");
        if (this.over) return;
        // È l'avversario a misurare il proprio tempo: si adotta il valore che comunica.
        if (this.timed(prompt.player)) {
          clearTimeout(this.timeout);
          if (m.clock && Number.isFinite(m.clock.left)) this.clock.sync(prompt.player, m.clock.left, m.clock.bonus);
          else this.clock.pause(performance.now());
          this.renderClock();
        }
        if (m.seq !== this.seq) throw new Error(`Out-of-order sequence (${m.seq} instead of ${this.seq})`);
        if (m.sum !== res.checksum) {
          toast("Warning: Duel state differs from your opponent's (different data versions?)", { kind: "error", ms: 8000 });
          console.error("desync", { seq: this.seq, mine: res.checksum, theirs: m.sum });
        }
        response = m.response;
      }
      this.seq++;
      this.history.push(response);
      res = await this.engine.call("respond", { response });
    }
  }

  /** La summon in sospeso è avvenuta: ora l'avversario riceve le risposte, nell'ordine. */
  commitPending() {
    const p = this.pending;
    this.pending = null;
    if (this.mux) for (const out of p.outbox) this.send(out);
  }

  /** "Back" durante la scelta della zona: si ricostruisce lo stato di prima della summon. */
  async undoPending() {
    const p = this.pending;
    this.pending = null;
    this.view.setStatus("Going back...");
    const res = await this.engine.call("replay", { duel: this.cfg.duel, responses: this.history.slice(0, p.histLen) });
    this.history.length = p.histLen;
    this.seq = p.seq;
    this.view.logRewind(p.logMark);
    this.view.setStatus("");
    // Niente animazioni: lo stato si ridisegna dalla fotografia e si torna alla scelta dell'azione.
    return { ...res, messages: [] };
  }

  /** rematch=false: duello chiuso da un abbandono o da una disconnessione (niente rivincita). */
  finish({ winner, reason, text, sub, rematch = true }) {
    if (this.over) return;
    this.over = true;
    this.winner = winner; // indice del core del vincitore (2 o null = pareggio): serve alla rivincita
    clearTimeout(this.timeout);
    clearInterval(this.tick);
    this.clock?.pause(performance.now());
    this.view.prompter.abort();
    this.view.setStatus("Duel over");
    // Partita al meglio di N: il duello conta per il punteggio; uscite e disconnessioni chiudono la partita.
    const series = this.cfg.match?.bestOf > 1 ? this.cfg.match : null;
    let nextGame = false;
    if (series && rematch) {
      const outcome = winner === this.cfg.me ? "me" : winner === 0 || winner === 1 ? "opp" : null;
      recordGame(series, outcome);
      this.view.setMatchInfo(series);
      const score = `${series.wins[0]}–${series.wins[1]}`;
      if (series.over) {
        const won = series.wins[0] > series.wins[1];
        // Il motivo dell'ultimo duello (es. "You surrendered") resta accanto al punteggio.
        const why = [text, sub].filter(Boolean).join(" · ");
        text = won ? "MATCH WON" : "MATCH LOST";
        sub = why ? `${score} · ${why}` : score;
      } else {
        nextGame = true;
        sub = `${outcome === "me" ? "You win this Duel" : outcome === "opp" ? "Your opponent wins this Duel" : "Draw: it does not count"} · ${score}`;
      }
    }
    this.view.showResult({ winner, reason, text, sub });
    this.inbox.push({ t: "end" });
    if (rematch && this.mux && this.cfg.onRematch && !this.mux.closed) this.showRematch({ nextGame });
    else if (!this.mux && nextGame && this.cfg.onNextGame) this.showNextGame();
    else if (!this.mux && this.cfg.onLocalRematch) this.showLocalRematch();
  }

  /** Partita locale non finita: il duello successivo parte da solo (o subito con il pulsante). */
  showNextGame() {
    let left = 4;
    const status = h("div.rematch-status");
    const go = () => {
      clearInterval(timer);
      if (!this.view.el.isConnected) return;
      this.cfg.onNextGame(this);
    };
    const paint = () => (status.textContent = `Next Duel (Game ${this.cfg.match.game}) in ${left}...`);
    const timer = setInterval(() => (--left <= 0 ? go() : paint()), 1000);
    paint();
    const el = h(
      "div.rematch-panel.asked",
      status,
      h("div.rematch-actions", h("button.btn", { onclick: () => { clearInterval(timer); this.leave(); } }, "Leave"), h("button.btn.primary", { onclick: go }, "Next Duel"))
    );
    this.view.overlay.append(el);
  }

  /** Duello di prova: rivincita immediata con gli stessi mazzi (nessun avversario da aspettare). */
  showLocalRematch() {
    const el = h(
      "div.rematch-panel",
      h("div.rematch-status", "Play again with the same Decks?"),
      h("div.rematch-actions", h("button.btn", { onclick: () => this.leave() }, "Leave"), h("button.btn.primary", { onclick: () => this.cfg.onLocalRematch(this) }, "Rematch"))
    );
    this.view.overlay.append(el);
  }

  // ---------------------------------------------------------------- rivincita

  /** nextGame: partita al meglio di N non ancora finita, si passa da soli al duello successivo. */
  showRematch({ nextGame = false } = {}) {
    const btn = h("button.btn.primary", { onclick: () => this.askRematch() }, "Rematch");
    const text = h("div.rematch-status");
    const el = h("div.rematch-panel", text, h("div.rematch-actions", h("button.btn", { onclick: () => this.leave() }, "Leave"), btn));
    this.rematch.ui = { el, btn, text };
    this.rematch.nextGame = nextGame;
    if (nextGame) btn.hidden = true;
    this.view.overlay.append(el);
    this.updateRematch();
    if (nextGame) this.askRematch();
  }

  askRematch() {
    const r = this.rematch;
    if (r.me || r.oppLeft || r.started) return;
    r.me = true;
    this.send({ t: "rematch" });
    this.updateRematch();
  }

  opponentLeft(text) {
    if (this.rematch.oppLeft) return;
    this.rematch.oppLeft = text;
    this.updateRematch();
  }

  /** Aggiorna il pannello e, quando entrambi sono d'accordo, avvia la nuova negoziazione. */
  updateRematch() {
    const r = this.rematch;
    if (this.over && r.me && r.opp && !r.oppLeft && !r.started) {
      r.started = true;
      // Sincrono: play.js passa subito il collegamento alla partita successiva (mux.newGame).
      this.cfg.onRematch(this);
    }
    const ui = r.ui;
    if (!ui) return;
    if (r.nextGame && !r.failed && !r.oppLeft) {
      ui.text.textContent = r.started ? `Starting Game ${this.cfg.match.game}...` : `Next Duel: Game ${this.cfg.match.game}. Waiting for your opponent...`;
    } else if (r.started && !r.failed) {
      ui.text.textContent = "Starting the rematch...";
      ui.btn.disabled = true;
    } else if (r.failed) {
      ui.text.textContent = r.failed;
      ui.btn.disabled = true;
    } else if (r.oppLeft) {
      ui.text.textContent = r.oppLeft;
      ui.btn.disabled = true;
    } else if (r.me) {
      ui.text.textContent = "Waiting for opponent...";
      ui.btn.disabled = true;
    } else if (r.opp) {
      ui.text.textContent = "Your opponent wants a rematch";
      ui.btn.textContent = "Accept rematch";
    } else {
      ui.text.textContent = "Play again with the same opponent?";
    }
    ui.el.classList.toggle("asked", !!(r.opp && !r.me && !r.oppLeft));
  }

  /** La negoziazione della rivincita è fallita: resta la schermata del risultato con il motivo. */
  rematchFailed(message) {
    this.rematch.failed = `Rematch failed: ${message}`;
    this.updateRematch();
  }

  async surrender() {
    if (this.over) return;
    if (!(await confirmModal("Surrender?", "Your opponent will win the Duel.", "Surrender", "Cancel"))) return;
    this.send({ t: "surrender" });
    this.finish({ winner: 1 - this.cfg.me, text: "You surrendered" });
  }

  async leave() {
    if (!this.over && !(await confirmModal("Leave the Duel?", "You will lose the current Duel.", "Leave", "Stay"))) return;
    this.send({ t: "bye" });
    this.destroy();
    this.cfg.onExit?.();
  }

  /** keepLink: il collegamento resta aperto per la rivincita. */
  destroy({ keepLink = false } = {}) {
    this.over = true;
    this.offClose?.();
    this.clearSleeves?.();
    clearTimeout(this.timeout);
    clearInterval(this.tick);
    this.view.destroy();
    this.engine.terminate();
    if (!keepLink) this.mux?.close();
  }
}
