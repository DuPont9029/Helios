// IA molto semplice: gioca in modo legale e un minimo sensato.
// Usata per i duelli contro la CPU e per i test automatici del motore.
import { BATTLE, IDLE, MSG, POS, RESP, TYPE } from "./constants.js";
import { availableZones } from "./zones.js";
import { findSum } from "./sum.js";
import { isDeclarable } from "./declarable.js";

export class SimpleAI {
  /**
   * @param getCard   code -> carta (parseCard)
   * @param allCards  iterabile di tutte le carte (per ANNOUNCE_CARD)
   * @param random    funzione () => [0,1) (deterministica nei test)
   */
  constructor({ getCard, allCards = [], random = Math.random }) {
    this.getCard = getCard;
    this.allCards = allCards;
    this.random = random;
    this.activationsThisTurn = 0;
    this.turnKey = null;
    this.idleActions = 0;
  }

  atk(code) {
    return this.getCard(code)?.atk ?? 0;
  }

  respond(msg, state = {}) {
    const turnKey = `${state.turn}`;
    if (turnKey !== this.turnKey) {
      this.turnKey = turnKey;
      this.activationsThisTurn = 0;
      this.idleActions = 0;
    }
    switch (msg.type) {
      case MSG.SELECT_IDLECMD: return this.idle(msg, state);
      case MSG.SELECT_BATTLECMD: return this.battle(msg);
      case MSG.SELECT_EFFECTYN: return { type: RESP.SELECT_EFFECTYN, yes: true };
      case MSG.SELECT_YESNO: return { type: RESP.SELECT_YESNO, yes: true };
      case MSG.SELECT_OPTION: return { type: RESP.SELECT_OPTION, index: 0 };
      case MSG.SELECT_CARD: return { type: RESP.SELECT_CARD, indicies: range(Math.max(1, msg.min)).slice(0, msg.selects.length) };
      case MSG.SELECT_TRIBUTE: return { type: RESP.SELECT_TRIBUTE, indicies: this.tribute(msg) };
      case MSG.SELECT_UNSELECT_CARD:
        if (msg.can_finish || (msg.select_cards.length === 0 && msg.can_cancel)) return { type: RESP.SELECT_UNSELECT_CARD, index: null };
        return { type: RESP.SELECT_UNSELECT_CARD, index: 0 };
      case MSG.SELECT_CHAIN:
        if (msg.forced && msg.selects.length) return { type: RESP.SELECT_CHAIN, index: 0 };
        if (msg.selects.length && this.activationsThisTurn < 6 && this.random() < 0.7) {
          this.activationsThisTurn++;
          return { type: RESP.SELECT_CHAIN, index: Math.floor(this.random() * msg.selects.length) };
        }
        return { type: RESP.SELECT_CHAIN, index: null };
      case MSG.SELECT_PLACE:
      case MSG.SELECT_DISFIELD: {
        const zones = availableZones(msg);
        const mine = zones.filter((z) => z.player === msg.player);
        const theirs = zones.filter((z) => z.player !== msg.player);
        // Per SELECT_PLACE si preferisce il proprio campo, per DISFIELD quello avversario.
        const pool = msg.type === MSG.SELECT_PLACE ? [...mine, ...theirs] : [...theirs, ...mine];
        return {
          type: msg.type === MSG.SELECT_PLACE ? RESP.SELECT_PLACE : RESP.SELECT_DISFIELD,
          places: pool.slice(0, msg.count),
        };
      }
      case MSG.SELECT_POSITION: {
        const p = msg.positions;
        const pos = p & POS.FACEUP_ATTACK || p & POS.FACEUP_DEFENSE || p & POS.FACEDOWN_DEFENSE || p & POS.FACEDOWN_ATTACK;
        return { type: RESP.SELECT_POSITION, position: pos };
      }
      case MSG.SORT_CHAIN:
      case MSG.SORT_CARD:
        return { type: RESP.SORT_CARD, order: null };
      case MSG.SELECT_COUNTER: {
        let left = msg.count;
        const counters = msg.cards.map((c) => {
          const take = Math.min(left, c.count);
          left -= take;
          return take;
        });
        return { type: RESP.SELECT_COUNTER, counters };
      }
      case MSG.SELECT_SUM:
        return { type: RESP.SELECT_SUM, indicies: findSum(msg) ?? range(msg.selects.length) };
      case MSG.ANNOUNCE_RACE:
        return { type: RESP.ANNOUNCE_RACE, races: pickBits(BigInt(msg.available), msg.count) };
      case MSG.ANNOUNCE_ATTRIB:
        return { type: RESP.ANNOUNCE_ATTRIB, attributes: pickBits(BigInt(msg.available), msg.count).map(Number) };
      case MSG.ANNOUNCE_CARD: {
        for (const c of this.allCards) {
          if (isDeclarable(c, msg.opcodes)) return { type: RESP.ANNOUNCE_CARD, card: c.code };
        }
        return { type: RESP.ANNOUNCE_CARD, card: 0 };
      }
      case MSG.ANNOUNCE_NUMBER:
        return { type: RESP.ANNOUNCE_NUMBER, value: 0 };
      case MSG.ROCK_PAPER_SCISSORS:
        return { type: RESP.ROCK_PAPER_SCISSORS, value: 1 + Math.floor(this.random() * 3) };
    }
    throw new Error(`AI: unhandled message ${msg.type}`);
  }

