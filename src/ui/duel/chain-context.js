// Contesto della richiesta di catena: a cosa si sta rispondendo (come negli altri simulatori).
// Segue gli eventi del duello (catena in corso, summon, attacchi, pescate, carte mosse, fasi) e
// li combina con il "timing" che il core allega a MSG_SELECT_CHAIN.
import { MSG, LOC, PHASE_NAMES } from "../../core/constants.js";
import { cardName } from "../../data/db.js";

// Timing del core (OcgHintTiming), dal più specifico al più generico.
const T = {
  DRAW_PHASE: 0x1, STANDBY_PHASE: 0x2, MAIN_END: 0x4, BATTLE_START: 0x8, BATTLE_END: 0x10, END_PHASE: 0x20,
  SUMMON: 0x40, SPSUMMON: 0x80, FLIPSUMMON: 0x100, MSET: 0x200, SSET: 0x400, POS_CHANGE: 0x800,
  ATTACK: 0x1000, DAMAGE_STEP: 0x2000, DAMAGE_CAL: 0x4000, CHAIN_END: 0x8000, DRAW: 0x10000,
  DAMAGE: 0x20000, RECOVER: 0x40000, DESTROY: 0x80000, REMOVE: 0x100000, TOHAND: 0x200000,
  TODECK: 0x400000, TOGRAVE: 0x800000, BATTLE_PHASE: 0x1000000, EQUIP: 0x2000000,
  BATTLE_STEP_END: 0x4000000, BATTLED: 0x8000000,
};

