// HDPC (Hypergeometric Distribution Probability Calculator): calcolatore della distribuzione ipergeometrica per sapere quanto è probabile
// aprire certe carte nella mano iniziale (come stattrek.com e deck-probability.com).
//  - gruppi di carte del mazzo (es. "Starter", "Extender", "Hand trap"): ogni carta sta in un solo gruppo;
//  - mani desiderate: per ogni gruppo un minimo e un massimo di copie in mano; più mani alternative (OR);
//  - calcolo esatto con l'ipergeometrica multivariata (si enumerano le combinazioni di copie pescate).
import { h, clear, icon } from "./dom.js";
import { cardFace } from "./card.js";
import { getCard, cardName } from "../data/db.js";
import { settings } from "../data/settings.js";
import { loadDecks } from "../deck/deck.js";
import { openDeckPicker } from "./editor.js";

const KEY = "ygoweb.hdpc";
const MAX_GROUPS = 8;

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") ?? {};
  } catch {
    return {};
  }
}
function saveState(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage non disponibile */
  }
}

// ------------------------------------------------------------- matematica

/** Coefficienti binomiali C(n, k) in virgola mobile (esatti fino a valori molto più grandi di quelli di un mazzo). */
const binomCache = new Map();
export function binom(n, k) {
  if (k < 0 || k > n || n < 0) return 0;
  k = Math.min(k, n - k);
  const key = n * 1000 + k;
  if (binomCache.has(key)) return binomCache.get(key);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  binomCache.set(key, r);
  return r;
}

/** P(X = x) dell'ipergeometrica: N carte, K successi, n pescate. */
export function hyperPmf(N, K, n, x) {
  return (binom(K, x) * binom(N - K, n - x)) / binom(N, n);
}

/**
 * Probabilità di aprire almeno una delle mani desiderate.
 * @param N carte nel mazzo, @param n carte in mano, @param sizes copie di ogni gruppo
 * @param scenarios [[{ g, min, max }]]: ogni mano è un elenco di requisiti (tutti veri), le mani sono in OR
 * @returns { any, each: [probabilità di ogni mano] }
 */
export function handOdds(N, n, sizes, scenarios) {
  const total = binom(N, n);
  const other = N - sizes.reduce((a, b) => a + b, 0);
  const each = scenarios.map(() => 0);
  let any = 0;
  if (other < 0 || n > N || !total) return { any: 0, each };
  const k = new Array(sizes.length).fill(0);
  const ok = (sc) => sc.every((r) => k[r.g] >= r.min && k[r.g] <= r.max);
  const walk = (i, used, ways) => {
    if (i === sizes.length) {
      const rest = n - used;
      if (rest > other) return;
      const p = (ways * binom(other, rest)) / total;
      let hit = false;
      scenarios.forEach((sc, j) => {
        if (ok(sc)) {
          each[j] += p;
          hit = true;
        }
      });
      if (hit) any += p;
      return;
    }
    for (let x = 0; x <= Math.min(sizes[i], n - used); x++) {
      k[i] = x;
      walk(i + 1, used + x, ways * binom(sizes[i], x));
    }
    k[i] = 0;
  };
  walk(0, 0, 1);
  return { any, each };
}

const pct = (p) => `${(p * 100).toFixed(p > 0 && p < 0.001 ? 4 : 2)}%`;
const oneIn = (p) => (p > 0 ? `≈ 1 in ${p >= 0.5 ? (1 / p).toFixed(2) : Math.round(1 / p).toLocaleString("en-US")}` : "never");

// ------------------------------------------------------------- pagina

