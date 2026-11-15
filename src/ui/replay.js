// Replay dei duelli (pagina "Replays" e visore). Il duello si rigioca nel motore dalla configurazione e dalle
// risposte salvate (data/replays.js), come fa il report del coaching: avanti con le animazioni, oppure si salta
// a un momento (stato ricostruito da capo, senza animazioni, con il registro rifatto fin lì).
// Il visore usa la modalità di chi guarda di DuelView (setWatch): a sinistra il registro o niente, nessun comando
// da giocatore, i Life Points in basso a destra. Si esporta come video (registrazione dall'inizio alla fine) o come
// codice HELIOS-REPLAY da importare in un altro Helios.
import { h, clear, icon } from "./dom.js";
import { openModal, toast, confirmModal, promptModal } from "./modal.js";
import { fullscreenButton } from "./fullscreen.js";
import { DuelView } from "./duel/view.js";
import { DATA_URL } from "../data/db.js";
import { STANDALONE, loadArchive } from "../data/bundle.js";
import { settings } from "../data/settings.js";
import { EngineClient } from "../duel/engine-client.js";
import { StatsRecorder } from "../duel/duel-stats.js";
import { DUEL, MSG, IDLE, LOC } from "../core/constants.js";
import { listReplays, saveReplay, deleteReplay, renameReplay, replayToCode, replayFromCode, onReplaysChange, REPLAY_PREFIX } from "../data/replays.js";
import { canRecordVideo, startVideo, showVideo, videoErrorText } from "./video-capture.js";
import { useRemoteCards } from "../data/custom-cards.js";
import { isMobile } from "./mobile.js";

const title = (r) => r.title || `${r.names[0]} vs ${r.names[1]}`;
const when = (at) => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

// ---------------------------------------------------------------- pagina

/** Pagina con i replay salvati: guardarli, esportarli (codice o video), importarne uno, rinominarli, cancellarli. */
export function showReplays(app) {
  const root = clear(app.root);
  const listEl = h("div.replay-list");
  const render = () => {
    const all = listReplays();
    clear(listEl).append(
      ...(all.length
        ? all.map(row)
        : [h("div.replay-empty", icon("movie"), h("b", "No replays yet"), h("span.muted.small", "Your finished Duels (online, with friends, against the CPU, Test Duel) are saved here. You can also import a replay code."))])
    );
  };
  const row = (r) =>
    h(
      `div.replay-row.${r.winner == null ? "draw" : r.winner === r.me ? "won" : "lost"}`,
      h(
        "button.replay-main",
        { title: "Watch the replay", onclick: () => watchReplay(app, r, { onExit: () => showReplays(app) }) },
        icon("play_circle"),
        h("span.replay-text", h("b", title(r)), h("span.muted.small", [r.mode, r.game ? `Game ${r.game}` : null, when(r.at)].filter(Boolean).join(" · ")), h("span.replay-result", r.result || ""))
      ),
      h(
        "div.replay-actions",
        h("button.btn.small", { title: "Copy the replay code (import it in another Helios)", onclick: () => shareReplay(r) }, icon("content_copy"), " Code"),
        canRecordVideo() ? h("button.btn.small", { title: "Record the whole replay as a video", onclick: () => videoReplay(app, r) }, icon("videocam"), " Video") : null,
        h("button.btn.small.ghost", {
          title: "Rename",
          onclick: async () => {
            const v = await promptModal("Rename replay", "Name", title(r));
            if (v != null) renameReplay(r.id, v);
          },
        }, icon("edit")),
        h("button.btn.small.ghost", {
          title: "Delete",
          onclick: async () => {
            if (await confirmModal("Delete replay?", `"${title(r)}" will be removed.`, "Delete", "Cancel")) deleteReplay(r.id);
          },
        }, icon("delete"))
      )
    );
  const off = onReplaysChange(() => (listEl.isConnected ? render() : off()));
  root.append(
    h(
      "div.page.replays",
      h(
        "div.page-head",
        h("button.btn.ghost.round.page-back", { title: "Menu (right-click)", onclick: () => app.home("duel") }, icon("chevron_left")),
        h("h1", "Replays"),
        h("div.page-tools", h("button.btn", { onclick: () => importReplay(app) }, icon("download"), " Import a code"))
      ),
      h("p.muted.small.replay-hint", "Watch a Duel again, share it as a code or save it as a video. The latest 60 Duels are kept."),
      listEl
    )
  );
  render();
}

