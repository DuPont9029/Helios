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
import { EngineClient } from "./engine-client.js";
import { rateLimit } from "../net/guard.js";
import { settings } from "../data/settings.js";
import { Broadcast } from "../net/spectate.js";
import { statusChanged } from "../net/social.js";
import { startReportGame, endReportGame, closeReport, onReportChange } from "./coaching.js";
import { coachResultButton } from "../ui/coaching.js";
import { StatsRecorder } from "./duel-stats.js";
import { COACHING } from "../data/features.js";

// Risposte arrivate prima di questa soglia sono automatiche (es. catena saltata): non contano come azione.
const AUTO_RESPONSE_MS = 60;
// Margine per la latenza prima di dichiarare scaduto il tempo dell'avversario remoto.
const REMOTE_GRACE_MS = 8000;
// Margine sul tempo dichiarato dall'avversario rispetto a quello misurato qui (ritardo della rete).
const CLOCK_TOLERANCE_MS = 1000;

const AUTOPLAY = (() => {
  try {
    return localStorage.getItem("ygoweb.autoplay") === "1";
  } catch {
    return false;
  }
})();

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
   *   practice: true = giocata di prova (dal report del coaching): niente spettatori né report,
   *   prefix: risposte da rigiocare subito senza animazioni (la prova parte da quel momento del duello),
   *   sideTab: scheda in più accanto a Log e Chat (vedi DuelView),
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
      sideTab: cfg.sideTab ?? null,
    });
    // La giocata di prova non è un duello per gli amici (la presenza resta "online").
    if (cfg.practice) this.view.el.classList.add("practice");
    this.view.startLP = cfg.duel.lp;
    if (cfg.match?.bestOf > 1) this.view.setMatchInfo(cfg.match);
    this.clearSleeves = applySleeves(cfg.sleeves);
    const preset = TIMER_PRESETS[cfg.timer ?? "off"];
    this.clock = preset ? new DuelClock(preset) : null;
    if (this.clock) this.tick = setInterval(() => this.renderClock(), 200);
    if (p2p) this.bindLink(cfg.mux);
    // Amici spettatori: duelli contro la CPU e online (non il duello di prova né il Combo Trainer), se il
    // giocatore lo permette (Settings → Profile → Friends).
    const watchable = !this.trainer && !cfg.practice && !cfg.reveal && cfg.controllers.some((c) => c === "ai" || c === "remote") && settings.allowSpectators !== false;
    if (watchable) this.startBroadcast(p2p ? "Online Duel" : "Vs CPU");
    // Statistiche per il report (e passi della giocata di prova).
    if ((this.broadcast && COACHING) || cfg.practice) this.stats = new StatsRecorder(cfg.me, { base: cfg.prefix?.length ?? 0, onChange: cfg.onStats });
  }

  // ---------------------------------------------------------------- spettatori

  /** Il duello va sui relay per gli amici che lo guardano (net/spectate.js); le loro note vanno nel report. */
  startBroadcast(mode) {
    const { cfg } = this;
    const series = cfg.match ?? null;
    // Un report per partita: al meglio di N tutti i duelli finiscono nello stesso.
    const report = series ? (series.reportId ??= crypto.randomUUID().slice(0, 18)) : crypto.randomUUID().slice(0, 18);
    this.broadcast = new Broadcast({ duel: cfg.duel, names: cfg.names, me: cfg.me, mode, match: series?.bestOf > 1 ? series : null, report });
    this.reportId = report;
    startReportGame({ report, stream: this.broadcast.id, game: series?.game ?? 1, names: [cfg.names[cfg.me], cfg.names[1 - cfg.me]], mode });
    // Chi guarda adesso (le note restano nascoste fino alla fine della partita).
    const watching = new Map();
    this.offReport = onReportChange((r, change, w) => {
      if (r?.id !== report || !w?.pk) return;
      if (change === "watcher") {
        this.broadcast.activate();
        if (!watching.has(w.pk) && !this.over) toast(`${w.name} is watching your Duel`, { ms: 3500 });
        watching.set(w.pk, w.name);
      } else if (change === "watcher-left") watching.delete(w.pk);
      else return;
      this.view.setWatchers([...watching.values()]);
    });
  }

  /** Risposte definitive agli spettatori: una summon annullabile ("Back") parte solo quando avviene. */
  cast() {
    this.broadcast?.update(this.history, this.pending ? this.pending.histLen : this.history.length);
  }

  /** Fine del duello per gli spettatori e per il report (testi dal punto di vista di chi gioca). */
  endBroadcast({ winner, reason, why, over }) {
    if (!this.broadcast || this.broadcastEnded) return;
    this.broadcastEnded = true;
    const me = this.cfg.names[this.cfg.me];
    const opp = this.cfg.names[1 - this.cfg.me];
    // Per gli spettatori "You" e "Your opponent" diventano i nomi.
    const neutral = why ? why.replace(/\bYour opponent\b/g, opp).replace(/\bYou\b/g, me) : "";
    this.broadcast.end({ winner, reason, sub: neutral || undefined });
    const outcome = winner === this.cfg.me ? "Victory" : winner === 0 || winner === 1 ? "Defeat" : "Draw";
    // Il duello resta nel report: si rigioca sul campo dai momenti segnalati, con le statistiche.
    const replay = { duel: this.cfg.duel, me: this.cfg.me, names: this.cfg.names, history: this.history.slice(), stats: this.stats?.result(this.cfg.duel.lp) ?? null };
    endReportGame(this.broadcast.id, why ? `${outcome} · ${why}` : outcome, over, replay);
    if (over && COACHING) this.view.overlay.append(coachResultButton(this.reportId));
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
    // Chat dell'avversario: al massimo 8 messaggi ogni 10 secondi (gli altri si scartano).
    const chatOk = rateLimit(8, 10000);
    mux.on("chat", (m) => chatOk() && this.view.addChat(opp(), String(m.text).slice(0, 300)));
    mux.on("surrender", () => this.finish({ winner: this.cfg.me, text: "Your opponent surrendered" }));
    // "Tempo scaduto" dall'avversario: vale solo per il suo giocatore (equivale ad arrendersi). Il proprio
    // timeout lo decide solo il proprio orologio: un messaggio che dice il contrario si ignora.
    mux.on("timeout", (m) => {
      const p = 1 - this.cfg.me;
      if (m.player !== p) return console.warn("Ignored a timeout message for the local player from the opponent");
      if (!this.timed(p)) return console.warn("Ignored a timeout message: this Duel has no timer");
      if (this.clock) {
        this.clock.pause(performance.now());
        this.clock.left[p] = 0;
        this.renderClock();
      }
      this.finish({ winner: 1 - p, sub: `${this.cfg.names[p]} ran out of time` });
    });
    // Partita classificata: firma del risultato dell'avversario (vedi net/elo.js). Chiudendo la scheda a duello
    // in corso si manda la firma della propria sconfitta: chi esce perde.
    if (this.cfg.ranked) {
      this.cfg.ranked.onStatus = (text, kind = "ok") => toast(text, { kind, ms: 4000 });
      mux.on("rank-result", (m) => this.cfg.ranked.receiveResult(m));
      this.onPageHide = () => {
        if (this.over) return;
        this.cfg.ranked.resign();
        this.send({ t: "bye" });
      };
      addEventListener("pagehide", this.onPageHide);
    }
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
    // Gli amici vedono subito che si può guardare il duello (anche nella rivincita, sulla stessa schermata).
    if (this.broadcast) statusChanged();
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
      if (this.cfg.prefix?.length) res = await this.fastForward(this.cfg.prefix);
      await this.loop(res);
    } catch (err) {
      if (this.over) return;
      console.error(err);
      this.view.setStatus("Error: " + err.message);
      toast("Engine error: " + err.message, { kind: "error", ms: 8000 });
    }
  }

  /** Giocata di prova: si arriva senza animazioni al momento scelto del duello (prefix = risposte date fin lì). */
  async fastForward(prefix) {
    const res = await this.engine.call("replay", { duel: this.cfg.duel, responses: prefix });
    this.history = prefix.slice();
    this.seq = prefix.length;
    this.view.render(res.snapshot);
    this.view.syncChain(res.snapshot.chain ?? []);
    if (this.stats) {
      this.stats.turn = res.snapshot.turn;
      this.stats.lp = res.snapshot.players.map((p) => p.lp);
    }
    return { ...res, messages: [] };
  }

  async loop(res) {
    for (;;) {
      if (this.over) return;
      for (const l of res.logs) console.warn("[script]", l.text);
      await this.view.playMessages(res.messages);
      this.stats?.messages(res.messages, this.history.length, res.snapshot);
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
      let thought = null; // tempo per decidere (statistiche del report)
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
        // Combo Trainer: prima si arriva alla fase di partenza della combo (es. Battle Phase), poi l'auto-play.
        let auto = this.trainer?.phaseRespond?.(prompt) ?? this.trainer?.autoRespond?.(prompt);
        if (auto === undefined) {
          for (;;) {
            // Auto-play acceso mentre si aspetta la scelta: si smette di aspettare e sceglie il trainer.
            const autoOn = this.trainer ? new Promise((r) => (this.trainer.onAutoplay = (on) => on && r({ trainerAuto: true }))) : null;
            response = await Promise.race([this.view.prompter.ask(prompt), back, autoOn].filter(Boolean));
            if (this.trainer) this.trainer.onAutoplay = null;
            // Duello chiuso mentre si sceglieva (es. "Leave"): niente nuove richieste.
            if (this.over) return;
            if (response?.trainerAuto) {
              this.view.prompter.abort();
              auto = this.trainer.autoRespond(prompt);
              if (auto !== undefined) break;
              continue;
            }
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
        if (auto !== undefined) {
          await this.trainer?.waitResume?.(); // auto-play in pausa
          if (this.over) return;
          await this.view.wait(prompt.type === MSG.SELECT_IDLECMD || prompt.type === MSG.SELECT_BATTLECMD ? 650 : 300);
          response = auto ?? this.ai.respond(prompt, { turn: res.snapshot.turn });
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
        const took = performance.now() - asked;
        this.stopClock(prompt.player, took >= AUTO_RESPONSE_MS);
        if (took >= AUTO_RESPONSE_MS) thought = took;
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
        // È l'avversario a misurare il proprio tempo: si adotta il valore che comunica, ma non più di quello
        // che risulta anche qui (più l'incremento dell'azione e un margine per la rete): un client modificato
        // non può darsi tempo in più.
        if (this.timed(prompt.player)) {
          clearTimeout(this.timeout);
          const now = performance.now();
          const here = this.clock.view(prompt.player, now).left;
          if (m.clock && Number.isFinite(m.clock.left)) {
            const max = here + this.clock.inc + CLOCK_TOLERANCE_MS;
            if (m.clock.left > max) console.warn(`Opponent's clock adjusted: reported ${Math.round(m.clock.left)} ms, allowed ${Math.round(max)} ms`);
            const bonus = Number.isFinite(m.clock.bonus) ? Math.min(Math.max(0, m.clock.bonus), this.clock.maxBonus) : undefined;
            this.clock.sync(prompt.player, Math.min(m.clock.left, max), bonus);
          } else this.clock.pause(now);
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
      this.stats?.response(this.history.length, prompt, response, res.snapshot, thought);
      this.seq++;
      this.history.push(response);
      this.cast();
      res = await this.engine.call("respond", { response });
    }
  }

  /** La summon in sospeso è avvenuta: ora l'avversario riceve le risposte, nell'ordine. */
  commitPending() {
    const p = this.pending;
    this.pending = null;
    if (this.mux) for (const out of p.outbox) this.send(out);
    this.cast();
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
    this.stats?.rewind(mark.histLen);
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
    const why = [text, sub].filter(Boolean).join(" · ");
    this.rankedEnd(winner, rematch);
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
    // Report del coaching: si legge a partita finita (al meglio di N: dopo l'ultimo duello, o uscendo).
    this.endBroadcast({ winner, reason, why, over: !series || series.over || !rematch });
    this.inbox.push({ t: "end" });
    if (rematch && this.mux && this.cfg.onRematch && !this.mux.closed) this.showRematch({ nextGame });
    else if (!this.mux && nextGame && this.cfg.onNextGame) this.showNextGame();
    else if (!this.mux && this.cfg.onLocalRematch) this.showLocalRematch();
  }

  /**
   * Partita classificata: a fine duello si firma il risultato (vincitore, o pareggio); se l'avversario se ne
   * va (rematch = false: uscita o collegamento perso) o non firma entro 30 secondi, vale l'abbandono.
   */
  rankedEnd(winner, rematch) {
    const r = this.cfg.ranked;
    if (!r) return;
    // Uscita o collegamento perso: se l'avversario ha già mandato la firma della sua sconfitta (è uscito lui),
    // la si controfirma; altrimenti vale l'abbandono.
    if (!rematch && !r.pendingOpp) return void r.abandoned();
    const pk = !rematch ? r.me : winner === this.cfg.me ? r.me : winner === 1 - this.cfg.me ? r.opp : null;
    r.finished(pk);
    // Firma dell'avversario che non arriva (se n'è andato o non vuole firmare la sconfitta): vale l'abbandono,
    // che RankedGame pubblica solo per chi ha vinto.
    setTimeout(() => r.abandoned(), 30000);
    this.mux?.onClose(() => r.abandoned());
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
    if (this.broadcast) {
      closeReport(this.broadcast.id);
      if (COACHING) this.view.overlay.append(coachResultButton(this.reportId));
    }
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
    if (!this.over && !this.cfg.practice && !(await confirmModal("Leave the Duel?", this.cfg.ranked ? "You will lose the current Duel (ranked: it counts as a loss)." : "You will lose the current Duel.", "Leave", "Stay", { top: true }))) return;
    if (!this.over) this.cfg.ranked?.resign(); // classificata: chi esce perde
    if (!this.over) this.endBroadcast({ winner: 1 - this.cfg.me, why: "You left the Duel", over: true });
    else if (this.broadcast) closeReport(this.broadcast.id);
    this.send({ t: "bye" });
    this.destroy();
    this.cfg.onExit?.();
  }

  /** keepLink: il collegamento resta aperto per la rivincita. */
  destroy({ keepLink = false } = {}) {
    this.over = true;
    this.broadcast?.close();
    this.offReport?.();
    if (this.onPageHide) removeEventListener("pagehide", this.onPageHide);
    this.offClose?.();
    this.clearSleeves?.();
    clearTimeout(this.timeout);
    clearInterval(this.tick);
    this.view.destroy();
    this.engine.terminate();
    if (!keepLink) this.mux?.close();
  }
}
