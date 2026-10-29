// Coaching: guardare il duello di un amico e segnalarne gli errori; il report unito a fine partita.
//  - WatchSession: lo spettatore rigioca il duello trasmesso (net/spectate.js) nel proprio motore, con il campo visto
//    dall'amico; la scheda "Coach" elenca le sue azioni, ognuna si può segnalare (gravità, cosa era sbagliato, cosa
//    avrebbe dovuto fare). Le note vanno subito al giocatore, che le vede solo a partita finita.
//  - showReport: il report con le note di tutti gli spettatori unite (duel/coaching.js), da scaricare o copiare.
import { h, clear, icon, download } from "./dom.js";
import { openModal, toast, confirmModal } from "./modal.js";
import { cardFace, miniCards } from "./card.js";
import { DuelView } from "./duel/view.js";
import { DATA_URL, db, cardName } from "../data/db.js";
import { STANDALONE, loadArchive } from "../data/bundle.js";
import { EngineClient } from "../duel/engine-client.js";
import { DUEL, MSG, IDLE, LOC } from "../core/constants.js";
import { watchStream } from "../net/spectate.js";
import { sendWatch, presenceOf, onSocialChange, socialState } from "../net/social.js";
import { toHex } from "../net/identity.js";
import { copyText } from "../net/clipboard.js";
import { SEVERITIES, severityOf, describeAction, phaseShort, getReport, listReports, deleteReport, hasContent, onReportChange, severityCount, reportMarkdown } from "../duel/coaching.js";
import { ReviewSession, openPractice, statsSection, lessonsSection, logSection, mistakesSection, exportPdf } from "./coach-review.js";
import { gamesOf, gameSummary } from "../duel/coach-insights.js";
import { COACHING } from "../data/features.js";
import "../styles/coaching.css";

// Più risposte di così ancora da rigiocare: lo spettatore recupera senza animazioni.
const CATCH_UP = 2;
const FIND_MS = 25000;

const severityBadge = (id, { label = false } = {}) => {
  const s = severityOf(id);
  return h(`span.sev-badge.sev-${s.id}`, { title: `${s.label}: ${s.hint}` }, s.mark, label ? ` ${s.label}` : null);
};

/** Azione segnalata: miniature delle carte, testo e scelte fatte dentro l'azione. */
function actionBlock(action, { big = false } = {}) {
  if (!action) return h("div.coach-act.general", h("span.icon", { "aria-hidden": "true" }, "sticky_note_2"), h("span", "General note on this moment"));
  const thumbs = action.codes?.length ? h(`span.coach-thumbs${big ? ".big" : ""}`, action.codes.slice(0, 6).map((c) => h("span.coach-thumb", { title: cardName(c) }, cardFace(c)))) : null;
  return h("div.coach-act", thumbs, h("div.coach-act-text", h("div", action.text), (action.details ?? []).map((d) => h("div.coach-detail", d))));
}

// ---------------------------------------------------------------- finestra della segnalazione

/**
 * Nota su un'azione (o generale, action = null). note: quella già scritta (modifica).
 * canShow: duello finito, la giocata giusta si può mostrare sul campo ({ note, show: true }).
 * Restituisce { note } (salvata), { note, show: true }, { deleted: true } o null (annullata).
 */
