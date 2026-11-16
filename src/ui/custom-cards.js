// Carte personalizzate (dati in data/custom-cards.js), con un editor ispirato a Magic Set Editor
// (github.com/twanvl/MagicSetEditor2), pensato per Yu-Gi-Oh!: un "set" di carte in un'unica schermata.
//  - a sinistra le carte (cerca, nuova, importa, condividi);
//  - al centro la carta grande: si modifica cliccandola (nome, attributo, livello o tipo di Magia/Trappola, artwork,
//    testo, ATK/DEF), come in MSE;
//  - a destra le proprietà; tutto si salva da solo.
// Lo script Lua si scrive in una pagina a parte (ui/script-editor.js). "Save and try" prova la carta in un duello con
// il mazzo e lo stato di partenza scelti come nel Combo Trainer (ui/combos.js: tryCustomCard).
// Online servono le regole con "Allow unofficial cards"; l'avversario riceve le carte del mazzo (net/match.js).
import { h, clear, icon } from "./dom.js";
import { openModal, toast, confirmModal } from "./modal.js";
import { cardFace } from "./card.js";
import { db, typeLine } from "../data/db.js";
import { TYPE, ATTRIBUTES, RACES } from "../core/constants.js";
import { customCards, saveCustomCard, deleteCustomCard, newCustomCode, cardsToCode, cardsFromCode, getCustomCard, CARD_PREFIX } from "../data/custom-cards.js";
import { renderCardImage, artFromFile } from "./card-render.js";
import { autoScript, showScriptPage } from "./script-editor.js";
import { tryCustomCard } from "./combos.js";

const MONSTER_FRAMES = [
  ["normal", "Normal", TYPE.NORMAL],
  ["effect", "Effect", TYPE.EFFECT],
  ["ritual", "Ritual", TYPE.RITUAL | TYPE.EFFECT],
  ["fusion", "Fusion", TYPE.FUSION | TYPE.EFFECT],
  ["synchro", "Synchro", TYPE.SYNCHRO | TYPE.EFFECT],
  ["xyz", "Xyz", TYPE.XYZ | TYPE.EFFECT],
  ["link", "Link", TYPE.LINK | TYPE.EFFECT],
];
const ABILITIES = [[TYPE.TUNER, "Tuner"], [TYPE.FLIP, "Flip"], [TYPE.GEMINI, "Gemini"], [TYPE.SPIRIT, "Spirit"], [TYPE.UNION, "Union"], [TYPE.TOON, "Toon"]];
const SPELLS = [["Normal", 0], ["Quick-Play", TYPE.QUICKPLAY], ["Continuous", TYPE.CONTINUOUS], ["Equip", TYPE.EQUIP], ["Field", TYPE.FIELD], ["Ritual", TYPE.RITUAL]];
const TRAPS = [["Normal", 0], ["Continuous", TYPE.CONTINUOUS], ["Counter", TYPE.COUNTER]];
const ARROWS = [[0x40, "↖"], [0x80, "↑"], [0x100, "↗"], [0x8, "←"], [0, ""], [0x20, "→"], [0x1, "↙"], [0x2, "↓"], [0x4, "↘"]];
const FRAME_BITS = TYPE.NORMAL | TYPE.EFFECT | TYPE.RITUAL | TYPE.FUSION | TYPE.SYNCHRO | TYPE.XYZ | TYPE.LINK;

const blank = () => ({ code: newCustomCode(), name: "New card", desc: "", type: TYPE.MONSTER | TYPE.EFFECT, attribute: 0x20, race: 0x2000, level: 4, atk: 1800, def: 1000, lscale: 0, rscale: 0, linkMarker: 0, setcodes: [], strings: [], script: "", scriptAuto: true, art: null });
const bitCount = (n) => {
  let k = 0;
  for (; n; n &= n - 1) k++;
  return k;
};
const kindOf = (c) => (c.type & TYPE.MONSTER ? "monster" : c.type & TYPE.SPELL ? "spell" : "trap");

