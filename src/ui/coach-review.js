// Report del coaching, la parte per imparare (a partita finita):
//  - ReviewSession: il duello rigiocato sul campo dal report (deterministico: mazzi, seed e risposte), azione per
//    azione, con le note degli spettatori; le giocate mostrate da loro si guardano sul campo dallo stesso momento.
//  - openPractice: giocata di prova da un momento del duello (il giocatore contro la CPU); lo spettatore la usa per
//    mostrare la giocata giusta, il giocatore per provarla.
//  - statistiche, grafici, osservazioni e registro del duello (schede del report) e il report in PDF.
import { h, clear, icon } from "./dom.js";
import { toast } from "./modal.js";
import { cardFace } from "./card.js";
import { DuelView } from "./duel/view.js";
import { DATA_URL, cardName } from "../data/db.js";
import { imageUrl } from "../data/settings.js";
import { STANDALONE, loadArchive } from "../data/bundle.js";
import { EngineClient } from "../duel/engine-client.js";
import { DuelSession } from "../duel/session.js";
import { DUEL, MSG, IDLE, LOC } from "../core/constants.js";
import { SEVERITIES, severityOf, severityCount, mergedReport } from "../duel/coaching.js";
import { gamesOf, gameSummary, mistakeBreakdown, lessons, observations, STAT_ROWS, statValue, secs, duration, phaseName } from "../duel/coach-insights.js";

// ---------------------------------------------------------------- miniature

/** Miniatura di una carta: a schermo la carta del client, nel PDF l'immagine. */
const screenThumb = (code) => h("span.coach-thumb", { title: cardName(code) }, cardFace(code));
const printThumb = (code) => h("img.thumb", { src: imageUrl(code), alt: cardName(code) });
const thumbs = (codes, thumb, max = 6) => (codes?.length ? h("span.coach-thumbs", codes.slice(0, max).map(thumb)) : null);

const severityBadge = (id, label = false) => {
  const s = severityOf(id);
  return h(`span.sev-badge.sev-${s.id}`, { title: `${s.label}: ${s.hint}` }, s.mark, label ? ` ${s.label}` : null);
};

// ---------------------------------------------------------------- giocata di prova

/**
 * Duello di prova dal momento `prefix` (risposte già date): il giocatore `me` contro la CPU.
 * hide: elementi da nascondere finché dura (la schermata di prima, che resta viva sotto).
 * record = la giocata si salva ("Save this play") e torna a onDone(line); altrimenti onDone(null).
 */
export function openPractice({ root, hide = [], duel, me, names, prefix, title, hint, notes = [], record = false, onDone }) {
  hide.forEach((e) => (e.hidden = true));
  let session = null;
  const stepsEl = h("div.practice-steps");
  const paintSteps = () => {
    const steps = session?.stats?.steps(prefix.length) ?? [];
    clear(stepsEl).append(steps.length
      ? h("ol.practice-list", steps.map((s) => h(`li.p${s.p === me ? "me" : "opp"}`, thumbs(s.codes, screenThumb, 3), h("span", s.p === me ? "" : `${names[s.p]}: `, s.text))))
      : h("p.muted.small", record ? "Play the right line on the field: your actions appear here." : "Your actions appear here."));
  };
  const done = (line) => {
    session?.destroy();
    session = null;
    hide.forEach((e) => (e.hidden = false));
    onDone?.(line);
  };
  const save = () => {
    const responses = session.history.slice(prefix.length);
    if (!responses.length) return toast("Play at least one action first", { kind: "error" });
    if (responses.length > 300 || JSON.stringify(responses).length > 15000) return toast("This play is too long to send: show a shorter line", { kind: "error", ms: 5000 });
    done({ from: prefix.length, responses, steps: session.stats.steps(prefix.length) });
  };
  const launch = () => {
    session = new DuelSession({
      controllers: me === 0 ? ["local", "ai"] : ["ai", "local"],
      me,
      names,
      reveal: false,
      duel,
      prefix,
      practice: true,
      sideTab: { id: "practice", label: record ? "Your play" : "Practice", el: panel },
      onStats: paintSteps,
      onExit: () => done(null),
    });
    paintSteps();
    session.start(root);
  };
  const panel = h(
    "div.coach-panel.practice-panel",
    h("b", title),
    hint ? h("p.muted.small", hint) : null,
    notes.length ? h("div.practice-notes", notes.map((n) => h("div.practice-note", severityBadge(n.severity), h("span", h("b", `${n.name}: `), n.better || n.wrong)))) : null,
    stepsEl,
    h(
      "div.practice-btns",
      record ? h("button.btn.primary", { onclick: save }, icon("save"), " Save this play") : null,
      h("button.btn", { onclick: () => (session.destroy(), launch()) }, icon("restart_alt"), " Restart"),
      h("button.btn", { onclick: () => done(null) }, record ? "Cancel" : "Close")
    )
  );
  launch();
}

// ---------------------------------------------------------------- duello rigiocato

