// Scheda di una combo (come la sezione combo di masterduelmeta): mano iniziale, passi illustrati con le
// scelte e le note, hand trap, tag della board finale, carte necessarie e varianti con le differenze.
import { h, icon } from "./dom.js";
import { cardFace, miniCards } from "./card.js";
import { openModal } from "./modal.js";
import { cardName } from "../data/db.js";
import { STEP_ACTIONS, NO_CARD, detailText, detailCodes, usedCards } from "../duel/trainer.js";
import { openDeckViewer } from "./editor.js";
import { comboStats, endBoard } from "./combo-meta.js";

const ZONE_NAMES = { s0: "S/T 1", s1: "S/T 2", s2: "S/T 3", s3: "S/T 4", s4: "S/T 5", f: "Field", m5: "EMZ left", m6: "EMZ right" };
const zoneName = (z) => ZONE_NAMES[z] ?? `Monster ${+z.slice(1) + 1}`;

/** Copie di ogni carta di un elenco: Map codice -> copie. */
const tally = (codes) => codes.reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map());

/** Primo passo in cui due combo differiscono (azione o carta), -1 se i passi sono uguali. */
function divergence(a, b) {
  const n = Math.max(a.steps.length, b.steps.length);
  for (let i = 0; i < n; i++) {
    const x = a.steps[i];
    const y = b.steps[i];
    if (!x || !y || x.kind !== y.kind || x.code !== y.code) return i;
  }
  return -1;
}

/** Carte che la variante usa in più e in meno rispetto alla combo originale. */
function cardDiff(root, v) {
  const a = tally((({ main, extra }) => [...main, ...extra])(usedCards(root)));
  const b = tally((({ main, extra }) => [...main, ...extra])(usedCards(v)));
  const more = [...b].filter(([c, n]) => n > (a.get(c) ?? 0)).map(([c]) => c);
  const less = [...a].filter(([c, n]) => n > (b.get(c) ?? 0)).map(([c]) => c);
  return { more, less };
}

const cardsRow = (codes, cls = "") => h(`div.schema-cards${cls}`, codes.map((code) => h("div.schema-card", { title: cardName(code) }, cardFace(code))));

/**
 * @param combo  combo da mostrare
 * @param family [originale, ...varianti] della combo
 * @param onPractice(combo), onOpen(combo): avvia l'allenamento / apre la scheda di un'altra variante
 */