async function shareReplay(r) {
  const code = await replayToCode(r);
  const show = () =>
    openModal({
      title: "Replay code",
      body: [h("p.muted.small", "Copy this code and import it in another Helios client (Online Duel → Replays → Import a code)."), h("textarea.input.combo-code", { readOnly: true, rows: 6, value: code, onfocus: (e) => e.target.select() })],
      actions: [{ label: "Close", value: null, primary: true }],
    });
  if (!navigator.clipboard?.writeText) return show();
  navigator.clipboard.writeText(code).then(() => toast(`Replay code copied: "${title(r)}"`), show);
}

async function importReplay(app) {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    /* appunti non accessibili: si chiede di incollare */
  }
  if (!String(text).trim().startsWith(REPLAY_PREFIX)) {
    const area = h("textarea.input.combo-code", { rows: 6, placeholder: `${REPLAY_PREFIX}...` });
    const v = await openModal({ title: "Import a replay", body: [h("p.muted.small", "Paste the replay code:"), area], actions: [{ label: "Cancel", value: null }, { label: "Import", primary: true, onClick: (close) => close(area.value) }] }).result;
    if (!v) return;
    text = v;
  }
  try {
    const r = saveReplay(await replayFromCode(text));
    toast(`Replay imported: "${title(r)}"`);
    watchReplay(app, r, { onExit: () => showReplays(app) });
  } catch (e) {
    openModal({ title: "Import a replay", body: [h("p", e.message)], actions: [{ label: "Close", value: null, primary: true }] });
  }
}

/** Video del replay: si apre il visore e si registra dall'inizio alla fine (il browser chiede la scheda). */
async function videoReplay(app, r) {
  // getDisplayMedia va chiamato subito dopo il clic.
  let cap;
  try {
    cap = await startVideo(app.root);
  } catch (e) {
    const text = videoErrorText(e);
    if (text) openModal({ title: "Video recording", body: [h("p", text)], actions: [{ label: "Close", value: null, primary: true }] });
    return;
  }
  watchReplay(app, r, { onExit: () => showReplays(app), video: cap });
}

// ---------------------------------------------------------------- visore

/** Apre il visore del replay. video: registrazione già avviata (si gioca tutto da capo e si chiude da sola). */
export function watchReplay(app, r, { onExit, video = null } = {}) {
  app.current?.destroy?.();
  const player = new ReplayPlayer(r, { onExit: () => { app.current = null; onExit?.(); }, video });
  app.current = player;
  player.start(clear(app.root));
  return player;
}

const SPEEDS = [0.5, 1, 1.5, 2];

export class ReplayPlayer {
  constructor(rp, { onExit, video = null }) {
    this.rp = rp;
    this.onExit = onExit;
    this.video = video;
    this.pos = 0; // risposte già date al motore
    this.token = 0;
    this.busy = Promise.resolve();
    this.closed = false;
    this.playing = false;
    this.actions = []; // azioni (per andare avanti e indietro a passi): { seq, p, turn, phase, text }
    this.msgs = []; // msgs[i] = messaggi del core dopo i risposte (per rifare il registro saltando)
  }

  get track() {
    return this.rp.history;
  }

