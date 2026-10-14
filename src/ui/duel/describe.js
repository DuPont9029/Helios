// Testi per il registro del duello.
import { MSG, LOC, HINT, PHASE_NAMES, POS } from "../../core/constants.js";
import { cardName, descString, sysString, attributeName, raceName, counterName } from "../../data/db.js";

const LOC_NAMES = {
  [LOC.DECK]: "Deck", [LOC.HAND]: "Hand", [LOC.MZONE]: "Monster Zone", [LOC.SZONE]: "Spell & Trap Zone",
  [LOC.GRAVE]: "GY", [LOC.REMOVED]: "Banished", [LOC.EXTRA]: "Extra Deck", [LOC.OVERLAY]: "Xyz Materials",
};

export function locName(loc) {
  if (loc & LOC.OVERLAY) return LOC_NAMES[LOC.OVERLAY];
  return LOC_NAMES[loc] ?? "?";
}

/**
 * @param names  [nome giocatore 0, nome giocatore 1]
 * @param canSee (player, location, position, code) -> bool
 */
export function describe(m, names, canSee) {
  const who = (p) => names[p] ?? `Player ${p + 1}`;
  const nameIf = (code, p, loc, pos) => (code && canSee(p, loc, pos) ? `"${cardName(code)}"` : "a card");
  switch (m.type) {
    case MSG.NEW_TURN: return { cls: "turn", text: `— ${who(m.player)}'s Turn —` };
    case MSG.NEW_PHASE: return { cls: "phase", text: PHASE_NAMES[m.phase] ?? "Phase" };
    case MSG.DRAW: return { text: `${who(m.player)} draws ${m.drawn.length} card${m.drawn.length === 1 ? "" : "s"}` };
    case MSG.SUMMONING: return { text: `${who(m.controller)} Normal Summons "${cardName(m.code)}"` };
    case MSG.SPSUMMONING: return { text: `${who(m.controller)} Special Summons "${cardName(m.code)}"` };
    case MSG.FLIPSUMMONING: return { text: `${who(m.controller)} Flip Summons "${cardName(m.code)}"` };
    case MSG.SET: return { text: `${who(m.controller)} Sets a card` };
    case MSG.CHAINING: return { cls: "chain", text: `Chain ${m.chain_size}: ${who(m.controller)} activates "${cardName(m.code)}"` };
    case MSG.CHAIN_SOLVING: return { cls: "dim", text: `Resolving Chain Link ${m.chain_size}` };
    case MSG.CHAIN_NEGATED: return { cls: "warn", text: `Activation of Chain Link ${m.chain_size} negated` };
    case MSG.CHAIN_DISABLED: return { cls: "warn", text: `Effect of Chain Link ${m.chain_size} negated` };
    case MSG.DAMAGE: return { cls: "dmg", text: `${who(m.player)} takes ${m.amount} damage` };
    case MSG.RECOVER: return { cls: "heal", text: `${who(m.player)} gains ${m.amount} LP` };
    case MSG.PAY_LPCOST: return { cls: "dmg", text: `${who(m.player)} pays ${m.amount} LP` };
    case MSG.ATTACK: {
      const a = m.card;
      return { cls: "attack", text: m.target ? `${who(a.controller)} attacks a monster` : `${who(a.controller)} attacks directly` };
    }
    case MSG.MOVE: {
      const { from, to } = m;
      if (from.location === to.location || to.location === LOC.OVERLAY) return null;
      if (to.location === LOC.GRAVE) return { text: `${nameIf(m.card, to.controller, to.location, to.position)} is sent to the GY` };
      if (to.location === LOC.REMOVED) return { text: `${nameIf(m.card, to.controller, to.location, to.position)} is banished` };
      if (to.location === LOC.HAND && from.location !== LOC.DECK) return { text: `${nameIf(m.card, to.controller, to.location, to.position)} returns to the Hand` };
      if (to.location === LOC.HAND && from.location === LOC.DECK) return { text: `${who(to.controller)} adds a card from the Deck to the Hand` };
      if (to.location === LOC.DECK || to.location === LOC.EXTRA) {
        return { text: `${nameIf(m.card, from.controller, from.location, from.position)} returns to the ${locName(to.location)}` };
      }
      return null;
    }
    case MSG.POS_CHANGE: return { text: `"${cardName(m.code)}" changes to ${m.position & POS.ATTACK ? "Attack" : "Defense"} Position` };
    case MSG.TOSS_COIN: return { text: `Coin toss: ${m.results.map((r) => (r ? "Heads" : "Tails")).join(", ")}` };
    case MSG.TOSS_DICE: return { text: `Die roll: ${m.results.join(", ")}` };
    case MSG.EQUIP: return { text: "Card equipped" };
    case MSG.ADD_COUNTER: return { text: `+${m.count} ${counterName(m.counter_type)}` };
    case MSG.REMOVE_COUNTER: return { text: `-${m.count} ${counterName(m.counter_type)}` };
    case MSG.SHUFFLE_DECK: return { cls: "dim", text: `${who(m.player)} shuffles the Deck` };
    case MSG.CONFIRM_CARDS: {
      const shown = m.cards.map((c) => `"${cardName(c.code)}"`).join(", ");
      return { text: `${who(m.player)} reveals: ${shown}` };
    }
    case MSG.HINT:
      switch (m.hint_type) {
        case HINT.MESSAGE: return { cls: "hint", text: descString(m.hint) };
        case HINT.OPSELECTED: return { cls: "hint", text: `${who(1 - m.player)} chooses: ${descString(m.hint)}` };
        case HINT.EFFECT: return { cls: "hint", text: `Effect of "${cardName(Number(m.hint))}"` };
        case HINT.RACE: return { cls: "hint", text: `Declared Type: ${raceName(Number(m.hint))}` };
        case HINT.ATTRIB: return { cls: "hint", text: `Declared Attribute: ${attributeName(Number(m.hint))}` };
        case HINT.CODE: return { cls: "hint", text: `Declared card: "${cardName(Number(m.hint))}"` };
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