/** Il duello di un report sul campo. game: duello del report (con replay); at: risposta da cui partire. */
export class ReviewSession {
  constructor({ report, game, at = 0, note = null, onExit }) {
    this.r = report;
    this.g = game;
    this.rp = game.replay;
    this.startAt = at;
    this.startNote = note;
    this.onExit = onExit;
    this.real = this.rp.history;
    this.realActions = this.rp.stats?.actions ?? [];
    this.notesBySeq = new Map();
    for (const n of report.notes) if (n.game === game.game && n.seq != null) this.notesBySeq.set(n.seq, [...(this.notesBySeq.get(n.seq) ?? []), n]);
    this.track = this.real;
    this.actions = this.realActions;
    this.branch = null; // nota di cui si guarda la giocata
    this.pos = 0;
    this.token = 0;
    this.busy = Promise.resolve();
    this.closed = false;
  }

  get me() {
    return this.rp.me;
  }

  async start(container) {
    this.container = container;
    this.view = new DuelView({
      me: this.me,
      names: this.rp.names,
      reveal: false,
      separatePz: (BigInt(this.rp.duel.flags ?? 0) & DUEL.SEPARATE_PZONE) !== 0n,
      onChat: null,
      onLeave: () => this.leave(),
      sideTab: { id: "review", label: "Review", el: this.panel() },
    });
    this.view.el.classList.add("spectating");
    this.view.floatBar.classList.add("spectating");
    this.view.startLP = this.rp.duel.lp;
    container.append(this.view.el);
    this.engine = new EngineClient();
    try {
      this.view.setStatus("Starting engine...");
      await this.engine.call("init", { dataUrl: DATA_URL, archive: STANDALONE ? (await loadArchive()).bytes : null });
      if (this.closed) return;
      this.view.setStatus("Loading card scripts...");
      await this.engine.call("start", this.rp.duel);
      this.view.setStatus("");
      this.view.lp = [this.rp.duel.lp, this.rp.duel.lp];
      if (this.startNote?.line) return this.watchLine(this.startNote);
      const a = this.actions.find((x) => x.seq === this.startAt);
      if (a) this.playAction(a);
      else this.run((t) => this.goTo(this.startAt, t));
    } catch (e) {
      console.error(e);
      this.view.setStatus(`Error: ${e.message}`);
    }
  }

  /** Un comando alla volta: quello nuovo interrompe il precedente (alla fine dell'animazione in corso). */
  run(fn) {
    const t = ++this.token;
    this.playing = false;
    this.paintControls();
    this.busy = this.busy.then(() => (t === this.token && !this.closed ? fn(t) : null)).catch((e) => {
      console.error(e);
      this.view?.setStatus(`Error: ${e.message}`);
    });
    return this.busy;
  }

  /** Stato dopo n risposte, senza animazioni. */
  async goTo(n, t) {
    n = Math.max(0, Math.min(n, this.track.length));
    const res = await this.engine.call("replay", { duel: this.rp.duel, responses: this.track.slice(0, n) });
    if (t !== this.token || this.closed) return;
    this.pos = n;
    this.res = res;
    this.view.logRewind(null);
    this.view.pendulumSummon = false;
    this.view.render(res.snapshot);
    this.view.syncChain(res.snapshot.chain ?? []);
    this.view.setStatus(res.ended ? "Duel over" : "");
    this.setFocus(this.actionAt(n) ?? this.actionBefore(n));
  }

  /** Una risposta in avanti, con le animazioni. */
  async step(t) {
    if (this.pos >= this.track.length) return false;
    const a = this.actionAt(this.pos);
    if (a) this.setFocus(a);
    const response = this.track[this.pos];
    const prompt = this.res?.prompt;
    if (prompt?.type === MSG.SELECT_IDLECMD || prompt?.type === MSG.SELECT_BATTLECMD) this.view.pendulumSummon = false;
    if (prompt?.type === MSG.SELECT_IDLECMD && response?.action === IDLE.SPSUMMON && prompt.special_summons?.[response.index]?.location & LOC.SZONE) this.view.pendulumSummon = true;
    const res = await this.engine.call("respond", { response });
    if (t !== this.token || this.closed) return false;
    this.pos++;
    this.res = res;
    await this.view.playMessages(res.messages);
    if (this.closed) return false;
    this.view.render(res.snapshot);
    if (res.ended) {
      this.view.setStatus("Duel over");
      return false;
    }
    return true;
  }

  async playTo(end, t) {
    this.playing = true;
    this.paintControls();
    while (t === this.token && this.pos < end && (await this.step(t)));
    if (t === this.token) {
      this.playing = false;
      this.paintControls();
    }
  }

  /** Lo stato prima dell'azione, poi l'azione con le animazioni. */
  playAction(a) {
    return this.run(async (t) => {
      await this.goTo(a.seq, t);
      this.setFocus(a);
      await new Promise((r) => setTimeout(r, 450));
      if (t === this.token) await this.playTo(this.boundaryAfter(a.seq), t);
    });
  }

  actionAt(seq) {
    return this.actions.find((a) => a.seq === seq) ?? null;
  }

  actionBefore(seq) {
    return this.actions.findLast((a) => a.seq < seq) ?? null;
  }

  /** Dove finisce l'azione che inizia (o è in corso) a seq: l'inizio di quella dopo. */
  boundaryAfter(seq) {
    return this.actions.find((a) => a.seq > seq)?.seq ?? this.track.length;
  }