  async start(container) {
    const rp = this.rp;
    // Carte personalizzate dei mazzi: nel database prima della vista e del motore.
    if (rp.custom?.length) await useRemoteCards(rp.custom);
    this.view = new DuelView({
      me: rp.me,
      names: rp.names,
      reveal: false,
      separatePz: (BigInt(rp.duel.flags ?? 0) & DUEL.SEPARATE_PZONE) !== 0n,
      onChat: null,
      onLeave: () => this.leave(),
      // Sul telefono il registro coprirebbe il campo: si parte con il solo campo (il registro si apre dal menu).
      watch: settings.replayLeft === "none" || isMobile() ? "none" : "log",
    });
    this.view.el.classList.add("spectating", "replaying");
    this.view.floatBar.classList.add("spectating");
    this.view.startLP = rp.duel.lp;
    this.view.main.append(this.controls());
    container.append(this.view.el);
    this.engine = new EngineClient();
    try {
      this.view.setStatus("Starting engine...");
      await this.engine.call("init", { dataUrl: DATA_URL, archive: STANDALONE ? (await loadArchive()).bytes : null });
      if (this.closed) return;
      this.view.setStatus("Loading card scripts...");
      await this.scan();
      if (this.closed) return;
      this.view.setStatus("");
      this.view.lp = [rp.duel.lp, rp.duel.lp];
      if (this.video) return this.record();
      // Si parte dall'inizio, già in riproduzione.
      this.run(async (t) => {
        await this.goTo(0, t);
        await this.playTo(this.track.length, t);
      });
    } catch (e) {
      console.error(e);
      this.view.setStatus(`Error: ${e.message}`);
      this.video?.stop();
    }
  }

  /**
   * Prima passata, senza animazioni: le azioni del duello (per i passi avanti/indietro e la barra) e i messaggi
   * dopo ogni risposta (per rifare il registro quando si salta).
   */
  async scan() {
    const stats = new StatsRecorder(this.rp.me);
    let res = await this.engine.call("start", this.rp.duel);
    this.msgs = [res.messages];
    stats.messages(res.messages, 0, res.snapshot);
    for (let i = 0; i < this.track.length; i++) {
      if (this.closed) return;
      if (!res.prompt || res.ended) {
        // Il duello è finito prima delle risposte salvate (dati delle carte cambiati?): si tiene fin qui.
        this.rp = { ...this.rp, history: this.track.slice(0, i) };
        toast("This replay was recorded with different card data: it may stop early", { kind: "error", ms: 6000 });
        break;
      }
      stats.response(i, res.prompt, this.track[i], res.snapshot);
      res = await this.engine.call("respond", { response: this.track[i] });
      this.msgs.push(res.messages);
      stats.messages(res.messages, i + 1, res.snapshot);
      if (i % 40 === 0) this.view.setStatus(`Preparing the replay... ${Math.round((i / this.track.length) * 100)}%`);
    }
    this.actions = stats.actions.map(({ seq, p, turn, phase, text }) => ({ seq, p, turn, phase, text }));
    this.slider.max = String(this.track.length);
  }

  /** Un comando alla volta: quello nuovo interrompe il precedente (alla fine dell'animazione in corso). */
  run(fn) {
    const t = ++this.token;
    this.playing = false;
    this.paint();
    this.busy = this.busy.then(() => (t === this.token && !this.closed ? fn(t) : null)).catch((e) => {
      console.error(e);
      this.view?.setStatus(`Error: ${e.message}`);
    });
    return this.busy;
  }

  /** Stato dopo n risposte, senza animazioni; il registro è rifatto fin lì. */
  async goTo(n, t) {
    n = Math.max(0, Math.min(n, this.track.length));
    const res = await this.engine.call("replay", { duel: this.rp.duel, responses: this.track.slice(0, n) });
    if (t !== this.token || this.closed) return;
    this.pos = n;
    this.res = res;
    this.view.prompter.abort();
    this.view.logRewind(null);
    Object.assign(this.view, { winLogged: false, chainLinks: [], resolving: null, lastChain: null });
    for (const list of this.msgs.slice(0, n + 1)) for (const m of list) this.view.logMessage(m);
    this.view.pendulumSummon = false;
    this.view.render(res.snapshot);
    this.view.syncChain(res.snapshot.chain ?? []);
    this.view.setStatus(res.ended ? "Duel over" : "");
    this.paint();
  }

