// Deck Editor: ricerca carte, costruzione del mazzo, banlist, import/export.
import { h, clear, download, pickFile, icon } from "./dom.js";
import { cardFace } from "./card.js";
import { createDetailPanel } from "./detail.js";
import { openModal, toast, confirmModal, promptModal, alertModal } from "./modal.js";
import { db, getCard, isExtraDeckCard, statLine } from "../data/db.js";
import { settings, artUrl } from "../data/settings.js";
import { ATTRIBUTES, RACES, TYPE } from "../core/constants.js";
import {
  loadDecks, saveDecks, emptyDeck, parseDeckText, toYdk, toYdke, toOmega, banlistByName, cardLimit, validateDeck, sortDeckPart,
} from "../deck/deck.js";

const MAX = { main: 60, extra: 15, side: 15 };

// Importa un mazzo: "clipboard" (appunti), "paste" (testo incollato a mano) o "file" (.ydk).
// Formati riconosciuti da soli: .ydk, ydke://, codice di YGO Omega, lista "3 Nome carta". Restituisce il mazzo o null.
async function importDeck(mode) {
  let text;
  let name = "Imported Deck";
  if (mode === "file") {
    const f = await pickFile(".ydk,.txt,text/plain");
    if (!f) return null;
    text = await f.text();
    name = f.name.replace(/\.(ydk|txt)$/i, "");
  } else if (mode === "clipboard") {
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = null; // permesso negato o browser senza accesso agli appunti: si incolla a mano
    }
    if (!text?.trim()) return importDeck("paste");
  } else {
    text = await pasteModal();
    if (text == null) return null;
  }
  try {
    const { deck, format, missing } = await parseDeckText(text, name);
    if (format === "omega") deck.name = "Imported Deck (Omega)";
    const total = deck.main.length + deck.extra.length + deck.side.length;
    if (!total) throw new Error("The deck is empty: no card codes found.");
    if (missing.length) alertModal("Some cards were not found", `${missing.length} card name(s) are not in the database and were skipped:\n${missing.slice(0, 15).join("\n")}`);
    toast(`Deck imported (${{ ydk: "YDK", ydke: "ydke://", omega: "Omega code", recipe: "card list" }[format]}, ${total} cards)`);
    return deck;
  } catch (e) {
    alertModal("Import failed", e.message);
    return null;
  }
}

/** Finestra con un'area di testo multiriga (un campo su una riga sola perderebbe gli a capo dei .ydk). */
function pasteModal() {
  const area = h("textarea.input.paste-area", { rows: 10, placeholder: "Paste here: Omega deck code, .ydk text, ydke:// link or a card list (e.g. \"3 Ash Blossom & Joyous Spring\")" });
  const m = openModal({
    title: "Import deck",
    className: "wide",
    body: [area, h("p.muted.small", "From YGO Omega: Deck Manager → Export → \"Clipboard code\" or \"Clipboard YDK\", then paste here.")],
    actions: [{ label: "Cancel", value: null }, { label: "Import", primary: true, onClick: (close) => close(area.value) }],
  });
  setTimeout(() => area.focus(), 30);
  return m.result.then((v) => (v == null ? null : String(v)));
}

// Scatola del mazzo disegnata in CSS, con l'artwork della prima carta sul fronte.
function deckBox(deck) {
  const lead = deck.main.find((c) => getCard(c)) ?? deck.extra.find((c) => getCard(c));
  const hue = [...deck.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 0);
  const art = lead && h("img", { src: artUrl(lead), alt: "", loading: "lazy", draggable: false, onerror: (e) => e.target.remove() });
  return h("div.deck-box", { style: { "--hue": hue } }, h("div.deck-box-front", art), h("div.deck-box-side"), h("div.deck-box-top"));
}