  // ---- giocata mostrata da uno spettatore

  watchLine(note) {
    const line = note.line;
    if (line.from > this.real.length) return toast("This play does not match the Duel", { kind: "error" });
    this.branch = note;
    this.track = this.real.slice(0, line.from).concat(line.responses);
    this.actions = line.steps.map((s) => ({ ...s, seq: line.from + s.at, turn: null, phase: "" }));
    this.paintList();
    this.paintBranch();
    return this.run(async (t) => {
      await this.goTo(line.from, t);
      await new Promise((r) => setTimeout(r, 600));
      if (t === this.token) await this.playTo(this.track.length, t);
    });
  }

  backToDuel() {
    const from = this.branch?.line.from ?? this.pos;
    this.branch = null;
    this.track = this.real;
    this.actions = this.realActions;
    this.paintList();
    this.paintBranch();
    return this.run((t) => this.goTo(from, t));
  }

  // ---- prova dal momento attuale

  practice() {
    this.run(() => null);
    const n = this.pos;
    const snap = this.res?.snapshot;
    const notes = this.focus ? this.notesBySeq.get(this.focus.seq) ?? [] : [];
    openPractice({
      root: this.container,
      hide: [this.view.el, this.view.floatBar],
      duel: this.rp.duel,
      me: this.me,
      names: this.rp.names,
      prefix: this.track.slice(0, n),
      title: `Try it yourself · Turn ${snap?.turn ?? "?"}`,
      hint: `You play ${this.rp.names[this.me]} from this moment; the CPU plays the opponent${this.r.mode === "Online Duel" ? " (in the real Duel it was a person: its answers may differ)" : ""}.`,
      notes,
      onDone: () => this.run((t) => this.goTo(n, t)),
    });
  }

  // ---- scheda "Review"

  panel() {
    this.whereEl = h("div.review-where");
    this.branchEl = h("div.review-branch", { hidden: true });
    this.playBtn = h("button.btn.small", { title: "Play / pause", onclick: () => this.togglePlay() }, icon("play_arrow"));
    const ctl = (name, title, fn) => h("button.btn.small", { title, onclick: fn }, icon(name));
    this.notesEl = h("div.review-notes");
    this.listEl = h("div.coach-actions.review-list");
    this.paintList();
    return h(
      "div.coach-panel.review-panel",
      h("div.coach-head", h("b", `Replay${this.r.games.length > 1 ? ` · Game ${this.g.game}` : ""}`), this.whereEl),
      this.branchEl,
      h(
        "div.review-ctl",
        ctl("skip_previous", "Start of the Duel", () => this.run((t) => this.goTo(0, t))),
        ctl("chevron_left", "Previous action", () => {
          const a = this.actionBefore(this.focus && this.focus.seq < this.pos ? this.focus.seq : this.pos);
          if (a) this.playAction(a);
        }),
        this.playBtn,
        ctl("chevron_right", "Next action", () => {
          const a = this.actions.find((x) => x.seq >= this.pos);
          if (a) this.playAction(a);
        }),
        h("button.btn.small.primary", { title: "Play from this moment yourself, against the CPU", onclick: () => this.practice() }, icon("sports_esports"), " Try from here")
      ),
      this.notesEl,
      this.listEl,
      h("button.btn.small", { onclick: () => this.leave() }, icon("arrow_back"), " Back to the report")
    );
  }

  togglePlay() {
    if (this.playing) return this.run(() => null);
    this.run((t) => this.playTo(this.track.length, t));
  }

  paintControls() {
    if (!this.playBtn) return;
    this.playBtn.replaceChildren(icon(this.playing ? "pause" : "play_arrow"));
  }

  paintBranch() {
    const n = this.branch;
    this.branchEl.hidden = !n;
    if (!n) return;
    clear(this.branchEl).append(
      h("div", icon("lightbulb"), h("b", ` ${n.name}'s play`)),
      n.better ? h("p", n.better) : null,
      h("div.practice-btns",
        h("button.btn.small", { onclick: () => this.watchLine(n) }, icon("replay"), " Watch again"),
        h("button.btn.small", { onclick: () => this.backToDuel() }, icon("undo"), " Back to the real Duel"))
    );
  }

  paintList() {
    const flagged = (a) => (this.branch ? null : this.notesBySeq.get(a.seq));
    let turn = null;
    const rows = [];
    for (const a of this.actions) {
      if (a.turn != null && a.turn !== turn) rows.push(h("div.review-turn", `Turn ${(turn = a.turn)}`));
      const notes = flagged(a);
      const worst = notes ? [...notes].sort((x, y) => SEVERITIES.findIndex((s) => s.id === y.severity) - SEVERITIES.findIndex((s) => s.id === x.severity))[0] : null;
      a.el = h(`button.coach-row.${a.p === this.me ? "pme" : "popp"}${worst ? `.flagged.sev-${worst.severity}` : ""}`, { onclick: () => this.playAction(a) },
        h("span.coach-when", a.p === this.me ? (a.phase || "") : "Opp"),
        thumbs(a.codes, screenThumb, 3),
        h("span.coach-row-text", a.text, a.details?.length ? h("small", a.details.join(" · ")) : null),
        a.ms != null ? h("span.review-ms", secs(a.ms)) : null,
        worst ? severityBadge(worst.severity) : null);
      rows.push(a.el);
    }
    clear(this.listEl).append(...rows);
    this.setFocus(this.focus);
  }