function editNote({ player, action, where, note = null, canShow = false }) {
  let severity = note?.severity ?? "mistake";
  const sevBtns = SEVERITIES.map((s) =>
    h(`button.sev-choice.sev-${s.id}`, { type: "button", title: s.hint, onclick: () => { severity = s.id; paint(); } }, h("b", s.mark), h("span", s.label), h("small", s.hint)));
  const paint = () => sevBtns.forEach((b, i) => b.classList.toggle("on", SEVERITIES[i].id === severity));
  paint();
  const wrong = h("textarea.input.coach-text", { rows: 3, maxLength: 1000, placeholder: action ? "Why was this a mistake?" : "What happened?" });
  wrong.value = note?.wrong ?? "";
  const better = h("textarea.input.coach-text", { rows: 4, maxLength: 2000, placeholder: `The play ${player} should have made instead` });
  better.value = note?.better ?? "";
  const err = h("p.coach-error", { hidden: true });
  let line = note?.line ?? null;
  const lineEl = h("div.coach-line");
  const paintLine = () => {
    if (!action) return;
    clear(lineEl).append(
      line
        ? h("div.coach-line-saved", icon("check_circle"), ` Play shown on the field: ${line.steps.length || line.responses.length} step${(line.steps.length || line.responses.length) === 1 ? "" : "s"}`,
            canShow ? h("button.btn.small", { type: "button", onclick: () => m.close({ note: collect(), show: true }) }, "Record again") : null,
            h("button.btn.small.ghost", { type: "button", onclick: () => { line = null; paintLine(); } }, "Remove"))
        : canShow
          ? h("button.btn", { type: "button", onclick: () => m.close({ note: collect(), show: true }) }, icon("sports_esports"), ` Show the better play on the field`)
          : h("p.muted.small", `When the Duel is over you can also show the better play on the field, from this moment: ${player} watches it in the report.`)
    );
  };
  const collect = () => ({ severity, wrong: wrong.value.trim(), better: better.value.trim(), line });
  const m = openModal({
    title: note ? "Edit your note" : action ? "Report a mistake" : "General note",
    className: "coach-note",
    body: [
      h("div.coach-where", where),
      actionBlock(action, { big: true }),
      h("div.field", h("span", "How serious?"), h("div.sev-choices", sevBtns)),
      h("label.field", h("span", action ? "What went wrong (optional)" : "What went wrong"), wrong),
      h("label.field", h("span", `What should ${player} have done?`), better),
      lineEl,
      err,
      h("p.muted.small", `${player} sees your notes only after the Duel, in one report with the notes of the other friends watching.`),
    ],
    actions: [
      { label: "Cancel", value: null },
      ...(note ? [{ label: "Delete", danger: true, value: { deleted: true } }] : []),
      {
        label: "Save",
        primary: true,
        onClick: (close) => {
          if (!better.value.trim() && !line && !(wrong.value.trim() && !action)) {
            err.hidden = false;
            err.textContent = `Write what ${player} should have done${canShow ? ", or show it on the field" : ""}.`;
            return better.focus();
          }
          close({ note: collect() });
        },
      },
    ],
  });
  paintLine();
  setTimeout(() => (action ? better : wrong).focus(), 40);
  return m.result.then((v) => v ?? null);
}

// ---------------------------------------------------------------- spettatore

class WatchSession {
  /** friend: { pk, name }; info: { id, pk, key } dalla sua presenza. */
  constructor({ friend, info, onExit, onWatchNext }) {
    this.friend = friend;
    this.info = info;
    this.onExit = onExit;
    this.onWatchNext = onWatchNext;
    this.responses = [];
    this.applied = 0;
    this.actions = []; // azioni del giocatore: { seq, turn, phase, text, codes, details, el }
    this.notes = new Map(); // id → nota (per seq o generale)
    this.closed = false;
    this.wakeUp = null;
  }

  get player() {
    return this.cfg?.names[this.cfg.me] ?? this.friend.name;
  }

  start(container) {
    this.container = container;
    this.waitText = h("p", `Looking for ${this.friend.name}'s Duel on the Nostr relays…`);
    this.waitEl = h("div.watch-wait.card-box", h("h3", `Watching ${this.friend.name}`), this.waitText, h("span.spinner"),
      h("div.row", h("button.btn", { onclick: () => this.leave() }, "Back")));
    container.append(this.waitEl);
    this.stream = watchStream(this.info, {
      onConfig: (cfg) => this.begin(cfg).catch((e) => this.fail(e)),
      onResponses: (list) => {
        this.responses = list;
        this.wake();
      },
      onEnd: (end) => {
        this.end = end;
        this.wake();
      },
    });
    if (!this.stream.connected) return this.fail(new Error("Not connected to the Nostr relays: check your connection and try again."));
    this.findTimer = setTimeout(() => {
      if (!this.cfg) this.waitText.textContent = `${this.friend.name}'s Duel was not found yet. The relays may be slow, or the Duel is already over: keep waiting or go back.`;
    }, FIND_MS);
    sendWatch(this.friend.pk, { t: "watch-hello", id: this.info.id });
  }

