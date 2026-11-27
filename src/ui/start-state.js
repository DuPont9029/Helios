// Mano e board di partenza in Vs CPU e Test Duel: le carte si scelgono nella schermata del deck builder
// (openCardCollector, come lo stato di partenza del Combo Trainer) e si passano al motore con cfg.top, cfg.handSize
// e cfg.place (vedi DuelEngine.start). L'ultima scelta resta in settings.localStart.
import { h, icon } from "./dom.js";
import { miniCards } from "./card.js";
import { openCardCollector } from "./editor.js";
import { settings } from "../data/settings.js";
import { getCard, cardName, isExtraDeckCard } from "../data/db.js";
import { TYPE, LOC, POS } from "../core/constants.js";

const SIDES = ["me", "opp"];
// banishedDown: le carte bandite coperte (nel deck builder stanno nella stessa parte delle bandite scoperte).
const KEYS = ["hand", "field", "gy", "banished", "banishedDown"];
const emptySide = () => ({ hand: [], field: [], gy: [], banished: [], banishedDown: [] });
const empty = () => ({ me: emptySide(), opp: emptySide() });

const codes = (v) => (Array.isArray(v) ? v.filter((c) => Number.isInteger(c) && c > 0) : []);
function clean(s) {
  const out = empty();
  for (const side of SIDES) for (const k of KEYS) out[side][k] = codes(s?.[side]?.[k]);
  return out;
}
const count = (s) => SIDES.reduce((n, side) => n + KEYS.reduce((m, k) => m + s[side][k].length, 0), 0);

const type = (code) => getCard(code)?.type ?? 0;
const isMonster = (code) => (type(code) & TYPE.MONSTER) !== 0;
const isFieldSpell = (code) => (type(code) & TYPE.FIELD) !== 0;
const noExtra = (card) => card && !isExtraDeckCard(card);

/**
 * Riquadro del setup: pulsante che apre la scelta, riepilogo con le carte e "Clear".
 * labels: { me, opp } (es. "You" / "CPU"). read(): lo stato scelto, o null se è vuoto.
 */
export function startStateBox({ labels = { me: "You", opp: "Opponent" } } = {}) {
  let state = clean(settings.localStart);
  const summary = h("div.start-state-sum");
  const box = h("div.field.start-state", h("span", "Starting hand and board"), summary);
  const paint = () => {
    const n = count(state);
    const row = (side) => {
      const s = state[side];
      const parts = [["Hand", s.hand], ["Field", s.field], ["GY", s.gy]].filter(([, l]) => l.length);
      const banished = s.banished.length + s.banishedDown.length;
      return parts.length || banished ? h("div.start-state-row", h("b", labels[side]),
        parts.map(([l, list]) => h("span.start-state-part", h("span.muted.small", `${l} ${list.length}`), miniCards(list))),
        banished ? h("span.start-state-part", h("span.muted.small", `Banished ${banished}`), banishedList(s)) : null) : null;
    };
    summary.replaceChildren(
      ...[n ? null : h("span.muted.small", "Normal start: shuffled Decks and a random hand. Choose cards to start with a precise hand, or with cards already on the field, in the GY or banished."),
        row("me"), row("opp"),
        h("div.row",
          h("button.btn.small", { type: "button", onclick: edit }, icon("style"), n ? " Edit in the Deck Builder" : " Choose in the Deck Builder"),
          n ? h("button.btn.small.ghost", { type: "button", onclick: () => { state = empty(); settings.localStart = null; paint(); } }, "Clear") : null),
      ].filter(Boolean));
  };
  /** Carte bandite: l'occhio le gira (scoperta / coperta), × le toglie. */
  function banishedList(s) {
    const save = () => { settings.localStart = count(state) ? state : null; paint(); };
    const chip = (code, i, down) =>
      h(`span.chip.banished-chip${down ? ".down" : ""}`, miniCards([code]), cardName(code),
        h("button.chip-btn", {
          type: "button",
          title: down ? "Face-down: click to banish it face-up" : "Face-up: click to banish it face-down",
          onclick: () => { (down ? s.banishedDown : s.banished).splice(i, 1); (down ? s.banished : s.banishedDown).push(code); save(); },
        }, icon(down ? "visibility_off" : "visibility")),
        h("button.chip-btn", { type: "button", title: "Remove", onclick: () => { (down ? s.banishedDown : s.banished).splice(i, 1); save(); } }, "×"));
    return h("div.setup-list", s.banished.map((code, i) => chip(code, i, false)), s.banishedDown.map((code, i) => chip(code, i, true)));
  }
  async function edit() {
    const part = (side, k, label, extra = {}) => ({ key: `${side}_${k}`, label: `${labels[side]}: ${label}`, cards: state[side][k], ...extra });
    const banishedPart = (side) => part(side, "banished", "banished", { cards: [...state[side].banished, ...state[side].banishedDown], hint: "face-up; the eye in the summary turns a card face-down" });
    const parts = SIDES.flatMap((side) => [
      part(side, "hand", "starting hand", { filter: noExtra, max: 20, hint: "always in the opening hand; the rest of the hand is drawn as usual" }),
      part(side, "field", "field", { max: 13, hint: "monsters face-up in Attack Position, Field Spells face-up, other Spells and Traps Set" }),
      part(side, "gy", "GY"),
      banishedPart(side),
    ]);
    const v = await openCardCollector({ title: "Starting hand and board", subtitle: "The cards come from the Decks when they have them, otherwise they are added", parts, active: "me_hand", sortable: true });
    if (!v) return;
    const next = empty();
    for (const side of SIDES) {
      for (const k of ["hand", "field", "gy"]) next[side][k] = codes(v[`${side}_${k}`]);
      // restano coperte tante copie quante lo erano prima
      const down = [...state[side].banishedDown];
      for (const code of codes(v[`${side}_banished`])) {
        const i = down.indexOf(code);
        if (i >= 0) next[side].banishedDown.push(...down.splice(i, 1));
        else next[side].banished.push(code);
      }
    }
    state = next;
    settings.localStart = count(state) ? state : null;
    paint();
  }
  paint();
  return { el: box, read: () => (count(state) ? clean(state) : null) };
}

