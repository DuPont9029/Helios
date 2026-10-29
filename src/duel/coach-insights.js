// Analisi del report del coaching: statistiche di ogni duello (raccolte da duel-stats.js), precisione del
// giocatore, errori per fase, per turno e per carta, e osservazioni da cui imparare.
import { cardName } from "../data/db.js";
import { SEVERITIES } from "./coaching.js";

const PHASE_NAMES = { DP: "Draw Phase", SP: "Standby Phase", M1: "Main Phase 1", BP: "Battle Phase", M2: "Main Phase 2", EP: "End Phase" };
export const phaseName = (p) => PHASE_NAMES[p] ?? (p || "—");

export const secs = (ms) => (ms == null ? "—" : ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
export const duration = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m ? `${m} min ${s} s` : `${s} s`;
};
const num = (n) => n.toLocaleString("en-GB");

/** Duelli del report in ordine, con le note di ognuno. */
export function gamesOf(r) {
  return [...r.games].sort((a, b) => a.game - b.game).map((g) => ({ ...g, notes: r.notes.filter((n) => n.game === g.game) }));
}

/** Azioni del giocatore segnalate (seq) in un duello. */
const flaggedSeqs = (notes) => new Set(notes.filter((n) => n.seq != null).map((n) => n.seq));

/**
 * Riepilogo di un duello: { stats, me, mine: [azioni del giocatore], flagged, accuracy (0..1 o null), avgThink,
 * flaggedThink }. stats = null per i duelli senza dati (report vecchi o duello lasciato a metà).
 */
export function gameSummary(g) {
  const stats = g.replay?.stats ?? null;
  if (!stats) return { stats: null };
  const me = stats.me;
  const mine = stats.actions.filter((a) => a.p === me);
  const flagged = flaggedSeqs(g.notes);
  const accuracy = mine.length ? Math.max(0, 1 - mine.filter((a) => flagged.has(a.seq)).length / mine.length) : null;
  const timed = mine.filter((a) => a.ms != null);
  const avg = (list) => (list.length ? list.reduce((s, a) => s + a.ms, 0) / list.length : null);
  return { stats, me, mine, flagged, accuracy, avgThink: avg(timed), flaggedThink: avg(timed.filter((a) => flagged.has(a.seq))) };
}

/** Life Points persi in ogni turno dal giocatore p: [{ turn, lost }] (solo i turni con danni o costi). */
export function lpLosses(stats, p) {
  const out = [];
  for (let i = 1; i < stats.lp.length; i++) {
    const lost = stats.lp[i - 1][p + 1] - stats.lp[i][p + 1];
    if (lost > 0) out.push({ turn: stats.lp[i][0], lost });
  }
  return out;
}