  /** Una risposta in avanti, con le animazioni. */
  async step(t) {
    if (this.pos >= this.track.length) return false;
    const response = this.track[this.pos];
    const prompt = this.res?.prompt;
    // Evocazione Pendulum: le carte partono dalla mano (come nel duello vero).
    if (prompt?.type === MSG.SELECT_IDLECMD || prompt?.type === MSG.SELECT_BATTLECMD) this.view.pendulumSummon = false;
    if (prompt?.type === MSG.SELECT_IDLECMD && response?.action === IDLE.SPSUMMON && prompt.special_summons?.[response.index]?.location & LOC.SZONE) this.view.pendulumSummon = true;
    const res = await this.engine.call("respond", { response });
    if (t !== this.token || this.closed) return false;
    this.pos++;
    this.res = res;
    this.paint();
    await this.view.playMessages(res.messages);
    if (this.closed) return false;
    this.view.render(res.snapshot);
    if (res.ended) {
      this.view.setStatus("Duel over");
      return false;
    }
    // Ultima risposta salvata: com'è finito il duello (una resa o un'uscita non sono risposte al core).
    if (this.pos === this.track.length && this.rp.result) this.view.caption(this.rp.result, "done");
    return true;
  }

  async playTo(end, t) {
    this.playing = true;
    this.paint();
    while (t === this.token && this.pos < end && (await this.step(t)));
    if (t === this.token) {
      this.playing = false;
      this.paint();
    }
  }

  togglePlay() {
    if (this.playing) return this.run(() => null);
    this.run(async (t) => {
      if (this.pos >= this.track.length) await this.goTo(0, t);
      await this.playTo(this.track.length, t);
    });
  }

  /** Azione precedente / successiva: lo stato prima dell'azione, poi l'azione con le animazioni. */
  jumpAction(dir) {
    const a = dir < 0 ? this.actions.findLast((x) => x.seq < this.pos - 1) : this.actions.find((x) => x.seq >= this.pos);
    const from = a ? a.seq : dir < 0 ? 0 : this.track.length;
    const to = this.actions.find((x) => x.seq > from)?.seq ?? this.track.length;
    this.run(async (t) => {
      await this.goTo(from, t);
      if (a && t === this.token) await this.playTo(to, t);
    });
  }

  /** Inizio del turno precedente / successivo. */
  jumpTurn(dir) {
    const cur = this.actions.findLast((x) => x.seq < Math.max(1, this.pos))?.turn ?? 0;
    const target = dir < 0 ? this.actions.findLast((x) => x.turn < cur) : this.actions.find((x) => x.turn > cur);
    const turnStart = target ? this.actions.find((x) => x.turn === target.turn).seq : dir < 0 ? 0 : this.track.length;
    this.run((t) => this.goTo(turnStart, t));
  }

  // ---- barra dei comandi

