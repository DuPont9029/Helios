// Testi per il registro del duello.
import { MSG, LOC, HINT, PHASE_NAMES, POS } from "../../core/constants.js";
import { cardName, descString, sysString, attributeName, raceName, counterName } from "../../data/db.js";

const LOC_NAMES = {
  [LOC.DECK]: "Deck", [LOC.HAND]: "Hand", [LOC.MZONE]: "Monster Zone", [LOC.SZONE]: "Spell & Trap Zone",
  [LOC.GRAVE]: "GY", [LOC.REMOVED]: "Banishment", [LOC.EXTRA]: "Extra Deck", [LOC.OVERLAY]: "Xyz Materials",
};

/** Nome di carta cliccabile nel registro: view.log lo trasforma in uno <span> che apre il dettaglio. */
const C = (code) => ({ code });

/**
 * Template per le righe del registro: `t\`... ${C(code)} ...\`` restituisce l'elenco di parti
 * (stringhe e { code }) da cui la vista costruisce i nodi.
 */
function t(strings, ...vals) {
  const parts = [];
  strings.forEach((s, i) => {
    if (s) parts.push(s);
    if (i < vals.length) {
      const v = vals[i];
      if (Array.isArray(v)) parts.push(...v);
      else if (v != null && v !== "") parts.push(typeof v === "object" ? v : String(v));
    }
  });
  return parts;
}

/** Testo semplice di una riga (le carte tra virgolette), per chi non usa i nodi. */
const plain = (parts) => parts.map((p) => (typeof p === "string" ? p : p.code ? `"${cardName(p.code)}"` : "a card")).join("");

export function locName(loc) {
  if (loc & LOC.OVERLAY) return LOC_NAMES[LOC.OVERLAY];
  return LOC_NAMES[loc] ?? "?";
}

/**
 * @param names  [nome giocatore 0, nome giocatore 1]
 * @param canSee (player, location, position, code) -> bool
 * @returns { cls, parts (stringhe e { code } per i nomi cliccabili), text } oppure null
 */
export function describe(m, names, canSee, ctx = {}) {
  const e = describeParts(m, names, canSee, ctx);
  if (!e) return null;
  const parts = typeof e.text === "string" ? [e.text] : e.text;
  return { cls: e.cls, parts, text: plain(parts) };
}