  setFocus(a) {
    this.focus = a ?? null;
    for (const x of this.actions) x.el?.classList.toggle("current", x === a);
    a?.el?.scrollIntoView?.({ block: "nearest" });
    const snap = this.res?.snapshot;
    if (this.whereEl) this.whereEl.textContent = snap ? `Turn ${snap.turn} · ${phaseName(a?.phase || "")}` : "";
    if (!this.notesEl) return;
    const notes = a && !this.branch ? this.notesBySeq.get(a.seq) ?? [] : [];
    clear(this.notesEl).append(...notes.map((n) => h(`div.review-note.sev-${n.severity}`,
      h("div.report-note-head", severityBadge(n.severity, true), h("span.muted.small", ` by ${n.name}`)),
      n.wrong ? h("p", h("span.muted", "What went wrong: "), n.wrong) : null,
      n.better ? h("p.report-better", h("span.muted", "Better play: "), n.better) : null,
      n.line ? h("button.btn.small.primary", { onclick: () => this.watchLine(n) }, icon("play_circle"), ` Watch ${n.name}'s play`) : null)));
  }

  leave() {
    this.destroy();
    this.onExit?.();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.token++;
    this.view?.destroy();
    this.engine?.terminate();
  }
}

// ---------------------------------------------------------------- grafici (SVG)

const SVG = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const W = 900;
const H = 260;
const PAD = { l: 44, r: 130, t: 12, b: 26 };
const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p / 2) * 2 * p;
};

/** Contenitore del grafico: titolo, legenda (2 serie), svg e tooltip. */
function chartBox(title, series, svg, tip) {
  return h("figure.chart",
    h("figcaption", h("b", title), series.length > 1 ? h("span.chart-legend", series.map(([cls, label]) => h("span", h(`i.${cls}`), label))) : null),
    h("div.chart-plot", svg, tip));
}

function axes(maxY, ticks, xs) {
  const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / maxY);
  const g = s("g", { class: "axis" });
  for (let i = 0; i <= ticks; i++) {
    const v = (maxY / ticks) * i;
    g.append(s("line", { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), class: i ? "grid" : "base" }), s("text", { x: PAD.l - 6, y: y(v) + 4, "text-anchor": "end" }, v >= 1000 ? `${v / 1000}k` : Math.round(v)));
  }
  for (const [x, label] of xs) g.append(s("text", { x, y: H - 8, "text-anchor": "middle" }, label));
  return { g, y };
}

/** Tooltip al passaggio: colonne invisibili più larghe dei segni. */
function hoverColumns(svg, tip, cols) {
  const guide = s("line", { class: "guide", y1: PAD.t, y2: H - PAD.b, visibility: "hidden" });
  svg.append(guide);
  for (const c of cols) {
    const r = s("rect", { x: c.x - c.w / 2, y: PAD.t, width: c.w, height: H - PAD.t - PAD.b, class: "hit" });
    r.addEventListener("mouseenter", () => {
      guide.setAttribute("x1", c.x);
      guide.setAttribute("x2", c.x);
      guide.setAttribute("visibility", "visible");
      tip.replaceChildren(...c.lines.map((l, i) => h(i ? "div" : "b", l)));
      tip.hidden = false;
      tip.style.left = `${(c.x / W) * 100}%`;
    });
    r.addEventListener("mouseleave", () => {
      guide.setAttribute("visibility", "hidden");
      tip.hidden = true;
    });
    svg.append(r);
  }
}

/** Life Points alla fine di ogni turno, una linea per giocatore. */
export function lpChart(stats, names) {
  const me = stats.me;
  const pts = stats.lp;
  const maxY = niceMax(Math.max(...pts.flatMap((p) => [p[1], p[2]])));
  const n = Math.max(1, pts.length - 1);
  const x = (i) => PAD.l + ((W - PAD.l - PAD.r) * i) / n;
  const step = Math.ceil(pts.length / 12);
  const { g, y } = axes(maxY, 4, pts.filter((_, i) => i % step === 0).map((p, i) => [x(i * step), p[0] ? `T${p[0]}` : "Start"]));
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": "Life Points at the end of each turn" }, g);
  for (const [p, cls] of [[me, "you"], [1 - me, "opp"]]) {
    svg.append(s("polyline", { class: `line ${cls}`, points: pts.map((v, i) => `${x(i)},${y(v[p + 1])}`).join(" ") }));
    pts.forEach((v, i) => svg.append(s("circle", { class: `dot ${cls}`, cx: x(i), cy: y(v[p + 1]), r: 3.5 })));
    const last = pts.at(-1);
    svg.append(s("text", { class: "direct", x: x(pts.length - 1) + 8, y: y(last[p + 1]) + 4 }, `${names[p]} ${last[p + 1]}`));
  }
  const tip = h("div.chart-tip", { hidden: true });
  hoverColumns(svg, tip, pts.map((v, i) => ({ x: x(i), w: (W - PAD.l - PAD.r) / n, lines: [v[0] ? `Turn ${v[0]}` : "Start", `${names[me]}: ${v[me + 1]} LP`, `${names[1 - me]}: ${v[2 - me]} LP`] })));
  return chartBox("Life Points at the end of each turn", [["you", names[me]], ["opp", names[1 - me]]], svg, tip);
}