/** Zone libere per le carte del campo: mostri nelle Main Monster Zone (poi Extra), Field Spell nella sua zona. */
function placeField(player, list) {
  const out = [];
  const used = new Set();
  const take = (zones) => zones.find((z) => !used.has(z));
  for (const code of list) {
    const monster = isMonster(code);
    const zone = isFieldSpell(code) ? take(["f"]) : monster ? take(["m2", "m1", "m3", "m0", "m4", "m5", "m6"]) : take(["s2", "s1", "s3", "s0", "s4"]);
    if (!zone) continue; // zone piene: la carta resta fuori
    used.add(zone);
    if (zone === "f") out.push({ player, code, location: LOC.SZONE, sequence: 5, position: POS.FACEUP_ATTACK });
    else if (monster) out.push({ player, code, location: LOC.MZONE, sequence: +zone.slice(1), position: POS.FACEUP_ATTACK });
    else out.push({ player, code, location: LOC.SZONE, sequence: +zone.slice(1), position: POS.FACEDOWN });
  }
  return out;
}

/**
 * Configurazione del duello con lo stato di partenza. decks: i mazzi in ordine di turno; me: l'indice del giocatore
 * "me" (giocatore 1 nel Test Duel); hand: le carte della mano di partenza normali.
 * Le carte già in gioco si tolgono dal mazzo (una copia, se c'è), quelle della mano vanno in cima.
 */
export function startDuelConfig(state, { decks, me, hand }) {
  const out = { decks: decks.map((d) => ({ main: [...d.main], extra: [...d.extra] })), top: [null, null], handSize: [hand, hand], place: [] };
  for (const side of SIDES) {
    const p = side === "me" ? me : 1 - me;
    const s = state[side];
    const d = out.decks[p];
    const drop = (code) => {
      const list = isExtraDeckCard(getCard(code)) ? d.extra : d.main;
      const i = list.indexOf(code);
      if (i >= 0) list.splice(i, 1);
    };
    const placed = [...placeField(p, s.field),
      ...s.gy.map((code) => ({ player: p, code, location: LOC.GRAVE, sequence: 0, position: POS.FACEUP_ATTACK })),
      ...s.banished.map((code) => ({ player: p, code, location: LOC.REMOVED, sequence: 0, position: POS.FACEUP_ATTACK })),
      ...s.banishedDown.map((code) => ({ player: p, code, location: LOC.REMOVED, sequence: 0, position: POS.FACEDOWN }))];
    for (const c of placed) drop(c.code);
    out.place.push(...placed);
    if (s.hand.length) {
      out.top[p] = [...s.hand];
      out.handSize[p] = Math.max(hand, s.hand.length);
    }
  }
  return out;
}