  idle(msg, state) {
    // Evita cicli infiniti (es. evocazione annullata e riproposta).
    if (++this.idleActions > 25) {
      return { type: RESP.SELECT_IDLECMD, action: msg.to_bp && state.turn > 1 ? IDLE.TO_BP : IDLE.TO_EP, index: 0 };
    }
    const pick = (action, list, scoreFn) => {
      if (!list.length) return null;
      let best = 0;
      list.forEach((c, i) => {
        if (scoreFn(c) > scoreFn(list[best])) best = i;
      });
      return { type: RESP.SELECT_IDLECMD, action, index: best };
    };
    const byAtk = (c) => this.atk(c.code);
    const choice =
      pick(IDLE.SPSUMMON, msg.special_summons, byAtk) ||
      pick(IDLE.SUMMON, msg.summons, byAtk) ||
      (this.activationsThisTurn < 6 && msg.activates.length
        ? (this.activationsThisTurn++, { type: RESP.SELECT_IDLECMD, action: IDLE.ACTIVATE, index: Math.floor(this.random() * msg.activates.length) })
        : null) ||
      pick(IDLE.MSET, msg.monster_sets, (c) => -this.atk(c.code)) ||
      pick(IDLE.SSET, msg.spell_sets.filter((c) => this.getCard(c.code)?.type & TYPE.TRAP), () => 0);
    if (choice) return choice;
    if (msg.to_bp && state.turn > 1) return { type: RESP.SELECT_IDLECMD, action: IDLE.TO_BP, index: 0 };
    return { type: RESP.SELECT_IDLECMD, action: IDLE.TO_EP, index: 0 };
  }

  battle(msg) {
    if (msg.attacks.length) return { type: RESP.SELECT_BATTLECMD, action: BATTLE.ATTACK, index: 0 };
    if (msg.to_m2) return { type: RESP.SELECT_BATTLECMD, action: BATTLE.TO_M2, index: 0 };
    return { type: RESP.SELECT_BATTLECMD, action: BATTLE.TO_EP, index: 0 };
  }

  tribute(msg) {
    // Le carte con release_param più alto contano per più tributi.
    const order = msg.selects.map((c, i) => [i, this.atk(c.code)]).sort((a, b) => a[1] - b[1]);
    const out = [];
    let count = 0;
    for (const [i] of order) {
      if (count >= msg.min) break;
      out.push(i);
      count += msg.selects[i].release_param || 1;
    }
    return out;
  }
}

function range(n) {
  return Array.from({ length: n }, (_, i) => i);
}

function pickBits(mask, count) {
  const out = [];
  for (let bit = 1n; bit <= mask && out.length < count; bit <<= 1n) if (mask & bit) out.push(bit);
  return out;
}