/** Barre per turno: una o due serie ([{ cls, label, values: Map(turno → valore) }]). */
export function turnBars(title, series, turns, fmt = (v) => String(v)) {
  const maxY = niceMax(Math.max(1, ...series.flatMap((se) => turns.map((t) => se.values.get(t) ?? 0))));
  const slot = (W - PAD.l - PAD.r) / Math.max(1, turns.length);
  const bw = Math.max(3, Math.min(18, (slot - 6) / series.length - 2));
  const cx = (i) => PAD.l + slot * (i + 0.5);
  const step = Math.ceil(turns.length / 14);
  const { g, y } = axes(maxY, 4, turns.filter((_, i) => i % step === 0).map((t, i) => [cx(i * step), `T${t}`]));
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": title }, g);
  turns.forEach((t, i) => series.forEach((se, k) => {
    const v = se.values.get(t) ?? 0;
    if (!v) return;
    const x0 = cx(i) - (series.length * (bw + 2)) / 2 + k * (bw + 2) + 1;
    const top = y(v);
    const hgt = y(0) - top;
    // Estremità arrotondata in alto, base piatta sull'asse.
    const rr = Math.min(4, bw / 2, hgt);
    svg.append(s("path", { class: `bar ${se.cls}`, d: `M${x0},${y(0)}V${top + rr}Q${x0},${top} ${x0 + rr},${top}H${x0 + bw - rr}Q${x0 + bw},${top} ${x0 + bw},${top + rr}V${y(0)}Z` }));
  }));
  const tip = h("div.chart-tip", { hidden: true });
  hoverColumns(svg, tip, turns.map((t, i) => ({ x: cx(i), w: slot, lines: [`Turn ${t}`, ...series.map((se) => `${se.label}: ${fmt(se.values.get(t) ?? 0)}`)] })));
  return chartBox(title, series.map((se) => [se.cls, se.label]), svg, tip);
}

/** Barre orizzontali con il valore scritto (errori per fase). */
function hBars(title, rows) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return h("figure.chart.hbars", h("figcaption", h("b", title)),
    h("div.hbar-list", rows.map(([label, v]) => h("div.hbar", h("span.hbar-label", label), h("span.hbar-track", h("i", { style: { width: `${(v / max) * 100}%` } })), h("span.hbar-v", v)))));
}

// ---------------------------------------------------------------- schede del report

/**
 * Statistiche di ogni duello. opts: { thumb, onSee(game, seq, note?) } (onSee = null nel PDF; game = numero del duello).
 */
export function statsSection(r, { thumb = screenThumb, onSee = null } = {}) {
  const out = [];
  for (const g of gamesOf(r)) {
    const sum = gameSummary(g);
    if (r.games.length > 1) out.push(h("h3.report-game", `Game ${g.game}`));
    if (!sum.stats) {
      out.push(h("p.muted", "No statistics for this Duel (it was played with an older version, or it was left before the end)."));
      continue;
    }
    const { stats, me } = sum;
    const names = g.replay.names;
    const turns = stats.turns.map((_, i) => i + 1);
    const tile = (label, value, sub) => h("div.stat-tile", h("span.stat-label", label), h("b", value), sub ? h("span.stat-sub", sub) : null);
    out.push(h("div.stat-tiles",
      tile("Result", (g.result ?? "—").split(" · ")[0], (g.result ?? "").split(" · ").slice(1).join(" · ") || null),
      tile("Turns", String(stats.turns.length), stats.turns.length ? `${names[stats.turns[0]]} went first` : null),
      tile("Duration", duration(stats.duration)),
      tile("Accuracy", sum.accuracy == null ? "—" : `${Math.round(sum.accuracy * 100)}%`, `${sum.mine.filter((a) => !sum.flagged.has(a.seq)).length} of ${sum.mine.length} actions not flagged`),
      tile("Think time", secs(sum.avgThink), "average per decision")));
    out.push(h("table.stat-table",
      h("thead", h("tr", h("th", ""), h("th", names[me]), h("th", names[1 - me]))),
      h("tbody", STAT_ROWS.map((row) => h("tr", h("td", row[0]), h("td", statValue(stats.per[me], row)), h("td", statValue(stats.per[1 - me], row)))))));
    out.push(lpChart(stats, names));
    const perTurn = (p, f) => {
      const m = new Map();
      for (const a of stats.actions) if (a.p === p) m.set(a.turn, (m.get(a.turn) ?? 0) + f(a));
      return m;
    };
    out.push(turnBars("Actions per turn", [{ cls: "you", label: names[me], values: perTurn(me, () => 1) }, { cls: "opp", label: names[1 - me], values: perTurn(1 - me, () => 1) }], turns));
    if (sum.avgThink != null) out.push(turnBars(`${names[me]}'s think time per turn`, [{ cls: "you", label: names[me], values: perTurn(me, (a) => (a.ms ?? 0) / 1000) }], turns, (v) => secs(v * 1000)));
    const slow = sum.mine.filter((a) => a.ms != null).sort((a, b) => b.ms - a.ms).slice(0, 5);
    if (slow.length) {
      out.push(h("h4.report-sub", "Longest decisions"), h("ol.slow-list", slow.map((a) => h("li",
        h("span.slow-ms", secs(a.ms)), thumbs(a.codes, thumb, 3), h("span", `Turn ${a.turn} · ${a.phase} · ${a.text}`),
        sum.flagged.has(a.seq) ? h("span.muted.small", " (flagged)") : null,
        onSee ? h("button.btn.small", { onclick: () => onSee(g.game, a.seq) }, icon("visibility"), " See") : null))));
    }
    out.push(h("h4.report-sub", "Cards used the most"), h("div.used-cards", [me, 1 - me].map((p) => h("div",
      h("div.muted.small", names[p]),
      stats.cards[p].length ? h("div.used-list", stats.cards[p].slice(0, 8).map(([c, n]) => h("span.used-card", thumb(c), h("b", `×${n}`)))) : h("span.muted.small", "—")))));
  }
  return out;
}

