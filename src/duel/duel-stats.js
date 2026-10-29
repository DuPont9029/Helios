// Statistiche di un duello per il report del coaching (e per le giocate di prova da un momento del duello).
// Si raccolgono durante il duello (DuelSession) dai messaggi del core e dalle risposte date. Ogni evento ricorda
// quante risposte erano già state date (h): tornando indietro ("Back") si tolgono quelli successivi.
import { MSG, LOC } from "../core/constants.js";
import { describeAction, phaseShort } from "./coaching.js";

const MAX_ACTIONS = 800;

/** Statistiche vuote di un giocatore (vedi summarize). */
const blank = () => ({
  draws: 0, normal: 0, special: 0, flip: 0, activations: 0, negated: 0, attacks: 0, direct: 0,
  damage: 0, paid: 0, healed: 0, toGrave: 0, banished: 0, searched: 0, actions: 0, decisions: 0, think: 0, thinkMax: 0,
});

export class StatsRecorder {
  /** me: indice del core del giocatore; base: risposte già date prima (giocata di prova da un momento). */
  constructor(me, { base = 0, onChange = null } = {}) {
    this.me = me;
    this.base = base;
    this.onChange = onChange;
    this.events = []; // { h, turn, k, p, n?, code? }
    this.actions = []; // { seq, p, turn, phase, text, codes, details: [{ seq, text, codes }], ms }
    this.chain = []; // chi ha attivato ogni anello della catena in corso
    this.turn = 0;
    this.lp = null;
    this.startedAt = Date.now();
  }

  /** Messaggi del core dopo h risposte; snapshot = stato dopo i messaggi. */
  messages(list, h, snapshot) {
    const ev = (k, p, extra) => this.events.push({ h, turn: this.turn, k, p, ...extra });
    for (const m of list ?? []) {
      switch (m.type) {
        case MSG.NEW_TURN:
          this.turn++;
          ev("turn", m.player);
          break;
        case MSG.DRAW:
          ev("draw", m.player, { n: m.drawn?.length ?? 1 });
          break;
        case MSG.SUMMONING:
          ev("normal", m.controller, { code: m.code });
          break;
        case MSG.SPSUMMONING:
          ev("special", m.controller, { code: m.code });
          break;
        case MSG.FLIPSUMMONING:
          ev("flip", m.controller, { code: m.code });
          break;
        case MSG.CHAINING:
          this.chain[m.chain_size - 1] = m.controller;
          ev("act", m.controller, { code: m.code });
          break;
        case MSG.CHAIN_NEGATED:
        case MSG.CHAIN_DISABLED: {
          const p = this.chain[m.chain_size - 1];
          if (p === 0 || p === 1) ev("negated", p);
          break;
        }
        case MSG.CHAIN_END:
          this.chain = [];
          break;
        case MSG.ATTACK:
          ev("attack", m.card.controller, { direct: !m.target || !m.target.location });
          break;
        case MSG.DAMAGE:
          ev("damage", m.player, { n: m.amount });
          break;
        case MSG.PAY_LPCOST:
          ev("paid", m.player, { n: m.amount });
          break;
        case MSG.RECOVER:
          ev("healed", m.player, { n: m.amount });
          break;
        case MSG.MOVE: {
          const { from, to } = m;
          if (!from || !to || to.location & LOC.OVERLAY) break;
          if (to.location === LOC.GRAVE && from.location & LOC.ONFIELD) ev("toGrave", from.controller, { code: m.card });
          else if (to.location === LOC.REMOVED && from.location !== LOC.REMOVED) ev("banished", from.controller, { code: m.card });
          else if (from.location === LOC.DECK && to.location === LOC.HAND) ev("searched", to.controller, { code: m.card });
          break;
        }
      }
    }
    const lp = snapshot?.players?.map((p) => p.lp);
    if (lp && (!this.lp || lp[0] !== this.lp[0] || lp[1] !== this.lp[1])) {
      this.lp = lp;
      ev("lp", null, { lp });
    }
  }

