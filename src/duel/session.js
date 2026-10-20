// Gestione di una partita. Entrambi i peer eseguono lo stesso core con lo
// stesso seed e gli stessi mazzi (lockstep): sulla rete viaggiano solo le
// risposte del giocatore di turno, più un checksum per scoprire divergenze.
import { DATA_URL, db, getCard } from "../data/db.js";
import { SimpleAI, PassAI } from "../core/ai.js";
import { DuelView } from "../ui/duel/view.js";
import { confirmModal, toast } from "../ui/modal.js";
import { MSG, DUEL, IDLE, BATTLE, LOC } from "../core/constants.js";
import { DuelClock, TIMER_PRESETS } from "./clock.js";
import { applySleeves } from "../data/sleeve.js";
import { recordGame, seriesLabel } from "./series.js";
import { h } from "../ui/dom.js";
import { STANDALONE, loadArchive } from "../data/bundle.js";

// Helios in un solo file: il worker del motore è incorporato nel bundle (niente file worker.js da caricare).
const InlineWorker = STANDALONE ? (await import("./worker.js?worker&inline")).default : null;

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
    this.worker = InlineWorker ? new InlineWorker() : new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
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

// Summon, Set e attivazioni annullabili finché non avvengono: l'azione resta "in sospeso" (non va
// all'avversario, che quindi non vede i bersagli e i costi scelti) mentre il core chiede costi, bersagli,
// zona e posizione; "Back" ricostruisce lo stato di prima.
const UNDOABLE_ACTIONS = new Set([IDLE.SUMMON, IDLE.SPSUMMON, IDLE.MSET, IDLE.SSET, IDLE.ACTIVATE]);
const UNDOABLE_PROMPTS = new Set([
  MSG.SELECT_PLACE, MSG.SELECT_POSITION, MSG.SELECT_CARD, MSG.SELECT_TRIBUTE, MSG.SELECT_SUM, MSG.SELECT_UNSELECT_CARD,
  MSG.SELECT_OPTION, MSG.SELECT_YESNO, MSG.SELECT_COUNTER, MSG.ANNOUNCE_CARD, MSG.ANNOUNCE_RACE, MSG.ANNOUNCE_ATTRIB, MSG.ANNOUNCE_NUMBER,
]);
// Richieste in cui compare "Back".
const BACK_PROMPTS = UNDOABLE_PROMPTS;
// La summon/il set è avvenuto: non si torna più indietro. (Le attivazioni no: il core manda MSG_CHAINING
// prima di chiedere bersagli e costi, quindi restano annullabili finché durano quelle scelte.)
const DONE_MSGS = new Set([MSG.SUMMONING, MSG.SPSUMMONING, MSG.SET, MSG.FLIPSUMMONING]);

/** Azione annullabile iniziata dalla risposta: "summon" (summon/set), "activate" (attivazione) o null. */
function pendingKind(prompt, response) {
  if (prompt.type === MSG.SELECT_IDLECMD && UNDOABLE_ACTIONS.has(response.action)) return response.action === IDLE.ACTIVATE ? "activate" : "summon";
  if (prompt.type === MSG.SELECT_BATTLECMD && response.action === BATTLE.ACTIVATE) return "activate";
  if (prompt.type === MSG.SELECT_CHAIN && response.index != null) return "activate";
  return null;
}