/** Osservazioni, giocate giuste da ricordare, errori per fase e per carta. */
export function lessonsSection(r, { thumb = screenThumb, onSee = null, onTry = null } = {}) {
  const obs = observations(r);
  const list = lessons(r);
  const b = mistakeBreakdown(r);
  const out = [h("h4.report-sub", "What the Duel says")];
  out.push(obs.length ? h("ul.obs-list", obs.map((o) => h("li", o))) : h("p.muted", "Not enough data for observations."));
  out.push(h("h4.report-sub", "Better plays to remember"));
  out.push(list.length
    ? h("ol.lesson-list", list.map((n) => h(`li.sev-${n.severity}`,
        h("div.report-note-head", severityBadge(n.severity, true), h("span.muted.small", ` ${r.games.length > 1 ? `Game ${n.game} · ` : ""}Turn ${n.turn}${n.phase ? ` · ${n.phase}` : ""} · by ${n.name}`)),
        n.action ? h("div.lesson-act", thumbs(n.action.codes, thumb, 4), h("span.muted", n.action.text)) : null,
        n.better ? h("p.report-better", n.better) : null,
        n.line ? lineSteps(n.line, thumb, meOf(r, n.game)) : null,
        onSee && n.seq != null && meOf(r, n.game) != null ? h("div.practice-btns",
          n.line ? h("button.btn.small.primary", { onclick: () => onSee(n.game, n.seq, n) }, icon("play_circle"), ` Watch ${n.name}'s play`) : null,
          h("button.btn.small", { onclick: () => onSee(n.game, n.seq) }, icon("visibility"), " See the moment"),
          onTry ? h("button.btn.small", { onclick: () => onTry(n.game, n.seq) }, icon("sports_esports"), " Try it yourself") : null) : null)))
    : h("p.muted", "No better plays were written."));
  if (r.notes.length) {
    out.push(hBars("Flagged moments by phase", b.phases.filter(([, v]) => v).map(([p, v]) => [phaseName(p), v])));
    if (b.cards.length) out.push(h("h4.report-sub", "Cards in the flagged actions"), h("div.used-list", b.cards.map(([c, n]) => h("span.used-card", thumb(c), h("b", `×${n}`)))));
  }
  return out;
}

/** La giocata mostrata dallo spettatore, come passi (me = indice del core del giocatore, per le risposte della CPU). */
function lineSteps(line, thumb, me) {
  if (!line.steps.length) return h("p.muted.small", `Play shown on the field (${line.responses.length} choices).`);
  return h("ol.line-steps", line.steps.map((st) => h("li", thumbs(st.codes, thumb, 3),
    h("span", me != null && st.p !== me ? h("span.muted", "Opponent: ") : null, st.text, st.details?.length ? h("small", ` (${st.details.join(" · ")})`) : null))));
}

const meOf = (r, game) => r.games.find((g) => g.game === game)?.replay?.me ?? null;