function describeParts(m, names, canSee, ctx) {
  const who = (p) => names[p] ?? `Player ${p + 1}`;
  const nameIf = (code, p, loc, pos) => (code && canSee(p, loc, pos) ? C(code) : "a card");
  // Carta in una zona (OcgLocPos): nome se visibile, altrimenti "a card"; per le carte fuori dal campo la zona.
  const at = (c) => {
    const code = c.location & LOC.ONFIELD ? ctx.codeAt?.(c.controller, c.location, c.sequence) : 0;
    if (code && canSee(c.controller, c.location, c.position)) return C(code);
    return c.location & LOC.ONFIELD ? `a face-down card` : `a card in the ${locName(c.location)}`;
  };
  const list = (cards) => cards.flatMap((c, i) => (i ? [", ", at(c)] : [at(c)]));
  switch (m.type) {
    case MSG.NEW_TURN: return { cls: "turn", text: `— ${who(m.player)}'s Turn —` };
    case MSG.NEW_PHASE: return { cls: "phase", text: PHASE_NAMES[m.phase] ?? "Phase" };
    case MSG.DRAW: return { text: `${who(m.player)} draws ${m.drawn.length} card${m.drawn.length === 1 ? "" : "s"}` };
    case MSG.SUMMONING: return { text: t`${who(m.controller)} Normal Summons ${C(m.code)}` };
    case MSG.SPSUMMONING: return { text: t`${who(m.controller)} Special Summons ${C(m.code)}` };
    case MSG.FLIPSUMMONING: return { text: t`${who(m.controller)} Flip Summons ${C(m.code)}` };
    case MSG.SET: return { text: `${who(m.controller)} Sets a card` };
    case MSG.CHAINING: return { cls: "chain", text: t`Chain ${m.chain_size}: ${who(m.controller)} activates ${C(m.code)}` };
    case MSG.CHAIN_SOLVING: {
      const code = ctx.chainCode?.(m.chain_size);
      return { cls: "resolve", text: code ? t`Chain Link ${m.chain_size} resolves: ${C(code)}` : `Chain Link ${m.chain_size} resolves` };
    }
    case MSG.BECOME_TARGET: return m.cards.length ? { cls: "target", text: t`Targets: ${list(m.cards)}` } : null;
    case MSG.CARD_SELECTED: return m.cards.length ? { cls: "dim", text: t`Selected: ${list(m.cards)}` } : null;
    case MSG.EQUIP: return { text: t`${at(m.card)} is equipped to ${at(m.target)}` };
    case MSG.CHAIN_NEGATED: return { cls: "warn", text: `Activation of Chain Link ${m.chain_size} negated` };
    case MSG.CHAIN_DISABLED: return { cls: "warn", text: `Effect of Chain Link ${m.chain_size} negated` };
    case MSG.DAMAGE: return { cls: "dmg", text: `${who(m.player)} takes ${m.amount} damage` };
    case MSG.RECOVER: return { cls: "heal", text: `${who(m.player)} gains ${m.amount} LP` };
    case MSG.PAY_LPCOST: return { cls: "dmg", text: `${who(m.player)} pays ${m.amount} LP` };
    case MSG.ATTACK: {
      const a = m.card;
      return { cls: "attack", text: m.target && m.target.location ? t`${at(a)} attacks ${at(m.target)}` : t`${at(a)} attacks directly` };
    }
    case MSG.MOVE: {
      const { from, to } = m;
      if (from.location === to.location || to.location === LOC.OVERLAY) return null;
      // Da dove arriva la carta (dal campo si dice solo "is sent to the GY": può essere distrutta o mandata).
      const from_ = from.location & LOC.ONFIELD || from.location === 0 ? "" : ` from the ${locName(from.location)}`;
      if (to.location === LOC.GRAVE) return { text: t`${nameIf(m.card, to.controller, to.location, to.position)} is sent to the GY${from_}` };
      if (to.location === LOC.REMOVED) return { text: t`${nameIf(m.card, to.controller, to.location, to.position)} is banished${from_}` };
      if (to.location === LOC.HAND && from.location !== LOC.DECK) return { text: t`${nameIf(m.card, to.controller, to.location, to.position)} returns to the Hand` };
      if (to.location === LOC.HAND && from.location === LOC.DECK) return { text: t`${who(to.controller)} adds ${nameIf(m.card, to.controller, to.location, to.position)} from the Deck to the Hand` };
      if (to.location === LOC.DECK || to.location === LOC.EXTRA) {
        return { text: t`${nameIf(m.card, from.controller, from.location, from.position)} returns to the ${locName(to.location)}` };
      }
      return null;
    }
    case MSG.POS_CHANGE: return { text: t`${C(m.code)} changes to ${m.position & POS.ATTACK ? "Attack" : "Defense"} Position` };
    case MSG.TOSS_COIN: return { text: `Coin toss: ${m.results.map((r) => (r ? "Heads" : "Tails")).join(", ")}` };
    case MSG.TOSS_DICE: return { text: `Die roll: ${m.results.join(", ")}` };
    case MSG.ADD_COUNTER: return { text: `+${m.count} ${counterName(m.counter_type)}` };
    case MSG.REMOVE_COUNTER: return { text: `-${m.count} ${counterName(m.counter_type)}` };
    case MSG.SHUFFLE_DECK: return { cls: "dim", text: `${who(m.player)} shuffles the Deck` };
    case MSG.CONFIRM_CARDS: {
      const shown = m.cards.flatMap((c, i) => (i ? [", ", C(c.code)] : [C(c.code)]));
      return { text: t`${who(m.cards[0]?.controller ?? m.player)} reveals: ${shown}` };
    }
    case MSG.CONFIRM_DECKTOP: {
      const shown = m.cards.flatMap((c, i) => (i ? [", ", C(c.code)] : [C(c.code)]));
      return { text: t`${who(m.cards[0]?.controller ?? m.player)} reveals the top of the Deck: ${shown}` };
    }
    case MSG.CONFIRM_EXTRATOP: {
      const shown = m.cards.flatMap((c, i) => (i ? [", ", C(c.code)] : [C(c.code)]));
      return { text: t`${who(m.cards[0]?.controller ?? m.player)} reveals from the Extra Deck: ${shown}` };
    }
    case MSG.HINT:
      switch (m.hint_type) {
        case HINT.MESSAGE: return { cls: "hint", text: descString(m.hint) };
        case HINT.OPSELECTED: return { cls: "hint", text: `${who(1 - m.player)} chooses: ${descString(m.hint)}` };
        case HINT.EFFECT: return { cls: "hint", text: t`Effect of ${C(Number(m.hint))}` };
        case HINT.RACE: return { cls: "hint", text: `Declared Type: ${raceName(Number(m.hint))}` };
        case HINT.ATTRIB: return { cls: "hint", text: `Declared Attribute: ${attributeName(Number(m.hint))}` };
        case HINT.CODE: return { cls: "hint", text: t`Declared card: ${C(Number(m.hint))}` };
        case HINT.NUMBER: return { cls: "hint", text: `Declared number: ${m.hint}` };
        default: return null;
      }
    case MSG.WIN: return { cls: "turn", text: m.player === 2 ? "Draw!" : `${who(m.player)} wins the Duel!` };
    case MSG.MATCH_KILL: return { text: "Match kill!" };
    case MSG.RETRY: return { cls: "warn", text: "Invalid choice, try again" };
    default: return null;
  }
}

export { sysString };