export function showComboSchema(combo, { family = [combo], onPractice, onOpen } = {}) {
  const c = combo;
  const st = c.setup ?? {};
  const ints = c.interrupts ?? [];
  const intRow = (it) => h("li.schema-int", icon("bolt"), ` The opponent uses "${cardName(it.code)}"`);
  const steps = [];
  ints.filter((x) => x.after === 0).forEach((it) => steps.push(intRow(it)));
  c.steps.forEach((s, i) => {
    steps.push(
      h(
        "li.schema-step",
        h("span.schema-num", i + 1),
        NO_CARD.has(s.kind) ? h("div.schema-card.empty", icon(s.kind === "endphase" ? "skip_next" : "swap_vert")) : h("div.schema-card", { title: cardName(s.code) }, cardFace(s.code)),
        h(
          "div.schema-text",
          h("b", STEP_ACTIONS[s.kind] ?? s.kind, NO_CARD.has(s.kind) ? "" : ` "${cardName(s.code)}"`),
          s.details?.length ? h("ul.schema-details", s.details.map((d) => h("li", miniCards(detailCodes(d)), detailText(d)))) : null,
          s.note ? h("p.schema-note", icon("sticky_note_2"), " ", s.note) : null
        )
      )
    );
    ints.filter((x) => x.after === i + 1).forEach((it) => steps.push(intRow(it)));
  });

  const setupParts = [
    ["Your field", (st.me?.field ?? []).map((f) => `${cardName(f.code)} (${zoneName(f.zone)})`)],
    ["Your GY", (st.me?.gy ?? []).map(cardName)],
    ["Your banished cards", [...(st.me?.banished ?? []).map(cardName), ...(st.me?.banishedDown ?? []).map((code) => `${cardName(code)} (face-down)`)]],
    ["Top of your Deck", (st.me?.deckTop ?? []).map(cardName)],
    ["Opponent's field", (st.opp?.field ?? []).map((f) => `${cardName(f.code)} (${zoneName(f.zone)})`)],
    ["Opponent's hand", (st.opp?.hand ?? []).map(cardName)],
    ["Opponent's GY", (st.opp?.gy ?? []).map(cardName)],
  ].filter(([, v]) => v.length);

  const cards = usedCards(c);
  const list = c.cards ?? { main: [], extra: [] };
  const [root] = family;
  const variants = family.length > 1
    ? family.map((v) => {
        const at = v === root ? -1 : divergence(root, v);
        const diff = v === root ? null : cardDiff(root, v);
        const what = v === root
          ? "Original combo"
          : [
              at < 0 ? "Same steps" : at === 0 ? "Different from the first step" : `Same as the original up to step ${at}, then different`,
              diff.more.length ? `uses ${diff.more.map((x) => `"${cardName(x)}"`).join(", ")}` : "",
              diff.less.length ? `without ${diff.less.map((x) => `"${cardName(x)}"`).join(", ")}` : "",
            ].filter(Boolean).join(" · ");
        return h(
          `div.schema-variant${v.id === c.id ? ".on" : ""}`,
          h("div", h("b", v === root ? v.name : `↳ ${v.branch || "Variant"}`), h("div.muted.small", what)),
          v.id === c.id ? h("span.muted.small", "This one") : h("button.btn.small", { onclick: () => { m.close(); onOpen?.(v); } }, "Open")
        );
      })
    : null;

  const sec = (title, ...body) => h("section.schema-sec", h("h3.combo-sec", title), ...body);
  // Intestazione come ygopocket: mano → passi → board finale, i numeri della combo e le statistiche stimate.
  const stats = comboStats(c);
  const board = endBoard(c);
  const tagOf = new Map((c.tags ?? []).map((t) => [t.code, t.text]));
  const box = (ic, label, value) => h("div.cv-box", h("span.cv-box-label", icon(ic), ` ${label}`), h("b", value));
  const header = [
    h("div.cc-banner.cv-banner",
      h("div.cc-side", h("div.cc-label", "Starter", h("b", stats.starters)), h("div.cc-faces", c.hand.map((code) => h("div.cc-face", { title: cardName(code) }, cardFace(code))))),
      h("div.cc-mid", h("span.cc-pill", `${stats.steps} step${stats.steps === 1 ? "" : "s"}`)),
      h("div.cc-side.end", h("div.cc-label", "Final board", h("b", stats.board || "?")), h("div.cc-faces", board.length ? board.slice(0, 6).map((code) => h("div.cc-face", { title: cardName(code) }, cardFace(code))) : h("span.muted.small", "Practice it or play it with Auto-play once to save the final board")))),
    h("div.cc-chips", c.format ? h("span.cc-chip", c.format) : null, ...(c.archetypes ?? []).map((a) => h("span.cc-chip.arch", a)), c.difficulty ? h(`span.cc-chip.diff-${c.difficulty.toLowerCase()}`, c.difficulty) : null),
    h("div.cv-boxes",
      box("flag", "Starter", stats.starters), box("format_list_numbered", "Steps", stats.steps), box("emoji_events", "Final board", stats.board || "?"),
      box("speed", "Difficulty", c.difficulty ?? "—"), box("swap_horiz", "Turn", c.first ? "1st" : "2nd"), box("style", "Format", c.format ?? "—"), box("local_fire_department", "OTK", c.otk ? "Yes" : "No")),
    h("div.cv-statline", h("span.muted.small", "Stats:"),
      h("span.cc-chip", `${stats.normal} Normal Summons`), h("span.cc-chip", `${stats.special} Special Summons`),
      stats.handEnd != null ? h("span.cc-chip", `${stats.handEnd} cards in hand at the end`) : null,
      stats.nibiru ? h("span.cc-chip.otk", "Vulnerable to Nibiru") : null, stats.droll ? h("span.cc-chip.otk", "Vulnerable to Droll") : null,
      h("span.muted.small.cv-note", "heuristic estimates, not guarantees")),
  ];
  const m = openModal({
    title: c.parent ? `${c.name} — ${c.branch || "Variant"}` : c.name,
    className: "wide combo-schema",
    body: [
      ...header,
      h("div.muted.small", [c.first ? "Going first" : "Going second", `Decklist: ${list.main.length} Main · ${list.extra.length} Extra`].join(" · ")),
      c.notes ? h("p.schema-notes", c.notes) : null,
      sec("Starting hand", cardsRow(c.hand)),
      setupParts.length ? sec("Starting board state", h("ul.schema-setup", setupParts.map(([k, v]) => h("li", h("b", `${k}: `), v.join(", "))))) : null,
      sec("Steps", h("ol.schema-steps", steps)),
      board.length ? sec("Final board", h("div.schema-cards", board.map((code) => h("div.schema-card", { title: cardName(code) }, cardFace(code), tagOf.has(code) ? h("span.schema-tag", tagOf.get(code)) : null)))) : null,
      // La decklist si guarda nella schermata del deck builder, con evidenziate le carte che la combo usa.
      sec(
        "Decklist",
        h("div.decklist-summary", h("span", h("b", list.main.length), " Main"), h("span", h("b", list.extra.length), " Extra"), h("span", h("b", list.side?.length ?? 0), " Side"), h("span.muted", `the combo uses ${cards.main.length + cards.extra.length} cards`)),
        h(
          "div.sheet-tools",
          h("button.btn.small", {
            onclick: () =>
              openDeckViewer({
                main: list.main.length + list.extra.length ? list.main : cards.main,
                extra: list.main.length + list.extra.length ? list.extra : cards.extra,
                side: list.side ?? [],
                title: c.name,
                subtitle: "Decklist of the combo",
                marks: new Map([...tally([...cards.main, ...cards.extra])].map(([code, count]) => [code, { kind: "used", count }])),
                legend: "Highlighted: the cards the combo uses (starting hand, steps, precise choices, top of the Deck).",
              }),
          }, icon("style"), " View in the Deck Builder")
        )
      ),
      variants ? sec("Variants", h("div.schema-variants", variants)) : null,
    ],
    actions: [
      { label: "Close", value: null },
      ...(onPractice ? [{ label: "Practice", primary: true, onClick: (close) => { close(); onPractice(c); } }] : []),
    ],
  });
  return m.result;
}