  wake() {
    const w = this.wakeUp;
    this.wakeUp = null;
    w?.();
  }

  fail(e) {
    if (this.closed) return;
    console.error(e);
    if (this.waitEl?.isConnected) {
      this.waitText.textContent = e.message;
      this.waitEl.querySelector(".spinner")?.remove();
    } else toast(`Spectator: ${e.message}`, { kind: "error", ms: 7000 });
  }

  async begin(cfg) {
    if (this.closed || this.cfg) return;
    this.cfg = cfg;
    clearTimeout(this.findTimer);
    if (cfg.data !== (db.manifest?.version ?? "?")) toast(`${this.friend.name} has a different card data version: the Duel may look different here.`, { kind: "error", ms: 7000 });
    this.view = new DuelView({
      me: cfg.me,
      names: cfg.names,
      reveal: false,
      separatePz: (BigInt(cfg.duel.flags ?? 0) & DUEL.SEPARATE_PZONE) !== 0n,
      onChat: null,
      onLeave: () => this.leave(),
      // Coaching spento (data/features.js): si guarda e basta, la scheda resta fuori dalla schermata.
      sideTab: COACHING ? { id: "coach", label: "Coach", el: this.panel() } : (this.panel(), null),
    });
    // Chi guarda non risponde al core: niente comandi della catena né Auto-place (anche sopra le finestre).
    this.view.el.classList.add("spectating");
    this.view.floatBar.classList.add("spectating");
    this.view.startLP = cfg.duel.lp;
    this.waitEl.remove();
    this.container.append(this.view.el);
    this.engine = new EngineClient();
    this.view.setStatus("Starting engine...");
    await this.engine.call("init", { dataUrl: DATA_URL, archive: STANDALONE ? (await loadArchive()).bytes : null });
    if (this.closed) return;
    this.view.setStatus("Loading card scripts...");
    const res = await this.engine.call("start", cfg.duel);
    this.view.setStatus("");
    this.view.lp = [cfg.duel.lp, cfg.duel.lp];
    await this.loop(res);
  }

  async loop(res) {
    for (;;) {
      if (this.closed) return;
      this.view.instant = this.responses.length - this.applied > CATCH_UP;
      this.paintLive();
      for (const l of res.logs ?? []) console.warn("[script]", l.text);
      await this.view.playMessages(res.messages);
      if (this.closed) return;
      this.view.render(res.snapshot);
      if (res.ended) {
        const win = res.messages.find((m) => m.type === MSG.WIN);
        return this.finish({ winner: win?.player ?? res.snapshot.winner, reason: win?.reason });
      }
      const prompt = res.prompt;
      if (prompt.type === MSG.SELECT_IDLECMD || prompt.type === MSG.SELECT_BATTLECMD) this.view.pendulumSummon = false;
      // Si aspetta la risposta successiva (il giocatore ci sta pensando, o arriva dai relay).
      while (this.applied >= this.responses.length) {
        if (this.end && this.applied >= this.end.n) return this.finish(this.end);
        this.view.instant = false;
        this.paintLive();
        this.view.setStatus(`${this.cfg.names[prompt.player]} is choosing…`);
        await new Promise((r) => (this.wakeUp = r));
        if (this.closed) return;
      }
      this.view.setStatus("");
      const seq = this.applied++;
      const response = this.responses[seq];
      this.record(prompt, response, res.snapshot, seq);
      if (prompt.type === MSG.SELECT_IDLECMD && response?.action === IDLE.SPSUMMON && prompt.special_summons?.[response.index]?.location & LOC.SZONE) this.view.pendulumSummon = true;
      res = await this.engine.call("respond", { response });
    }
  }