/** Errori per fase, per turno e per carta (tutte le note con un'azione). */
export function mistakeBreakdown(r) {
  const phases = new Map();
  const cards = new Map();
  const sev = Object.fromEntries(SEVERITIES.map((s) => [s.id, 0]));
  for (const n of r.notes) {
    sev[n.severity]++;
    if (n.phase) phases.set(n.phase, (phases.get(n.phase) ?? 0) + 1);
    for (const c of n.action?.codes ?? []) cards.set(c, (cards.get(c) ?? 0) + 1);
  }
  return {
    severity: sev,
    phases: ["DP", "SP", "M1", "BP", "M2", "EP"].map((p) => [p, phases.get(p) ?? 0]),
    cards: [...cards].sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

/** Le giocate giuste da ricordare: una per nota con "Better play", la più grave prima. */
export function lessons(r) {
  const rank = (s) => SEVERITIES.findIndex((x) => x.id === s);
  return r.notes.filter((n) => n.better || n.line).sort((a, b) => rank(b.severity) - rank(a.severity) || a.game - b.game || a.turn - b.turn);
}

/** Osservazioni sul gioco, dai dati del duello e dalle note: frasi da leggere. */
export function observations(r) {
  const out = [];
  const name = r.names[0];
  const b = mistakeBreakdown(r);
  const total = r.notes.length;
  const top = [...b.phases].sort((x, y) => y[1] - x[1])[0];
  if (total >= 2 && top[1] >= 2) out.push(`Most of the flagged moments were in the ${phaseName(top[0])} (${top[1]} of ${total}).`);
  if (b.cards[0]?.[1] >= 2) out.push(`"${cardName(b.cards[0][0])}" was involved in ${b.cards[0][1]} flagged actions: review how and when to use it.`);
  for (const g of gamesOf(r)) {
    const s = gameSummary(g);
    if (!s.stats) continue;
    const tag = r.games.length > 1 ? `Game ${g.game}: ` : "";
    const per = s.stats.per;
    const me = per[s.me];
    const opp = per[1 - s.me];
    if (s.accuracy != null && s.mine.length) out.push(`${tag}${Math.round(s.accuracy * 100)}% of ${name}'s ${s.mine.length} actions were not flagged by the coaches.`);
    if (s.avgThink != null) {
      const slow = s.mine.filter((a) => a.ms != null).sort((x, y) => y.ms - x.ms)[0];
      out.push(`${tag}On average ${secs(s.avgThink)} per decision; the longest was ${secs(slow.ms)} (Turn ${slow.turn} · ${slow.text}).`);
      if (s.flaggedThink != null && s.flagged.size >= 2) {
        if (s.flaggedThink < s.avgThink * 0.7) out.push(`${tag}The flagged actions were played faster than the others (${secs(s.flaggedThink)} vs ${secs(s.avgThink)}): take a moment before the key plays.`);
        else if (s.flaggedThink > s.avgThink * 1.5) out.push(`${tag}The flagged actions took longer than the others (${secs(s.flaggedThink)} vs ${secs(s.avgThink)}): these were the hard spots, worth studying with the replays.`);
      }
    }
    const losses = lpLosses(s.stats, s.me);
    if (losses.length) {
      const worst = losses.sort((x, y) => y.lost - x.lost)[0];
      const lost = losses.reduce((t, l) => t + l.lost, 0);
      out.push(`${tag}${name} lost ${num(lost)} LP, ${num(worst.lost)} of them in Turn ${worst.turn}.`);
    }
    if (me.negated) out.push(`${tag}${me.negated} of ${name}'s activations ${me.negated === 1 ? "was" : "were"} negated: think about baiting the negation first or playing around it.`);
    const passed = s.mine.filter((a) => a.text.startsWith("Did not activate"));
    const passedFlagged = passed.filter((a) => s.flagged.has(a.seq)).length;
    if (passedFlagged) out.push(`${tag}${passedFlagged} of the ${passed.length} times ${name} chose not to activate a card ${passedFlagged === 1 ? "was" : "were"} flagged: watch for the right moment to use hand traps and quick effects.`);
    if (me.special + me.normal + opp.special + opp.normal) out.push(`${tag}Summons: ${name} ${me.normal + me.special + me.flip} (${me.special} Special), opponent ${opp.normal + opp.special + opp.flip} (${opp.special} Special).`);
  }
  const shown = r.notes.filter((n) => n.line).length;
  if (shown) out.push(`${shown} note${shown === 1 ? " includes" : "s include"} the better play shown on the field: watch ${shown === 1 ? "it" : "them"}, then try ${shown === 1 ? "it" : "them"} yourself from the same moment.`);
  return out;
}

/** Righe della tabella delle statistiche: [etichetta, chiave o funzione, formato]. */
export const STAT_ROWS = [
  ["Actions", "actions"],
  ["Cards drawn", "draws"],
  ["Cards added from the Deck", "searched"],
  ["Normal Summons", "normal"],
  ["Special Summons", "special"],
  ["Flip Summons", "flip"],
  ["Card effects activated", "activations"],
  ["Activations negated", "negated"],
  ["Attacks", "attacks"],
  ["Direct attacks", "direct"],
  ["Damage taken", "damage", num],
  ["LP paid as cost", "paid", num],
  ["LP gained", "healed", num],
  ["Cards sent to the GY from the field", "toGrave"],
  ["Cards banished", "banished"],
  ["Average think time", (s) => (s.decisions ? s.think / s.decisions : null), secs],
  ["Longest decision", (s) => (s.decisions ? s.thinkMax : null), secs],
];

export const statValue = (s, [, key, fmt]) => {
  const v = typeof key === "function" ? key(s) : s[key];
  return v == null ? "—" : fmt ? fmt(v) : String(v);
};
