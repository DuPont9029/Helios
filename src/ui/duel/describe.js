// Testi per il registro del duello.
import { MSG, LOC, HINT, PHASE_NAMES, POS, TYPE } from "../../core/constants.js";
import { cardName, descString, sysString, attributeName, raceName, counterName, getCard } from "../../data/db.js";

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

/**
 * Zona di una carta per il registro: "Monster Zone 3", "the left Extra Monster Zone", "Spell & Trap Zone 2",
 * "the Field Zone", "the left Pendulum Zone". Le zone numerate e le Pendulum sono dal punto di vista del
 * controllore; le Extra Monster Zone (condivise) sinistra/destra come si vedono sullo schermo (me = chi guarda).
 */
export function zoneName(loc, seq, { pendulum = false, controller, me } = {}) {
  if (loc & LOC.MZONE) {
    if (seq < 5) return `Monster Zone ${seq + 1}`;
    // La 5 è la sinistra per chi la controlla: vista dall'avversario è a destra.
    const left = controller == null || me == null || controller === me ? seq === 5 : seq === 6;
    return `the ${left ? "left" : "right"} Extra Monster Zone`;
  }
  if (loc & LOC.SZONE) {
    if (seq === 5) return "the Field Zone";
    if (seq >= 6 || (pendulum && (seq === 0 || seq === 4))) return `the ${seq === 0 || seq === 6 ? "left" : "right"} Pendulum Zone`;
    return `Spell & Trap Zone ${seq + 1}`;
  }
  return `the ${locName(loc)}`;
}

/** Dove si attiva una carta: "from the hand", "in Monster Zone 2", "from the GY"... */
function whereActivated(m, me) {
  const loc = m.location;
  if (loc & LOC.ONFIELD) {
    const pendulum = ((getCard(m.code)?.type ?? 0) & TYPE.PENDULUM) !== 0 && !(m.position & POS.FACEDOWN);
    return ` in ${zoneName(loc, m.sequence, { pendulum, controller: m.controller, me })}`;
  }
  if (loc & LOC.OVERLAY) return " as Xyz Material";
  return loc ? ` from the ${locName(loc)}` : "";
}

/** Carta in una posizione (OcgLocPos) per il registro: il nome se visibile, altrimenti dove si trova. */
export function cardAt(c, canSee, ctx = {}) {
  const code = ctx.codeAt?.(c.controller, c.location, c.sequence) ?? 0;
  if (code && canSee(c.controller, c.location, c.position)) return C(code);
  if (c.location & LOC.ONFIELD) return "a face-down card";
  return `a card in the ${locName(c.location)}`;
}

export const cardList = (cards, canSee, ctx) => cards.flatMap((c, i) => (i ? [", ", cardAt(c, canSee, ctx)] : [cardAt(c, canSee, ctx)]));

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
  const at = (c) => cardAt(c, canSee, ctx);
  const list = (cards) => cardList(cards, canSee, ctx);
  const zone = (loc, seq, controller) => zoneName(loc, seq, { controller, me: ctx.me });
  switch (m.type) {
    case MSG.NEW_TURN: return { cls: "turn", text: `— ${who(m.player)}'s Turn —` };
    case MSG.NEW_PHASE: return { cls: "phase", text: PHASE_NAMES[m.phase] ?? "Phase" };
    case MSG.DRAW: return { text: `${who(m.player)} draws ${m.drawn.length} card${m.drawn.length === 1 ? "" : "s"}` };
    case MSG.SUMMONING: return { text: t`${who(m.controller)} Normal Summons ${C(m.code)} to ${zone(m.location, m.sequence, m.controller)}` };
    case MSG.SPSUMMONING: return { text: t`${who(m.controller)} ${ctx.pendulum ? "Pendulum Summons" : "Special Summons"} ${C(m.code)} to ${zone(m.location, m.sequence, m.controller)}` };
    case MSG.FLIPSUMMONING: return { text: t`${who(m.controller)} Flip Summons ${C(m.code)} in ${zone(m.location, m.sequence, m.controller)}` };
    case MSG.SET: return { text: `${who(m.controller)} Sets a card in ${zone(m.location, m.sequence, m.controller)}` };
    case MSG.CHAINING: return { cls: "chain", text: t`Chain ${m.chain_size}: ${who(m.controller)} activates ${C(m.code)}${whereActivated(m, ctx.me)}` };
    case MSG.CHAIN_SOLVING: {
      // I bersagli si dichiarano all'attivazione (sulla sua riga, vedi DuelView.logMessage): qui non si ripetono.
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
      if (to.location === LOC.REMOVED) return { text: t`${nameIf(m.card, to.controller, to.location, to.position)} is banished${to.position & POS.FACEDOWN ? " face-down" : ""}${from_}` };
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
    case MSG.SHUFFLE_SET_CARD: return { text: `${who(m.cards[0]?.from.controller ?? 0)} shuffles ${m.cards.length} Set card${m.cards.length === 1 ? "" : "s"}` };
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
