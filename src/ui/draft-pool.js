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

/**
 * Vista di un pool con le schede Main / Extra e l'interruttore "Group by bundle".
 * state: { tab, grouped } (condiviso tra un render e l'altro); rarityOf(id) → { name, color } per i bundle.
 */
export function poolView(codes, binder, state, { onClick, onHover, onContext, rarityOf = () => null, empty = "No cards", rerender, fresh = null }) {
  const main = codes.filter((c) => !isExtra(c));
  const extra = codes.filter(isExtra);
  const shown = state.tab === "extra" ? extra : main;
  const hasBundles = binder.some((x) => x.round === 1);
  const tabs = h(
    "div.pool-tabs",
    h(`button.draft-tab${state.tab !== "extra" ? ".on" : ""}`, { onclick: () => { state.tab = "main"; rerender(); } }, `Main Deck (${main.length})`),
    h(`button.draft-tab${state.tab === "extra" ? ".on" : ""}`, { onclick: () => { state.tab = "extra"; rerender(); } }, `Extra Deck (${extra.length})`),
    hasBundles
      ? h("label.check.pool-grouping", h("input", { type: "checkbox", checked: !!state.grouped, onchange: (e) => { state.grouped = e.target.checked; rerender(); } }), "Group by bundle")
      : null
  );
  const opts = { onClick, onHover, onContext, fresh };
  let body;
  if (!shown.length) body = h("p.muted.small.pool-empty", empty);
  else if (state.grouped && hasBundles) {
    body = h(
      "div.pool-groups",
      groupByBundle(shown, binder).map((g) => {
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
  } else body = h("div.pool-cards", cardStacks(shown, opts));
  return h("div.pool-view", tabs, body);
}
