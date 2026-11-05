// Pool del draft (binder durante il draft, sideboard nel deck builder): carte divise tra Main ed Extra Deck, una per
// tipo con il numero di copie, e la vista "per bundle" che rimette insieme le carte dei bundle del round 1 (le carte
// singole del round 2 non si raggruppano mai).
import { h, icon } from "./dom.js";
import { cardFace } from "./card.js";
import { getCard, isExtraDeckCard } from "../data/db.js";
import { sortDeckPart } from "../deck/deck.js";

const isExtra = (c) => isExtraDeckCard(getCard(c));

/** Gruppi di `codes` (tutte le copie) per bundle d'origine: [{ label, item, codes }]; le altre in "Single cards". */
export function groupByBundle(codes, binder) {
  const left = new Map();
  for (const c of codes) left.set(c, (left.get(c) ?? 0) + 1);
  const take = (c) => {
    const n = left.get(c) ?? 0;
    if (!n) return false;
    left.set(c, n - 1);
    return true;
  };
  const groups = [];
  for (const item of binder.filter((x) => x.round === 1)) {
    const got = [...item.main, ...item.extra].filter(take);
    if (got.length) groups.push({ label: item.label, item, codes: got });
  }
  const rest = [...left].flatMap(([c, n]) => Array(n).fill(c));
  if (rest.length) groups.push({ label: "Single cards", item: null, codes: rest });
  return groups;
}

/** Carte uguali una volta sola con ×N; onClick(code) su una pila; fresh: codici da evidenziare (es. l'ultima scelta). */
export function cardStacks(codes, { onClick, onHover, onContext, fresh = null } = {}) {
  const n = new Map();
  for (const c of sortDeckPart(codes)) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n].map(([code, k]) => {
    const el = h(
      `button.draft-stack.pool-stack${fresh?.has(code) ? ".fresh" : ""}`,
      { title: getCard(code)?.name ?? "", onclick: () => onClick?.(code), onmouseenter: () => onHover?.(code) },
      cardFace(code),
      k > 1 ? h("b.draft-copies", `×${k}`) : null,
      fresh?.has(code) ? h("b.pool-new", "New") : null
    );
    if (onContext) el.addEventListener("contextmenu", (e) => { e.preventDefault(); onContext(code); });
    return el;
  });
}

/** Toglie da `codes` una copia di ogni codice di `minus` (multinsiemi). */
export function withoutCopies(codes, minus) {
  const left = new Map();
  for (const c of minus) left.set(c, (left.get(c) ?? 0) + 1);
  return codes.filter((c) => {
    const n = left.get(c) ?? 0;
    if (!n) return true;
    left.set(c, n - 1);
    return false;
  });
}

/**
 * Vista del binder durante il draft: il mazzo che si sta costruendo, con le schede "Deck" (Main ed Extra Deck nella
 * stessa schermata) e "Side". Una scelta va nella scheda aperta in quel momento (vedi draft-table.js); un clic su
 * una carta la sposta tra Deck e Side. state: { tab: "deck" | "side", grouped, side: [codici nel Side] }.
 * rarityOf(id) → { name, color } per i bundle.
 */
export function poolView(codes, binder, state, { onHover, onContext, rarityOf = () => null, empty = "No cards", rerender, fresh = null }) {
  const side = state.side ?? (state.side = []);
  const deck = withoutCopies(codes, side);
  const main = deck.filter((c) => !isExtra(c));
  const extra = deck.filter(isExtra);
  const onSide = state.tab === "side";
  const hasBundles = binder.some((x) => x.round === 1);
  const move = (code) => {
    if (onSide) side.splice(side.indexOf(code), 1);
    else side.push(code);
    rerender();
  };
  const tabs = h(
    "div.pool-tabs",
    h(`button.draft-tab${!onSide ? ".on" : ""}`, { title: "Your deck: the picks made with this tab open go here", onclick: () => { state.tab = "deck"; rerender(); } }, `Deck (${main.length} + ${extra.length})`),
    h(`button.draft-tab${onSide ? ".on" : ""}`, { title: "Your side: the picks made with this tab open go here", onclick: () => { state.tab = "side"; rerender(); } }, `Side (${side.length})`),
    hasBundles
      ? h("label.check.pool-grouping", h("input", { type: "checkbox", checked: !!state.grouped, onchange: (e) => { state.grouped = e.target.checked; rerender(); } }), "Group by bundle")
      : null
  );
  const opts = { onClick: move, onHover, onContext, fresh };
  const cardsOf = (list) => {
    if (!state.grouped || !hasBundles) return h("div.pool-cards", cardStacks(list, opts));
    return h(
      "div.pool-groups",
      groupByBundle(list, binder).map((g) => {
        const r = g.item ? rarityOf(g.item.rarity) : null;
        // Per bundle: si evidenzia solo il gruppo dell'ultima scelta (lo stesso bundle preso prima resta normale).
        const last = !!fresh && (g.item ? g.item === binder.at(-1) : binder.at(-1)?.round !== 1);
        return h(
          `div.pool-group${last && g.item ? ".fresh" : ""}`,
          { style: `--rc: ${r?.color ?? "#5b6070"}` },
          h("div.pool-group-head", g.item ? icon("inventory_2") : icon("style"), h("b", g.label), r ? h("span.rarity-chip", r.name) : null, h("span.muted.small", `${g.codes.length}`)),
          h("div.pool-cards", cardStacks(g.codes, { ...opts, fresh: last ? fresh : null }))
        );
      })
    );
  };
  const hint = h("p.muted.small.pool-hint", onSide ? "Picks go to your Side · click a card to put it in your Deck · right-click: details" : "Picks go to your Deck · click a card to move it to your Side · right-click: details");
  let body;
  if (onSide) body = side.length ? cardsOf(side) : h("p.muted.small.pool-empty", "Nothing in your Side yet.");
  else if (!deck.length) body = h("p.muted.small.pool-empty", empty);
  else
    body = h(
      "div.pool-deck",
      h("div.pool-part-head", h("b", "Main Deck"), h("span.muted.small", `${main.length}`)),
      main.length ? cardsOf(main) : h("p.muted.small.pool-empty", "No Main Deck cards."),
      h("div.pool-part-head", h("b", "Extra Deck"), h("span.muted.small", `${extra.length}`)),
      extra.length ? cardsOf(extra) : h("p.muted.small.pool-empty", "No Extra Deck cards.")
    );
  return h("div.pool-view", tabs, hint, body);
}