  /** Risposta del giocatore guardato: azione nuova o scelta dentro l'ultima (bersagli, zona...). */
  record(prompt, response, snapshot, seq) {
    if (prompt.player !== this.cfg.me) return;
    const d = describeAction(prompt, response, this.cfg.me);
    if (!d) return;
    const last = this.actions.at(-1);
    if (!d.main && last && last.turn === snapshot.turn) {
      if (last.details.length < 12) last.details.push(d.text);
      last.codes = [...new Set([...last.codes, ...d.codes])].slice(0, 12);
      return this.paintAction(last);
    }
    const a = { seq, turn: snapshot.turn, phase: phaseShort(snapshot.phase), text: d.text, codes: d.codes, details: [] };
    this.actions.push(a);
    this.paintAction(a);
  }

  // ---- scheda "Coach"

  panel() {
    this.liveEl = h("span.watch-live");
    this.listEl = h("div.coach-actions");
    this.countEl = h("div.coach-count.muted.small");
    this.generalEl = h("div.coach-general");
    this.panelEl = h(
      "div.coach-panel",
      h("div.coach-head", h("b", `Watching ${this.player}`), this.liveEl),
      h("p.muted.small", `Click one of ${this.player}'s actions to report a mistake. ${this.player} sees the notes only after the Duel.`),
      h("button.btn.small", { onclick: () => this.addGeneral() }, icon("note_add"), " General note on this moment"),
      this.generalEl,
      this.listEl,
      this.countEl
    );
    this.paintCount();
    return this.panelEl;
  }

  paintLive() {
    if (!this.liveEl) return;
    const over = this.over;
    const catching = !over && this.view?.instant;
    this.liveEl.textContent = over ? "Duel over" : catching ? `Catching up… ${this.applied}/${this.responses.length}` : "● Live";
    this.liveEl.className = `watch-live${over ? " over" : catching ? " catching" : " on"}`;
  }