/** Editor di una carta: l'area di lavoro con quella carta (null = una carta nuova). */
export function editCustomCard(app, card) {
  return showCustomCards(app, card ? { select: card.code } : { create: true });
}

/** L'area di lavoro delle carte personalizzate. select: codice della carta aperta; create: ne crea una nuova. */
export async function showCustomCards(app, { select: selectCode = null, create = false } = {}) {
  const root = clear(app.root);
  let c = null; // carta aperta (copia modificabile)
  let saveTimer = 0;
  let filter = "";
  const status = h("span.muted.small.cc-saved");

  // ---- salvataggio automatico
  const saveSoon = () => {
    if (!c) return;
    status.textContent = "Saving…";
    clearTimeout(saveTimer);
    const card = c;
    saveTimer = setTimeout(async () => {
      try {
        Object.assign(card, await saveCustomCard(card));
        status.textContent = "Saved";
        paintList();
      } catch (e) {
        status.textContent = e.message;
      }
    }, 500);
  };
  const flush = async () => {
    clearTimeout(saveTimer);
    if (c) Object.assign(c, await saveCustomCard(c));
  };

  // ---- elenco (sinistra)
  const list = h("div.cc-list");
  const search = h("input.input.small", { placeholder: "Search your cards…", oninput: (e) => { filter = e.target.value.trim().toLowerCase(); paintList(); } });
  const paintList = () => {
    const all = customCards().filter((x) => !filter || `${x.name}\n${x.desc}`.toLowerCase().includes(filter));
    clear(list).append(
      ...(all.length
        ? all.map((x) =>
            h(
              `button.cc-item${c?.code === x.code ? ".on" : ""}`,
              { onclick: () => openCard(x.code) },
              h("span.cc-item-card", cardFace(x.code)),
              h("span.cc-item-text", h("b", x.name), h("span.muted.small", typeLine(db.cards.get(x.code) ?? x)))
            )
          )
        : [h("p.muted.small.cc-empty", customCards().length ? "No cards found." : "No custom cards yet: make one with New card.")])
    );
  };

  // ---- carta (centro): anteprima con le zone da cliccare, come in MSE
  const preview = h("img.cc-preview", { alt: "" });
  const hot = h("div.cc-hot");
  const pop = h("div.cc-pop", { hidden: true });
  const stage = h("div.cc-stage", preview, hot, pop);
  let paintTimer = 0;
  const paintCard = () => {
    clearTimeout(paintTimer);
    const card = c;
    paintTimer = setTimeout(async () => card === c && (preview.src = await renderCardImage(card)), 80);
  };
  const artInput = h("input", { type: "file", accept: "image/*", hidden: true });
  artInput.addEventListener("change", async () => {
    const f = artInput.files?.[0];
    artInput.value = "";
    if (!f || !c) return;
    try {
      c.art = await artFromFile(f);
      changed(false);
      paintProps();
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  });

  /** Una modifica: carta ridisegnata, script automatico aggiornato (se non l'ha cambiato l'utente) e salvataggio. */
  const changed = (regenScript = true) => {
    if (regenScript && c.scriptAuto !== false) {
      c.script = autoScript(c);
      c.scriptAuto = true;
    }
    paintCard();
    saveSoon();
  };

  // campi (servono sia al pannello delle proprietà sia ai riquadri sulla carta)
  const field = (label, el, hint = "") => h("label.field", h("span", label), el, hint ? h("small.muted", hint) : null);
  const num = (key, min, max, { allowUnknown = false } = {}) => {
    const el = h("input.input", { type: "text", inputMode: "numeric", value: c[key] === -2 ? "?" : String(c[key] ?? 0), title: allowUnknown ? "? = unknown" : "" });
    el.addEventListener("input", () => {
      const v = el.value.trim();
      c[key] = allowUnknown && v === "?" ? -2 : Math.max(min, Math.min(max, parseInt(v, 10) || 0));
      changed();
    });
    return el;
  };
  const select = (opts, value, on) => {
    const el = h("select.select", opts.map(([v, l]) => h("option", { value: v, selected: String(v) === String(value) }, l)));
    el.addEventListener("change", () => on(el.value));
    return el;
  };
  const nameInput = () => h("input.input", { value: c.name, maxLength: 60, oninput: (e) => { c.name = e.target.value; title.textContent = c.name; changed(); } });
  const descInput = () => h("textarea.input.cc-desc", { rows: 7, maxLength: 3000, value: c.desc, placeholder: "Card text (lore or effects)", oninput: (e) => { c.desc = e.target.value; changed(false); } });
  const attrSelect = () => select(ATTRIBUTES.map(([bit, l]) => [bit, l]), c.attribute, (v) => { c.attribute = +v; changed(false); });
  const subtypeSelect = () => {
    const k = kindOf(c);
    const list = k === "spell" ? SPELLS : TRAPS;
    const cur = list.find(([, bit]) => bit && c.type & bit)?.[1] ?? 0;
    return select(list.map(([l, bit]) => [bit, l]), cur, (v) => { c.type = (k === "spell" ? TYPE.SPELL : TYPE.TRAP) | +v; changed(); });
  };
  const arrowsGrid = (repaint) =>
    h("div.adv-arrows.cc-arrows", ARROWS.map(([bit, l]) => (bit ? h(`button.adv-arrow${c.linkMarker & bit ? ".on" : ""}`, { onclick: () => { c.linkMarker ^= bit; c.level = Math.max(1, bitCount(c.linkMarker)); changed(); repaint(); } }, l) : h("span.adv-arrow-mid", `LINK-${c.level}`))));
  const kindButtons = (after) =>
    h(
      "div.cc-kind",
      ...[["monster", "Monster"], ["spell", "Spell"], ["trap", "Trap"]].map(([v, l]) =>
        h(`button.btn.small${kindOf(c) === v ? ".primary" : ""}`, {
          onclick: (e) => {
            e.preventDefault();
            if (v === kindOf(c)) return;
            c.type = v === "monster" ? TYPE.MONSTER | TYPE.EFFECT : v === "spell" ? TYPE.SPELL : TYPE.TRAP;
            changed();
            paintHot();
            after?.();
          },
        }, l)
      )
    );

  // riquadri cliccabili sulla carta (posizioni sul disegno di card-render.js, 421×614)
  // (posizioni dello stile "Series 10" di Magic Set Editor, in % della carta di 421×614: vedi card-render.js)
  const pct = (x, y, w, h) => ({ x: (x / 421) * 100, y: (y / 614) * 100, w: (w / 421) * 100, h: (h / 614) * 100 });
  const pend = () => kindOf(c) === "monster" && !!(c.type & TYPE.PENDULUM) && !(c.type & TYPE.LINK);
  const pendInput = () => h("textarea.input.cc-desc", { rows: 4, maxLength: 1000, value: c.pendText ?? "", placeholder: "Pendulum Effect (in the box between the scales)", oninput: (e) => { c.pendText = e.target.value; changed(false); } });
  const zones = () => [
    { key: "name", ...pct(31, 25, 316, 43), title: "Name", body: () => nameInput() },
    { key: "attr", ...pct(350.5, 25, 43, 43), title: "Attribute", when: () => kindOf(c) === "monster", body: () => attrSelect() },
    { key: "kind", ...pct(350.5, 25, 43, 43), title: "Spell or Trap", when: () => kindOf(c) !== "monster", body: () => kindButtons(() => closePop()) },
    { key: "level", ...pct(48, 76.5, 331.5, 26), title: "Level / Rank", when: () => kindOf(c) === "monster" && !(c.type & TYPE.LINK), body: () => num("level", 0, 13) },
    { key: "sub", ...pct(48, 76.5, 331.5, 26), title: "Type", when: () => kindOf(c) !== "monster", body: () => subtypeSelect() },
    { key: "arrows", ...pct(48, 76.5, 331.5, 26), title: "Link Arrows", when: () => !!(c.type & TYPE.LINK), body: () => { const box = h("div"); const paint = () => clear(box).append(arrowsGrid(paint)); paint(); return box; } },
    { key: "art", ...(pend() ? pct(27, 109, 368, 235) : pct(49, 111.5, 323, 323)), title: "Artwork: click to choose an image", action: () => artInput.click() },
    { key: "pend", ...pct(66, 389, 288, 60), title: "Pendulum Effect", when: pend, body: () => pendInput() },
    { key: "desc", ...(kindOf(c) === "monster" ? pct(33, 464, 353, 92) : pct(33, 464, 353, 107.5)), title: "Card text", body: () => descInput() },
    { key: "stats", ...pct(250, 560, 140, 19), title: "ATK / DEF", when: () => kindOf(c) === "monster", body: () => h("div.cc-row", field("ATK", num("atk", -2, 1000000, { allowUnknown: true })), c.type & TYPE.LINK ? null : field("DEF", num("def", -2, 1000000, { allowUnknown: true }))) },
  ];
  const paintHot = () => {
    const ZONES = zones();
    clear(hot).append(
      ...ZONES.filter((z) => !z.when || z.when()).map((z) =>
        h("button.cc-zone", { title: z.title, style: `left:${z.x}%;top:${z.y}%;width:${z.w}%;height:${z.h}%`, onclick: (e) => { e.stopPropagation(); z.action ? z.action() : openPop(z); } })
      )
    );
  };
  const openPop = (z) => {
    pop.hidden = false;
    pop.style.left = `${Math.min(z.x, 40)}%`;
    pop.style.top = `${Math.min(z.y + z.h + 1, 62)}%`;
    clear(pop).append(h("div.cc-pop-head", h("b", z.title), h("button.btn.small.ghost", { title: "Close (Esc)", onclick: closePop }, icon("close"))), z.body());
    pop.querySelector("input, textarea, select")?.focus();
  };
  const closePop = () => {
    if (pop.hidden) return;
    pop.hidden = true;
    paintHot();
    paintProps(); // il pannello mostra quello che si è cambiato sulla carta
  };
  pop.addEventListener("click", (e) => e.stopPropagation());
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || (e.key === "Enter" && e.target.tagName === "INPUT")) closePop();
  });
  stage.addEventListener("click", closePop);

  // ---- proprietà (destra)
  const props = h("div.cc-props");
  const paintProps = () => {
    if (!c) return clear(props);
    const setNames = Object.entries(db.strings.setname ?? {}).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const monster = [];
    if (kindOf(c) === "monster") {
      const frame = MONSTER_FRAMES.find(([, , bits]) => (c.type & FRAME_BITS) === bits)?.[0] ?? (c.type & TYPE.NORMAL ? "normal" : "effect");
      const link = !!(c.type & TYPE.LINK);
      const xyz = !!(c.type & TYPE.XYZ);
      monster.push(
        h("div.cc-row",
          field("Frame", select(MONSTER_FRAMES.map(([v, l]) => [v, l]), frame, (f) => {
            c.type = (c.type & ~FRAME_BITS) | MONSTER_FRAMES.find(([v]) => v === f)[2];
            if (f === "link") {
              c.type &= ~TYPE.PENDULUM;
              c.level = Math.max(1, bitCount(c.linkMarker));
            }
            changed();
            paintHot();
            paintProps();
          })),
          field("Attribute", attrSelect()),
          field("Type", select(RACES.map(([bit, l]) => [bit, l]), c.race, (v) => { c.race = +v; changed(false); }))
        ),
        h("div.cc-row",
          ...[
            link ? field("Link Arrows", arrowsGrid(paintProps)) : field(xyz ? "Rank" : "Level", num("level", 0, 13)),
            field("ATK", num("atk", -2, 1000000, { allowUnknown: true })),
            link ? null : field("DEF", num("def", -2, 1000000, { allowUnknown: true })),
          ].filter(Boolean)
        ),
        h("div.cc-checks",
          h("label.check", h("input", { type: "checkbox", checked: !!(c.type & TYPE.PENDULUM), disabled: link, onchange: (e) => { c.type = e.target.checked ? c.type | TYPE.PENDULUM : c.type & ~TYPE.PENDULUM; changed(); paintProps(); } }), "Pendulum"),
          ...ABILITIES.map(([bit, l]) => h("label.check", h("input", { type: "checkbox", checked: !!(c.type & bit), onchange: (e) => { c.type = e.target.checked ? c.type | bit : c.type & ~bit; changed(false); } }), l))
        ),
        c.type & TYPE.PENDULUM ? h("div.cc-row", field("Left scale", num("lscale", 0, 15)), field("Right scale", num("rscale", 0, 15))) : null,
        c.type & TYPE.PENDULUM && !link ? field("Pendulum Effect", pendInput()) : null
      );
    } else monster.push(field(kindOf(c) === "spell" ? "Spell type" : "Trap type", subtypeSelect()));
    clear(props).append(
      ...[
        field("Name", nameInput()),
        // l'ID serve negli script di altre carte (es. Duel.CreateToken per un Token personalizzato)
        field("Card ID", h("input.input", { type: "text", readOnly: true, value: String(c.code), onfocus: (e) => e.target.select() }), "Use it in other cards' scripts (e.g. to create this card with Duel.CreateToken)."),
        field("Card", kindButtons(() => paintProps())),
        ...monster,
        field("Archetype", select([["", "None"], ...setNames], c.setcodes[0] ?? "", (v) => { c.setcodes = v ? [+v] : []; changed(false); }), "Optional: the card counts as part of that archetype"),
        field(kindOf(c) === "monster" && c.type & TYPE.PENDULUM ? "Monster Effect" : "Card text", descInput()),
        h("div.cc-row", h("button.btn.small", { onclick: () => artInput.click() }, icon("image"), " Artwork…"), c.art ? h("button.btn.small.ghost", { onclick: () => { c.art = null; changed(false); paintProps(); } }, "Remove artwork") : null),
        h(
          "div.cc-script-box",
          h("div", h("b", "Lua script"), h("span.muted.small", c.scriptAuto !== false ? " · automatic (Summon procedure of the card type)" : ` · ${c.script.split("\n").length} lines`)),
          h("button.btn.primary", { onclick: async () => { await flush(); showScriptPage(app, c, { onBack: (saved) => showCustomCards(app, { select: saved.code }) }); } }, icon("code"), " Edit script")
        ),
      ].filter(Boolean)
    );
  };

  // ---- carta aperta
  const openCard = async (code) => {
    await flush();
    const card = getCustomCard(code);
    if (!card) return;
    c = structuredClone(card);
    pop.hidden = true;
    status.textContent = "Saved";
    title.textContent = c.name;
    actions.hidden = false;
    paintList();
    paintCard();
    paintHot();
    paintProps();
  };
  const newCard = async () => {
    await flush();
    const b = blank();
    b.script = autoScript(b);
    const saved = await saveCustomCard(b);
    if (!stage.contains(preview)) stage.replaceChildren(preview, hot, pop);
    await openCard(saved.code);
  };

  const title = h("h1", "Custom cards");
  const actions = h(
    "div.page-tools",
    { hidden: true },
    status,
    h("button.btn", { title: "Duplicate this card", onclick: async () => { await flush(); const copy = await saveCustomCard({ ...c, code: newCustomCode(), name: `${c.name} (copy)` }); openCard(copy.code); } }, icon("content_copy"), " Duplicate"),
    h("button.btn", { title: "Copy the code of this card (import it in another Helios)", onclick: async () => { await flush(); shareCards([c]); } }, icon("share"), " Share"),
    h("button.btn.danger", { title: "Delete this card", onclick: async () => { if (await confirmModal("Delete card?", `"${c.name}" will be removed (also from your Decks).`, "Delete", "Cancel")) { clearTimeout(saveTimer); await deleteCustomCard(c.code); c = null; const next = customCards()[0]; next ? openCard(next.code) : showCustomCards(app); } } }, icon("delete")),
    h("button.btn.primary", { title: "Choose a Deck and the starting hand / board state, then play a Duel with this card", onclick: async () => { await flush(); const card = c; tryCustomCard(app, card, { onExit: () => showCustomCards(app, { select: card.code }) }); } }, icon("sports_esports"), " Save and try")
  );
  root.append(
    h(
      "div.page.cc-page",
      h("div.page-head", h("button.btn.ghost.round.page-back", { title: "Back (right-click)", onclick: async () => { await flush(); app.home(); } }, icon("chevron_left")), title, actions),
      h(
        "div.cc-work",
        h(
          "aside.cc-side",
          h("div.cc-side-tools",
            h("button.btn.small.primary", { onclick: newCard }, icon("add"), " New card"),
            h("button.btn.small", { title: "Import a card code", onclick: () => importCards().then((codes) => codes?.length && openCard(codes[0])) }, icon("download"), " Import"),
            h("button.btn.small.ghost", { title: "Copy the code of all your custom cards", onclick: async () => { await flush(); customCards().length && shareCards(customCards()); } }, icon("share"))
          ),
          search,
          list
        ),
        h("div.cc-center", stage, h("p.muted.small.cc-tip", "Click a part of the card to edit it: name, attribute, level, artwork, text, ATK/DEF."), artInput),
        props
      )
    )
  );
  paintList();
  if (create) await newCard();
  else if (selectCode && getCustomCard(selectCode)) await openCard(selectCode);
  else if (customCards()[0]) await openCard(customCards()[0].code);
  else stage.replaceChildren(h("div.replay-empty", icon("draw"), h("b", "No custom cards yet"), h("span.muted.small", "Make a card with its own artwork, text and Lua script: it works in the Deck builder, in Duels and online (your opponent receives it)."), h("button.btn.primary", { onclick: newCard }, icon("add"), " New card")));
}