export class DuelSession {
  /**
   * @param cfg {
   *   controllers: ["local"|"ai"|"remote"|"pass", ...] per giocatore del core (0 = chi inizia);
   *     "pass" = avversario passivo del duello di prova senza mazzo (chiude subito il turno),
   *   me: indice del core visto in basso, names: [n0, n1], reveal,
   *   duel: { flags, seed, lp, hand, draw, decks },
   *   timer: chiave di TIMER_PRESETS ("omega" | "off"),
   *   sleeves: [immagine del giocatore 0, del giocatore 1] (data URL o null),
   *   pendulums: [gemme Pendulum del giocatore 0, del giocatore 1] ({ red, blue, side } o null = gemme predefinite),
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
    this.passer = cfg.controllers.includes("pass") || cfg.controllers.includes("trainer") ? new PassAI({ getCard, allCards: db.list }) : null;
    // Combo Trainer: segue la combo del giocatore e pilota l'avversario (interruzioni).
    this.trainer = cfg.trainer ?? null;
    if (this.trainer) this.trainer.me = cfg.me;
    // Rivincita (solo P2P): chi l'ha chiesta tra noi e l'avversario.
    this.rematch = { me: false, opp: false, oppLeft: false, started: false, ui: null };
    const p2p = cfg.controllers.includes("remote");
    this.view = new DuelView({
      me: cfg.me,
      names: cfg.names,
      reveal: cfg.reveal,
      trainerEl: cfg.trainer?.el ?? null,
      // Gemme delle zone Pendulum di ogni giocatore (come gli sleeve: l'avversario vede le sue).
      pendulums: cfg.pendulums ?? null,
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
      // Un solo file: il worker riceve una copia dell'archivio dei dati (carte e script Lua).
      await this.engine.call("init", { dataUrl: DATA_URL, archive: STANDALONE ? (await loadArchive()).bytes : null });
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
      this.trainer?.onMessages(res.messages);
      if (this.over) return;
      // Combo Trainer: "Back" premuto mentre il duello non aspettava il giocatore (animazioni, avversario).
      if (this.trainer?.rewindTo) {
        const mark = this.trainer.rewindTo;
        this.trainer.rewindTo = null;
        res = await this.rewind(mark);
        continue;
      }
      this.view.render(res.snapshot);
      if (this.clock && res.messages.some((m) => m.type === MSG.NEW_TURN)) this.clock.newTurn();
      // Summon in sospeso: diventa definitiva appena avviene o il core chiede altro (anche all'avversario).
      const next = res.prompt;
      const done = this.pending?.kind === "summon" && res.messages.some((m) => DONE_MSGS.has(m.type));
      if (this.pending && (res.ended || !next || done || next.player !== this.pending.player || !UNDOABLE_PROMPTS.has(next.type))) this.commitPending();
      if (res.ended) {
        const win = res.messages.find((m) => m.type === MSG.WIN);
        this.finish({ winner: win?.player ?? res.snapshot.winner, reason: win?.reason });
        return;
      }
      const prompt = res.prompt;
      // Di nuovo alla scelta dell'azione: una Pendulum Summon annullata non vale per le summon successive.
      if (prompt.type === MSG.SELECT_IDLECMD || prompt.type === MSG.SELECT_BATTLECMD) this.view.pendulumSummon = false;
      this.trainer?.onPrompt(prompt);
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
        // Combo Trainer: il pulsante "Back" interrompe l'attesa della scelta e fa tornare indietro.
        const back = this.trainer ? new Promise((r) => (this.trainer.onBack = () => r({ trainerBack: true }))) : null;
        // Auto-play (esportazione video): il trainer sceglie da solo; undefined = tocca al giocatore.
        const auto = this.trainer?.autoRespond?.(prompt);
        if (auto !== undefined) {
          await this.view.wait(prompt.type === MSG.SELECT_IDLECMD || prompt.type === MSG.SELECT_BATTLECMD ? 650 : 300);
          response = auto ?? this.ai.respond(prompt, { turn: res.snapshot.turn });
        } else {
          for (;;) {
            response = await (back ? Promise.race([this.view.prompter.ask(prompt), back]) : this.view.prompter.ask(prompt));
            // Duello chiuso mentre si sceglieva (es. "Leave"): niente nuove richieste.
            if (this.over) return;
            if (!response || response.trainerBack || response.back) break;
            // Modalità strict: azione o scelta diversa dalla combo, si richiede (senza scelte automatiche).
            const err = this.trainer?.check?.(prompt, response);
            if (!err) break;
            toast(err, { kind: "error", ms: 3200 });
            this.view.caption(err, "wrong");
            this.view.prompter.forceManual = true;
          }
          this.view.prompter.forceManual = false;
        }
        if (this.trainer) this.trainer.onBack = null;
        if (response?.trainerBack) {
          this.view.prompter.abort();
          this.view.prompter.back = null;
          this.view.prompter.summoning = false;
          this.stopClock(prompt.player, false);
          const mark = this.trainer.rewindTo;
          this.trainer.rewindTo = null;
          res = await this.rewind(mark);
          continue;
        }
        this.view.prompter.back = null;
        this.view.prompter.summoning = false;
        this.stopClock(prompt.player, performance.now() - asked >= AUTO_RESPONSE_MS);
        this.view.setStatus("");
        if (this.over) return;
        if (response?.back) {
          res = await this.undoPending();
          continue;
        }
        // Stato da ricostruire tornando indietro: anche quello del trainer (passo e scelta attesi).
        const mark = () => ({ histLen: this.history.length, seq: this.seq, logMark: this.view.logMark(), trainer: this.trainer?.save?.() });
        const kind = pendingKind(prompt, response);
        if (kind && !this.pending) this.pending = { kind, player: prompt.player, ...mark(), outbox: [] };
        this.trainer?.onResponse(prompt, response, mark());
        const clock = this.timed(prompt.player) ? { left: this.clock.left[prompt.player], bonus: this.clock.bonus[prompt.player] } : undefined;
        const out = { t: "resp", seq: this.seq, response, sum: res.checksum, clock };
        if (this.pending) this.pending.outbox.push(out);
        else if (this.mux) this.send(out);
      } else if (who === "pass") {
        response = this.passer.respond(prompt, { turn: res.snapshot.turn });
      } else if (who === "trainer") {
        if (prompt.type === MSG.SELECT_CHAIN) await this.view.wait(250);
        response = this.trainer.respond(prompt, (pr) => this.passer.respond(pr, { turn: res.snapshot.turn }));
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
      // Pendulum Summon (azione "Special Summon" della carta nella zona Pendulum): le summon che seguono
      // si chiamano così nel campo e nel registro.
      if (prompt.type === MSG.SELECT_IDLECMD && response?.action === IDLE.SPSUMMON && prompt.special_summons?.[response.index]?.location & LOC.SZONE) {
        this.view.pendulumSummon = true;
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
    return this.rewind(p);
  }

  /**
   * Torna allo stato di un punto precedente ({ histLen, seq, logMark }) ricostruendolo nel worker
   * con le risposte date fin lì (il duello è deterministico). Usato da "Back" e dal Combo Trainer.
   */
  async rewind(mark) {
    this.pending = null;
    this.view.prompter.abort();
    this.view.setStatus("Going back...");
    const res = await this.engine.call("replay", { duel: this.cfg.duel, responses: this.history.slice(0, mark.histLen) });
    this.history.length = mark.histLen;
    this.seq = mark.seq;
    this.view.logRewind(mark.logMark);
    if (mark.trainer) this.trainer?.restore?.(mark.trainer);
    this.view.pendulumSummon = false;
    // Segnalini e contesto della catena come nello stato ricostruito (l'attivazione annullata sparisce).
    this.view.render(res.snapshot);
    this.view.syncChain(res.snapshot.chain ?? []);
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
        sub = `${outcome === "me" ? "You win this Duel" : outcome === "opp" ? "Your opponent wins this Duel" : `Draw: it does not count, Game ${series.game} is replayed`} · ${score}`;
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
    // Con un Side Deck si apre prima il side decking (nel deck editor), poi parte il duello.
    const side = !!this.cfg.sideDeck;
    const paint = () => (status.textContent = side ? `Opening the Side Deck for Game ${this.cfg.match.game} in ${left}...` : `Next Duel (Game ${this.cfg.match.game}) in ${left}...`);
    const timer = setInterval(() => (--left <= 0 ? go() : paint()), 1000);
    paint();
    const el = h(
      "div.rematch-panel.asked",
      status,
      h("div.rematch-actions", h("button.btn", { onclick: () => { clearInterval(timer); this.leave(); } }, "Leave"), h("button.btn.primary", { onclick: go }, side ? "Open Side Deck" : "Next Duel"))
    );
    this.view.overlay.append(el);
  }