  paintAction(a) {
    const note = [...this.notes.values()].find((n) => n.seq === a.seq);
    const row = h(`button.coach-row${note ? `.flagged.sev-${note.severity}` : ""}`, {
      title: note ? "Edit your note" : "Report this action as a mistake",
      onclick: () => this.noteOn(a),
    },
    h("span.coach-when", `T${a.turn} ${a.phase}`),
    miniCards(a.codes.slice(0, 3)),
    h("span.coach-row-text", a.text, a.details.length ? h("small", a.details.join(" · ")) : null),
    note ? severityBadge(note.severity) : h("span.coach-flag", icon("flag")));
    const stick = this.listEl.scrollTop + this.listEl.clientHeight >= this.listEl.scrollHeight - 30;
    if (a.el?.isConnected) a.el.replaceWith(row);
    else this.listEl.append(row);
    a.el = row;
    if (stick) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  paintGeneral() {
    const general = [...this.notes.values()].filter((n) => n.seq == null);
    clear(this.generalEl).append(...general.map((n) =>
      h(`button.coach-row.flagged.sev-${n.severity}`, { title: "Edit your note", onclick: () => this.editGeneral(n) },
        h("span.coach-when", `T${n.turn} ${n.phase}`), h("span.coach-row-text", n.wrong || n.better), severityBadge(n.severity))));
  }

  paintCount() {
    const n = this.notes.size;
    this.countEl.textContent = n ? `${n} note${n === 1 ? "" : "s"} sent to ${this.player}` : "No notes yet";
  }

  where(turn, phase) {
    const game = this.cfg.match ? `Game ${this.cfg.match.game} · ` : "";
    return `${game}Turn ${turn}${phase ? ` · ${phase}` : ""}`;
  }

  async noteOn(a) {
    const old = [...this.notes.values()].find((n) => n.seq === a.seq);
    const action = { text: a.text, codes: a.codes, details: a.details };
    const r = await editNote({ player: this.player, action, where: this.where(a.turn, a.phase), note: old, canShow: !!this.over });
    if (!r || this.closed) return;
    if (r.deleted) return (this.remove(old), this.paintAction(a));
    const note = { ...(old ?? { id: toHex(crypto.getRandomValues(new Uint8Array(6))) }), seq: a.seq, turn: a.turn, phase: a.phase, action, ...r.note };
    if (!r.show) {
      this.save(note);
      return this.paintAction(a);
    }
    // A duello finito: la giocata giusta sul campo, dallo stesso momento (il giocatore contro la CPU).
    if (note.better || note.wrong || note.line) this.save(note);
    openPractice({
      root: this.container,
      hide: [this.view.el, this.view.floatBar],
      duel: this.cfg.duel,
      me: this.cfg.me,
      names: this.cfg.names,
      prefix: this.responses.slice(0, a.seq),
      title: `Show the better play · Turn ${a.turn}`,
      hint: `Play ${this.player}'s cards the way they should have been played; the CPU answers for the opponent. Then save: ${this.player} watches it on the field in the report.`,
      notes: note.better || note.wrong ? [{ ...note, name: "Your note" }] : [],
      record: true,
      onDone: (line) => {
        if (line && !this.closed) {
          this.save({ ...note, line });
          toast(`Play saved and sent to ${this.player}`);
        }
        this.paintAction(a);
      },
    });
  }

  async addGeneral() {
    const snap = this.view?.board.snapshot;
    const turn = snap?.turn ?? 0;
    const phase = phaseShort(snap?.phase ?? 0);
    const r = await editNote({ player: this.player, action: null, where: this.where(turn, phase) });
    if (!r?.note || this.closed) return;
    this.save({ id: toHex(crypto.getRandomValues(new Uint8Array(6))), seq: null, turn, phase, action: null, ...r.note });
    this.paintGeneral();
  }

  async editGeneral(n) {
    const r = await editNote({ player: this.player, action: null, where: this.where(n.turn, n.phase), note: n });
    if (!r || this.closed) return;
    if (r.deleted) this.remove(n);
    else this.save({ ...n, ...r.note });
    this.paintGeneral();
  }

  /** La nota va subito al giocatore (cifrata, solo lui la legge). */
  async save(note) {
    note.at = Date.now();
    this.notes.set(note.id, note);
    this.paintCount();
    const { id, seq, turn, phase, action, severity, wrong, better, line, at } = note;
    const n = await sendWatch(this.friend.pk, { t: "watch-note", id: this.info.id, note: { id, seq, turn, phase, action, severity, wrong, better, line: line ?? null, at } });
    if (!n) toast("The note was not sent: the Nostr relays did not answer. Open it and save it again.", { kind: "error", ms: 6000 });
  }

  remove(note) {
    if (!note) return;
    this.notes.delete(note.id);
    this.paintCount();
    sendWatch(this.friend.pk, { t: "watch-note", id: this.info.id, deleted: true, note: { id: note.id } });
  }

  // ---- fine

  finish({ winner, reason, sub }) {
    if (this.over) return;
    this.over = true;
    this.view.instant = false;
    this.paintLive();
    this.view.setStatus("Duel over");
    const draw = !(winner === 0 || winner === 1);
    this.view.showResult({ winner, reason, text: draw ? "DRAW" : `${this.cfg.names[winner]} wins`, sub });
    const n = this.notes.size;
    const next = h("button.btn.primary", { hidden: true, onclick: () => this.onWatchNext?.(this.nextInfo) }, icon("visibility"), " Watch the next Duel");
    const panel = h(
      "div.rematch-panel",
      COACHING && h("div.rematch-status", n ? `Your ${n} note${n === 1 ? " was" : "s were"} sent to ${this.player}: the report opens for them when the match is over.` : `You can still add notes from the Coach tab: ${this.player} gets them in the report.`,
        h("br"), `Now you can also show the better plays on the field: open an action in the Coach tab → "Show the better play on the field".`),
      h("div.rematch-actions", h("button.btn", { onclick: () => this.leave() }, "Leave"), next)
    );
    this.view.overlay.append(panel);
    // Rivincita o duello successivo della partita: si può continuare a guardare.
    const check = () => {
      const f = socialState().friends.find((x) => x.pk === this.friend.pk);
      const w = f ? presenceOf(f).watch : null;
      this.nextInfo = w && w.id !== this.info.id ? w : null;
      next.hidden = !this.nextInfo;
    };
    this.offSocial = onSocialChange(check);
    check();
  }

  leave() {
    this.destroy();
    this.onExit?.();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.findTimer);
    this.offSocial?.();
    this.stream?.close();
    this.wake();
    sendWatch(this.friend.pk, { t: "watch-bye", id: this.info.id });
    this.view?.destroy();
    this.waitEl?.remove();
    this.engine?.terminate();
  }
}