const q = (code) => (code ? `"${cardName(code)}"` : "a card");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export class ChainContext {
  /** @param who (player) -> nome da mostrare; @param codeAt (player, location, sequence) -> codice della carta o 0 */
  constructor(who, codeAt) {
    this.who = who;
    this.codeAt = codeAt;
    this.reset();
  }

  reset() {
    this.chain = []; // anelli della catena in costruzione
    this.summon = null;
    this.attack = null;
    this.draw = null;
    this.moved = null;
    this.damage = null;
    this.phase = null;
  }

  track(m) {
    switch (m.type) {
      case MSG.NEW_TURN: this.reset(); break;
      case MSG.NEW_PHASE: this.phase = m.phase; this.attack = null; break;
      case MSG.CHAINING: this.chain.push({ code: m.code, player: m.controller, link: m.chain_size }); break;
      case MSG.CHAIN_END: this.chain = []; break;
      case MSG.SUMMONING: this.summon = { kind: "Normal Summon", code: m.code, player: m.controller }; break;
      case MSG.SPSUMMONING: this.summon = { kind: "Special Summon", code: m.code, player: m.controller }; break;
      case MSG.FLIPSUMMONING: this.summon = { kind: "Flip Summon", code: m.code, player: m.controller }; break;
      case MSG.ATTACK: {
        const a = m.card;
        const t = m.target;
        this.attack = {
          code: this.codeAt(a.controller, a.location, a.sequence),
          player: a.controller,
          target: t && t.location ? this.codeAt(t.controller, t.location, t.sequence) : null,
        };
        break;
      }
      case MSG.DRAW: this.draw = { player: m.player, count: m.drawn.length }; break;
      case MSG.MOVE: if (m.from.location !== m.to.location) this.moved = { code: m.card, from: m.from, to: m.to }; break;
      case MSG.DAMAGE: this.damage = { player: m.player, amount: m.amount }; break;
    }
  }

  /** { title, detail } per la finestra della catena. */
  describe(msg) {
    const top = this.chain.at(-1);
    if (top) {
      return {
        title: `Chain to ${q(top.code)}?`,
        detail: `${this.who(top.player)} activated ${q(top.code)} (Chain Link ${top.link}). Activate a card or effect in response?`,
      };
    }
    const timing = (msg.hint_timing ?? 0) | (msg.hint_timing_other ?? 0);
    const has = (t) => (timing & t) !== 0;
    const s = this.summon;
    const a = this.attack;
    const mv = this.moved;
    const phase = PHASE_NAMES[this.phase] ?? "this phase";
    const respond = (title, detail) => ({ title, detail: `${detail} Activate a card or effect in response?` });
    if (has(T.DAMAGE_CAL)) return respond("Damage calculation", "Damage calculation is about to happen.");
    if (has(T.DAMAGE_STEP)) return respond("Damage Step", "The Damage Step has started.");
    if (has(T.ATTACK) && a) {
      const what = a.target ? `an attack on ${q(a.target)}` : "a direct attack";
      return respond(`Attack of ${q(a.code)}`, `${this.who(a.player)}'s ${q(a.code)} declared ${what}.`);
    }
    if (has(T.SUMMON | T.SPSUMMON | T.FLIPSUMMON) && s) return respond(`${s.kind} of ${q(s.code)}`, `${this.who(s.player)} ${s.kind === "Normal Summon" ? "Normal Summoned" : s.kind === "Flip Summon" ? "Flip Summoned" : "Special Summoned"} ${q(s.code)}.`);
    if (has(T.MSET | T.SSET)) return respond("A card was Set", "A card was Set.");
    if (has(T.POS_CHANGE)) return respond("Battle position changed", "A monster changed its battle position.");
    if (has(T.DRAW) && this.draw) return respond(`${this.who(this.draw.player)} drew`, `${this.who(this.draw.player)} drew ${plural(this.draw.count, "card")}.`);
    // Carta spostata: la frase viene dal timing; il nome solo se l'ultimo spostamento è proprio quello
    // (e la carta è visibile: in mano o nel Deck non si dice quale).
    for (const [flag, where, locs] of [
      [T.TOGRAVE, "sent to the GY", [LOC.GRAVE]],
      [T.REMOVE, "banished", [LOC.REMOVED]],
      [T.TOHAND, "added to the hand", [LOC.HAND]],
      [T.TODECK, "returned to the Deck", [LOC.DECK, LOC.EXTRA]],
      [T.DESTROY, "destroyed", []],
    ]) {
      if (!has(flag)) continue;
      const named = mv && locs.includes(mv.to.location) && mv.to.location !== LOC.HAND && mv.to.location !== LOC.DECK ? q(mv.code) : "A card";
      return respond(`Card ${where}`, `${named} was ${where}.`);
    }
    if (has(T.DAMAGE) && this.damage) return respond("Damage", `${this.who(this.damage.player)} took ${this.damage.amount} damage.`);
    if (has(T.RECOVER)) return respond("LP gained", "Life Points were gained.");
    if (has(T.EQUIP)) return respond("Card equipped", "A card was equipped.");
    if (has(T.CHAIN_END)) return respond("Chain resolved", "The Chain has resolved.");
    if (has(T.BATTLED | T.BATTLE_STEP_END)) return respond("End of the Damage Step", "The battle has ended.");
    if (has(T.MAIN_END)) return { title: `End of ${phase}`, detail: `The ${phase} is about to end. Activate a card or effect before moving on?` };
    if (has(T.BATTLE_START)) return { title: "Start of the Battle Phase", detail: "The Battle Phase has started. Activate a card or effect?" };
    if (has(T.BATTLE_END)) return { title: "End of the Battle Phase", detail: "The Battle Phase is about to end. Activate a card or effect?" };
    if (has(T.DRAW_PHASE)) return { title: "Draw Phase", detail: "It is the Draw Phase. Activate a card or effect?" };
    if (has(T.STANDBY_PHASE)) return { title: "Standby Phase", detail: "It is the Standby Phase. Activate a card or effect?" };
    if (has(T.END_PHASE)) return { title: "End Phase", detail: "It is the End Phase. Activate a card or effect?" };
    return { title: "Activate a card or effect?", detail: `During the ${phase}.` };
  }
}