  /**
   * Duello di prova / Combo Trainer: rivincita immediata con gli stessi mazzi (nessun avversario da aspettare).
   * keepPlaying: il duello non è finito (combo completa), il pannello si può chiudere e continuare.
   */
  showLocalRematch({ text = "Play again with the same Decks?", label = "Rematch", keepPlaying = false } = {}) {
    this.view.overlay.querySelector(".rematch-panel")?.remove();
    const el = h(
      "div.rematch-panel",
      h("div.rematch-status", text),
      h(
        "div.rematch-actions",
        keepPlaying ? h("button.btn.ghost", { onclick: () => el.remove() }, "Keep playing") : h("button.btn", { onclick: () => this.leave() }, "Leave"),
        h("button.btn.primary", { onclick: () => this.cfg.onLocalRematch(this) }, label)
      )
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
      const game = this.cfg.match.game;
      ui.text.textContent = this.cfg.sideDeck
        ? r.started ? `Opening the Side Deck for Game ${game}...` : `Side Deck for Game ${game}: waiting for your opponent...`
        : r.started ? `Starting Game ${game}...` : `Next Duel: Game ${game}. Waiting for your opponent...`;
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

  /**
   * La partita al meglio di N finisce senza giocare altri duelli (resa dal side deck): won = ha vinto
   * il giocatore locale (me). Il risultato del duello lascia il posto a quello della partita.
   */
  concludeMatch({ won, why }) {
    const s = this.cfg.match;
    if (s) {
      s.over = true;
      this.view.setMatchInfo(s);
    }
    this.rematch.started = true; // niente più rivincite su questa partita
    this.view.overlay.querySelectorAll(".result, .rematch-panel").forEach((e) => e.remove());
    const score = s ? `${s.wins[0]}–${s.wins[1]}` : "";
    this.view.showResult({ winner: won ? this.cfg.me : 1 - this.cfg.me, text: won ? "MATCH WON" : "MATCH LOST", sub: [score, why].filter(Boolean).join(" · ") });
    const panel = h(
      "div.rematch-panel",
      h("div.rematch-status", why),
      h(
        "div.rematch-actions",
        h("button.btn", { onclick: () => this.leave() }, "Leave"),
        this.cfg.onLocalRematch ? h("button.btn.primary", { onclick: () => this.cfg.onLocalRematch(this) }, "Rematch") : null
      )
    );
    this.view.overlay.append(panel);
  }

  /** La negoziazione della rivincita è fallita: resta la schermata del risultato con il motivo. */
  rematchFailed(message) {
    this.rematch.failed = `Rematch failed: ${message}`;
    this.updateRematch();
  }

  async surrender() {
    if (this.over) return;
    // Sopra a qualsiasi altra finestra aperta (scelte del duello comprese).
    if (!(await confirmModal("Surrender?", "Your opponent will win the Duel.", "Surrender", "Cancel", { top: true }))) return;
    this.send({ t: "surrender" });
    this.finish({ winner: 1 - this.cfg.me, text: "You surrendered" });
  }

  async leave() {
    if (!this.over && !(await confirmModal("Leave the Duel?", "You will lose the current Duel.", "Leave", "Stay", { top: true }))) return;
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