/** Guarda il duello di un amico (dalla lista amici: presenza "In a Duel" con le chiavi del duello). */
export function watchFriend(app, friend, info = presenceOf(friend).watch) {
  if (!info) return toast(`${friend.name} is not in a Duel you can watch`, { kind: "error" });
  app.onLeave?.();
  app.onLeave = null;
  app.current?.destroy?.();
  const root = clear(app.root);
  const session = new WatchSession({
    friend,
    info,
    onExit: () => app.home(),
    onWatchNext: (next) => watchFriend(app, friend, next),
  });
  app.current = session;
  session.start(root);
}

// ---------------------------------------------------------------- report

/** Pulsante del report sul risultato del duello: compare quando qualcuno ha guardato o ha scritto note. */
export function coachResultButton(id) {
  const btn = h("button.btn.coach-result", { onclick: () => showReport(getReport(id)) });
  const paint = () => {
    const r = getReport(id);
    btn.hidden = !hasContent(r);
    if (!r) return;
    const n = r.notes.length;
    btn.replaceChildren(icon("rate_review"), ` Coaching report · ${n ? `${n} note${n === 1 ? "" : "s"}` : "no notes yet"} from ${r.watchers.map((w) => w.name).join(", ")}`);
  };
  paint();
  // Note in ritardo (lo spettatore finisce di scrivere): il pulsante si aggiorna.
  const off = onReportChange((r) => (btn.isConnected || !r ? r?.id === id && paint() : off()));
  return btn;
}

// L'app (per aprire il duello rigiocato a tutto schermo) e la pagina a cui tornare dopo (vedi initCoaching).
let coachApp = null;
let backToReports = null;

/** Da main.js: app e ritorno alla pagina dei report (Online → Friends & Ranking). */
export function initCoaching(app, back) {
  coachApp = app;
  backToReports = back;
}

/** Il duello del report sul campo, dal momento seq (note: guarda la giocata mostrata da quello spettatore). */
function openReview(r, gameNo, seq, note = null, tab = "mistakes", practice = false) {
  const game = r.games.find((g) => g.game === gameNo);
  if (!game?.replay || !coachApp) return toast("This Duel cannot be replayed (it was played with an older version)", { kind: "error" });
  const app = coachApp;
  app.onLeave?.();
  app.onLeave = null;
  app.current?.destroy?.();
  const root = clear(app.root);
  const session = new ReviewSession({
    report: r,
    game,
    at: seq,
    note,
    onExit: () => {
      app.current = null;
      backToReports?.();
      showReport(getReport(r.id) ?? r, tab);
    },
  });
  app.current = session;
  session.start(root).then(() => practice && !session.closed && session.practice());
}

const REPORT_TABS = [
  ["lessons", "Lessons", "school"],
  ["mistakes", "Mistakes", "flag"],
  ["stats", "Statistics", "monitoring"],
  ["log", "Duel log", "list"],
];

