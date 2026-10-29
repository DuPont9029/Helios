// Coaching: gli amici che guardano un duello (net/spectate.js) segnalano gli errori del giocatore, con la gravità
// e cosa avrebbe dovuto fare. Le segnalazioni di tutti gli spettatori finiscono in un solo report per partita
// (al meglio di N: un report per tutti i duelli), che il giocatore vede solo a partita finita.
// Qui: le azioni del giocatore come testo (dalle risposte al core), l'archivio dei report e il report unito.
import { cardName } from "../data/db.js";
import { MSG, IDLE, BATTLE, PHASE } from "../core/constants.js";
import { actionOf, stepText, detailOf, detailText, detailCodes } from "./trainer.js";
import { onWatchMessage } from "../net/social.js";

// ---------------------------------------------------------------- gravità

export const SEVERITIES = [
  { id: "inaccuracy", label: "Inaccuracy", mark: "?!", hint: "Not the best play, small cost" },
  { id: "mistake", label: "Mistake", mark: "?", hint: "A clear error that cost resources or tempo" },
  { id: "blunder", label: "Blunder", mark: "??", hint: "A serious error: it lost or could have lost the Duel" },
];
export const severityOf = (id) => SEVERITIES.find((s) => s.id === id) ?? SEVERITIES[1];

// ---------------------------------------------------------------- azioni del giocatore

const PHASE_SHORT = [[PHASE.DRAW, "DP"], [PHASE.STANDBY, "SP"], [PHASE.MAIN1, "M1"], [PHASE.MAIN2, "M2"], [PHASE.END, "EP"]];
/** "DP", "M1", "BP"... per una fase del core. */
export const phaseShort = (phase) => PHASE_SHORT.find(([p]) => p === phase)?.[1] ?? (phase ? "BP" : "");

const q = (code) => `"${cardName(code)}"`;
const nums = (codes) => [...new Set(codes.filter((c) => Number.isInteger(c) && c > 0))];

/**
 * Risposta del giocatore come testo per l'elenco delle azioni: { main, text, codes } (main = azione nuova, altrimenti
 * è una scelta dentro l'ultima azione: bersagli, zona, posizione...), null = niente da mostrare.
 */
export function describeAction(prompt, response, me) {
  if (!prompt || response == null) return null;
  const act = actionOf(prompt, response);
  if (act && act.kind !== "other") return { main: true, text: stepText(act), codes: nums([act.code]) };
  if (prompt.type === MSG.SELECT_IDLECMD) {
    if (response.action === IDLE.TO_BP) return { main: true, text: "Enter the Battle Phase", codes: [] };
    if (response.action === IDLE.REPOS) {
      const code = prompt.pos_changes?.[response.index]?.code ?? 0;
      return { main: true, text: `Change the battle position of ${q(code)}`, codes: nums([code]) };
    }
    if (response.action === IDLE.SHUFFLE) return { main: true, text: "Shuffle the hand", codes: [] };
  }
  if (prompt.type === MSG.SELECT_BATTLECMD) {
    if (response.action === BATTLE.ATTACK) {
      const code = prompt.attacks?.[response.index]?.code ?? 0;
      return { main: true, text: `Attack with ${q(code)}`, codes: nums([code]) };
    }
    if (response.action === BATTLE.TO_M2) return { main: true, text: "Go to Main Phase 2", codes: [] };
  }
  // Catena: non attivare quando si poteva è una scelta (es. la hand trap tenuta in mano).
  if (prompt.type === MSG.SELECT_CHAIN && response.index == null && prompt.selects?.length && !prompt.forced) {
    const codes = nums(prompt.selects.map((c) => c.code));
    return { main: true, text: `Did not activate (could activate ${codes.map(q).join(", ")})`, codes };
  }
  const d = detailOf(prompt, response, me);
  if (d) return { main: false, text: detailText(d), codes: nums(detailCodes(d)) };
  return null;
}

// ---------------------------------------------------------------- segnalazioni