// ------------------------------------------------------------ elenco mazzi (schermata "DECK" di MDPro3)
export function showDeckList(app) {
  const root = clear(app.root);
  let decks = loadDecks();
  let selecting = false;
  const chosen = new Set();
  const grid = h("div.decks-grid");
  const count = h("span.decks-count");
  const filter = h("input.input", { type: "search", placeholder: "Search decks", oninput: () => render() });
  const delSel = h("button.btn.danger", { hidden: true, onclick: () => remove([...chosen]) });
  const selBtn = h("button.btn", { title: "Select multiple decks to delete", onclick: () => { selecting = !selecting; chosen.clear(); render(); } });

  const save = () => saveDecks(decks);
  const open = (d) => { settings.lastDeck = d.id; showEditor(app); };

  async function remove(ids) {
    if (!ids.length) return;
    const names = decks.filter((d) => ids.includes(d.id)).map((d) => d.name);
    const ok = ids.length === 1
      ? await confirmModal("Delete deck?", `"${names[0]}" will be permanently deleted.`, "Delete", "Cancel", { danger: true })
      : await confirmModal(`Delete ${ids.length} decks?`, names.map((n) => `• ${n}`).join("\n"), "Delete", "Cancel", { danger: true });
    if (!ok) return;
    decks = decks.filter((d) => !ids.includes(d.id));
    if (ids.includes(settings.lastDeck)) settings.lastDeck = decks[0]?.id ?? null;
    save();
    selecting = false;
    chosen.clear();
    toast(ids.length === 1 ? "Deck deleted" : `${ids.length} decks deleted`);
    render();
  }

  const add = (d) => {
    if (!d) return;
    decks.push(d);
    save();
    open(d);
  };

  function render() {
    const text = filter.value.trim().toLowerCase();
    count.textContent = decks.length;
    selBtn.replaceChildren(icon(selecting ? "close" : "delete_sweep"), selecting ? " Cancel" : " Delete multiple");
    selBtn.classList.toggle("toggle", selecting);
    selBtn.classList.toggle("on", selecting);
    delSel.hidden = !selecting;
    delSel.disabled = chosen.size === 0;
    delSel.replaceChildren(icon("delete"), ` Delete (${chosen.size})`);
    const tiles = decks
      .filter((d) => !text || d.name.toLowerCase().includes(text))
      .map((d) => {
        const tile = h(
          `div.deck-tile${d.id === settings.lastDeck ? ".active" : ""}${chosen.has(d.id) ? ".chosen" : ""}`,
          { tabIndex: 0, title: `${d.main.length} main · ${d.extra.length} extra · ${d.side.length} side` },
          deckBox(d),
          h("div.deck-tile-name", d.name),
          h("div.deck-tile-meta", `${d.main.length} · ${d.extra.length} · ${d.side.length}`),
          selecting
            ? h("span.deck-tile-check", icon(chosen.has(d.id) ? "check_box" : "check_box_outline_blank"))
            : h("button.deck-tile-del", { title: "Delete deck", onclick: (e) => { e.stopPropagation(); remove([d.id]); } }, icon("delete"))
        );
        const act = () => {
          if (!selecting) return open(d);
          chosen.has(d.id) ? chosen.delete(d.id) : chosen.add(d.id);
          render();
        };
        tile.addEventListener("click", act);
        tile.addEventListener("keydown", (e) => e.key === "Enter" && act());
        return tile;
      });
    clear(grid).append(
      h("button.deck-tile.new", { title: "New Deck", onclick: async () => { const n = await promptModal("New Deck", "Name", "New Deck"); if (n) add(emptyDeck(n)); } }, h("span.plus", icon("add")), h("div.deck-tile-name", "New Deck")),
      ...tiles
    );
  }

  root.append(
    h(
      "div.page.decks",
      h(
        "header.decks-head",
        h("button.btn.ghost.round", { title: "Menu", onclick: () => app.home() }, icon("chevron_left")),
        h("h1", "Deck"),
        h("span.decks-num", icon("inventory_2"), count),
        h("div.spacer"),
        h("button.btn.primary", { title: "Omega code, .ydk text, ydke:// or card list from the clipboard", onclick: async () => add(await importDeck("clipboard")) }, icon("content_paste"), " Import from clipboard"),
        h("button.btn", { onclick: async () => add(await importDeck("paste")) }, icon("edit_note"), " Paste text"),
        h("button.btn", { onclick: async () => add(await importDeck("file")) }, icon("upload_file"), " .ydk file"),
        selBtn,
        delSel
      ),
      grid,
      h("footer.decks-foot", h("span.tag.solid", "Local decks"), filter)
    )
  );
  render();
}