  /** Risposta numero seq (0 = la prima del duello); ms = tempo per pensarci (solo il giocatore locale). */
  response(seq, prompt, response, snapshot, ms = null) {
    const d = describeAction(prompt, response, this.me);
    if (!d) return;
    const p = prompt.player;
    const last = this.actions.at(-1);
    if (!d.main && last && last.p === p && last.turn === snapshot.turn) {
      if (last.details.length < 12) last.details.push({ seq, text: d.text, codes: d.codes });
      if (ms != null) last.ms = (last.ms ?? 0) + ms;
    } else if (this.actions.length < MAX_ACTIONS) {
      this.actions.push({ seq, p, turn: snapshot.turn, phase: phaseShort(snapshot.phase), text: d.text, codes: d.codes, details: [], ms });
    }
    this.onChange?.();
  }

  /** Stato ricostruito con le prime h risposte ("Back"): via quello che è venuto dopo. */
  rewind(h) {
    this.events = this.events.filter((e) => e.h <= h);
    this.actions = this.actions.filter((a) => a.seq < h);
    for (const a of this.actions) a.details = a.details.filter((d) => d.seq < h);
    this.chain = [];
    this.turn = this.events.filter((e) => e.k === "turn").length;
    this.lp = this.events.findLast((e) => e.k === "lp")?.lp ?? null;
    this.onChange?.();
  }

  /** Le azioni come passi da mostrare: [{ p, text, codes }] (dalla risposta `from` in poi). */
  steps(from = 0, max = 60) {
    return this.actions.filter((a) => a.seq >= from).slice(0, max).map((a) => ({
      at: a.seq - from,
      p: a.p,
      text: a.text,
      codes: [...new Set([...a.codes, ...a.details.flatMap((d) => d.codes)])].slice(0, 6),
      details: a.details.map((d) => d.text).slice(0, 6),
    }));
  }

  /** Riepilogo da salvare nel report (vedi summarize). */
  result(startLp) {
    return {
      v: 1,
      me: this.me,
      duration: Date.now() - this.startedAt,
      turns: this.events.filter((e) => e.k === "turn").map((e) => e.p),
      lp: lpByTurn(this.events, startLp),
      per: perPlayer(this.events, this.actions),
      cards: usedCards(this.events),
      actions: this.actions.map((a) => ({
        seq: a.seq, p: a.p, turn: a.turn, phase: a.phase, text: a.text,
        codes: [...new Set([...a.codes, ...a.details.flatMap((d) => d.codes)])].slice(0, 8),
        details: a.details.map((d) => d.text),
        ms: a.ms == null ? null : Math.round(a.ms),
      })),
    };
  }
}

/** Life Points alla fine di ogni turno: [[turno, lp0, lp1], ...] (turno 0 = inizio del duello). */
function lpByTurn(events, startLp) {
  const out = [[0, startLp, startLp]];
  let lp = [startLp, startLp];
  let turn = 0;
  for (const e of events) {
    if (e.k === "turn") {
      if (turn > 0) out.push([turn, ...lp]);
      turn++;
    } else if (e.k === "lp") lp = e.lp;
  }
  if (turn > 0) out.push([turn, ...lp]);
  return out;
}

function perPlayer(events, actions) {
  const per = [blank(), blank()];
  for (const e of events) {
    const s = per[e.p];
    if (!s) continue;
    switch (e.k) {
      case "draw": s.draws += e.n; break;
      case "normal": case "special": case "flip": case "negated": case "toGrave": case "banished": case "searched": s[e.k]++; break;
      case "act": s.activations++; break;
      case "attack": s.attacks++; if (e.direct) s.direct++; break;
      case "damage": case "paid": case "healed": s[e.k] += e.n; break;
    }
  }
  for (const a of actions) {
    const s = per[a.p];
    s.actions++;
    if (a.ms != null) {
      s.decisions++;
      s.think += a.ms;
      s.thinkMax = Math.max(s.thinkMax, a.ms);
    }
  }
  for (const s of per) s.think = Math.round(s.think);
  return per;
}

/** Carte usate di più da ogni giocatore (evocate o attivate): [[[codice, volte], ...], [...]]. */
function usedCards(events) {
  const counts = [new Map(), new Map()];
  for (const e of events) {
    if (!["normal", "special", "flip", "act"].includes(e.k) || !e.code || !counts[e.p]) continue;
    counts[e.p].set(e.code, (counts[e.p].get(e.code) ?? 0) + 1);
  }
  return counts.map((m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 12));
}