/** Tutte le azioni del duello, con le note dove ci sono. */
export function logSection(r, { thumb = screenThumb, onSee = null } = {}) {
  const out = [];
  for (const g of gamesOf(r)) {
    const sum = gameSummary(g);
    if (r.games.length > 1) out.push(h("h3.report-game", `Game ${g.game}`));
    if (!sum.stats) {
      out.push(h("p.muted", "No log for this Duel."));
      continue;
    }
    const notes = new Map();
    for (const n of g.notes) if (n.seq != null) notes.set(n.seq, [...(notes.get(n.seq) ?? []), n]);
    const general = g.notes.filter((n) => n.seq == null);
    let turn = null;
    const rows = [];
    const flushGeneral = (t) => {
      for (const n of general.filter((x) => x.turn === t)) rows.push(h(`div.log-note.sev-${n.severity}`, severityBadge(n.severity), h("span", h("b", `${n.name}: `), n.wrong || n.better)));
    };
    for (const a of sum.stats.actions) {
      if (a.turn !== turn) {
        if (turn != null) flushGeneral(turn);
        turn = a.turn;
        rows.push(h("div.review-turn", `Turn ${turn} · ${g.replay.names[sum.stats.turns[turn - 1]] ?? ""}`));
      }
      const ns = notes.get(a.seq) ?? [];
      rows.push(h(`div.log-row.${a.p === sum.me ? "pme" : "popp"}`,
        h("span.coach-when", a.phase),
        thumbs(a.codes, thumb, 3),
        h("span.coach-row-text", h("span", a.p === sum.me ? "" : h("span.muted", `${g.replay.names[a.p]}: `), a.text), a.details.length ? h("small", a.details.join(" · ")) : null),
        a.ms != null ? h("span.review-ms", secs(a.ms)) : null,
        ns.map((n) => severityBadge(n.severity)),
        onSee ? h("button.btn.small.ghost", { title: "See it on the field", onclick: () => onSee(g.game, a.seq) }, icon("visibility")) : null));
      for (const n of ns) rows.push(h(`div.log-note.sev-${n.severity}`, h("span", h("b", `${n.name}: `), [n.wrong, n.better && `Better: ${n.better}`].filter(Boolean).join(" — "))));
    }
    if (turn != null) flushGeneral(turn);
    out.push(h("div.log-list", rows));
  }
  return out;
}

/** Note unite per azione (scheda "Mistakes" e PDF). */
export function mistakesSection(r, { thumb = screenThumb, onSee = null, onTry = null } = {}) {
  const groups = mergedReport(r);
  let game = 0;
  if (!groups.length) return [h("p.muted", "No mistakes were reported.")];
  return groups.flatMap((g) => {
    const out = [];
    if (r.games.length > 1 && g.game !== game) out.push(h("h3.report-game", `Game ${(game = g.game)}`));
    const act = g.action
      ? h("div.coach-act", thumbs(g.action.codes, thumb), h("div.coach-act-text", h("div", g.action.text), (g.action.details ?? []).map((d) => h("div.coach-detail", d))))
      : h("div.coach-act.general", h("span", "General note on this moment"));
    const canSee = onSee && g.seq != null && r.games.find((x) => x.game === g.game)?.replay;
    out.push(h(`section.report-item.sev-${g.worst}`,
      h("div.report-when", `Turn ${g.turn}${g.phase ? ` · ${g.phase}` : ""}`),
      act,
      h("ul.report-notes", g.notes.map((n) => h("li",
        h("div.report-note-head", severityBadge(n.severity, true), h("span.muted.small", ` by ${n.name}`)),
        n.wrong ? h("p", h("span.muted", "What went wrong: "), n.wrong) : null,
        n.better ? h("p.report-better", h("span.muted", "Better play: "), n.better) : null,
        n.line ? lineSteps(n.line, thumb, meOf(r, g.game)) : null,
        canSee && n.line ? h("button.btn.small.primary", { onclick: () => onSee(g.game, g.seq, n) }, icon("play_circle"), ` Watch ${n.name}'s play on the field`) : null))),
      canSee ? h("div.practice-btns",
        h("button.btn.small", { onclick: () => onSee(g.game, g.seq) }, icon("visibility"), " See it on the field"),
        onTry ? h("button.btn.small", { onclick: () => onTry(g.game, g.seq) }, icon("sports_esports"), " Try the better play") : null) : null));
    return out;
  });
}

// ---------------------------------------------------------------- PDF