export function showEditor(app) {
  const root = clear(app.root);
  let decks = loadDecks();
  if (!decks.length) decks = [emptyDeck()];
  let deck = decks.find((d) => d.id === settings.lastDeck) ?? decks[0];
  let banlist = banlistByName(settings.lastBanlist ?? db.banlists[0]?.name);
  const detail = createDetailPanel({
    actions: (code) => {
      const extra = isExtraDeckCard(getCard(code));
      return [
        h("button.btn.small.add-main", { onclick: () => addCard(code) }, extra ? "+ Extra" : "+ Main"),
        h("button.btn.small.add-side", { onclick: () => addCard(code, "side") }, "+ Side"),
      ];
    },
  });

  const persist = () => {
    saveDecks(decks);
    settings.lastDeck = deck.id;
  };

  // ------------------------------------------------------------ barra superiore
  const deckSel = h("select.select");
  const refreshDeckSel = () => {
    clear(deckSel).append(...decks.map((d) => h("option", { value: d.id }, d.name)));
    deckSel.value = deck.id;
  };
  deckSel.addEventListener("change", () => {
    deck = decks.find((d) => d.id === deckSel.value);
    persist();
    renderDeck();
  });
  const banSel = h("select.select", h("option", { value: "" }, "No banlist"), db.banlists.map((b) => h("option", { value: b.name }, b.name)));
  banSel.value = banlist?.name ?? "";
  banSel.addEventListener("change", () => {
    banlist = banlistByName(banSel.value);
    settings.lastBanlist = banSel.value;
    renderDeck();
    runSearch();
  });
  const validity = h("button.validity", { onclick: () => {
    const errs = validateDeck(deck, banlist);
    alertModal(errs.length ? "Deck issues" : "Valid deck", errs.length ? errs.join("\n") : "The deck follows the rules and the selected banlist.");
  } });

  const menu = (label, items) => {
    const btn = h("button.btn", label);
    btn.addEventListener("click", () => {
      const r = btn.getBoundingClientRect();
      const m = h("div.dropdown", items.map(([text, fn]) => h("button.dropdown-item", { onclick: () => { m.remove(); fn(); } }, text)));
      Object.assign(m.style, { left: r.left + "px", top: r.bottom + 4 + "px" });
      document.body.append(m);
      setTimeout(() => document.addEventListener("mousedown", function off(e) {
        if (!m.contains(e.target)) { m.remove(); document.removeEventListener("mousedown", off); }
      }), 0);
    });
    return btn;
  };

  const addDeck = (d) => {
    decks.push(d);
    deck = d;
    persist();
    refreshDeckSel();
    renderDeck();
  };

  // Elimina i mazzi indicati; ne resta sempre almeno uno (vuoto) da modificare.
  const deleteDecks = (ids) => {
    decks = decks.filter((d) => !ids.includes(d.id));
    if (!decks.length) decks.push(emptyDeck());
    if (!decks.includes(deck)) deck = decks[0];
    persist();
    refreshDeckSel();
    renderDeck();
    toast(ids.length === 1 ? "Deck deleted" : `${ids.length} decks deleted`);
  };

  const deleteCurrent = async () => {
    if (!(await confirmModal("Delete deck?", `"${deck.name}" will be permanently deleted.`, "Delete", "Cancel", { danger: true }))) return;
    deleteDecks([deck.id]);
  };

  const manageDecks = () => {
    const chosen = new Set();
    let delBtn;
    const update = () => {
      delBtn.disabled = chosen.size === 0;
      delBtn.textContent = chosen.size ? `Delete selected (${chosen.size})` : "Delete selected";
    };
    const rows = decks.map((d) =>
      h(
        "label.deck-row",
        h("input", { type: "checkbox", onchange: (e) => { e.target.checked ? chosen.add(d.id) : chosen.delete(d.id); update(); } }),
        h("span.deck-row-name", d.name),
        h("span.muted.small", `${d.main.length} main · ${d.extra.length} extra · ${d.side.length} side`),
        h("button.btn.small.danger", {
          onclick: async (e) => {
            e.preventDefault();
            m.close();
            if (await confirmModal("Delete deck?", `"${d.name}" will be permanently deleted.`, "Delete", "Cancel", { danger: true })) deleteDecks([d.id]);
            else manageDecks();
          },
        }, "Delete")
      )
    );
    const m = openModal({
      title: `Your decks (${decks.length})`,
      className: "wide",
      body: [h("div.deck-list", rows)],
      actions: [
        { label: "Close", value: null },
        {
          label: "Delete selected",
          danger: true,
          onClick: async (close) => {
            const ids = [...chosen];
            close();
            const names = decks.filter((d) => ids.includes(d.id)).map((d) => `• ${d.name}`).join("\n");
            if (await confirmModal(`Delete ${ids.length} decks?`, names, "Delete", "Cancel", { danger: true })) deleteDecks(ids);
            else manageDecks();
          },
        },
      ],
    });
    delBtn = m.buttons[1];
    update();
  };

  const toolbar = h(
    "div.editor-toolbar",
    h("button.btn.ghost.round", { title: "Decks", onclick: () => showDeckList(app) }, icon("chevron_left")),
    deckSel,
    h("button.btn.danger", { title: "Delete the selected deck", onclick: deleteCurrent }, icon("delete"), " Delete"),
    menu("Deck ▾", [
      ["New Deck", async () => { const n = await promptModal("New Deck", "Name", "New Deck"); if (n) addDeck(emptyDeck(n)); }],
      ["Rename", async () => { const n = await promptModal("Rename", "Name", deck.name); if (n) { deck.name = n; persist(); refreshDeckSel(); } }],
      ["Duplicate", () => addDeck({ ...deck, id: crypto.randomUUID(), name: deck.name + " (copy)", main: [...deck.main], extra: [...deck.extra], side: [...deck.side] })],
      ["Sort", () => { for (const p of ["main", "extra", "side"]) deck[p] = sortDeckPart(deck[p]); persist(); renderDeck(); }],
      ["Clear", async () => { if (await confirmModal("Clear the deck?", deck.name, "Clear", "Cancel", { danger: true })) { deck.main = []; deck.extra = []; deck.side = []; persist(); renderDeck(); } }],
      ["Manage decks…", manageDecks],
    ]),
    menu("Import ▾", [
      ["From clipboard (Omega, YDK, ydke://)", async () => { const d = await importDeck("clipboard"); if (d) addDeck(d); }],
      ["Paste text…", async () => { const d = await importDeck("paste"); if (d) addDeck(d); }],
      ["File .ydk…", async () => { const d = await importDeck("file"); if (d) addDeck(d); }],
    ]),
    menu("Export ▾", [
      ["Download .ydk", () => download(`${deck.name}.ydk`, toYdk(deck))],
      ["Copy ydke://", () => navigator.clipboard?.writeText(toYdke(deck)).then(() => toast("ydke:// link copied"))],
      ["Copy Omega code", async () => navigator.clipboard?.writeText(await toOmega(deck)).then(() => toast("Omega deck code copied"))],
      ["Copy YDK text", () => navigator.clipboard?.writeText(toYdk(deck)).then(() => toast("YDK copied"))],
    ]),
    h("div.spacer"),
    banSel,
    validity
  );

  // ------------------------------------------------------------ area mazzo
  const parts = {};
  for (const p of ["main", "extra", "side"]) {
    const grid = h(`div.deck-grid.${p}`);
    const head = h("div.deck-head");
    grid.addEventListener("dragover", (e) => e.preventDefault());
    grid.addEventListener("drop", (e) => {
      e.preventDefault();
      const data = JSON.parse(e.dataTransfer.getData("text/plain") || "{}");
      if (!data.code) return;
      if (data.from) removeAt(data.from, data.index);
      addCard(data.code, p);
    });
    parts[p] = { grid, head, el: h(`section.deck-part.${p}`, head, grid) };
  }

  const limitBadge = (code) => {
    const l = cardLimit(banlist, code);
    return l < 3 ? h(`div.limit.l${l}`, l === 0 ? "✕" : l) : null;
  };

  const countCopies = (code) => {
    const c = getCard(code);
    const base = c?.alias && Math.abs(c.alias - code) < 20 ? c.alias : code;
    return [...deck.main, ...deck.extra, ...deck.side].filter((x) => {
      const cx = getCard(x);
      return (cx?.alias && Math.abs(cx.alias - x) < 20 ? cx.alias : x) === base;
    }).length;
  };

  function addCard(code, target) {
    const c = getCard(code);
    if (!c || c.type & TYPE.TOKEN) return;
    let part = target ?? (isExtraDeckCard(c) ? "extra" : "main");
    if (part === "main" && isExtraDeckCard(c)) part = "extra";
    if (part === "extra" && !isExtraDeckCard(c)) part = "main";
    if (deck[part].length >= MAX[part]) return toast(`${part === "main" ? "Main" : part === "extra" ? "Extra" : "Side"} Deck is full`, { kind: "error" });
    const limit = Math.min(3, cardLimit(banlist, code));
    if (limit === 0) return toast(`${c.name} is forbidden in the selected banlist`, { kind: "error" });
    if (countCopies(code) >= limit) return toast(`Maximum ${limit} copies of ${c.name}`, { kind: "error" });
    deck[part].push(code);
    persist();
    renderDeck();
  }

  function removeAt(part, index) {
    deck[part].splice(index, 1);
    persist();
    renderDeck();
  }

  function renderDeck() {
    for (const p of ["main", "extra", "side"]) {
      const { grid, head } = parts[p];
      const codes = deck[p];
      const count = (t) => codes.filter((c) => getCard(c)?.type & t).length;
      const pill = (cls, n, title) => h(`span.type-count.${cls}`, { title }, n);
      const counts = p === "extra"
        ? [pill("fusion", count(TYPE.FUSION), "Fusion"), pill("synchro", count(TYPE.SYNCHRO), "Synchro"), pill("xyz", count(TYPE.XYZ), "Xyz"), pill("link", count(TYPE.LINK), "Link")]
        : [pill("monster", count(TYPE.MONSTER), "Monsters"), pill("spell", count(TYPE.SPELL), "Spells"), pill("trap", count(TYPE.TRAP), "Traps")];
      clear(head).append(
        h("b", p === "main" ? "Main Deck" : p === "extra" ? "Extra Deck" : "Side Deck"),
        h("span.count", `${codes.length}`),
        h("span.spacer"),
        ...counts
      );
      clear(grid).append(
        ...codes.map((code, index) => {
          const el = h("div.deck-card", { draggable: true }, cardFace(code), limitBadge(code));
          el.addEventListener("mouseenter", () => detail.show(code));
          // Clic: dettaglio (utile su touch). Tasto destro: rimuove dal mazzo. Per spostare nel/dal Side si trascina.
          el.addEventListener("click", () => detail.show(code));
          el.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            removeAt(p, index);
          });
          el.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", JSON.stringify({ code, from: p, index })));
          return el;
        })
      );
    }
    const errs = validateDeck(deck, banlist);
    validity.textContent = errs.length ? `⚠ ${errs.length} issues` : "✓ Valid";
    validity.className = `validity ${errs.length ? "bad" : "ok"}`;
  }

  // ------------------------------------------------------------ ricerca
  const q = h("input.input", { placeholder: "Card name or text…", type: "search" });
  const fType = h("select.select", h("option", { value: "" }, "All types"), h("option", { value: "monster" }, "Monsters"), h("option", { value: "spell" }, "Spells"), h("option", { value: "trap" }, "Traps"), h("option", { value: "extra" }, "Extra Deck"));
  const SUBTYPES = [["", "Any subtype"], [TYPE.NORMAL, "Normal"], [TYPE.EFFECT, "Effect"], [TYPE.RITUAL, "Ritual"], [TYPE.FUSION, "Fusion"], [TYPE.SYNCHRO, "Synchro"], [TYPE.XYZ, "Xyz"], [TYPE.LINK, "Link"], [TYPE.PENDULUM, "Pendulum"], [TYPE.TUNER, "Tuner"], [TYPE.FLIP, "Flip"], [TYPE.QUICKPLAY, "Quick-Play"], [TYPE.CONTINUOUS, "Continuous"], [TYPE.EQUIP, "Equip"], [TYPE.FIELD, "Field"], [TYPE.COUNTER, "Counter"]];
  const fSub = h("select.select", SUBTYPES.map(([v, l]) => h("option", { value: v }, l)));
  const fAttr = h("select.select", h("option", { value: "" }, "Attribute"), ATTRIBUTES.map(([v, l]) => h("option", { value: v }, l)));
  const fRace = h("select.select", h("option", { value: "" }, "Type"), RACES.map(([v, l]) => h("option", { value: v }, l)));
  const fLevel = h("input.input", { placeholder: "Lv.", type: "number", min: 0, max: 13 });
  const fAtk = h("input.input", { placeholder: "ATK ≥", type: "number", min: 0, step: 100 });
  const fDef = h("input.input", { placeholder: "DEF ≥", type: "number", min: 0, step: 100 });
  const fLimit = h("select.select", h("option", { value: "" }, "Any status"), h("option", { value: "0" }, "Forbidden"), h("option", { value: "1" }, "Limited"), h("option", { value: "2" }, "Semi-Limited"), h("option", { value: "legal" }, "Legal only"));
  const fUnoff = h("input", { type: "checkbox" });
  // Pulsanti colorati per tipo e attributo (pilotano i select nascosti fType e fAttr).
  const chipRow = (select, items, cls) => {
    const row = h(`div.chips.${cls}`);
    const draw = () => clear(row).append(
      ...items.map(([v, label, c]) =>
        h(`button.chip${c ? "." + c : ""}${select.value === String(v) ? ".on" : ""}`, {
          onclick: () => { select.value = select.value === String(v) ? "" : String(v); draw(); runSearch(); },
        }, label)
      )
    );
    draw();
    return row;
  };
  const typeChips = chipRow(fType, [["monster", "Monsters", "monster"], ["spell", "Spells", "spell"], ["trap", "Traps", "trap"], ["extra", "Extra", "extra"]], "types");
  const ATTR_CLS = { 0x01: "earth", 0x02: "water", 0x04: "fire", 0x08: "wind", 0x10: "light", 0x20: "dark", 0x40: "divine" };
  const attrChips = chipRow(fAttr, ATTRIBUTES.map(([v, l]) => [v, l, ATTR_CLS[v]]), "attrs");
  const results = h("div.results");
  const resultInfo = h("div.muted.small");
  let shown = 120;
  let found = [];

  function runSearch() {
    const text = q.value.trim().toLowerCase();
    const type = fType.value;
    const sub = +fSub.value || 0;
    const attr = +fAttr.value || 0;
    const race = +fRace.value || 0;
    const lvl = fLevel.value === "" ? null : +fLevel.value;
    const atk = fAtk.value === "" ? null : +fAtk.value;
    const def = fDef.value === "" ? null : +fDef.value;
    const lim = fLimit.value;
    found = db.list.filter((c) => {
      if (c.type & TYPE.TOKEN || c.type & TYPE.SKILL) return false;
      if (!fUnoff.checked && c.source === 1) return false;
      if (c.alias && Math.abs(c.alias - c.code) < 20 && getCard(c.alias)) return false; // arte alternativa
      if (type === "monster" && !(c.type & TYPE.MONSTER)) return false;
      if (type === "spell" && !(c.type & TYPE.SPELL)) return false;
      if (type === "trap" && !(c.type & TYPE.TRAP)) return false;
      if (type === "extra" && !isExtraDeckCard(c)) return false;
      if (sub && !(c.type & sub)) return false;
      if (attr && !(c.attribute & attr)) return false;
      if (race && !(c.race & race)) return false;
      if (lvl != null && c.level !== lvl) return false;
      if (atk != null && !(c.atk >= atk)) return false;
      if (def != null && (c.type & TYPE.LINK || !(c.def >= def))) return false;
      if (lim) {
        const l = cardLimit(banlist, c.code);
        if (lim === "legal" ? l === 0 : l !== +lim) return false;
      }
      if (text && !c.search.includes(text)) return false;
      return true;
    });
    if (text) {
      // Prima le carte il cui nome contiene il testo.
      found.sort((a, b) => (b.name.toLowerCase().includes(text) ? 1 : 0) - (a.name.toLowerCase().includes(text) ? 1 : 0));
    }
    shown = 120;
    renderResults();
  }

  function renderResults() {
    resultInfo.textContent = `${found.length} cards`;
    clear(results).append(
      ...found.slice(0, shown).map((c) => {
        const plus = h("button.result-add", { title: "Add (right-click: Side)" }, icon("add"));
        const row = h("div.result-row", { draggable: true }, cardFace(c.code), h("div.result-text", h("div.result-name", c.name), h("div.muted.small", statLine(c) || (c.type & TYPE.SPELL ? "Spell" : "Trap"))), limitBadge(c.code), plus);
        row.addEventListener("mouseenter", () => detail.show(c.code));
        row.addEventListener("click", () => addCard(c.code));
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          addCard(c.code, "side");
        });
        row.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", JSON.stringify({ code: c.code })));
        return row;
      }),
      ...(found.length > shown ? [h("button.btn.ghost.more", { onclick: () => { shown += 200; renderResults(); } }, `Show more (${found.length - shown})`)] : [])
    );
  }

  let timer;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 150);
  };
  for (const el of [q, fLevel, fAtk, fDef]) el.addEventListener("input", debounced);
  for (const el of [fType, fSub, fAttr, fRace, fLimit, fUnoff]) el.addEventListener("change", runSearch);

  const search = h(
    "aside.search-panel",
    h("div.search-tabs", h("span.search-tab.on", icon("view_list"), " Card list")),
    q,
    typeChips,
    attrChips,
    h("div.filter-grid", fSub, fRace, fLevel, fAtk, fDef, fLimit),
    h("label.check.small", fUnoff, "Include unofficial cards"),
    resultInfo,
    results,
    h("p.muted.small.hint", "Click: add · Right-click: add to Side · In deck: right-click removes, drag to move between Main, Extra and Side")
  );

  root.append(
    h("div.page.editor", toolbar, h("div.editor-body", detail.el, h("div.deck-area", parts.main.el, parts.extra.el, parts.side.el), search))
  );
  refreshDeckSel();
  renderDeck();
  runSearch();
}