export function showHdpc(app) {
  const root = clear(app.root);
  const decks = loadDecks();
  let all = loadState();
  // La dimensione del mazzo viene dal mazzo scelto (Main Deck): non si scrive a mano.
  const deckSel = h("select.select", decks.map((d) => h("option", { value: d.id }, `${d.name} (${d.main.length})`)));
  deckSel.value = decks.some((d) => d.id === settings.lastDeck) ? settings.lastDeck : decks[0]?.id ?? "";
  const deck = () => decks.find((d) => d.id === deckSel.value) ?? null;
  const fresh = () => ({
    hand: 5,
    groups: [{ name: "Starter", cards: [], count: 3 }],
    scenarios: [[{ g: 0, min: 1, max: 99 }]],
  });
  let st = all[deckSel.value || "_"] ?? fresh();
  const store = () => {
    all = { ...all, [deckSel.value || "_"]: st };
    saveState(all);
  };

  const handIn = h("input.input.hdpc-count", { type: "number", min: 1, max: 20, value: st.hand, title: "Cards in the starting hand" });
  const groupsEl = h("div.hdpc-groups");
  const scenEl = h("div.hdpc-scenarios");
  const result = h("div.hdpc-result");

  const N = () => deck()?.main.length ?? 40;
  const copiesInDeck = (code) => deck()?.main.filter((c) => c === code).length ?? 0;
  /** Copie del gruppo: le carte scelte dal mazzo, oppure il numero scritto a mano. */
  const size = (g) => (deck() && g.cards.length ? g.cards.reduce((a, c) => a + copiesInDeck(c), 0) : Math.max(0, g.count | 0));

  function renderGroups() {
    clear(groupsEl).append(
      ...st.groups.map((g, i) => {
        const name = h("input.input.hdpc-name", { value: g.name, maxLength: 30, oninput: () => { g.name = name.value; renderScenarios(); compute(); } });
        const count = h("input.input.hdpc-count", { type: "number", min: 0, max: 60, value: size(g), disabled: !!(deck() && g.cards.length), title: "Copies of this group in the Deck", oninput: () => { g.count = +count.value || 0; compute(); } });
        const cards = h(
          "div.hdpc-cards",
          g.cards.map((code, j) =>
            h("button.hdpc-card", { title: `${cardName(code)} (${copiesInDeck(code)} in the Deck) — click to remove`, onclick: () => { g.cards.splice(j, 1); renderGroups(); compute(); } }, cardFace(code), h("b", `×${copiesInDeck(code)}`))
          ),
          deck() &&
            h("button.btn.small.ghost", {
              onclick: async () => {
                // Le carte del gruppo si scelgono nella schermata del deck builder: una copia per carta
                // (il gruppo conta tutte le copie nel mazzo), senza quelle già in altri gruppi.
                const others = new Set(st.groups.filter((x) => x !== g).flatMap((x) => x.cards));
                const v = await openDeckPicker({
                  main: [...new Set(deck().main)].filter((code) => !others.has(code)),
                  extra: deck().extra,
                  side: deck().side,
                  picked: [...g.cards],
                  title: deck().name,
                  label: g.name || "Group",
                  max: 60,
                  hint: "Each card counts with all its copies in the Deck. Cards already in other groups are not shown.",
                });
                if (!v) return;
                g.cards = [...new Set(v)];
                renderGroups();
                compute();
              },
            }, icon("style"), " Choose in the Deck Builder")
        );
        return h(
          "div.hdpc-group",
          h("div.hdpc-group-head", h("span.hdpc-dot", { style: `background: hsl(${i * 47 + 190}, 80%, 60%)` }), name, h("label.hdpc-copies", count, " copies"), st.groups.length > 1 && h("button.btn.small.ghost", { title: "Remove group", onclick: () => removeGroup(i) }, icon("close"))),
          cards
        );
      }),
      ...(st.groups.length >= MAX_GROUPS ? [] : [h("button.btn.small", { onclick: () => { st.groups.push({ name: `Group ${st.groups.length + 1}`, cards: [], count: 3 }); renderGroups(); renderScenarios(); compute(); } }, icon("add"), " Add group")])
    );
  }

  function removeGroup(i) {
    st.groups.splice(i, 1);
    // Requisiti sul gruppo eliminato: tolti; gli altri scalano di indice.
    st.scenarios = st.scenarios.map((sc) => sc.filter((r) => r.g !== i).map((r) => ({ ...r, g: r.g > i ? r.g - 1 : r.g }))).filter((sc) => sc.length);
    if (!st.scenarios.length) st.scenarios = [[{ g: 0, min: 1, max: 99 }]];
    renderGroups();
    renderScenarios();
    compute();
  }

  function renderScenarios() {
    clear(scenEl).append(
      ...st.scenarios.flatMap((sc, i) => [
        i > 0 ? h("div.hdpc-or", "OR") : null,
        h(
          "div.hdpc-scenario",
          h("div.hdpc-scenario-head", h("b", `Hand ${i + 1}`), h("span.hdpc-each", { dataset: { i } }), st.scenarios.length > 1 && h("button.btn.small.ghost", { title: "Remove this hand", onclick: () => { st.scenarios.splice(i, 1); renderScenarios(); compute(); } }, icon("close"))),
          ...sc.map((r, j) => {
            const g = h("select.select", st.groups.map((x, k) => h("option", { value: k }, x.name || `Group ${k + 1}`)));
            g.value = String(r.g);
            g.addEventListener("change", () => { r.g = +g.value; compute(); });
            const min = h("input.input", { type: "number", min: 0, max: 20, value: r.min, oninput: () => { r.min = Math.max(0, +min.value || 0); compute(); } });
            const max = h("input.input", { type: "number", min: 0, max: 20, value: r.max >= 99 ? "" : r.max, placeholder: "any", oninput: () => { r.max = max.value === "" ? 99 : Math.max(0, +max.value); compute(); } });
            return h("div.hdpc-req", h("span.muted", j ? "and" : "Open"), h("span", "at least"), min, h("span", "at most"), max, h("span", "of"), g, sc.length > 1 && h("button.btn.small.ghost", { title: "Remove", onclick: () => { sc.splice(j, 1); renderScenarios(); compute(); } }, icon("close")));
          }),
          h("button.btn.small.ghost", { onclick: () => { sc.push({ g: 0, min: 1, max: 99 }); renderScenarios(); compute(); } }, icon("add"), " And…")
        ),
      ]).filter(Boolean),
      h("button.btn.small", { onclick: () => { st.scenarios.push([{ g: 0, min: 1, max: 99 }]); renderScenarios(); compute(); } }, icon("add"), " Or another hand")
    );
  }

  function compute() {
    st.hand = Math.max(1, +handIn.value || 5);
    store();
    const sizes = st.groups.map(size);
    const total = N();
    const used = sizes.reduce((a, b) => a + b, 0);
    if (used > total) {
      clear(result).append(h("div.hdpc-big.bad", "—"), h("p.muted", `The groups have ${used} cards but the Deck has only ${total}.`));
      return;
    }
    const { any, each } = handOdds(total, st.hand, sizes, st.scenarios);
    clear(result).append(
      h("div.hdpc-big", pct(any)),
      h("div.muted", `chance to open ${st.scenarios.length > 1 ? "at least one of these hands" : "this hand"} · ${oneIn(any)}`),
      h("div.muted.small", `Deck ${total} cards · hand ${st.hand} cards`)
    );
    scenEl.querySelectorAll(".hdpc-each").forEach((el) => (el.textContent = st.scenarios.length > 1 ? pct(each[+el.dataset.i]) : ""));
  }

  const sync = () => {
    st = all[deckSel.value || "_"] ?? fresh();
    handIn.value = st.hand;
    renderGroups();
    renderScenarios();
    compute();
  };
  deckSel.addEventListener("change", () => {
    if (deckSel.value) settings.lastDeck = deckSel.value;
    sync();
  });
  handIn.addEventListener("input", compute);

  root.append(
    h(
      "div.page.hdpc",
      h("div.page-head", h("button.btn.ghost.round.page-back", { title: "Back (right-click)", onclick: () => app.home("training") }, icon("chevron_left")), h("h1", "HDPC", h("small.page-sub", "Hypergeometric Distribution Probability Calculator"))),
      h(
        "div.hdpc-grid",
        h(
          "div.hdpc-main",
          h(
            "section.card-box.hdpc-setup",
            h("label.field", h("span", "Deck"), deckSel),
            // Come le copie dei gruppi: campo piccolo con la scritta accanto.
            h("label.hdpc-copies.hdpc-hand", handIn, " cards in hand"),
            h("div.hdpc-quick-hand", h("button.btn.small.ghost", { onclick: () => { handIn.value = 5; compute(); } }, "Going first (5)"), h("button.btn.small.ghost", { onclick: () => { handIn.value = 6; compute(); } }, "Going second (6)"))
          ),
          h("section.card-box", h("h3", "Card groups"), h("p.muted.small", "Put the cards of the Deck in groups (each card in one group): e.g. your starters, extenders, hand traps. A group without cards counts the copies you write next to its name."), groupsEl),
          h("section.card-box", h("h3", "Hands you want to open"), h("p.muted.small", "A hand is a list of requirements that must all be true. With more hands, the result is the chance of opening at least one of them."), scenEl)
        ),
        h("aside.hdpc-side", h("section.card-box.hdpc-result-box", h("h3", "Result"), result), quickCalculator())
      )
    )
  );
  sync();
}