const PRINT_CSS = `
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
body { margin: 0; font: 10.5pt/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1a19; background: #fff;
  --you: #2a78d6; --opp: #eb6834; --muted: #5f5e58; --line: #d9d8d2; --panel: #f6f5f1; }
h1 { font-size: 18pt; margin: 0 0 4px; }
h2 { font-size: 13pt; margin: 18px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #1a1a19; break-after: avoid; }
h3, .report-game { font-size: 11.5pt; margin: 14px 0 6px; break-after: avoid; }
h4, .report-sub { font-size: 10.5pt; margin: 12px 0 6px; break-after: avoid; }
p { margin: 3px 0; }
.muted, .stat-sub, .stat-label { color: var(--muted); }
.small, small { font-size: 8.5pt; }
.meta { color: var(--muted); margin-bottom: 8px; }
.sev-inaccuracy { --sev: #b88a00; } .sev-mistake { --sev: #d2691e; } .sev-blunder { --sev: #c8102e; }
.sev-badge { display: inline-block; padding: 0 5px; font: 700 8.5pt ui-monospace, monospace; color: #fff; background: var(--sev); border-radius: 2px; }
.sev-count { display: inline-block; margin-right: 8px; padding: 1px 6px; border: 1px solid var(--sev); color: var(--sev); }
.thumb { width: 34px; height: auto; border-radius: 2px; vertical-align: middle; }
.coach-thumbs { display: inline-flex; gap: 2px; margin-right: 6px; vertical-align: middle; }
.coach-act { display: flex; gap: 8px; align-items: flex-start; }
.coach-detail::before { content: "↳ "; } .coach-detail { color: var(--muted); font-size: 9pt; }
.report-item { break-inside: avoid; border-left: 4px solid var(--sev); padding: 6px 10px; margin: 8px 0; background: var(--panel); }
.report-when { font: 600 8.5pt ui-monospace, monospace; color: var(--muted); text-transform: uppercase; }
.report-notes { list-style: none; padding: 0; margin: 6px 0 0; }
.report-notes li { margin-top: 6px; }
.report-better { color: #0b5394; }
.stat-tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin: 6px 0 10px; }
.stat-tile { border: 1px solid var(--line); padding: 6px; display: grid; }
.stat-tile b { font-size: 13pt; }
.stat-table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; break-inside: avoid; }
.stat-table th, .stat-table td { padding: 3px 6px; border-bottom: 1px solid var(--line); text-align: right; font-variant-numeric: tabular-nums; }
.stat-table th:first-child, .stat-table td:first-child { text-align: left; }
.chart { margin: 8px 0; break-inside: avoid; }
.chart figcaption { display: flex; justify-content: space-between; margin-bottom: 4px; }
.chart-legend span { margin-left: 10px; } .chart-legend i { display: inline-block; width: 10px; height: 3px; margin-right: 4px; vertical-align: middle; }
.chart-legend i.you { background: var(--you); } .chart-legend i.opp { background: var(--opp); }
.chart-svg { width: 100%; height: auto; }
.chart-tip, .hit, .guide { display: none; }
.axis text { font-size: 10px; fill: var(--muted); } .axis .grid { stroke: #ecebe6; } .axis .base { stroke: #9a998f; }
.line { fill: none; stroke-width: 2; } .line.you, .dot.you { stroke: var(--you); } .line.opp, .dot.opp { stroke: var(--opp); }
.dot { fill: #fff; stroke-width: 2; } .direct { font-size: 10px; fill: #1a1a19; }
.bar.you { fill: var(--you); } .bar.opp { fill: var(--opp); }
.hbar { display: grid; grid-template-columns: 110px 1fr 30px; gap: 6px; align-items: center; margin: 2px 0; }
.hbar-track i { display: block; height: 8px; background: var(--you); border-radius: 0 4px 4px 0; }
.slow-list, .obs-list, .lesson-list, .line-steps { margin: 4px 0; padding-left: 18px; }
.slow-list li, .lesson-list li, .obs-list li { margin: 4px 0; break-inside: avoid; }
.slow-ms { font-weight: 700; margin-right: 6px; }
.lesson-act { margin: 3px 0; }
.used-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.used-list { display: flex; flex-wrap: wrap; gap: 6px; }
.used-card { display: inline-flex; flex-direction: column; align-items: center; font-size: 8.5pt; }
.review-turn { margin-top: 8px; font-weight: 700; border-bottom: 1px solid var(--line); break-after: avoid; }
.log-row { display: flex; gap: 6px; align-items: center; padding: 2px 0; break-inside: avoid; }
.log-row.popp { color: var(--muted); }
.coach-when { width: 28px; flex: none; font: 600 8pt ui-monospace, monospace; color: var(--muted); }
.coach-row-text { flex: 1; display: flex; flex-direction: column; }
.review-ms { font-size: 8.5pt; color: var(--muted); }
.log-note { margin: 0 0 4px 34px; padding: 3px 6px; border-left: 3px solid var(--sev); background: var(--panel); font-size: 9pt; }
.btn { display: none; }
`;

/** Il report in PDF: un documento da stampare (finestra di stampa del browser → "Salva come PDF"). */
export async function exportPdf(r) {
  const opts = { thumb: printThumb };
  const count = severityCount(r);
  const doc = [
    h("h1", `Coaching report: ${r.names[0]} vs ${r.names[1]}`),
    h("div.meta", `${r.mode} · ${new Date(r.at).toLocaleString("en-GB")} · watched by ${r.watchers.map((w) => w.name).join(", ") || "nobody"}`),
    h("div", gamesOf(r).map((g) => h("div", `${r.games.length > 1 ? `Game ${g.game}: ` : "Result: "}${g.result ?? "—"}`))),
    h("p", SEVERITIES.map((sv) => h(`span.sev-count.sev-${sv.id}`, `${count[sv.id]} ${sv.label}${count[sv.id] === 1 ? "" : "s"}`))),
    h("h2", "Lessons"), ...lessonsSection(r, opts),
    h("h2", "Statistics"), ...statsSection(r, opts),
    h("h2", "Mistakes reported"), ...mistakesSection(r, opts),
    h("h2", "Duel log"), ...logSection(r, opts),
  ];
  const frame = h("iframe", { title: "Coaching report", style: { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" } });
  document.body.append(frame);
  const d = frame.contentDocument;
  d.open();
  d.write("<!doctype html><html><head><meta charset=\"utf-8\"><title></title></head><body></body></html>");
  d.close();
  d.title = `Coaching report - ${r.names[0]} vs ${r.names[1]}`;
  d.head.append(Object.assign(d.createElement("style"), { textContent: PRINT_CSS }));
  for (const el of doc) d.body.append(d.importNode(el, true));
  // Le immagini delle carte prima di stampare (al massimo qualche secondo).
  const imgs = [...d.images].filter((i) => !i.complete);
  await Promise.race([Promise.all(imgs.map((i) => new Promise((ok) => (i.onload = i.onerror = ok)))), new Promise((ok) => setTimeout(ok, 6000))]);
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 60000);
}