async function shareCards(cards) {
  const code = await cardsToCode(cards);
  const show = () =>
    openModal({ title: "Card code", body: [h("p.muted.small", "Copy this code and import it in another Helios client (Deck → Custom cards → Import)."), h("textarea.input.combo-code", { readOnly: true, rows: 6, value: code, onfocus: (e) => e.target.select() })], actions: [{ label: "Close", value: null, primary: true }] });
  if (!navigator.clipboard?.writeText) return show();
  navigator.clipboard.writeText(code).then(() => toast(cards.length === 1 ? `Card code copied: "${cards[0].name}"` : `Code of ${cards.length} cards copied`), show);
}

/** Importa un codice di carte; restituisce i codici delle carte importate. */
async function importCards() {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    /* appunti non accessibili */
  }
  if (!String(text).trim().startsWith(CARD_PREFIX)) {
    const area = h("textarea.input.combo-code", { rows: 6, placeholder: `${CARD_PREFIX}...` });
    const v = await openModal({ title: "Import cards", body: [h("p.muted.small", "Paste the card code:"), area], actions: [{ label: "Cancel", value: null }, { label: "Import", primary: true, onClick: (close) => close(area.value) }] }).result;
    if (!v) return [];
    text = v;
  }
  try {
    const cards = await cardsFromCode(text);
    // Stesso codice di una carta che c'è già: è la stessa carta (aggiornata), non una nuova.
    for (const c of cards) await saveCustomCard(c);
    toast(cards.length === 1 ? `Card imported: "${cards[0].name}"` : `${cards.length} cards imported`);
    return cards.map((c) => c.code);
  } catch (e) {
    openModal({ title: "Import cards", body: [h("p", e.message)], actions: [{ label: "Close", value: null, primary: true }] });
    return [];
  }
}