/** Il report unito di una partita (solo a partita finita): note, statistiche, lezioni, registro del duello. */
export function showReport(r, tab = "lessons") {
  if (!r) return;
  if (!r.over) return toast("The report opens when the match is over", { kind: "error" });
  const head = h("div.report-head");
  const tabsEl = h("div.report-tabs", { role: "tablist" });
  const body = h("div.coach-report");
  let m = null;
  // Dal report al campo: la finestra si chiude, il duello rigiocato si apre a tutto schermo.
  const go = (practice) => (game, seq, note) => {
    m?.close(true);
    openReview(r, game, seq, note, tab, practice);
  };
  const opts = { onSee: go(false), onTry: go(true) };
  const paint = () => {
    const count = severityCount(r);
    const acc = gamesOf(r).map(gameSummary).filter((x) => x.accuracy != null);
    clear(head).append(
      h("div", h("b", `${r.names[0]} vs ${r.names[1]}`), h("span.muted", ` · ${r.mode} · ${new Date(r.at).toLocaleString("en-GB")}`)),
      h("div.muted.small", [...r.games].sort((a, b) => a.game - b.game).map((g) => `${r.games.length > 1 ? `Game ${g.game}: ` : ""}${g.result ?? "—"}`).join(" · ")),
      h("div.muted.small", `Watched by ${r.watchers.map((w) => w.name).join(", ") || "nobody"}`),
      h("div.report-sum",
        SEVERITIES.map((sv) => h(`span.sev-count.sev-${sv.id}`, h("b", count[sv.id]), ` ${sv.label}${count[sv.id] === 1 ? "" : "s"}`)),
        acc.length ? h("span.report-acc", { title: "Actions not flagged by the coaches" }, "Accuracy ", h("b", `${Math.round((acc.reduce((t, x) => t + x.accuracy, 0) / acc.length) * 100)}%`)) : null));
    clear(tabsEl).append(...REPORT_TABS.map(([id, label, ic]) => h(`button.report-tab${id === tab ? ".on" : ""}`, { role: "tab", onclick: () => ((tab = id), paint()) }, icon(ic), ` ${label}`)));
    const section = tab === "stats" ? statsSection(r, opts) : tab === "log" ? logSection(r, opts) : tab === "mistakes" ? mistakesSection(r, opts) : lessonsSection(r, opts);
    clear(body).append(...section);
  };
  paint();
  const off = onReportChange((x) => (x?.id === r.id ? paint() : null));
  const file = `coaching-${r.names[0]}-vs-${r.names[1]}-${new Date(r.at).toISOString().slice(0, 10)}.md`.replace(/[^\w.-]+/g, "_");
  m = openModal({
    title: "Coaching report",
    className: "wide coach-report-modal",
    body: [head, tabsEl, body],
    actions: [
      { label: "Export PDF", onClick: () => exportPdf(r).catch((e) => toast(`PDF export failed: ${e.message}`, { kind: "error" })) },
      { label: "Copy text", onClick: () => copyText(reportMarkdown(r)).then((ok) => toast(ok ? "Report copied" : "Copy failed")) },
      { label: "Download .md", onClick: () => download(file, reportMarkdown(r), "text/markdown") },
      { label: "Close", primary: true, value: true },
    ],
  });
  m.result.then(off);
}

/** Elenco dei report (pagina Online → Friends & Ranking). */
export function reportsBox() {
  const box = h("div.card-box.coach-reports");
  const paint = () => {
    const list = listReports();
    clear(box).append(
      h("h3", `Coaching reports (${list.length})`),
      list.length
        ? h("ul.friend-list", list.map((r) => {
            const c = severityCount(r);
            return h("li.friend-row",
              h("span.icon", { "aria-hidden": "true" }, "rate_review"),
              h("div.friend-info", h("b", `vs ${r.names[1]}`), h("span.muted.small", ` ${r.mode} · ${new Date(r.at).toLocaleDateString("en-GB")} · ${r.watchers.map((w) => w.name).join(", ")}`)),
              h("span.report-mini", SEVERITIES.map((s) => (c[s.id] ? h(`span.sev-badge.sev-${s.id}`, { title: s.label }, `${c[s.id]}${s.mark}`) : null))),
              h("button.btn.small.primary", { onclick: () => showReport(r) }, "Open"),
              h("button.btn.small.ghost", { title: "Delete", onclick: async () => { if (await confirmModal("Delete report", "Delete this coaching report?", "Delete", "Cancel", { danger: true })) deleteReport(r.id); } }, icon("delete")));
          }))
        : h("p.muted.small", "When friends watch your Duels (Vs CPU or online) they can report your mistakes: their notes are merged into one report here, after the Duel. To watch a friend, press Watch next to them while they are in a Duel.")
    );
  };
  paint();
  const off = onReportChange(() => (box.isConnected ? paint() : off()));
  return box;
}
