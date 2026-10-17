// Side Deck tra un duello e l'altro di una partita al meglio di 3/5: si scambiano carte tra Main/Extra e Side.
import { h, clear } from "./dom.js";
import { cardFace } from "./card.js";
import { openModal, alertModal } from "./modal.js";
import { getCard, isExtraDeckCard } from "../data/db.js";
import { validateDeck, banlistByName, sortDeckPart } from "../deck/deck.js";

/**
 * Finestra di side decking. Restituisce il mazzo da usare nel duello successivo (una copia: il mazzo
 * salvato non cambia). Senza Side Deck restituisce subito il mazzo così com'è.
 * @param deck { name, main, extra, side }
 * @param options { banlist (nome), allowUnofficial }; game: numero del duello che sta per iniziare
 */
export function sideDeck(deck, { banlist = null, allowUnofficial = false, game = 2, who = "" } = {}) {
  const start = { main: [...deck.main], extra: [...deck.extra], side: [...(deck.side ?? [])] };
  if (!start.side.length) return Promise.resolve({ ...deck, ...start });
  let cur = structuredClone(start);
  const parts = { main: h("div.side-grid"), extra: h("div.side-grid"), side: h("div.side-grid") };
  const counts = { main: h("b"), extra: h("b"), side: h("b") };
  const errorsEl = h("div.side-errors");
  const list = banlist ? banlistByName(banlist) : null;

  const move = (from, i) => {
    const [code] = cur[from].splice(i, 1);
    const to = from === "side" ? (isExtraDeckCard(getCard(code)) ? "extra" : "main") : "side";
    cur[to].push(code);
    cur[to] = sortDeckPart(cur[to]);
    render();
  };
  function render() {
    for (const k of Object.keys(parts)) {
      clear(parts[k]).append(
        ...cur[k].map((code, i) => {
          const changed = !start[k].includes(code) || cur[k].filter((x) => x === code).length > start[k].filter((x) => x === code).length;
          return h(`button.side-card${changed ? ".changed" : ""}`, { title: k === "side" ? "Move to the Deck" : "Move to the Side Deck", onclick: () => move(k, i) }, cardFace(code));
        })
      );
      counts[k].textContent = cur[k].length;
    }
    const errors = validateDeck(cur, list, { allowUnofficial });
    clear(errorsEl).append(...errors.slice(0, 4).map((e) => h("div", e)));
  }
  render();
  const section = (k, label) => h("section.side-sec", h("h4", label, " ", counts[k]), parts[k]);
  return openModal({
    title: `Side Deck${who ? ` — ${who}` : ""} · Game ${game}`,
    className: "wide side-deck",
    dismissable: false,
    body: [
      h("p.muted.small", "Click a card of the Main or Extra Deck to move it to the Side Deck, and a Side Deck card to put it in the Deck. Changes are only for this match: your saved Deck does not change."),
      section("main", "Main Deck"),
      section("extra", "Extra Deck"),
      section("side", "Side Deck"),
      errorsEl,
    ],
    actions: [
      { label: "Reset", onClick: () => { cur = structuredClone(start); render(); } },
      {
        label: "Ready",
        primary: true,
        onClick: (close) => {
          const errors = validateDeck(cur, list, { allowUnofficial });
          if (errors.length) return alertModal("Invalid Deck", errors.slice(0, 8).join("\n"));
          close({ ...deck, ...cur });
        },
      },
    ],
  }).result;
}
