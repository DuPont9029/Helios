// Deck Editor: ricerca carte, costruzione del mazzo, banlist, import/export.
import { h, clear, download, pickFile, icon, rect } from "./dom.js";
import { cardFace, regionBadge } from "./card.js";
import { createDetailPanel } from "./detail.js";
import { openModal, toast, confirmModal, promptModal, alertModal } from "./modal.js";
import { db, getCard, isExtraDeckCard, statLine } from "../data/db.js";
import { settings, artUrl } from "../data/settings.js";
import { ATTRIBUTES, RACES, TYPE } from "../core/constants.js";
import {
  loadDecks, saveDecks, emptyDeck, parseDeckText, toYdk, toYdke, toOmega, toRecipe, banlistByName, cardLimit, validateDeck, sortDeckPart, OT,
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
        h("button.btn.ghost.round.page-back", { title: "Menu (right-click)", onclick: () => app.home() }, icon("chevron_left")),
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

// Copia di lavoro di un mazzo (la bozza modificata nell'editor).
const cloneDeck = (d) => ({ ...d, main: [...d.main], extra: [...d.extra], side: [...d.side] });
const isEmptyDeck = (d) => !d.main.length && !d.extra.length && !d.side.length;
const LONG_PRESS = 450;

/**
 * Side Deck tra i duelli di una partita al meglio di N: lo stesso deck editor in modalità limitata
 * (si spostano solo carte tra Main/Extra e Side, al massimo 15), aperto sopra il duello.
 * Restituisce il mazzo da usare nel duello successivo (il mazzo salvato non cambia), oppure
 * { surrendered: true } se il giocatore abbandona la partita da qui.
 * La promessa ha .close(value): chiude la schermata dall'esterno (es. l'avversario si è arreso).
 */
export function openSideEditor(deck, { banlist = null, allowUnofficial = false, game = 2, who = "", canSurrender = true } = {}) {
  let finish;
  const promise = new Promise((resolve) => {
    const layer = h("div.side-editor-layer");
    document.body.append(layer);
    const host = { root: layer, home() {}, onLeave: null };
    let done = false;
    finish = (v) => {
      if (done) return;
      done = true;
      host.onLeave?.();
      layer.remove();
      resolve(v);
    };
    showEditor(host, { side: { deck, banlist, allowUnofficial, game, who, canSurrender, onDone: finish } });
  });
  promise.close = (v) => finish?.(v);
  return promise;
}

export function showEditor(app, { side = null } = {}) {
  const root = clear(app.root);
  // decks contiene solo le versioni salvate; deck è la bozza su cui si lavora.
  // Side Deck: un solo mazzo, la copia per la partita (non si salva nulla).
  let decks = side ? [cloneDeck({ ...side.deck, side: side.deck.side ?? [] })] : loadDecks();
  if (!decks.length) decks = [emptyDeck()];
  if (!side) saveDecks(decks); // salvataggio alla prima apertura (es. mazzi starter non ancora in memoria)
  let deck;
  let baseline = "";
  let undoStack = [];
  let redoStack = [];
  let banlist = side ? banlistByName(side.banlist) : banlistByName(settings.lastBanlist ?? db.banlists[0]?.name);
  // ------------------------------------------------------------ preferiti (bookmark)
  const isBookmarked = (code) => settings.bookmarks?.includes(code);
  function toggleBookmark(code) {
    const list = (settings.bookmarks ?? []).filter((c) => c !== code);
    if (!isBookmarked(code)) list.unshift(code);
    settings.bookmarks = list;
    // Aggiorna tutte le stelle di questa carta (risultati, pannello dettagli) e la scheda.
    document.querySelectorAll(`[data-bm="${code}"]`).forEach((b) => paintBookmark(b, code));
    refreshTabs?.();
    if (tab === "bookmarks") runSearch();
  }
  function paintBookmark(btn, code) {
    const on = isBookmarked(code);
    btn.classList.toggle("on", on);
    btn.title = on ? "Remove from bookmarks" : "Bookmark this card";
    clear(btn).append(icon(on ? "bookmark_added" : "bookmark_add"));
  }
  function bookmarkButton(code, cls = "bm") {
    const btn = h(`button.${cls}`, {
      dataset: { bm: code },
      onclick: (e) => { e.stopPropagation(); toggleBookmark(code); },
      oncontextmenu: (e) => e.stopPropagation(),
    });
    paintBookmark(btn, code);
    return btn;
  }
  let tab = "all"; // scheda della ricerca: "all" (tutte le carte) o "bookmarks"
  let refreshTabs = null;

  const detail = createDetailPanel();

  // ------------------------------------------------------------ bozza, salvataggio, annulla/ripeti
  const snap = () => JSON.stringify({ name: deck.name, main: deck.main, extra: deck.extra, side: deck.side });
  const isDirty = () => snap() !== baseline;

  function openDeck(d) {
    deck = cloneDeck(d);
    baseline = snap();
    undoStack = [];
    redoStack = [];
    if (!side) settings.lastDeck = deck.id;
    refreshDeckSel();
    renderDeck();
  }

  // Applica una modifica alla bozza registrandola nella cronologia (fn può non cambiare nulla).
  function change(fn) {
    const before = snap();
    fn();
    if (snap() === before) return false;
    undoStack.push(before);
    if (undoStack.length > 300) undoStack.shift();
    redoStack = [];
    renderDeck();
    return true;
  }

  function restore(state) {
    const s = JSON.parse(state);
    Object.assign(deck, { name: s.name, main: s.main, extra: s.extra, side: s.side });
    refreshDeckSel();
    renderDeck();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snap());
    restore(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snap());
    restore(redoStack.pop());
  }

  function save() {
    const i = decks.findIndex((d) => d.id === deck.id);
    if (i >= 0) decks[i] = cloneDeck(deck);
    else decks.push(cloneDeck(deck));
    saveDecks(decks);
    settings.lastDeck = deck.id;
    baseline = snap();
    refreshDeckSel();
    renderDeck();
    toast("Deck saved");
  }

  // Prima di lasciare la bozza: Salva / Scarta / Annulla. true = si può procedere.
  async function confirmLeave() {
    if (!isDirty()) return true;
    const v = await openModal({
      title: "Unsaved changes",
      body: [h("p", `"${deck.name}" has unsaved changes.`)],
      actions: [{ label: "Cancel", value: null }, { label: "Discard", danger: true, value: "discard" }, { label: "Save", primary: true, value: "save" }],
    }).result;
    if (v === "save") save();
    else if (v === "discard") openDeck(decks.find((d) => d.id === deck.id) ?? deck);
    return v === "save" || v === "discard";
  }

  // Uscita dall'editor: chiede per le modifiche non salvate e stacca i listener globali.
  async function leave(go) {
    if (!(await confirmLeave())) return;
    unmount();
    go();
  }

  const onBeforeUnload = (e) => {
    if (side || !isDirty()) return;
    e.preventDefault();
    e.returnValue = "";
  };
  const onKey = (e) => {
    if (!page.isConnected) return unmount();
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (document.querySelector(".modal-backdrop")) return; // c'è una finestra aperta
    const k = e.key.toLowerCase();
    // Side Deck: solo annulla/ripeti.
    if (side && !["z", "y"].includes(k)) return;
    if (k === "s") {
      e.preventDefault();
      save();
      return;
    }
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
    else if (k === "c" && !e.shiftKey) {
      if (window.getSelection()?.toString()) return; // copia del testo selezionato
      e.preventDefault();
      copyDeck();
    } else if (k === "v" && !e.shiftKey) {
      e.preventDefault();
      pasteDeck();
    }
  };
  function unmount() {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("beforeunload", onBeforeUnload);
    if (app.onLeave === unmount) app.onLeave = null;
  }
  document.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", onBeforeUnload);
  app.onLeave = unmount;

  // ------------------------------------------------------------ copia/incolla e import
  function copyDeck() {
    if (!navigator.clipboard?.writeText) return toast("Clipboard not available", { kind: "error" });
    navigator.clipboard.writeText(toYdk(deck)).then(
      () => toast(`"${deck.name}" copied as YDK`),
      () => toast("Could not write to the clipboard", { kind: "error" })
    );
  }

  async function pasteDeck() {
    let text = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      /* permesso negato */
    }
    if (!text?.trim()) return toast("The clipboard is empty or not accessible", { kind: "error" });
    try {
      const { deck: d, format, missing } = await parseDeckText(text, "Imported Deck");
      if (format === "omega") d.name = "Imported Deck (Omega)";
      if (isEmptyDeck(d)) throw new Error("no card codes found");
      if (missing.length) toast(`${missing.length} card name(s) not found and skipped`, { kind: "error" });
      importHere(d);
    } catch (e) {
      toast(`Nothing to paste: ${e.message}`, { kind: "error" });
    }
  }

  // Mazzo importato: dentro il mazzo aperto se è vuoto, altrimenti in un mazzo nuovo.
  async function importHere(d) {
    if (!d) return;
    if (isEmptyDeck(deck)) {
      change(() => {
        if (deck.name === "New Deck") deck.name = d.name;
        deck.main = [...d.main];
        deck.extra = [...d.extra];
        deck.side = [...d.side];
      });
      refreshDeckSel();
      toast(`Imported into "${deck.name}" (not saved yet)`);
      return;
    }
    if (!(await confirmLeave())) return;
    addDeck(d);
    toast(`Imported as new deck "${d.name}"`);
  }

  // ------------------------------------------------------------ barra superiore
  const deckSel = h("select.select");
  function refreshDeckSel() {
    clear(deckSel).append(...decks.map((d) => h("option", { value: d.id }, d.id === deck.id ? deck.name : d.name)));
    if (!decks.some((d) => d.id === deck.id)) deckSel.append(h("option", { value: deck.id }, deck.name));
    deckSel.value = deck.id;
  }
  deckSel.addEventListener("change", async () => {
    const target = decks.find((d) => d.id === deckSel.value);
    deckSel.value = deck.id;
    if (!target || !(await confirmLeave())) return;
    openDeck(target);
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
  const saveBtn = h("button.btn.primary.save-btn", { title: "Save the deck (Ctrl+S)", onclick: () => save() });
  const undoBtn = h("button.btn.ghost.round", { title: "Undo (Ctrl+Z)", onclick: undo }, icon("undo"));
  const redoBtn = h("button.btn.ghost.round", { title: "Redo (Ctrl+Shift+Z / Ctrl+Y)", onclick: redo }, icon("redo"));
  function refreshState() {
    const dirty = isDirty();
    saveBtn.classList.toggle("dirty", dirty);
    saveBtn.replaceChildren(icon("save"), dirty ? " Save" : " Saved", ...(dirty ? [h("span.unsaved-dot", { title: "Unsaved changes" })] : []));
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
  }

  const menu = (label, items) => {
    const btn = h("button.btn", label);
    btn.addEventListener("click", () => {
      const r = rect(btn);
      const m = h("div.dropdown", items.map(([text, fn]) => h("button.dropdown-item", { onclick: () => { m.remove(); fn(); } }, text)));
      Object.assign(m.style, { left: r.left + "px", top: r.bottom + 4 + "px" });
      document.body.append(m);
      setTimeout(() => document.addEventListener("mousedown", function off(e) {
        if (!m.contains(e.target)) { m.remove(); document.removeEventListener("mousedown", off); }
      }), 0);
    });
    return btn;
  };

  // Nuovo mazzo (creazione = salvataggio immediato) e apertura come bozza.
  const addDeck = (d) => {
    decks.push(cloneDeck(d));
    saveDecks(decks);
    openDeck(d);
  };

  // Elimina i mazzi indicati; ne resta sempre almeno uno (vuoto) da modificare.
  const deleteDecks = (ids) => {
    decks = decks.filter((d) => !ids.includes(d.id));
    if (!decks.length) decks.push(emptyDeck());
    saveDecks(decks);
    if (ids.includes(deck.id)) openDeck(decks[0]); // la bozza del mazzo eliminato si perde
    else refreshDeckSel();
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
    h("button.btn.ghost.round", { title: "Decks", onclick: () => leave(() => showDeckList(app)) }, icon("chevron_left")),
    deckSel,
    saveBtn,
    undoBtn,
    redoBtn,
    h("button.btn.danger", { title: "Delete the selected deck", onclick: deleteCurrent }, icon("delete"), " Delete"),
    menu("Deck ▾", [
      ["New Deck", async () => {
        if (!(await confirmLeave())) return;
        const n = await promptModal("New Deck", "Name", "New Deck");
        if (n) addDeck(emptyDeck(n));
      }],
      ["Rename", async () => { const n = await promptModal("Rename", "Name", deck.name); if (n) { change(() => (deck.name = n)); refreshDeckSel(); } }],
      ["Duplicate", async () => {
        if (!(await confirmLeave())) return;
        addDeck({ ...cloneDeck(deck), id: crypto.randomUUID(), name: deck.name + " (copy)" });
      }],
      ["Sort", () => change(() => { for (const p of ["main", "extra", "side"]) deck[p] = sortDeckPart(deck[p]); })],
      ["Clear", async () => { if (await confirmModal("Clear the deck?", deck.name, "Clear", "Cancel", { danger: true })) change(() => { deck.main = []; deck.extra = []; deck.side = []; }); }],
      ["Manage decks…", manageDecks],
    ]),
    menu("Import ▾", [
      ["From clipboard (Omega, YDK, ydke://)", async () => importHere(await importDeck("clipboard"))],
      ["Paste text…", async () => importHere(await importDeck("paste"))],
      ["File .ydk…", async () => importHere(await importDeck("file"))],
    ]),
    menu("Export ▾", [
      ["Download .ydk", () => download(`${deck.name}.ydk`, toYdk(deck))],
      ["Copy ydke://", () => navigator.clipboard?.writeText(toYdke(deck)).then(() => toast("ydke:// link copied"))],
      ["Copy Omega code", async () => navigator.clipboard?.writeText(await toOmega(deck)).then(() => toast("Omega deck code copied"))],
      ["Clipboard (Recipe)", () => navigator.clipboard?.writeText(toRecipe(deck)).then(() => toast("Card list copied (Omega Recipe format)"))],
      ["Copy YDK text (Ctrl+C)", copyDeck],
    ]),
    h("div.spacer"),
    banSel,
    validity
  );

  // Side Deck: barra ridotta (scambi, annulla/ripeti, ripristina, validità, pronto).
  const swapsEl = h("span.side-swaps");
  const sideToolbar = side && h(
    "div.editor-toolbar.side-toolbar",
    h("div.side-title", h("b", `Side Deck${side.who ? ` — ${side.who}` : ""}`), h("span.muted", `Game ${side.game}`)),
    swapsEl,
    undoBtn,
    redoBtn,
    h("button.btn", { title: "Back to the Deck of the previous Duel", onclick: () => change(() => { const d = cloneDeck(side.deck); deck.main = d.main; deck.extra = d.extra; deck.side = d.side ?? []; }) }, icon("restart_alt"), " Reset"),
    h("div.spacer"),
    side.canSurrender && h("button.btn.danger", {
      title: "Give up the whole match",
      onclick: async () => {
        if (await confirmModal("Surrender the match?", "You lose the match: no more Duels are played.", "Surrender", "Cancel", { danger: true, top: true })) side.onDone({ surrendered: true });
      },
    }, icon("flag"), " Surrender"),
    validity,
    h("button.btn.primary", {
      onclick: () => {
        const errs = validateDeck(deck, banlist, { allowUnofficial: side.allowUnofficial });
        if (errs.length) return alertModal("Invalid Deck", errs.slice(0, 8).join("\n"));
        side.onDone(cloneDeck(deck));
      },
    }, icon("check"), " Ready")
  );

  // ------------------------------------------------------------ area mazzo
  const PART_NAME = { main: "Main", extra: "Extra", side: "Side" };
  // Dati del trascinamento: { code } dai risultati, { code, from, index } da una carta del mazzo.
  const dragData = (e) => {
    try {
      return JSON.parse(e.dataTransfer.getData("text/plain") || "{}");
    } catch {
      return {};
    }
  };
  // Rilascio su una parte del mazzo (at = indice della carta davanti a cui inserire, null = in fondo).
  function dropInto(data, p, at = null) {
    if (!data.code) return;
    if (data.from) moveCard(data.from, data.index, p, at);
    else if (!side) addCard(data.code, p, at);
  }
  const parts = {};
  for (const p of ["main", "extra", "side"]) {
    const grid = h(`div.deck-grid.${p}`);
    const head = h("div.deck-head");
    grid.addEventListener("dragover", (e) => e.preventDefault());
    grid.addEventListener("drop", (e) => {
      e.preventDefault();
      dropInto(dragData(e), p);
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

  // Main ed Extra si scelgono dal tipo della carta; il Side accetta tutto.
  const routePart = (c, target) => (target === "side" ? "side" : isExtraDeckCard(c) ? "extra" : "main");

  function addCard(code, target, at = null) {
    const c = getCard(code);
    if (!c || c.type & TYPE.TOKEN) return;
    const part = routePart(c, target ?? "main");
    if (deck[part].length >= MAX[part]) return toast(`${PART_NAME[part]} Deck is full`, { kind: "error" });
    const limit = Math.min(3, cardLimit(banlist, code));
    if (limit === 0) return toast(`${c.name} is forbidden in the selected banlist`, { kind: "error" });
    if (countCopies(code) >= limit) return toast(`Maximum ${limit} copies of ${c.name}`, { kind: "error" });
    change(() => deck[part].splice(at ?? deck[part].length, 0, code));
  }

  function removeAt(part, index) {
    change(() => deck[part].splice(index, 1));
  }

  // Sposta una carta (tra parti o nella stessa parte per riordinare): il numero di copie non cambia.
  function moveCard(from, index, target, at = null) {
    const code = deck[from][index];
    const c = getCard(code);
    if (code == null || !c) return;
    const part = routePart(c, target);
    if (part === from) {
      // La carta prende il posto di quella su cui cade (davanti se va indietro, dopo se va avanti).
      const to = at ?? deck[part].length - 1;
      if (to === index) return;
      change(() => {
        deck[part].splice(index, 1);
        deck[part].splice(to, 0, code);
      });
      return;
    }
    if (deck[part].length >= MAX[part]) return toast(`${PART_NAME[part]} Deck is full`, { kind: "error" });
    if (side && part === "side" && swapped() >= SIDE_SWAPS) return toast(`You can swap at most ${SIDE_SWAPS} cards`, { kind: "error" });
    // Main↔Extra non cambia per tipo: l'indice di destinazione vale solo se la parte è quella richiesta
    change(() => {
      deck[from].splice(index, 1);
      deck[part].splice(part === target && at != null ? at : deck[part].length, 0, code);
    });
  }

  /** Side Deck: carte del Main/Extra di partenza ora nel Side (= carte scambiate). */
  const SIDE_SWAPS = 15;
  const startSide = side ? [...(side.deck.side ?? [])] : [];
  const swapped = () => {
    const left = [...startSide];
    let n = 0;
    for (const c of deck.side) {
      const i = left.indexOf(c);
      if (i >= 0) left.splice(i, 1);
      else n++;
    }
    return n;
  };

  // Pressione lunga: il rilascio non deve contare come clic (che rimuove la carta).
  let longPressed = false;
  let pointerKind = "mouse";

  function deckCard(code, p, index) {
    const el = h("div.deck-card", { draggable: true, dataset: { part: p, index } }, cardFace(code), limitBadge(code), regionBadge(code));
    let timer = null;
    let start = null;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
    };
    el.addEventListener("mouseenter", () => detail.show(code));
    el.addEventListener("pointerdown", (e) => {
      pointerKind = e.pointerType;
      longPressed = false;
      detail.show(code);
      if (e.button !== 0) return;
      start = [e.clientX, e.clientY];
      cancel();
      if (side) return; // Side Deck: niente copie aggiunte con la pressione lunga
      timer = setTimeout(() => {
        timer = null;
        longPressed = true;
        addCard(code, p, index + 1); // un'altra copia accanto, con i limiti di addCard
      }, LONG_PRESS);
    });
    el.addEventListener("pointermove", (e) => {
      if (timer && start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 6) cancel();
    });
    for (const ev of ["pointerup", "pointercancel", "pointerleave", "dragstart"]) el.addEventListener(ev, cancel);
    // Clic: rimuove (Side Deck: sposta tra Deck e Side). Tasto destro: Main/Extra → Side, Side → Main/Extra.
    el.addEventListener("click", () => {
      if (longPressed) return void (longPressed = false);
      if (side) return moveCard(p, index, p === "side" ? "main" : "side");
      removeAt(p, index);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (pointerKind === "touch" || longPressed) return; // su touch il menu arriva dalla pressione lunga
      moveCard(p, index, p === "side" ? "main" : "side");
    });
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", JSON.stringify({ code, from: p, index }));
      e.dataTransfer.effectAllowed = "move";
    });
    // Rilascio su una carta: si inserisce davanti (riordino nella stessa parte).
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.classList.add("drop-before");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-before"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("drop-before");
      dropInto(dragData(e), p, index);
    });
    return el;
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
        h("b", `${PART_NAME[p]} Deck`),
        h("span.count", `${codes.length}`),
        h("span.spacer"),
        ...counts
      );
      clear(grid).append(...codes.map((code, index) => deckCard(code, p, index)));
    }
    const errs = validateDeck(deck, banlist, { allowUnofficial: side?.allowUnofficial });
    if (side) swapsEl.textContent = `Swapped ${swapped()} / ${SIDE_SWAPS}`;
    validity.textContent = errs.length ? `⚠ ${errs.length} issues` : "✓ Valid";
    validity.className = `validity ${errs.length ? "bad" : "ok"}`;
    refreshState();
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
  const fFormat = h("select.select.format-filter", h("option", { value: "" }, "Any format"), h("option", { value: "TCG" }, "TCG legal"), h("option", { value: "OCG" }, "OCG legal"));
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
  // Vista dei risultati: griglia di carte o lista (ricordata nelle impostazioni).
  const viewToggle = h("div.view-toggle", ["grid", "list"].map((v) =>
    h(`button.view-btn${v === (settings.editorView === "list" ? "list" : "grid") ? ".on" : ""}`, {
      dataset: { view: v },
      title: v === "grid" ? "Show as cards" : "Show as a list",
      onclick: () => {
        settings.editorView = v;
        viewToggle.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
        renderResults();
      },
    }, icon(v === "grid" ? "grid_view" : "view_list"))
  ));
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
    const fmt = fFormat.value ? OT[fFormat.value] : 0;
    const marks = tab === "bookmarks" ? new Map((settings.bookmarks ?? []).map((c, i) => [c, i])) : null;
    found = (marks ? [...marks.keys()].map(getCard).filter(Boolean) : db.list).filter((c) => {
      if (!marks && (c.type & TYPE.TOKEN || c.type & TYPE.SKILL)) return false;
      if (!marks && !fUnoff.checked && c.source === 1) return false;
      if (!marks && c.alias && Math.abs(c.alias - c.code) < 20 && getCard(c.alias)) return false; // arte alternativa
      if (fmt && !(c.ot & fmt)) return false;
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

  // Risultati come carte in griglia (come nel mazzo) o come lista con nome e statistiche.
  function renderResults() {
    resultInfo.textContent = tab === "bookmarks" && !(settings.bookmarks ?? []).length ? "No bookmarks yet: use the bookmark icon on a card" : `${found.length} cards`;
    const list = settings.editorView === "list";
    results.classList.toggle("as-list", list);
    clear(results).append(
      ...found.slice(0, shown).map((c) => {
        const tile = list
          ? h(
              "div.result-row",
              { draggable: true },
              cardFace(c.code),
              h("div.result-text", h("div.result-name", c.name, regionBadge(c.code)), h("div.muted.small", statLine(c) || (c.type & TYPE.SPELL ? "Spell" : "Trap"))),
              limitBadge(c.code),
              bookmarkButton(c.code)
            )
          : h("div.result-card", { draggable: true, title: c.name }, cardFace(c.code), limitBadge(c.code), regionBadge(c.code), bookmarkButton(c.code));
        tile.addEventListener("mouseenter", () => detail.show(c.code));
        tile.addEventListener("click", () => addCard(c.code));
        tile.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          addCard(c.code, "side");
        });
        tile.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", JSON.stringify({ code: c.code })));
        return tile;
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
  for (const el of [fType, fSub, fAttr, fRace, fLimit, fFormat, fUnoff]) el.addEventListener("change", runSearch);

  // Filtri richiudibili: ridotti lasciano tutto lo spazio alla lista dei risultati.
  const filters = h(
    "div.search-filters",
    typeChips,
    attrChips,
    h("div.filter-grid", fSub, fRace, fLevel, fAtk, fDef, fLimit, fFormat),
    h("label.check.small", fUnoff, "Include unofficial cards")
  );
  const activeFilters = () =>
    [fType, fSub, fAttr, fRace, fLevel, fAtk, fDef, fLimit, fFormat].filter((el) => el.value !== "").length + (fUnoff.checked ? 1 : 0);
  const filterCount = h("b.filter-count");
  const filterToggle = h("button.search-tab.filter-toggle", { title: "Show or hide the filters", onclick: () => setFilters(!settings.editorFilters) });
  function setFilters(open) {
    settings.editorFilters = open;
    filters.hidden = !open;
    const n = activeFilters();
    filterCount.textContent = n ? String(n) : "";
    clear(filterToggle).append(icon("tune"), " Filters", filterCount, icon(open ? "expand_less" : "expand_more"));
  }
  for (const el of [fType, fSub, fAttr, fRace, fLevel, fAtk, fDef, fLimit, fFormat, fUnoff]) el.addEventListener("change", () => setFilters(settings.editorFilters));
  for (const el of [fLevel, fAtk, fDef]) el.addEventListener("input", () => setFilters(settings.editorFilters));
  setFilters(settings.editorFilters !== false);

  const tabAll = h("button.search-tab", { onclick: () => setTab("all") }, icon("view_module"), " Cards");
  const tabMarks = h("button.search-tab", { onclick: () => setTab("bookmarks") });
  refreshTabs = () => {
    tabAll.classList.toggle("on", tab === "all");
    tabMarks.classList.toggle("on", tab === "bookmarks");
    const n = (settings.bookmarks ?? []).length;
    clear(tabMarks).append(icon("bookmarks"), " Bookmarks", h("b.filter-count", n ? String(n) : ""));
  };
  // Trascinare una carta (dal mazzo o dai risultati) sulla scheda Bookmarks, o sui risultati quando
  // la scheda è aperta, la salva tra i preferiti; il mazzo non cambia.
  const dropBookmark = (target, active = () => true) => {
    target.addEventListener("dragover", (e) => {
      if (!active()) return;
      e.preventDefault();
      // L'effetto deve essere tra quelli permessi da chi trascina: le carte del mazzo permettono solo
      // "move" (con "copy" il browser rifiuterebbe il rilascio), quelle dei risultati anche "copy".
      const allowed = e.dataTransfer.effectAllowed;
      e.dataTransfer.dropEffect = /copy|all|uninitialized/i.test(allowed) ? "copy" : "move";
      target.classList.add("bm-drop");
    });
    target.addEventListener("dragleave", (e) => !target.contains(e.relatedTarget) && target.classList.remove("bm-drop"));
    target.addEventListener("drop", (e) => {
      target.classList.remove("bm-drop");
      if (!active()) return;
      e.preventDefault();
      e.stopPropagation();
      let code = 0;
      try {
        code = JSON.parse(e.dataTransfer.getData("text/plain") || "{}").code;
      } catch {
        return;
      }
      if (!code) return;
      if (isBookmarked(code)) return toast(`${getCard(code)?.name ?? "Card"} is already in your Bookmarks`);
      toggleBookmark(code);
      toast(`${getCard(code)?.name ?? "Card"} added to Bookmarks`);
    });
  };
  dropBookmark(tabMarks);
  dropBookmark(results, () => tab === "bookmarks");

  function setTab(t) {
    tab = t;
    refreshTabs();
    runSearch();
    results.scrollTop = 0;
  }
  refreshTabs();

  const search = h(
    "aside.search-panel",
    h("div.search-tabs", tabAll, tabMarks, filterToggle),
    q,
    filters,
    h("div.results-head", resultInfo, viewToggle),
    results,
    h(
      "p.muted.small.hint",
      "Search: click adds, right-click adds to Side, the bookmark icon (or dragging a card onto Bookmarks) saves it in Bookmarks. Deck: click removes, right-click moves to/from Side, hold adds a copy, drag onto a card to reorder. Ctrl+C / Ctrl+V copy & paste the deck, Ctrl+Z undo, Ctrl+S save."
    )
  );

  const sideHelp = side && h(
    "aside.search-panel.side-help",
    h("h3", "Side Deck"),
    h("p", "Swap up to 15 cards between your Deck and your Side Deck for the next Duel."),
    h("p.muted.small", "Click a card of the Main or Extra Deck to move it to the Side Deck, click a Side Deck card to put it back in the Deck (or drag the cards). Ctrl+Z undo, Reset goes back to the Deck of the previous Duel."),
    h("p.muted.small", "Changes are only for this match: your saved Deck does not change.")
  );
  const page = h(`div.page.editor${side ? ".side-mode" : ""}`, side ? sideToolbar : toolbar, h("div.editor-body", detail.el, h("div.deck-area", parts.main.el, parts.extra.el, parts.side.el), side ? sideHelp : search));
  root.append(page);
  openDeck(side ? decks[0] : decks.find((d) => d.id === settings.lastDeck) ?? decks[0]);
  if (!side) runSearch();
}