/** Calcolatore singolo come stattrek.com: N, K, n, x → P(X = x), P(X < x)... */
function quickCalculator() {
  const num = (v, min, max) => h("input.input", { type: "number", value: v, min, max });
  const N = num(40, 1, 100);
  const K = num(3, 0, 100);
  const n = num(5, 1, 100);
  const x = num(1, 0, 100);
  const out = h("table.hdpc-table");
  const calc = () => {
    const [nN, nK, nn, nx] = [N, K, n, x].map((el) => Math.max(0, Math.floor(+el.value || 0)));
    if (nK > nN || nn > nN) return clear(out).append(h("tr", h("td", { colSpan: 2 }, "K and n cannot be larger than N.")));
    const pmf = (k) => hyperPmf(nN, nK, nn, k);
    let lt = 0;
    for (let k = 0; k < nx; k++) lt += pmf(k);
    const eq = pmf(nx);
    const rows = [[`P(X = ${nx})`, eq], [`P(X < ${nx})`, lt], [`P(X ≤ ${nx})`, lt + eq], [`P(X > ${nx})`, Math.max(0, 1 - lt - eq)], [`P(X ≥ ${nx})`, Math.max(0, 1 - lt)]];
    clear(out).append(...rows.map(([l, p]) => h("tr", h("td", l), h("td", pct(p)))));
  };
  for (const el of [N, K, n, x]) el.addEventListener("input", calc);
  calc();
  return h(
    "section.card-box.hdpc-quick",
    h("h3", "Quick calculator"),
    h("p.muted.small", "Population N, successes K in the population, sample size n, successes x in the sample."),
    h("div.hdpc-quick-grid", h("label.field", h("span", "Deck size (N)"), N), h("label.field", h("span", "Copies (K)"), K), h("label.field", h("span", "Hand size (n)"), n), h("label.field", h("span", "In hand (x)"), x)),
    out
  );
}

export { getCard };