const str = (v, max) => String(v ?? "").replace(/\r/g, "").slice(0, max);
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);

// Giocata mostrata dallo spettatore (a duello finito, sul campo): risposte al core dal momento segnalato.
const LINE_MAX = 300;
const LINE_JSON_MAX = 15000; // i messaggi tra amici restano piccoli (vedi social.js)

/** Giocata pulita: { from, responses, steps: [{ at (indice in responses), p, text, codes, details }] } o null. */
export function cleanLine(l) {
  if (!l || typeof l !== "object") return null;
  const from = int(l.from, 0, 1e6);
  const list = l.responses;
  if (from == null || !Array.isArray(list) || !list.length || list.length > LINE_MAX) return null;
  if (!list.every((r) => r && typeof r === "object" && !Array.isArray(r))) return null;
  if (JSON.stringify(list).length > LINE_JSON_MAX) return null;
  const steps = Array.isArray(l.steps) ? l.steps.slice(0, 60).filter((x) => x && typeof x === "object" && int(x.at, 0, list.length - 1) != null).map((x) => ({
    at: x.at,
    p: x.p === 1 ? 1 : 0,
    text: str(x.text, 300),
    codes: Array.isArray(x.codes) ? nums(x.codes).slice(0, 6) : [],
    details: Array.isArray(x.details) ? x.details.slice(0, 6).map((d) => str(d, 200)) : [],
  })) : [];
  return { from, responses: list, steps };
}

/**
 * Segnalazione pulita (arriva dalla rete): { id, game, seq, turn, phase, action: { text, codes, details }, severity,
 * wrong, better, line, at }. line = la giocata giusta mostrata sul campo (vedi cleanLine), o null. seq = indice della risposta dell'azione nel duello (uguale per tutti gli spettatori,
 * il duello è deterministico), null = nota generale sul momento (turn/phase).
 */
export function cleanNote(n) {
  if (!n || typeof n !== "object" || typeof n.id !== "string" || !/^[0-9a-z]{1,24}$/.test(n.id)) return null;
  const better = str(n.better, 2000).trim();
  const wrong = str(n.wrong, 1000).trim();
  const line = cleanLine(n.line);
  if (!better && !wrong && !line) return null;
  const a = n.action && typeof n.action === "object" ? n.action : null;
  return {
    id: n.id,
    game: int(n.game, 1, 99) ?? 1,
    seq: int(n.seq, 0, 1e6),
    turn: int(n.turn, 0, 999) ?? 0,
    phase: str(n.phase, 4),
    action: a ? {
      text: str(a.text, 300),
      codes: Array.isArray(a.codes) ? nums(a.codes).slice(0, 12) : [],
      details: Array.isArray(a.details) ? a.details.slice(0, 12).map((d) => str(d, 200)) : [],
    } : null,
    severity: severityOf(n.severity).id,
    wrong,
    better,
    line,
    at: Number.isFinite(n.at) ? n.at : Date.now(),
  };
}

// ---------------------------------------------------------------- archivio dei report

const KEY = "ygoweb.coaching";
const MAX_REPORTS = 60;
// Duelli da rigiocare (mazzi, seed, risposte, statistiche): pesano, si tengono solo nei report più recenti.
const MAX_REPLAYS = 20;
const DAY = 24 * 3600 * 1000;

/**
 * { reports: [{ id, at, names: [io, avversario], mode, games: [{ game, stream, result, replay }], over,
 *   watchers: [{ pk, name }], notes: [{ from, name, ...cleanNote }] }], streams: { idDuello: idReport } }
 */