  controls() {
    const btn = (name, title, fn) => h("button.btn.small.ghost", { title, onclick: fn }, icon(name));
    this.playBtn = h("button.btn.small.primary", { title: "Play / pause (space)", onclick: () => this.togglePlay() }, icon("play_arrow"));
    this.slider = h("input.replay-slider", {
      type: "range",
      min: 0,
      max: 0,
      value: 0,
      title: "Go to a moment of the Duel",
      oninput: () => (this.where.textContent = this.whereText(+this.slider.value)),
      onchange: () => {
        const n = +this.slider.value; // run() ridisegna la barra (e lo slider): il valore va letto prima
        this.run((t) => this.goTo(n, t));
      },
    });
    this.where = h("span.replay-where");
    const speed = h(
      "select.select.small.replay-speed",
      { title: "Animation speed", onchange: () => (settings.animSpeed = +speed.value) },
      SPEEDS.map((v) => h("option", { value: v, selected: Math.abs((settings.animSpeed ?? 1) - v) < 0.01 }, `${v}×`))
    );
    const left = h(
      "select.select.small",
      {
        title: "On the left",
        onchange: () => {
          settings.replayLeft = left.value;
          this.view.setWatch(left.value);
        },
      },
      [["log", "Log"], ["none", "Only the field"]].map(([v, l]) => h("option", { value: v, selected: (settings.replayLeft === "none" || isMobile() ? "none" : "log") === v }, l))
    );
    this.bar = h(
      "div.replay-bar",
      h("div.replay-row1",
        btn("first_page", "Start of the Duel", () => this.run((t) => this.goTo(0, t))),
        btn("keyboard_double_arrow_left", "Previous turn", () => this.jumpTurn(-1)),
        btn("chevron_left", "Previous action", () => this.jumpAction(-1)),
        this.playBtn,
        btn("chevron_right", "Next action", () => this.jumpAction(1)),
        btn("keyboard_double_arrow_right", "Next turn", () => this.jumpTurn(1)),
        btn("last_page", "End of the Duel", () => this.run((t) => this.goTo(this.track.length, t))),
        this.where
      ),
      this.slider,
      h("div.replay-row2",
        speed,
        left,
        h("button.btn.small", { title: "Copy the replay code", onclick: () => shareReplay(this.rp) }, icon("content_copy"), " Code"),
        canRecordVideo() ? h("button.btn.small", { title: "Record the whole replay as a video", onclick: () => this.videoFromHere() }, icon("videocam"), " Video") : null,
        fullscreenButton("btn.small.ghost"),
        h("button.btn.small", { onclick: () => this.leave() }, icon("logout"), " Exit")
      )
    );
    // Spazio = play/pausa, frecce = azione precedente/successiva.
    this.onKey = (e) => {
      if (e.target.closest?.("input, select, textarea") || this.recording) return;
      if (e.key === " ") {
        e.preventDefault();
        this.togglePlay();
      } else if (e.key === "ArrowRight") this.jumpAction(1);
      else if (e.key === "ArrowLeft") this.jumpAction(-1);
    };
    document.addEventListener("keydown", this.onKey);
    this.paint();
    return this.bar;
  }

  whereText(n) {
    const a = this.actions.findLast((x) => x.seq < Math.max(1, n));
    return `${a ? `Turn ${a.turn}` : "Start"} · ${n}/${this.track.length}`;
  }

  paint() {
    if (!this.bar) return;
    this.playBtn.replaceChildren(icon(this.playing ? "pause" : "play_arrow"));
    this.slider.value = String(this.pos);
    this.where.textContent = this.whereText(this.pos);
  }

  // ---- video

  /** Video dal visore: il browser chiede la scheda, poi si registra tutto il duello. */
  async videoFromHere() {
    try {
      this.video = await startVideo(this.view.el);
    } catch (e) {
      const text = videoErrorText(e);
      if (text) openModal({ title: "Video recording", body: [h("p", text)], actions: [{ label: "Close", value: null, primary: true }] });
      return;
    }
    this.record();
  }

  /** Registrazione: barra nascosta, dall'inizio alla fine del duello, poi qualche secondo sul risultato. */
  record() {
    const cap = this.video;
    this.recording = true;
    this.view.el.classList.add("recording");
    const stopBtn = h("button.btn.small.video-btn.rec.video-btn-float", { title: "Stop the recording" }, "■ Stop");
    this.view.main.append(stopBtn);
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      stopBtn.remove();
      this.recording = false;
      this.video = null;
      this.view?.el.classList.remove("recording");
      const { blob, ext } = await cap.stop();
      if (blob.size) showVideo(blob, ext, title(this.rp), "Replay video");
    };
    stopBtn.onclick = () => {
      this.run(() => null);
      finish();
    };
    cap.done.then(finish); // condivisione interrotta dal browser
    this.stopRecording = finish;
    this.run(async (t) => {
      await this.goTo(0, t);
      await new Promise((r) => setTimeout(r, 1200));
      if (t !== this.token) return;
      await this.playTo(this.track.length, t);
      if (t !== this.token) return;
      await new Promise((r) => setTimeout(r, 3500));
      finish();
    });
  }

  // ---- uscita

  leave() {
    this.destroy();
    this.onExit?.();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.token++;
    this.stopRecording?.();
    document.removeEventListener("keydown", this.onKey);
    this.engine?.terminate();
    this.view?.destroy();
  }
}
