// Gestione di una partita. Entrambi i peer eseguono lo stesso core con lo
// stesso seed e gli stessi mazzi (lockstep): sulla rete viaggiano solo le
// risposte del giocatore di turno, più un checksum per scoprire divergenze.
import { DATA_URL, db, getCard } from "../data/db.js";
import { SimpleAI } from "../core/ai.js";
import { DuelView } from "../ui/duel/view.js";
import { confirmModal, toast } from "../ui/modal.js";
import { MSG } from "../core/constants.js";
import { DuelClock, TIMER_PRESETS } from "./clock.js";
import { applySleeves } from "../data/sleeve.js";

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

export class DuelSession {
  /**
   * @param cfg {
   *   controllers: ["local"|"ai"|"remote", ...] per giocatore del core (0 = chi inizia),
   *   me: indice del core visto in basso, names: [n0, n1], reveal,
   *   duel: { flags, seed, lp, hand, draw, decks },
   *   timer: chiave di TIMER_PRESETS ("omega" | "off"),
   *   sleeves: [immagine del giocatore 0, del giocatore 1] (data URL o null),
   *   mux: LinkMux (solo P2P),
   *   onExit()
   * }
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.engine = new EngineClient();
    this.inbox = new Inbox();
    this.seq = 0;
    this.over = false;
    this.ai = new SimpleAI({ getCard, allCards: db.list });
    const p2p = cfg.controllers.includes("remote");
    this.view = new DuelView({
      me: cfg.me,
      names: cfg.names,
      reveal: cfg.reveal,
      onChat: p2p ? (text) => this.send({ t: "chat", text }) : null,
      onSurrender: () => this.surrender(),
      onLeave: () => this.leave(),
    });
    this.view.startLP = cfg.duel.lp;
    this.clearSleeves = applySleeves(cfg.sleeves);
    const preset = TIMER_PRESETS[cfg.timer ?? "off"];
    this.clock = preset ? new DuelClock(preset) : null;
    if (this.clock) this.tick = setInterval(() => this.renderClock(), 200);
    if (p2p) this.bindLink(cfg.mux);
  }

  // ---------------------------------------------------------------- timer

  /** Giocatori il cui tempo viene misurato (la CPU non ha timer). */
  timed(p) {
    return this.clock && this.cfg.controllers[p] !== "ai";
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
    mux.on("bye", () => this.finish({ winner: this.cfg.me, text: "Your opponent left the Duel" }));
    mux.onClose((reason) => {
      if (!this.over) this.finish({ winner: null, text: "Connection lost", sub: reason });
    });
  }

  send(obj) {
    this.mux?.send(obj);
  }

  async start(container) {
    container.append(this.view.el);
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
        response = await this.view.prompter.ask(prompt);
        this.stopClock(prompt.player, performance.now() - asked >= AUTO_RESPONSE_MS);
        this.view.setStatus("");
        if (this.over) return;
        const clock = this.timed(prompt.player) ? { left: this.clock.left[prompt.player], bonus: this.clock.bonus[prompt.player] } : undefined;
        if (this.mux) this.send({ t: "resp", seq: this.seq, response, sum: res.checksum, clock });
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
      res = await this.engine.call("respond", { response });
    }
  }

  finish({ winner, reason, text, sub }) {
    if (this.over) return;
    this.over = true;
    clearTimeout(this.timeout);
    clearInterval(this.tick);
    this.clock?.pause(performance.now());
    this.view.prompter.abort();
    this.view.setStatus("Duel over");
    this.view.showResult({ winner, reason, text, sub });
    this.inbox.push({ t: "end" });
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

  destroy() {
    this.over = true;
    this.clearSleeves?.();
    clearTimeout(this.timeout);
    clearInterval(this.tick);
    this.view.destroy();
    this.engine.terminate();
    this.mux?.close();
  }
}