function load() {
  let v = null;
  try {
    v = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch { /* storage non leggibile */ }
  return { reports: Array.isArray(v?.reports) ? v.reports : [], streams: v?.streams && typeof v.streams === "object" ? v.streams : {} };
}
let store = load();
// Duelli rimasti a metà (pagina chiusa durante il duello): il report si può leggere.
for (const r of store.reports) r.over = true;

function save() {
  // Senza spettatori né note un report serve solo per le note in ritardo: dopo un giorno si toglie.
  const keep = (r) => r.watchers.length || r.notes.length || Date.now() - r.at < DAY;
  store.reports = store.reports.filter(keep).slice(0, MAX_REPORTS);
  const ids = new Set(store.reports.map((r) => r.id));
  for (const [s, r] of Object.entries(store.streams)) if (!ids.has(r)) delete store.streams[s];
  store.reports.slice(MAX_REPLAYS).forEach(dropReplays);
  // Storage pieno: via i duelli da rigiocare, dal report più vecchio.
  for (let i = store.reports.length; i >= 0; i--) {
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
      return;
    } catch {
      if (i > 0) dropReplays(store.reports[i - 1]);
    }
  }
}

function dropReplays(r) {
  for (const g of r.games) delete g.replay;
}

const listeners = new Set();
/** fn(report, change) quando un report cambia (change: "watcher", "note", "end"...). */
export function onReportChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = (r, change, extra) => {
  save();
  for (const fn of listeners) {
    try {
      fn(r, change, extra);
    } catch (e) {
      console.error(e);
    }
  }
};

export const getReport = (id) => store.reports.find((r) => r.id === id) ?? null;
/** Report da mostrare nell'elenco: quelli finiti con almeno uno spettatore o una nota. */
export const listReports = () => store.reports.filter((r) => r.over && (r.watchers.length || r.notes.length));
export const hasContent = (r) => !!(r && (r.watchers.length || r.notes.length));

export function deleteReport(id) {
  store.reports = store.reports.filter((r) => r.id !== id);
  save();
  for (const fn of listeners) fn(null, "delete");
}

/** Inizio di un duello trasmesso: crea il report della partita (o aggiunge il duello a quello esistente). */
export function startReportGame({ report, stream, game = 1, names, mode }) {
  let r = getReport(report);
  if (!r) {
    r = { id: report, at: Date.now(), names, mode, games: [], over: false, watchers: [], notes: [] };
    store.reports.unshift(r);
  }
  r.over = false;
  r.games = r.games.filter((g) => g.game !== game);
  r.games.push({ game, stream, result: null });
  store.streams[stream] = report;
  changed(r, "start");
}

/**
 * Fine di un duello (result: testo, es. "Victory"); over = la partita è finita, il report si può leggere.
 * replay: { duel, me, names, history, stats } per rigiocare il duello dal report (vedi ui/coach-review.js).
 */
export function endReportGame(stream, result, over, replay = null) {
  const r = getReport(store.streams[stream]);
  if (!r) return;
  const g = r.games.find((x) => x.stream === stream);
  if (g) g.result = result;
  if (g && replay) g.replay = replay;
  if (over) r.over = true;
  changed(r, "end");
}

/** Partita lasciata a metà (es. "Leave" durante il side deck): il report diventa leggibile. */
export function closeReport(stream) {
  const r = getReport(store.streams[stream]);
  if (r && !r.over) {
    r.over = true;
    changed(r, "end");
  }
}

/** Messaggi degli spettatori: valgono solo per i duelli trasmessi da questo browser. */
onWatchMessage((m) => {
  const r = getReport(store.streams[m.id]);
  if (!r) return;
  const game = r.games.find((g) => g.stream === m.id)?.game ?? 1;
  if (m.t === "watch-hello" || m.t === "watch-bye") {
    const w = r.watchers.find((x) => x.pk === m.from);
    if (w) w.name = m.name;
    else r.watchers.push({ pk: m.from, name: m.name });
    return changed(r, m.t === "watch-hello" ? "watcher" : "watcher-left", { pk: m.from, name: m.name, at: m.at });
  }
  if (m.t !== "watch-note") return;
  // Nota tolta dallo spettatore.
  if (m.deleted === true && typeof m.note?.id === "string") {
    r.notes = r.notes.filter((n) => !(n.from === m.from && n.id === m.note.id));
    return changed(r, "note");
  }
  const note = cleanNote(m.note);
  if (!note) return;
  note.game = game;
  if (!r.watchers.some((w) => w.pk === m.from)) r.watchers.push({ pk: m.from, name: m.name });
  const old = r.notes.findIndex((n) => n.from === m.from && n.id === note.id);
  const entry = { from: m.from, name: m.name, ...note };
  if (old >= 0) r.notes[old] = entry;
  else if (r.notes.length < 500) r.notes.push(entry);
  changed(r, "note", entry);
});

// ---------------------------------------------------------------- report unito

/**
 * Le note di tutti gli spettatori, unite: un gruppo per azione segnalata (stessa azione = stesso seq, il duello è
 * uguale per tutti) e per momento delle note generali, in ordine di partita. Ogni gruppo: { game, seq, turn, phase,
 * action, notes, worst }.
 */
export function mergedReport(r) {
  const groups = new Map();
  for (const n of r.notes) {
    const k = n.seq != null ? `${n.game}:a${n.seq}` : `${n.game}:t${n.turn}:${n.phase}`;
    if (!groups.has(k)) groups.set(k, { game: n.game, seq: n.seq, turn: n.turn, phase: n.phase, action: n.action, notes: [] });
    groups.get(k).notes.push(n);
  }
  const rank = (s) => SEVERITIES.findIndex((x) => x.id === s);
  const list = [...groups.values()];
  for (const g of list) {
    g.notes.sort((a, b) => rank(b.severity) - rank(a.severity) || a.at - b.at);
    g.worst = g.notes[0].severity;
  }
  // Le note generali dopo le azioni dello stesso turno.
  return list.sort((a, b) => a.game - b.game || a.turn - b.turn || (a.seq ?? 1e9) - (b.seq ?? 1e9));
}

/** Quante note per gravità: { inaccuracy, mistake, blunder }. */
export function severityCount(r) {
  const out = Object.fromEntries(SEVERITIES.map((s) => [s.id, 0]));
  for (const n of r.notes) out[n.severity]++;
  return out;
}

/** Il report come Markdown (da scaricare o copiare). */
export function reportMarkdown(r) {
  const date = new Date(r.at).toLocaleString("en-GB");
  const count = severityCount(r);
  const lines = [
    `# Coaching report: ${r.names[0]} vs ${r.names[1]}`,
    "",
    `- ${r.mode} · ${date}`,
    ...[...r.games].sort((a, b) => a.game - b.game).map((g) => `- ${r.games.length > 1 ? `Game ${g.game}: ` : "Result: "}${g.result ?? "—"}`),
    `- Watched by: ${r.watchers.map((w) => w.name).join(", ") || "—"}`,
    `- ${SEVERITIES.map((s) => `${count[s.id]} ${s.label.toLowerCase()}${count[s.id] === 1 ? "" : "s"}`).join(", ")}`,
    "",
  ];
  let game = 0;
  for (const g of mergedReport(r)) {
    if (r.games.length > 1 && g.game !== game) {
      game = g.game;
      lines.push(`## Game ${game}`, "");
    }
    const where = `Turn ${g.turn}${g.phase ? ` · ${g.phase}` : ""}`;
    lines.push(`### ${where} · ${g.action ? g.action.text : "General note"}`);
    for (const d of g.action?.details ?? []) lines.push(`> ${d}`);
    lines.push("");
    for (const n of g.notes) {
      const s = severityOf(n.severity);
      lines.push(`- **${s.label} (${s.mark})** by ${n.name}`);
      if (n.wrong) lines.push(`  - What went wrong: ${n.wrong.replace(/\n/g, " ")}`);
      if (n.better) lines.push(`  - Better play: ${n.better.replace(/\n/g, " ")}`);
      if (n.line) lines.push(`  - Shown on the field: ${n.line.steps.map((x) => x.text).join(" → ") || `${n.line.responses.length} choices`}`);
    }
    lines.push("");
  }
  if (!r.notes.length) lines.push("No mistakes were reported.", "");
  return lines.join("\n");
}
