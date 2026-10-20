// Combo Trainer: combo (mano iniziale, passi con le scelte precise, hand trap dell'avversario, stato di partenza,
// tag sulle carte, note) legate a un mazzo o con le sole carte necessarie, con varianti; spreadsheet che raccolgono
// più combo di un mazzo. Le combo si provano in un duello dove il trainer controlla i passi e l'avversario
// interrompe dove deciso.
import { h, clear, icon } from "./dom.js";
import { cardFace } from "./card.js";
import { openModal, toast, confirmModal, alertModal, promptModal } from "./modal.js";
import { db, getCard, cardName, isExtraDeckCard, statLine, typeLine } from "../data/db.js";
import { settings } from "../data/settings.js";
import { validSleeve } from "../data/sleeve.js";
import { pendulumIcons } from "../data/pendulum.js";
import { loadDecks, saveDecks, sortDeckPart } from "../deck/deck.js";
import { DUEL_MODES, LOC, POS, TYPE } from "../core/constants.js";
import { DuelSession } from "../duel/session.js";
import {
  ComboTrainer, ComboRecorder, STEP_ACTIONS, NO_CARD, NOTES_MAX, stepText, detailText, cleanStep, cleanSetup, cleanCards,
  loadComboStore, saveComboStore, comboToCode, comboFromCode, detectCards, comboDeck, interruptsOutsideBoard, isSheetCode,
  loadBoards, saveBoards, boardToCode, boardFromCode,
} from "../duel/trainer.js";
import { canRecordVideo, startVideo } from "./video-capture.js";
import { showComboSchema } from "./combo-view.js";
import { renderSheets, decklistPicker } from "./combo-sheets.js";
import { openDecklistEditor, openDeckPicker, openCardCollector } from "./editor.js";
import { baseCombos } from "../data/base-content.js";

const uid = () => Math.random().toString(36).slice(2, 10);
const uniq = (codes) => [...new Set(codes)];
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const tally = (codes) => codes.reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map());

// Scheda aperta (Combos o Spreadsheets, con lo spreadsheet aperto): ci si torna uscendo da un duello.
let view = { tab: "combos", sheetId: null };

/** Riassunto di una riga: turno, mano, passi, hand trap... */
export function comboSummary(c) {
  const parts = [c.first ? "Going first" : "Going second", `${plural(c.hand.length, "card")} in hand`, plural(c.steps.length, "step")];
  if (c.interrupts.length) parts.push(plural(c.interrupts.length, "interruption"));
  if (hasSetup(c.setup)) parts.push("custom board state");
  if (c.tags?.length) parts.push(plural(c.tags.length, "tag"));
  return parts.join(" · ");
}

/** Le combo di una famiglia (la combo originale e le sue varianti), originale per prima. */
export function comboFamily(combos, c) {
  const root = c.parent ? combos.find((x) => x.id === c.parent) ?? c : c;
  return [root, ...combos.filter((x) => x.parent === root.id && x.id !== root.id)];
}

export function showComboTrainer(app, { review } = {}) {
  const decks = loadDecks();
  // Al primo avvio i mazzi starter non sono ancora salvati e ricevono un id nuovo a ogni lettura:
  // li si salva (le combo nel formato vecchio, legate a un mazzo, ne copiano la lista).
  if (decks.length && !localStorage.getItem("ygoweb.decks")) saveDecks(decks);
  const root = clear(app.root);
  const store = loadComboStore();
  const list = h("div.combo-list");
  const panel = h("div.combo-panel");
  const save = () => {
    saveComboStore(store);
    renderTab();
  };
  const ctx = {
    app, store, decks, save,
    /** Aggiunge (o sostituisce) una combo nell'archivio. */
    put: (c) => {
      const i = store.combos.findIndex((x) => x.id === c.id);
      if (i >= 0) store.combos[i] = c;
      else store.combos.push(c);
      save();
      return c;
    },
    remove: (c) => removeCombo(c),
    edit: (c, opts) => editCombo(c, { decks, ...opts }),
    newCombo: (opts) => newCombo(opts),
    importCombo,
    practice: (c, opts) => practice(app, c, opts),
    schema: (c) => schema(c),
    fork: (c) => fork(c),
    setView: (v) => (view = { ...view, ...v }),
  };

  async function removeCombo(c) {
    if (!(await confirmModal("Delete combo", `Delete "${c.name}"?`, "Delete", "Cancel", { danger: true }))) return false;
    // Le varianti restano: la prima diventa la combo originale delle altre.
    const variants = store.combos.filter((x) => x.parent === c.id);
    const [heir, ...rest] = variants;
    if (heir) {
      delete heir.parent;
      rest.forEach((x) => (x.parent = heir.id));
    }
    store.combos = store.combos.filter((x) => x.id !== c.id);
    for (const sh of store.sheets) sh.combos = sh.combos.filter((id) => id !== c.id);
    save();
    return true;
  }

  /** Variante (fork): copia della combo da modificare, raggruppata sotto la combo originale. */
  async function fork(c) {
    const rootId = c.parent ?? c.id;
    const label = await promptModal("New variant", "What changes in this variant? (e.g. \"No Ash Blossom\", \"With Called by the Grave\")", "");
    if (label == null) return null;
    const copy = { ...structuredClone(c), id: uid(), parent: rootId, branch: label.trim().slice(0, 40) || "Variant" };
    copy.name = c.name;
    const v = await editCombo(copy, { decks });
    if (!v) return null;
    ctx.put(v);
    toast(`Variant saved: "${v.name} — ${v.branch}"`);
    return v;
  }

  /** Scheda della combo (passi illustrati, note, carte necessarie, varianti). */
  function schema(c) {
    showComboSchema(c, {
      family: comboFamily(store.combos, c),
      onPractice: (x) => practice(app, x),
      onOpen: (x) => schema(x),
    });
  }

  function row(c, variant) {
    return h(
      `div.combo-row${variant ? ".variant" : ""}`,
      h("div.combo-hand", c.hand.slice(0, 6).map((code) => cardFace(code))),
      h(
        "div.combo-info",
        h("b", variant ? h("span.combo-branch", "↳ ", c.branch || "Variant") : c.name),
        variant ? h("div.muted.small", `Variant of "${store.combos.find((x) => x.id === c.parent)?.name ?? c.name}"`) : null,
        h("div.muted.small", comboSummary(c))
      ),
      h(
        "div.combo-actions",
        h("button.btn.primary", { onclick: () => practice(app, c) }, icon("play_arrow"), " Practice"),
        h("button.btn", { title: "The trainer plays the combo by itself (no video)", onclick: () => practice(app, c, { autoplay: true }) }, icon("smart_display"), " Auto-play"),
        h("button.btn", { title: "Combo sheet: steps with the cards, notes, cards needed and variants", onclick: () => schema(c) }, icon("view_timeline"), " View"),
        h("button.btn", { title: "New variant of this combo (a copy to change: other cards, other line…)", onclick: () => fork(c) }, icon("fork_right"), " Fork"),
        h("button.btn", { title: "Share the combo or record a video of it", onclick: () => exportCombo(app, c) }, icon("ios_share"), " Export"),
        h("button.btn", { onclick: () => editCombo(c, { decks }).then((v) => v && ctx.put(v)) }, icon("edit"), " Edit"),
        h("button.btn.danger", { title: "Delete", onclick: () => removeCombo(c) }, icon("delete"))
      )
    );
  }

  /** Combo base (dei mazzi base): si provano e si guardano; per cambiarle se ne fa una copia tra le proprie. */
  function baseRow(c) {
    const copy = () => {
      const mine = { ...structuredClone(c), id: uid() };
      delete mine.base;
      delete mine.deckName;
      ctx.put(mine);
      toast(`Copied to your combos: "${mine.name}"`);
    };
    return h(
      "div.combo-row.base",
      h("div.combo-hand", c.hand.slice(0, 6).map((code) => cardFace(code))),
      h("div.combo-info", h("b", c.name), h("div.muted.small", `${c.deckName} · Basic level`), h("div.muted.small", comboSummary(c))),
      h(
        "div.combo-actions",
        h("button.btn.primary", { onclick: () => practice(app, c) }, icon("play_arrow"), " Practice"),
        h("button.btn", { title: "The trainer plays the combo by itself (no video)", onclick: () => practice(app, c, { autoplay: true }) }, icon("smart_display"), " Auto-play"),
        h("button.btn", { title: "Combo sheet: steps with the cards, notes and cards needed", onclick: () => showComboSchema(c, { family: [c], onPractice: (x) => practice(app, x), onOpen: () => {} }) }, icon("view_timeline"), " View"),
        h("button.btn", { title: "Copy it to your combos, to change it or make variants", onclick: copy }, icon("content_copy"), " Copy to my combos")
      )
    );
  }
  /** Sezione delle combo base, sotto le proprie (o nella pagina vuota). */
  function baseSection() {
    const list = baseCombos();
    if (!list.length) return null;
    return h(
      "section.combo-base",
      h("div.combo-toolbar-title", h("h2", "Base combos"), h("span.muted.small", "For the Base decks of the game (Basic level): practice them, watch them with Auto-play, or copy them to change them.")),
      h("div.combo-list", list.map(baseRow))
    );
  }

  // Ricerca: nome, variante, note e carte (mano e passi). Una famiglia si mostra se una sua combo corrisponde.
  const search = h("input.input.combo-search", { type: "search", placeholder: "Search by name or card…", oninput: () => renderList() });
  const matches = (c, q) =>
    [c.name, c.branch, c.notes, ...c.hand.map(cardName), ...c.steps.map((s) => (NO_CARD.has(s.kind) ? "" : cardName(s.code)))].some((t) => t?.toLowerCase().includes(q));

  function renderList() {
    const q = search.value.trim().toLowerCase();
    const all = store.combos;
    const ids = new Set(all.map((c) => c.id));
    // Combo originali (o varianti la cui originale non c'è più), ognuna seguita dalle sue varianti.
    const roots = all.filter((c) => !c.parent || !ids.has(c.parent));
    const rows = roots.flatMap((r) => {
      const family = [r, ...all.filter((x) => x.parent === r.id)];
      if (q && !family.some((x) => matches(x, q))) return [];
      return [row(r, false), ...family.slice(1).map((x) => row(x, true))];
    });
    clear(list).append(...(rows.length ? rows : [h("p.muted.combo-noresult", `No combos match "${search.value.trim()}".`)]));
  }

  const importAndSave = () => importCombo().then((v) => v && ctx.put(v));

  /** Come funziona il Trainer, in breve (aperto quando non ci sono ancora combo). */
  function howItWorks(open) {
    const point = (ic, title, text) => h("li", h("span.combo-how-icon", icon(ic)), h("div", h("b", title), h("span.muted.small", text)));
    return h(
      "details.combo-how",
      { open },
      h("summary", icon("help"), " How the Trainer works"),
      h(
        "ol.combo-how-points",
        point("style", "Starting point", "Each combo has its own decklist (a copy of one of your Decks, it does not change with it), the starting hand and, if needed, the board state."),
        point("format_list_numbered", "Steps", "Summons, Sets, activations and End Phase, with precise choices: targets, materials, zones, positions, answers. Notes help the player."),
        point("bolt", "Interruptions", "Put hand traps in the opponent's hand (or traps on their field) in the starting board state and choose after which step they are used: the opponent uses them at the first chance, then it's free play to find a way around them."),
        point("school", "Practice", "The Trainer checks every step and choice. Strict mode blocks wrong moves; Auto-play plays the combo by itself (also as a video)."),
        point("fork_right", "Variants and spreadsheets", "Fork a combo for another line; group combos by starter in a spreadsheet, with a sample decklist and the cards you need.")
      )
    );
  }

  /** Nessuna combo: i modi per iniziare. */
  function emptyState() {
    const tile = (ic, title, text, onclick, primary = false) =>
      h(`button.combo-start${primary ? ".primary" : ""}`, { onclick }, h("span.combo-start-icon", icon(ic)), h("b", title), h("span", text));
    return h(
      "div.combo-empty",
      h("div.combo-empty-head", h("h2", "Create your first combo"), h("p.muted", "Choose a starting decklist, then record the combo by playing it or write its steps. While you practice, the Trainer checks every step.")),
      h(
        "div.combo-start-grid",
        tile("radio_button_checked", "Record by playing", "Play the combo from your starting hand: every Summon, activation and choice becomes a step.", () => newCombo({ how: "record" }), true),
        tile("edit_note", "Write the steps", "Build the combo step by step, with the exact cards, zones and answers.", () => newCombo({ how: "write" })),
        tile("download", "Import a code", "Add a combo shared from another Helios client.", importAndSave)
      ),
      baseSection(),
      howItWorks(true)
    );
  }

  function renderCombos() {
    if (!store.combos.length) {
      clear(panel).append(emptyState());
      return;
    }
    const variants = store.combos.filter((c) => c.parent).length;
    clear(panel).append(
      h(
        "div.combo-toolbar",
        h("div.combo-toolbar-title", h("h2", "Your combos"), h("span.muted.small", [plural(store.combos.length - variants, "combo"), variants ? plural(variants, "variant") : ""].filter(Boolean).join(" · "))),
        search,
        h("button.btn", { title: "Import a combo code (from the clipboard or pasted)", onclick: importAndSave }, icon("download"), " Import"),
        h("button.btn.primary", { onclick: () => newCombo() }, icon("add"), " New combo")
      ),
      list,
      baseSection(),
      howItWorks(false)
    );
    renderList();
  }

  /**
   * "New combo": la decklist di partenza (copiata: la combo non dipende dal mazzo) e se scrivere i passi
   * o registrarli giocando (how, se già scelto). sheet: lo spreadsheet in cui aggiungerla (propone la sua
   * decklist d'esempio). Restituisce la combo scritta (quelle registrate arrivano dopo, a fine duello).
   */
  async function newCombo({ sheet = null, how = null } = {}) {
    const picker = decklistPicker(decks, { sample: sheet?.sample ?? null });
    const method = (value, ic, title, text) => h(`button.combo-start.small${value === "record" ? ".primary" : ""}`, { onclick: () => m.close(value) }, h("span.combo-start-icon", icon(ic)), h("b", title), h("span", text));
    const m = openModal({
      title: how === "record" ? "Record a new combo" : how === "write" ? "Write a new combo" : "New combo",
      className: "combo-method",
      body: [
        h("label.field", h("span", "Starting decklist"), picker.el),
        h("p.muted.small", "The combo gets its own copy of the list: changing or deleting the Deck later does not change the combo. You can edit it in the combo."),
        how
          ? null
          : h(
              "div.combo-start-grid.two",
              method("record", "radio_button_checked", "Record by playing", "Play it: every action and choice becomes a step."),
              method("write", "edit_note", "Write the steps", "Build it step by step in the editor.")
            ),
      ],
      actions: how ? [{ label: "Cancel", value: null }, { label: "Continue", primary: true, value: how }] : [{ label: "Cancel", value: null }],
    });
    how = await m.result;
    if (!how) return null;
    const base = await picker.read();
    if (!base) return null;
    const cards = { main: [...base.main], extra: [...base.extra], side: [...(base.side ?? [])] };
    if (how === "write") {
      const v = await editCombo(null, { decks, cards });
      if (!v) return null;
      ctx.put(v);
      if (sheet) {
        sheet.combos.push(v.id);
        save();
      }
      return v;
    }
    if (how === "record") {
      const setup = await editCombo(null, { decks, cards, setup: true });
      if (setup) record(app, setup, sheet?.id ?? null);
    }
    return null;
  }

  const tabs = h("div.tabs.big.combo-tabs");
  function renderTab() {
    clear(tabs).append(
      h(`button.tab${view.tab === "combos" ? ".on" : ""}`, { onclick: () => { view = { tab: "combos", sheetId: null }; renderTab(); } }, "Combos"),
      h(`button.tab${view.tab === "sheets" ? ".on" : ""}`, { onclick: () => { view = { tab: "sheets", sheetId: null }; renderTab(); } }, "Spreadsheets")
    );
    if (view.tab === "sheets") {
      renderSheets(clear(panel), ctx, view.sheetId, view.sheetMode);
      return;
    }
    renderCombos();
  }

  root.append(
    h(
      "div.page.combos",
      h("div.page-head", h("button.btn.ghost.round.page-back", { title: "Menu (right-click)", onclick: () => { view = { tab: "combos", sheetId: null }; app.home("training"); } }, icon("chevron_left")), h("h1", "Trainer")),
      tabs,
      panel
    )
  );
  renderTab();
  // Fine registrazione: si apre l'editor con i passi registrati (si possono rivedere e aggiungere hand trap).
  if (review) {
    editCombo(review.combo, { decks }).then((v) => {
      if (!v) return;
      ctx.put(v);
      const sh = review.sheetId && store.sheets.find((x) => x.id === review.sheetId);
      if (sh && !sh.combos.includes(v.id)) {
        sh.combos.push(v.id);
        save();
      }
    });
  }
}

const hasSetup = (s) => !!s && [s.me, s.opp].some((x) => x && Object.values(x).some((v) => v?.length));

/** Esportazione: codice da condividere o video della combo (giocata dal trainer o dal giocatore). */
async function exportCombo(app, c) {
  const video = canRecordVideo();
  const record = (autoplay) => async (close) => {
    close();
    // getDisplayMedia va chiamato subito dopo il clic: il browser chiede quale scheda condividere.
    let cap;
    try {
      cap = await startVideo(app.root);
    } catch (e) {
      if (e?.name === "NotReadableError") {
        alertModal("Video recording", "The browser could not capture the screen. On macOS allow it in System Settings → Privacy & Security → Screen & System Audio Recording (enable your browser), then restart the browser.");
      } else if (e?.name !== "NotAllowedError") toast(e.message || "Unable to record the video", { kind: "error" });
      return;
    }
    practice(app, c, { video: cap, autoplay });
  };
  await openModal({
    title: `Export "${c.name}"`,
    className: "combo-export",
    body: [
      h("p.muted.small", "Share code: import it in another Helios client (Trainer → Import)."),
      video
        ? h("p.muted.small", "Video: the browser asks which tab to share (choose this one). With auto-play the trainer plays the combo by itself, using the cards, zones and answers of each step; the recording stops a few seconds after the combo is complete. Board tags appear above the cards at the end.")
        : h("p.muted.small", "This browser cannot record videos."),
    ],
    actions: [
      { label: "Close", value: null },
      { label: "Copy share code", onClick: (close) => { close(); shareCombo(c); } },
      ...(video
        ? [
            { label: "Video: I play it", onClick: record(false) },
            { label: "Video: auto-play", primary: true, onClick: record(true) },
          ]
        : []),
    ],
  }).result;
}

/** Copia negli appunti il codice della combo (se non si può, lo mostra da copiare a mano). */
function shareCombo(c) {
  const code = comboToCode(c);
  const show = () =>
    openModal({ title: "Share combo", body: [h("p.muted.small", "Copy this code and import it in another Helios client (Trainer → Import)."), h("textarea.input.combo-code", { readOnly: true, rows: 5, value: code, onfocus: (e) => e.target.select() })], actions: [{ label: "Close", value: null, primary: true }] });
  if (!navigator.clipboard?.writeText) return show();
  navigator.clipboard.writeText(code).then(() => toast(`Combo code copied: "${c.name}"`), show);
}

/** Importa un codice di combo dagli appunti o incollato a mano; restituisce la combo nuova o null. */
async function importCombo() {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    /* appunti non accessibili: si chiede di incollare */
  }
  if (!String(text).trim().startsWith("HELIOS-COMBO:")) {
    const area = h("textarea.input.combo-code", { rows: 5, placeholder: "HELIOS-COMBO:..." });
    const v = await openModal({ title: "Import combo", body: [h("p.muted.small", "Paste the combo code:"), area], actions: [{ label: "Cancel", value: null }, { label: "Import", primary: true, onClick: (close) => close(area.value) }] }).result;
    if (!v) return null;
    text = v;
  }
  if (isSheetCode(text)) {
    alertModal("Import combo", "This is a spreadsheet code: import it from Trainer → Spreadsheets → Import.");
    return null;
  }
  try {
    const c = { id: uid(), ...comboFromCode(text) };
    toast(`Combo imported: "${c.name}"`);
    return c;
  } catch (e) {
    alertModal("Import combo", e.message);
    return null;
  }
}

// ------------------------------------------------------------- ricerca di una carta

/**
 * Finestra di ricerca di una carta (stessa grafica in tutto il Combo Trainer e nel calcolatore).
 * Restituisce il codice scelto o null.
 * @param pool  se indicato, solo queste carte (es. la decklist), mostrate tutte nell'ordine del deck builder;
 *              altrimenti l'intero database, con `suggest` mostrati quando la ricerca è vuota
 * @param filter (card) -> bool
 */
export function pickCard({ title = "Choose a card", suggest = [], filter = () => true, hint = "", pool = null } = {}) {
  const input = h("input.input", { placeholder: pool ? "Filter by name or text…" : "Search the card database…", autocomplete: "off" });
  const list = h("div.announce-list.card-search-list");
  const ordered = pool ? sortDeckPart(uniq(pool)).map(getCard).filter((c) => c && filter(c)) : null;
  const candidates = ordered ?? db.list.filter((c) => c.source !== 1 && filter(c));
  const row = (code) => h("button.announce-row", { onclick: () => m.close(code) }, cardFace(code), h("span", cardName(code), h("small.muted", statLine(getCard(code)) || typeLine(getCard(code)))));
  const render = () => {
    const q = input.value.trim().toLowerCase();
    if (!q && ordered) {
      clear(list).append(...(ordered.length ? ordered.map((c) => row(c.code)) : [h("div.muted.small.card-search-sub", "No cards: the decklist is empty or has none of this kind.")]));
      return;
    }
    if (!q) {
      const sug = suggest.filter((code) => getCard(code) && filter(getCard(code)));
      clear(list).append(...(sug.length ? [h("div.muted.small.card-search-sub", "Suggested"), ...sug.slice(0, 60).map(row)] : [h("div.muted.small.card-search-sub", "Type to search the card database.")]));
      return;
    }
    const byNameHit = candidates.filter((c) => c.name.toLowerCase().includes(q));
    const byText = byNameHit.length < 60 ? candidates.filter((c) => !c.name.toLowerCase().includes(q) && c.search?.includes(q)) : [];
    const found = [...byNameHit, ...byText].slice(0, 80);
    clear(list).append(...(found.length ? found.map((c) => row(c.code)) : [h("div.muted.small.card-search-sub", "No cards found.")]));
  };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") list.querySelector(".announce-row")?.click();
  });
  const m = openModal({ title, className: "wide card-search", body: [hint && h("p.muted.small", hint), input, list], actions: [{ label: "Cancel", value: null }] });
  render();
  setTimeout(() => input.focus(), 50);
  return m.result.then((v) => v ?? null);
}

// ------------------------------------------------------------- editor della combo

const ZONES = [
  ...[0, 1, 2, 3, 4].map((i) => [`m${i}`, `Main Monster Zone ${i + 1}`]),
  ["m5", "Extra Monster Zone (left)"],
  ["m6", "Extra Monster Zone (right)"],
  ...[0, 1, 2, 3, 4].map((i) => [`s${i}`, `Spell & Trap Zone ${i + 1}${i === 0 ? " / left Pendulum Zone" : i === 4 ? " / right Pendulum Zone" : ""}`]),
  ["f", "Field Zone"],
];
const POSITIONS = [["atk", "Face-up Attack / face-up"], ["def", "Face-up Defense"], ["set", "Face-down (Set)"]];
const TAG_SUGGESTIONS = ["Omni-negate", "Negate", "Pop", "Floodgate", "Interruption", "Banish", "Bounce", "Spin", "Follow-up", "Recursion", "Search", "Protection", "Extender", "Hand trap check"];
const isMonster = (code) => ((getCard(code)?.type ?? 0) & TYPE.MONSTER) !== 0;
const isFieldSpell = (code) => ((getCard(code)?.type ?? 0) & TYPE.FIELD) !== 0;
const isPendulum = (code) => ((getCard(code)?.type ?? 0) & TYPE.PENDULUM) !== 0;

/** Zona più adatta libera per una carta (mostri nelle zone mostri, magie di terreno nella Field Zone...). */
function freeZone(list, code) {
  const taken = new Set(list.map((x) => x.zone));
  const pref = isFieldSpell(code) ? ["f"] : isMonster(code) ? ["m2", "m1", "m3", "m0", "m4", "m5", "m6"] : ["s2", "s1", "s3", "s0", "s4"];
  return pref.find((z) => !taken.has(z)) ?? ZONES.map(([z]) => z).find((z) => !taken.has(z)) ?? null;
}

const emptySetup = () => ({ me: { field: [], gy: [], banished: [], deckTop: [] }, opp: { field: [], gy: [], banished: [], hand: [], deckTop: [], extra: [] } });

/**
 * Editor di una combo; restituisce la combo salvata o null.
 * cards: decklist di una combo nuova ({ main, extra }, copiata da un mazzo come punto di partenza).
 * setup: solo nome, turno, mano, decklist e stato di partenza, per iniziare una registrazione.
 */
function editCombo(combo, { decks = loadDecks(), cards = null, setup = false } = {}) {
  const c = combo ? structuredClone(combo) : { id: uid(), name: "New combo", first: true, hand: [], steps: [], interrupts: [], tags: [], cards: cards ?? { main: [], extra: [] } };
  c.cards = { main: [...(c.cards?.main ?? [])], extra: [...(c.cards?.extra ?? [])], side: [...(c.cards?.side ?? [])] };
  c.tags ??= [];
  c.notes ??= "";
  c.setup = { ...emptySetup(), ...(cleanSetup(c.setup) ?? {}) };
  // Combo vecchie: le hand trap partivano in mano da sole, ora sono carte della mano dell'avversario.
  c.setup.opp.hand.push(...interruptsOutsideBoard(c));
  const name = h("input.input", { value: c.name, maxLength: 60 });
  const first = h("select.select", h("option", { value: "1" }, "Going first"), h("option", { value: "0" }, "Going second"));
  first.value = c.first ? "1" : "0";
  const notes = h("textarea.input.combo-notes", { value: c.notes, rows: 3, maxLength: NOTES_MAX, placeholder: "Notes for the player: what the combo does, what to watch out for, choke points, alternatives…" });
  const branch = h("input.input", { value: c.branch ?? "", maxLength: 40, placeholder: "e.g. No Ash Blossom" });
  // Carte della decklist della combo, nell'ordine del deck builder (mostri, magie, trappole...).
  const empty = () => !c.cards.main.length && !c.cards.extra.length;
  const mainCards = () => sortDeckPart(uniq(c.cards.main));
  const deckCards = () => [...mainCards(), ...sortDeckPart(uniq(c.cards.extra))];
  /** Le carte della combo (mano, passi, scelte, tag) si scelgono solo tra quelle della sua decklist. */
  const pool = () => deckCards();
  const EMPTY_HINT = "The decklist is empty: add its cards first (Decklist → Edit in the Deck Builder).";
  /** Carte che una scelta precisa può indicare: la decklist e le carte dello stato di partenza (es. quelle dell'avversario). */
  const choicePool = () => {
    const st = c.setup;
    const fromSetup = [st.me, st.opp].flatMap((x) => [...(x.field ?? []).map((f) => f.code), ...(x.gy ?? []), ...(x.banished ?? []), ...(x.hand ?? []), ...(x.deckTop ?? []), ...(x.extra ?? [])]);
    return uniq([...deckCards(), ...fromSetup, ...c.interrupts.map((x) => x.code)]);
  };
  const handEl = h("div.combo-hand-pick");
  const poolEl = h("div.sheet-tools");
  const stepsEl = h("ol.combo-steps-edit");
  const setupEl = h("div.combo-setup");
  const tagsEl = h("div.combo-tags-edit");
  const cardsEl = h("div.combo-cards-edit");

  // ---- annulla / ripeti (Ctrl+Z, Ctrl+Y o Ctrl+Shift+Z)
  const history = [];
  let at = -1;
  const state = () => JSON.stringify({ name: c.name, first: c.first, hand: c.hand, steps: c.steps, interrupts: c.interrupts, setup: c.setup, tags: c.tags, cards: c.cards, notes: c.notes, branch: c.branch ?? "" });
  const undoBtn = h("button.btn.small.ghost", { title: "Undo (Ctrl+Z)", onclick: () => undo() }, icon("undo"));
  const redoBtn = h("button.btn.small.ghost", { title: "Redo (Ctrl+Y)", onclick: () => redo() }, icon("redo"));
  const paintHistory = () => {
    undoBtn.disabled = at <= 0;
    redoBtn.disabled = at >= history.length - 1;
  };
  /** Da chiamare dopo ogni modifica: salva lo stato nella cronologia. */
  const snap = () => {
    c.name = name.value.trim() || c.name;
    const s = state();
    if (history[at] === s) return;
    history.length = at + 1;
    history.push(s);
    if (history.length > 200) history.shift();
    at = history.length - 1;
    paintHistory();
  };
  const restore = (s) => {
    Object.assign(c, JSON.parse(s));
    name.value = c.name;
    first.value = c.first ? "1" : "0";
    notes.value = c.notes;
    branch.value = c.branch ?? "";
    renderAll();
    paintHistory();
  };
  const undo = () => at > 0 && restore(history[--at]);
  const redo = () => at < history.length - 1 && restore(history[++at]);
  name.addEventListener("change", snap);
  first.addEventListener("change", () => { c.first = first.value === "1"; snap(); });
  notes.addEventListener("input", () => (c.notes = notes.value));
  notes.addEventListener("change", snap);
  branch.addEventListener("input", () => (c.branch = branch.value));
  branch.addEventListener("change", snap);

  const cardBtn = (code, onPick, opts = {}) =>
    h("button.btn.card-pick-btn", { title: "Choose a card", onclick: () => pickCard(opts).then((v) => v && onPick(v)) }, code ? cardName(code) : opts.empty ?? "Choose a card…");

  function renderHand() {
    clear(handEl).append(
      ...(c.hand.length ? c.hand.map((code, i) => h("button.combo-card.chosen", { title: "Remove from the hand", onclick: () => { c.hand.splice(i, 1); renderHand(); snap(); } }, cardFace(code))) : [h("span.muted.small", "No cards yet: choose them from the decklist.")])
    );
    // La mano si sceglie dal Main Deck della decklist, in una schermata come quella del Side Deck.
    clear(poolEl).append(
      ...(c.cards.main.length
        ? [h("button.btn.small.primary", { onclick: () => chooseCards("hand") }, icon("style"), " Choose in the Deck Builder")]
        : [h("span.muted.small", EMPTY_HINT), h("button.btn.small", { onclick: () => editDecklist() }, icon("style"), " Edit in the Deck Builder")])
    );
  }

  // Le hand trap restano agganciate al passo dopo cui erano (after = quanti passi prima di loro).
  function insertStep(i) {
    c.steps.splice(i, 0, { kind: "activate", code: deckCards()[0] ?? 0 });
    c.interrupts.forEach((x) => { if (x.after > i) x.after++; });
    renderSteps();
    snap();
  }
  function removeStep(i) {
    c.steps.splice(i, 1);
    c.interrupts.forEach((x) => { if (x.after > i) x.after--; });
    renderSteps();
    snap();
  }
  function moveStep(from, to) {
    if (from === to || to < 0 || to >= c.steps.length) return;
    const [s] = c.steps.splice(from, 1);
    c.steps.splice(to, 0, s);
    renderSteps();
    snap();
  }

  const closeMenus = () => stepsEl.querySelectorAll(".step-menu").forEach((x) => (x.hidden = true));
  let dragFrom = null;
  // Passi con le scelte precise ridotte (solo nell'editor, non si salva).
  const collapsed = new WeakSet();
  const foldAll = h("button.btn.small.ghost", {
    onclick: () => {
      const open = c.steps.filter((s) => s.details?.length && !collapsed.has(s));
      if (open.length) open.forEach((s) => collapsed.add(s));
      else c.steps.forEach((s) => collapsed.delete(s));
      renderSteps();
    },
  });

  /** Menu ⋮ (stesso stile per passi e scelte precise). */
  const menuButton = (menu, title) =>
    h("button.btn.small.ghost.step-more", { title, onclick: (e) => { e.stopPropagation(); const open = menu.hidden; closeMenus(); menu.hidden = !open; } }, icon("more_vert"));

  /**
   * Trascinamento per riordinare: la riga si trascina dalla maniglia; drag = { get, set } dello stato
   * condiviso tra le righe dello stesso elenco, move(from, to) sposta l'elemento.
   */
  function draggable(row, handle, index, drag, move) {
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      row.draggable = true;
    });
    row.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      drag.set(index);
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
    });
    row.addEventListener("dragend", (e) => {
      e.stopPropagation();
      row.draggable = false;
      row.classList.remove("dragging");
      stepsEl.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    });
    const after = (e) => {
      const r = row.getBoundingClientRect();
      return e.clientY > r.top + r.height / 2;
    };
    row.addEventListener("dragover", (e) => {
      if (drag.get() == null) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.toggle("drop-after", after(e));
      row.classList.toggle("drop-before", !after(e));
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
    row.addEventListener("drop", (e) => {
      if (drag.get() == null) return;
      e.preventDefault();
      e.stopPropagation();
      let to = after(e) ? index + 1 : index;
      const from = drag.get();
      if (from < to) to--;
      drag.set(null);
      move(from, to);
    });
  }

  const DETAIL_ICONS = { cards: "style", pick: "touch_app", zone: "grid_view", pos: "screen_rotation", yesno: "help", option: "list" };
  let dragDetail = null; // { step, from }

  /** Scelta precisa come sotto-passo: menu ⋮, numero, testo (clic = modifica), maniglia per riordinare. */
  function detailRow(s, i, d, j) {
    const menu = h(
      "div.step-menu",
      { hidden: true },
      h("button", { onclick: () => { closeMenus(); editDetail(s, j); } }, icon("vertical_align_top"), " Add choice above"),
      h("button", { onclick: () => { closeMenus(); editDetail(s, j + 1); } }, icon("vertical_align_bottom"), " Add choice below"),
      h("button", { onclick: () => { closeMenus(); editDetail(s, j, true); } }, icon("edit"), " Edit choice…"),
      h("button.danger", { onclick: () => { s.details.splice(j, 1); renderSteps(); snap(); } }, icon("delete"), " Delete choice")
    );
    const handle = h("span.step-drag", { title: "Drag to reorder" }, icon("drag_indicator"));
    const row = h(
      "li.detail-row",
      h(
        "div.detail-line",
        menuButton(menu, "Choice options"),
        h("span.step-num.detail-num", `${i + 1}.${j + 1}`),
        h("button.detail-text", { title: "Edit this choice", onclick: () => editDetail(s, j, true) }, icon(DETAIL_ICONS[d.t] ?? "ads_click"), h("span", detailText(d))),
        handle
      ),
      menu
    );
    draggable(row, handle, j, { get: () => (dragDetail?.step === s ? dragDetail.from : null), set: (v) => (dragDetail = v == null ? null : { step: s, from: v }) }, (from, to) => {
      if (from === to) return;
      const [x] = s.details.splice(from, 1);
      s.details.splice(to, 0, x);
      renderSteps();
      snap();
    });
    return row;
  }

  function renderSteps() {
    // Il passo si ridisegna da capo: si tiene la posizione di scorrimento (senza, cancellando un sotto-passo
    // la lista si svuota per un istante e la finestra torna in alto).
    const scroller = stepsEl.closest(".modal-body");
    const top = scroller?.scrollTop ?? 0;
    if (scroller) stepsEl.style.minHeight = `${stepsEl.offsetHeight}px`;
    clear(stepsEl).append(
      ...c.steps.map((s, i) => {
        const act = h("select.select.step-kind", Object.entries(STEP_ACTIONS).map(([k, l]) => h("option", { value: k }, l)));
        act.value = s.kind;
        // Stessa finestra di ricerca di tutto l'editor, limitata alla decklist.
        const card = h("button.btn.card-pick-btn.step-card", {
          title: "Choose the card of this step",
          onclick: () => pickCard({ title: `Card for step ${i + 1}: ${STEP_ACTIONS[s.kind]}`, pool: pool() }).then((v) => { if (v) { s.code = v; renderSteps(); snap(); } }),
        }, s.code ? cardName(s.code) : "Choose a card…");
        // End Phase: nessuna carta da scegliere.
        const syncCard = () => (card.style.visibility = NO_CARD.has(s.kind) ? "hidden" : "");
        act.addEventListener("change", () => {
          s.kind = act.value;
          if (!NO_CARD.has(s.kind) && !s.code) s.code = deckCards()[0] ?? 0;
          syncCard();
          renderInts();
          snap();
        });
        syncCard();
        // ⋮ a sinistra: aggiunge un passo sopra o sotto, una scelta precisa, elimina il passo.
        const menu = h(
          "div.step-menu",
          { hidden: true },
          h("button", { onclick: () => insertStep(i) }, icon("vertical_align_top"), " Add step above"),
          h("button", { onclick: () => insertStep(i + 1) }, icon("vertical_align_bottom"), " Add step below"),
          h("button", { onclick: () => { closeMenus(); editDetail(s); } }, icon("ads_click"), " Add a precise choice…"),
          h("button", { onclick: () => { closeMenus(); editNote(s); } }, icon("sticky_note_2"), s.note ? " Edit the note…" : " Add a note…"),
          h("button.danger", { onclick: () => removeStep(i) }, icon("delete"), " Delete step")
        );
        const more = menuButton(menu, "Step options");
        // Maniglia a destra: si trascina il passo per riordinarlo.
        const handle = h("span.step-drag", { title: "Drag to reorder" }, icon("drag_indicator"));
        // Scelte precise: sotto-passi in colonna, che si possono ridurre.
        const n = s.details?.length ?? 0;
        const folded = collapsed.has(s);
        const fold = n
          ? h("button.btn.small.ghost.step-fold", {
              title: folded ? "Show the precise choices" : "Hide the precise choices",
              onclick: () => { if (folded) collapsed.delete(s); else collapsed.add(s); renderSteps(); },
            }, icon(folded ? "chevron_right" : "expand_more"), plural(n, "choice"))
          : null;
        const details = n && !folded ? h("ol.step-details", s.details.map((d, j) => detailRow(s, i, d, j))) : null;
        const note = s.note ? h("div.step-note", { title: "Note (⋮ → Edit the note)" }, icon("sticky_note_2"), " ", s.note) : null;
        const row = h("li.combo-step-row", h("div.step-line", more, h("span.step-num", `${i + 1}.`), act, card, fold, handle), menu, details, note);
        draggable(row, handle, i, { get: () => dragFrom, set: (v) => (dragFrom = v) }, moveStep);
        return row;
      })
    );
    const anyOpen = c.steps.some((s) => s.details?.length && !collapsed.has(s));
    foldAll.hidden = !c.steps.some((s) => s.details?.length);
    clear(foldAll).append(icon(anyOpen ? "unfold_less" : "unfold_more"), anyOpen ? " Collapse all choices" : " Expand all choices");
    renderInts();
    stepsEl.style.minHeight = "";
    if (scroller) scroller.scrollTop = top;
  }

  /**
   * Scelta precisa del passo, scritta a mano: gli stessi tipi che la registrazione salva da sola (carte da
   * scegliere, una carta alla volta, zona, posizione, Sì/No, opzione di un effetto).
   * at: posizione in cui inserirla (in fondo se manca); edit: modifica la scelta in posizione at.
   */
  async function editDetail(s, at = null, edit = false) {
    const type = h(
      "select.select",
      h("option", { value: "cards" }, "Select cards (targets, costs, materials, searched cards…)"),
      h("option", { value: "pick" }, "Select one card at a time / finish the selection"),
      h("option", { value: "zone" }, "Zone to use"),
      h("option", { value: "pos" }, "Battle position"),
      h("option", { value: "yesno" }, "Yes / No (e.g. use an optional effect)"),
      h("option", { value: "option" }, "Option (which effect of a card)")
    );
    const pool = choicePool();
    const pick = (title) => pickCard({ title, pool });
    // carte
    const codes = [];
    const chosen = h("div.detail-cards");
    const paintCodes = () => clear(chosen).append(...(codes.length ? codes.map((code, i) => h("button.chip", { title: "Remove", onclick: () => { codes.splice(i, 1); paintCodes(); } }, cardName(code), " ×")) : [h("span.muted.small", "No cards yet.")]));
    const addCard = h("button.btn.small", { onclick: () => pick("Card to select").then((v) => { if (v) { codes.push(v); paintCodes(); } }) }, icon("add"), " Add card");
    // una carta / fine
    let one = 0;
    const oneBtn = h("button.btn.card-pick-btn", { onclick: () => pick("Card to select").then((v) => { if (v) { one = v; oneBtn.textContent = cardName(v); finish.checked = false; } }) }, "Choose a card…");
    const finish = h("input", { type: "checkbox", onchange: () => { if (finish.checked) { one = 0; oneBtn.textContent = "Choose a card…"; } } });
    // zona
    const ZONE_CHOICES = [...ZONES, ["p6", "Left Pendulum Zone (Master Rule 3)"], ["p7", "Right Pendulum Zone (Master Rule 3)"]];
    const zone = h("select.select", ZONE_CHOICES.map(([z, l]) => h("option", { value: z }, l)));
    const whose = h("select.select", h("option", { value: "1" }, "Your zone"), h("option", { value: "0" }, "Opponent's zone"));
    // posizione
    const pos = h("select.select", [[POS.FACEUP_ATTACK, "Face-up Attack"], [POS.FACEDOWN_ATTACK, "Face-down Attack"], [POS.FACEUP_DEFENSE, "Face-up Defense"], [POS.FACEDOWN_DEFENSE, "Face-down Defense"]].map(([v, l]) => h("option", { value: v }, l)));
    // sì / no
    const yes = h("select.select", h("option", { value: "1" }, "Yes"), h("option", { value: "0" }, "No"));
    let yesCard = 0;
    const yesCardBtn = h("button.btn.card-pick-btn", { title: "Optional: the card whose effect is asked (\"Use the effect of …?\")", onclick: () => pick("Card whose effect is asked").then((v) => { yesCard = v ?? 0; yesCardBtn.textContent = v ? cardName(v) : "Any question"; }) }, "Any question");
    // opzione
    let optCard = 0;
    const optSel = h("select.select", { disabled: true }, h("option", "Choose a card first"));
    const setOptCard = (v) => {
      optCard = v;
      optCardBtn.textContent = cardName(v);
      const strings = (getCard(v)?.strings ?? []).map((t, i) => [i, t]).filter(([, t]) => t);
      clear(optSel).append(...(strings.length ? strings.map(([i, t]) => h("option", { value: i }, t)) : [h("option", { value: "" }, "This card has no effect options")]));
      optSel.disabled = !strings.length;
    };
    const optCardBtn = h("button.btn.card-pick-btn", { onclick: () => pick("Card with the effect").then((v) => v && setOptCard(v)) }, "Choose a card…");
    // Carte prese dal Deck (ricerche, materiali, evocazioni dal Deck): contano come copie in più nella decklist.
    const fromDeck = h("input", { type: "checkbox" });
    const oneFromDeck = h("input", { type: "checkbox" });
    // Modifica: i campi partono dalla scelta salvata.
    const init = edit ? s.details?.[at] : null;
    if (init) {
      type.value = init.t;
      switch (init.t) {
        case "cards": codes.push(...init.codes); fromDeck.checked = !!init.deck?.length; break;
        case "pick":
          if (init.code) { one = init.code; oneBtn.textContent = cardName(one); } else finish.checked = true;
          oneFromDeck.checked = !!init.deck;
          break;
        case "zone": {
          const p = init.places[0];
          const z = !p ? "" : p.loc === "s" && p.seq === 5 ? "f" : p.loc === "s" && p.seq > 5 ? `p${p.seq}` : `${p.loc}${p.seq}`;
          if (ZONE_CHOICES.some(([k]) => k === z)) zone.value = z;
          if (p) whose.value = p.mine ? "1" : "0";
          break;
        }
        case "pos": pos.value = String(init.pos); break;
        case "yesno":
          yes.value = init.yes ? "1" : "0";
          if (init.code) { yesCard = init.code; yesCardBtn.textContent = cardName(init.code); }
          break;
        case "option":
          if (init.desc) {
            const v = BigInt(init.desc);
            setOptCard(Number(v >> 20n));
            optSel.value = String(Number(v & 0xfffffn));
          }
          break;
      }
    }
    const parts = {
      cards: h("div.detail-part", chosen, addCard, h("label.check", { title: "Each card counts as one more copy needed in the decklist" }, fromDeck, "Taken from the Deck")),
      pick: h("div.detail-part", oneBtn, h("label.check", finish, "Finish the selection instead"), h("label.check", { title: "The card counts as one more copy needed in the decklist" }, oneFromDeck, "Taken from the Deck")),
      zone: h("div.detail-part", zone, whose),
      pos: h("div.detail-part", pos),
      yesno: h("div.detail-part", yes, h("span.muted.small", "for"), yesCardBtn),
      option: h("div.detail-part", optCardBtn, optSel),
    };
    const sync = () => Object.entries(parts).forEach(([k, el]) => (el.hidden = k !== type.value));
    type.addEventListener("change", sync);
    paintCodes();
    sync();
    const d = await openModal({
      title: `${init ? "Edit the precise choice" : "Precise choice"} for: ${stepText(s)}`,
      className: "combo-detail",
      body: [h("p.muted.small", "Choices are checked in order during the step (and used by auto-play)."), h("label.field", h("span", "Type"), type), ...Object.values(parts)],
      actions: [
        { label: "Cancel", value: null },
        {
          label: init ? "Save" : "Add",
          primary: true,
          onClick: (close) => {
            switch (type.value) {
              case "cards": {
                if (!codes.length) return alertModal("Select cards", "Add at least one card.");
                const sorted = [...codes].sort((a, b) => a - b);
                return close({ t: "cards", codes: sorted, ...(fromDeck.checked ? { deck: sorted } : {}) });
              }
              case "pick":
                if (!one && !finish.checked) return alertModal("Select a card", "Choose a card or \"Finish the selection\".");
                return close({ t: "pick", code: finish.checked ? 0 : one, ...(oneFromDeck.checked && !finish.checked ? { deck: true } : {}) });
              case "zone": {
                const z = zone.value;
                const place = z === "f" ? { loc: "s", seq: 5 } : z[0] === "p" ? { loc: "s", seq: +z.slice(1) } : { loc: z[0], seq: +z.slice(1) };
                return close({ t: "zone", places: [{ mine: whose.value === "1", ...place }] });
              }
              case "pos": return close({ t: "pos", pos: +pos.value });
              case "yesno": return close(yesCard ? { t: "yesno", yes: yes.value === "1", code: yesCard } : { t: "yesno", yes: yes.value === "1" });
              case "option":
                if (!optCard || optSel.disabled) return alertModal("Option", "Choose a card with effect options.");
                return close({ t: "option", desc: String((BigInt(optCard) << 20n) | BigInt(+optSel.value)) });
            }
          },
        },
      ],
    }).result;
    if (!d) return;
    s.details ??= [];
    if (init) s.details[at] = d;
    else s.details.splice(at ?? s.details.length, 0, d);
    collapsed.delete(s);
    renderSteps();
    snap();
  }

  // I passi cambiano: si aggiornano le scelte "quando l'avversario la usa" dello stato di partenza.
  const renderInts = () => renderSetup();

  // ---- stato di partenza (carte già in gioco, mano e Deck dell'avversario): le carte si cercano nel database
  // con la schermata del deck builder; zona e posizione delle carte sul campo si scelgono qui.
  const noExtra = (card) => !isExtraDeckCard(card);
  /** Carte sul campo dopo la schermata: quelle che c'erano tengono zona e posizione, le nuove vanno in una zona libera. */
  function fieldFrom(old, codes) {
    const left = [...old];
    const out = [];
    const fresh = [];
    for (const code of codes) {
      const i = left.findIndex((x) => x.code === code);
      if (i >= 0) out.push(left.splice(i, 1)[0]);
      else fresh.push(code);
    }
    let dropped = 0;
    for (const code of fresh) {
      const zone = freeZone(out, code);
      if (!zone) dropped++;
      else out.push({ code, zone, pos: isMonster(code) || isFieldSpell(code) ? "atk" : "set" });
    }
    if (dropped) alertModal("Field", `${plural(dropped, "card")} not placed: all zones are already used.`);
    return out;
  }
  /** Stato di partenza nella schermata del deck builder; active: la parte da riempire per prima. */
  async function editBoard(active = "me_field") {
    const st = c.setup;
    const parts = [
      { key: "me_field", label: "Your field", cards: st.me.field.map((x) => x.code), max: 13, hint: "zones and positions: in the combo editor" },
      { key: "me_gy", label: "Your GY", cards: st.me.gy },
      { key: "me_banished", label: "Your banished cards", cards: st.me.banished },
      { key: "opp_field", label: "Opponent's field", cards: st.opp.field.map((x) => x.code), max: 13, hint: "e.g. Set traps · zones, positions and when they are used: in the combo editor" },
      { key: "opp_hand", label: "Opponent's hand", cards: st.opp.hand, filter: noExtra, hint: "e.g. hand traps · when they are used: in the combo editor" },
      { key: "opp_deckTop", label: "Top of the opponent's Deck", cards: st.opp.deckTop, filter: noExtra, hint: "the first card is the top one" },
      { key: "opp_extra", label: "Opponent's Extra Deck", cards: st.opp.extra, filter: isExtraDeckCard },
      { key: "opp_gy", label: "Opponent's GY", cards: st.opp.gy },
      { key: "opp_banished", label: "Opponent's banished cards", cards: st.opp.banished },
    ];
    const v = await deckScreen(() => openCardCollector({ title: c.name, subtitle: "Starting board state", parts, active }));
    if (!v) return;
    const bound = interruptOf();
    st.me.field = fieldFrom(st.me.field, v.me_field);
    st.opp.field = fieldFrom(st.opp.field, v.opp_field);
    Object.assign(st.me, { gy: v.me_gy, banished: v.me_banished });
    Object.assign(st.opp, { hand: v.opp_hand, deckTop: v.opp_deckTop, extra: v.opp_extra, gy: v.opp_gy, banished: v.opp_banished });
    // Le interruzioni restano alle carte che l'avversario ha ancora (stesso codice).
    c.interrupts = [...bound.values()];
    pruneInterrupts();
    renderSetup();
    snap();
  }
  /**
   * Interruzione di ogni carta dell'avversario (mano, poi campo): le interruzioni { after, code } si legano,
   * nell'ordine, alla prima carta con quel codice ancora libera. Chiave "hand:i" / "field:i".
   */
  function interruptOf() {
    const map = new Map();
    const free = [...c.interrupts];
    const bind = (key, code) => {
      const i = free.findIndex((x) => x.code === code);
      if (i >= 0) map.set(key, free.splice(i, 1)[0]);
    };
    c.setup.opp.hand.forEach((code, i) => bind(`hand:${i}`, code));
    c.setup.opp.field.forEach((f, i) => bind(`field:${i}`, f.code));
    return map;
  }
  /** Interruzioni di carte che l'avversario non ha più: si tolgono. */
  const pruneInterrupts = () => {
    const bound = new Set(interruptOf().values());
    c.interrupts = c.interrupts.filter((x) => bound.has(x));
  };
  /** Quando l'avversario usa la carta: mai, dall'inizio o dopo un passo (interruzione). */
  function useSelect(code, bound) {
    const sel = h(
      "select.select.int-use",
      h("option", { value: "" }, "Not used"),
      h("option", { value: "0" }, "Used from the start"),
      c.steps.map((st, j) => h("option", { value: j + 1 }, `Used after step ${j + 1}: ${stepText(st)}`))
    );
    sel.value = bound ? String(Math.min(bound.after, c.steps.length)) : "";
    sel.classList.toggle("on", !!bound);
    sel.addEventListener("change", () => {
      if (bound) c.interrupts.splice(c.interrupts.indexOf(bound), 1);
      if (sel.value !== "") c.interrupts.push({ after: +sel.value, code });
      renderSetup();
      snap();
    });
    return sel;
  }
  const addBtn = (key) => h("button.btn.small.ghost", { title: "Add cards in the Deck Builder (card database search)", onclick: () => editBoard(key) }, icon("add"), " Add");
  function cardList(arr, key, ordered = false) {
    return h(
      "div.setup-list",
      arr.map((code, i) => h("button.chip", { title: "Remove", onclick: () => { arr.splice(i, 1); renderSetup(); snap(); } }, ordered ? `${i + 1}. ` : "", cardName(code), " ×")),
      addBtn(key)
    );
  }
  function fieldList(list, key) {
    const ints = key === "opp_field" ? interruptOf() : null;
    const rows = list.map((x, i) => {
      const zone = h("select.select", ZONES.map(([z, l]) => h("option", { value: z, disabled: z !== x.zone && list.some((y) => y.zone === z) }, l)));
      zone.value = x.zone;
      zone.addEventListener("change", () => { x.zone = zone.value; renderSetup(); snap(); });
      const pos = h("select.select", POSITIONS.map(([p, l]) => h("option", { value: p }, l)));
      pos.value = x.pos;
      pos.addEventListener("change", () => { x.pos = pos.value; snap(); });
      return h(
        "div.setup-field-row",
        h("span.setup-field-name", { title: cardName(x.code) }, cardName(x.code)),
        zone,
        pos,
        h("button.btn.small.ghost", { title: "Remove", onclick: () => { list.splice(i, 1); pruneInterrupts(); renderSetup(); snap(); } }, icon("close")),
        // Campo dell'avversario: quando la usa (sulla riga sotto).
        ints ? useSelect(x.code, ints.get(`field:${i}`)) : null
      );
    });
    return h("div.setup-field", rows, addBtn(key));
  }
  function renderSetup() {
    const s = c.setup;
    clear(setupEl).append(
      h(
        "div.setup-tools",
        h("button.btn.small.primary", { onclick: () => editBoard() }, icon("style"), " Edit in the Deck Builder"),
        h("span.muted.small", "All the zones in one screen, with the card database search."),
        h("span.spacer"),
        h("button.btn.small.ghost", { title: "Save this board state to use it in other combos, or copy its code", onclick: () => saveBoard() }, icon("save"), " Save…"),
        h("button.btn.small.ghost", { title: "Load a saved board state or paste a board state code", onclick: () => loadBoard() }, icon("download"), " Load…")
      ),
      h(
        "div.setup-col",
        h("h4", "You"),
        h("span.muted.small", "Field"), fieldList(s.me.field, "me_field"),
        h("span.muted.small", "GY"), cardList(s.me.gy, "me_gy"),
        h("span.muted.small", "Banished"), cardList(s.me.banished, "me_banished"),
        h("span.muted.small", "Top of your Deck, after the starting hand (1 = next draw)"),
        h(
          "div.setup-list",
          s.me.deckTop.map((code, i) => h("button.chip", { title: "Remove", onclick: () => { s.me.deckTop.splice(i, 1); renderSetup(); snap(); } }, `${i + 1}. `, cardName(code), " ×")),
          h("button.btn.small.ghost", { disabled: empty(), onclick: () => chooseCards("top") }, icon("style"), " Choose in the Deck Builder")
        )
      ),
      h(
        "div.setup-col",
        h("h4", "Opponent"),
        h("span.muted.small", "Field"), fieldList(s.opp.field, "opp_field"),
        h("span.muted.small", "Hand (hand traps: choose when they are used)"),
        h(
          "div.setup-field",
          (() => {
            const ints = interruptOf();
            return s.opp.hand.map((code, i) =>
              h(
                "div.setup-field-row.setup-hand-row",
                h("span.setup-field-name", { title: cardName(code) }, cardName(code)),
                useSelect(code, ints.get(`hand:${i}`)),
                h("button.btn.small.ghost", { title: "Remove", onclick: () => { s.opp.hand.splice(i, 1); pruneInterrupts(); renderSetup(); snap(); } }, icon("close"))
              )
            );
          })(),
          addBtn("opp_hand")
        ),
        h("span.muted.small", "Top of the Deck (1 = top card)"), cardList(s.opp.deckTop, "opp_deckTop", true),
        h("span.muted.small", "Extra Deck"), cardList(s.opp.extra, "opp_extra"),
        h("span.muted.small", "GY"), cardList(s.opp.gy, "opp_gy"),
        h("span.muted.small", "Banished"), cardList(s.opp.banished, "opp_banished")
      )
    );
  }



  // ---- stati di partenza salvati (da riusare in altre combo) e codici da condividere
  /** Hand trap dell'avversario con il momento in cui le usa (solo quelle legate a una sua carta). */
  const boardInts = () => [...interruptOf().values()].map((x) => ({ after: x.after, code: x.code }));
  async function saveBoard() {
    const name = await promptModal("Save board state", "Name", c.name);
    if (name == null) return;
    const board = { id: uid(), name: name.trim().slice(0, 60) || c.name, setup: structuredClone(c.setup), interrupts: boardInts() };
    const list = loadBoards();
    const same = list.findIndex((b) => b.name === board.name);
    if (same >= 0 && !(await confirmModal("Save board state", `Replace the saved board state "${board.name}"?`, "Replace", "Cancel"))) return;
    if (same >= 0) list[same] = { ...board, id: list[same].id };
    else list.unshift(board);
    saveBoards(list);
    const code = boardToCode(board);
    navigator.clipboard?.writeText(code).then(() => toast(`Board state saved: "${board.name}" (code copied)`), () => toast(`Board state saved: "${board.name}"`));
    if (!navigator.clipboard?.writeText) toast(`Board state saved: "${board.name}"`);
  }
  /** Sostituisce lo stato di partenza della combo; gli usi delle hand trap oltre l'ultimo passo vanno all'ultimo. */
  function applyBoard(b) {
    c.setup = { ...emptySetup(), ...structuredClone(b.setup) };
    c.interrupts = b.interrupts.map((x) => ({ after: Math.min(x.after, c.steps.length), code: x.code }));
    pruneInterrupts();
    renderSetup();
    snap();
    toast(`Board state loaded: "${b.name}"`);
  }
  async function loadBoard() {
    let list = loadBoards();
    const area = h("textarea.input.combo-code", { rows: 3, placeholder: "HELIOS-BOARD:..." });
    const summary = (b) => {
      const n = (s) => s.field.length + s.gy.length + s.banished.length + s.deckTop.length + (s.hand?.length ?? 0) + (s.extra?.length ?? 0);
      return `You ${plural(n(b.setup.me), "card")} · Opponent ${plural(n(b.setup.opp), "card")}${b.interrupts.length ? ` · ${plural(b.interrupts.length, "hand trap")}` : ""}`;
    };
    const listEl = h("div.board-list");
    let close = null;
    const draw = () => clear(listEl).append(
      ...(list.length
        ? list.map((b) => h(
            "div.board-row",
            h("div.board-row-text", h("b", b.name), h("span.muted.small", summary(b))),
            h("button.btn.small.ghost", { title: "Copy the code of this board state", onclick: () => navigator.clipboard?.writeText(boardToCode(b)).then(() => toast("Board state code copied")) }, icon("content_copy")),
            h("button.btn.small.ghost", {
              title: "Delete this saved board state",
              onclick: async () => {
                if (!(await confirmModal("Delete board state", `Delete the saved board state "${b.name}"?`, "Delete", "Cancel", { danger: true, top: true }))) return;
                list = list.filter((x) => x.id !== b.id);
                saveBoards(list);
                draw();
              },
            }, icon("delete")),
            h("button.btn.small.primary", { onclick: () => { close?.(); applyBoard(b); } }, "Load")
          ))
        : [h("p.muted.small", "No saved board states yet: use Save… in a combo with a board state.")])
    );
    draw();
    const m = openModal({
      title: "Load board state",
      className: "board-load",
      body: [h("p.muted.small", "It replaces the board state of this combo (your field, GY, banished cards and Deck top, and all of the opponent's)."), listEl, h("p.muted.small", "Or paste a board state code:"), area],
      actions: [
        { label: "Cancel", value: null },
        {
          label: "Load code",
          primary: true,
          onClick: (done) => {
            try {
              const b = boardFromCode(area.value);
              done();
              applyBoard(b);
            } catch (e) {
              toast(e.message, { kind: "error" });
            }
          },
        },
      ],
    });
    close = () => m.close?.();
    await m.result;
  }

  // ---- tag sulle carte della board finale
  function renderTags() {
    const list = h("datalist", { id: "combo-tag-names" }, TAG_SUGGESTIONS.map((t) => h("option", { value: t })));
    clear(tagsEl).append(
      list,
      ...c.tags.map((t, i) => {
        const text = h("input.input", { value: t.text, maxLength: 40, placeholder: "e.g. Omni-negate", list: "combo-tag-names" });
        text.addEventListener("input", () => (t.text = text.value));
        text.addEventListener("change", snap);
        return h("div.combo-tag-row", cardBtn(t.code, (v) => { t.code = v; renderTags(); snap(); }, { title: "Card on the final board", pool: pool() }), text, h("button.btn.small.ghost", { title: "Remove", onclick: () => { c.tags.splice(i, 1); renderTags(); snap(); } }, icon("close")));
      })
    );
  }

  // ---- decklist della combo (Main ed Extra Deck): è il mazzo con cui si gioca, indipendente dai mazzi salvati.
  // Si modifica con il deck builder; qui un'anteprima, con evidenziate le carte che la combo usa.
  let deckOpen = false;
  /** Schermata del deck builder: l'editor della combo si toglie di mezzo finché è aperta (scorciatoie e tasto destro sono suoi). */
  async function deckScreen(open) {
    const backdrop = m.el.closest(".modal-backdrop");
    const next = backdrop.nextSibling;
    deckOpen = true;
    backdrop.remove();
    try {
      return await open();
    } finally {
      document.body.insertBefore(backdrop, next?.isConnected ? next : null);
      deckOpen = false;
    }
  }
  /** Copie di `list` senza quelle di `used`. */
  const without = (list, used) => {
    const rest = [...list];
    for (const code of used) {
      const i = rest.indexOf(code);
      if (i >= 0) rest.splice(i, 1);
    }
    return rest;
  };

  /** Mano iniziale o cima del proprio Deck, scelte dal Main Deck della decklist (meno le carte già usate dall'altra). */
  async function chooseCards(kind) {
    const hand = kind === "hand";
    const top = c.setup.me.deckTop;
    const v = await deckScreen(() =>
      openDeckPicker({
        main: without(c.cards.main, hand ? top : c.hand),
        extra: c.cards.extra,
        side: c.cards.side,
        picked: hand ? c.hand : top,
        title: c.name,
        label: hand ? "Starting hand" : "Top of the Deck",
        max: hand ? 10 : 20,
        hint: hand ? "The order does not matter." : "In order: the first card is the next one drawn after the starting hand.",
      })
    );
    if (!v) return;
    if (hand) c.hand = v;
    else c.setup.me.deckTop = v;
    renderAll();
    snap();
  }

  async function editDecklist() {
    const v = await deckScreen(() => openDecklistEditor(c.cards, { title: c.name }));
    if (!v) return;
    c.cards = { main: v.main, extra: v.extra, side: v.side };
    // La mano non può avere più copie di quelle della decklist.
    const left = tally(c.cards.main);
    c.hand = c.hand.filter((code) => {
      const n = left.get(code) ?? 0;
      left.set(code, n - 1);
      return n > 0;
    });
    renderAll();
    snap();
  }

  function renderCards() {
    // Anche le carte del Side possono essere usate (es. una carta del Side messa in mano).
    const used = detectCards(c, empty() ? null : { main: [...c.cards.main, ...c.cards.side], extra: c.cards.extra });
    clear(cardsEl).append(
      h("p.muted.small", "The combo is practiced with this decklist: its own copy, it does not change with your saved Decks. The hand, the steps and the choices use its cards."),
      h(
        "div.decklist-summary",
        empty()
          ? h("span.muted", "Empty decklist.")
          : [h("span", h("b", c.cards.main.length), " Main"), h("span", h("b", c.cards.extra.length), " Extra"), h("span", h("b", c.cards.side.length), " Side"), h("span.muted", `the combo uses ${plural(used.main.length + used.extra.length, "card")}`)]
      ),
      h(
        "div.sheet-tools",
        h("button.btn.small.primary", { onclick: () => editDecklist() }, icon("style"), " Open in the Deck Builder"),
        h("button.btn.small", {
          title: "Keep only the cards that the hand, the steps, the precise choices and the top of the Deck use",
          disabled: empty(),
          onclick: () => {
            c.cards = { ...detectCards(c, c.cards), side: c.cards.side };
            renderAll();
            snap();
          },
        }, icon("auto_fix_high"), " Keep only the cards used")
      )
    );
  }

  /** Nota del passo: un consiglio per il giocatore, mostrato nella scheda della combo e durante l'allenamento. */
  async function editNote(s) {
    const v = await promptModal(`Note for: ${stepText(s)}`, "Note (empty = none)", s.note ?? "");
    if (v == null) return;
    if (v.trim()) s.note = v.trim().slice(0, 300);
    else delete s.note;
    renderSteps();
    snap();
  }

  function renderAll() {
    renderHand();
    renderSteps();
    renderSetup();
    renderTags();
    renderCards();
  }

  renderAll();
  snap();
  const collapsible = (title, el, open) => h("details.combo-fold", { open }, h("summary.combo-sec", title), el);
  const m = openModal({
    title: setup ? "Record a combo" : combo?.id && !combo.recorded ? "Edit combo" : "New combo",
    className: "wide combo-editor",
    body: [
      h("div.combo-editor-tools", undoBtn, redoBtn, h("span.muted.small", "Ctrl+Z / Ctrl+Y")),
      h("div.form-grid", h("label.field", h("span", "Name"), name), h("label.field", h("span", "Turn"), first), c.parent ? h("label.field", h("span", "Variant"), branch) : null),
      h("label.field", h("span", "Notes"), notes),
      h("h3.combo-sec", "Starting hand"),
      handEl,
      poolEl,
      collapsible(
        "Starting board state",
        h("div", h("p.muted.small", "Cards already in play when the combo starts (e.g. a monster you control, Pendulum Scales, the opponent's board, the top card of their Deck). Interruptions: put hand traps in the opponent's hand (or traps on their field) and choose after which step the opponent uses them."), setupEl),
        hasSetup(c.setup) || c.interrupts.length > 0
      ),
      collapsible("Decklist", cardsEl, empty()),
      ...(setup ? [h("p.muted.small", "Then you play the combo: every action you choose (Summons, Sets, activations, End Phase) is recorded as a step, with the cards, zones and answers you pick.")] : []),
      ...(setup
        ? []
        : [
            h("div.combo-sec-row", h("h3.combo-sec", "Steps"), foldAll),
            stepsEl,
            h("button.btn.small", { onclick: () => insertStep(c.steps.length) }, icon("add"), " Add step"),
            collapsible("Board tags", h("div", h("p.muted.small", "Labels shown above the cards of the final board when the combo is complete (also in videos): the role of each card, like Pop or Omni-negate."), tagsEl, h("button.btn.small", { onclick: () => { c.tags.push({ code: deckCards()[0] ?? 0, text: "" }); renderTags(); snap(); } }, icon("sell"), " Add tag")), c.tags.length > 0),
          ]),
    ],
    actions: [
      { label: "Cancel", value: null },
      {
        label: setup ? "Start recording" : "Save",
        primary: true,
        onClick: (close) => {
          c.name = name.value.trim() || "Combo";
          c.first = first.value === "1";
          if (!setup && !c.steps.length) return alertModal("Steps", "Add at least one step.");
          const blank = c.steps.findIndex((s) => !NO_CARD.has(s.kind) && !s.code);
          if (blank >= 0) return alertModal("Steps", `Choose the card of step ${blank + 1}.`);
          if (!comboDeck(c).main.length) return alertModal("Decklist", "Add the cards of the combo's decklist.");
          delete c.recorded;
          c.notes = notes.value.trim().slice(0, NOTES_MAX);
          if (c.parent) c.branch = branch.value.trim().slice(0, 40) || "Variant";
          // Decklist vuota: si salvano le carte che la combo usa (sono il mazzo con cui si gioca).
          c.cards = empty() ? { ...detectCards(c), side: [] } : cleanCards(c.cards);
          c.steps = c.steps.map(cleanStep);
          c.tags = c.tags.filter((t) => t.code && t.text.trim()).map((t) => ({ code: t.code, text: t.text.trim() }));
          c.setup = hasSetup(c.setup) ? cleanSetup(c.setup) : undefined;
          close(c);
        },
      },
    ],
  });
  // Clic fuori dal menu ⋮: si chiude.
  m.el.addEventListener("click", (e) => {
    if (!e.target.closest(".step-menu, .step-more")) closeMenus();
  });
  // Annulla / ripeti da tastiera (nei campi di testo resta quello del browser).
  const onKey = (e) => {
    if (deckOpen || !(e.ctrlKey || e.metaKey) || e.target.closest?.("input, textarea")) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
  };
  document.addEventListener("keydown", onKey);
  return m.result.then((v) => {
    document.removeEventListener("keydown", onKey);
    return v ?? null;
  });
}

// ------------------------------------------------------------- duello del trainer

/**
 * Registrazione: si gioca con la mano scelta (avversario passivo) e "Finish" apre l'editor con i passi.
 * sheetId: spreadsheet in cui aggiungere la combo registrata.
 */
function record(app, setup, sheetId = null) {
  const deck = comboDeck(setup);
  const recorder = new ComboRecorder(setup, {
    notify: (text, kind) => toast(text, { kind: kind === "error" ? "error" : "ok", ms: 2200 }),
    onFinish: (result) => {
      app.current?.destroy?.();
      app.current = null;
      const combo = { ...result, interrupts: [], recorded: true };
      // Senza decklist: quella con cui si è registrato (mano e carte usate, si può correggere nell'editor).
      if (!combo.cards?.main.length && !combo.cards?.extra.length) combo.cards = { main: [...deck.main], extra: [...deck.extra], side: [] };
      showComboTrainer(app, { review: { combo, sheetId } });
    },
  });
  startDuel(app, deck, { ...setup, interrupts: [] }, recorder, `Recording: ${setup.name}`);
}

/**
 * Avvia l'allenamento: la mano della combo, l'avversario con le hand trap in mano. Si gioca con il mazzo
 * della combo o, se non ne ha, con le sue carte necessarie.
 * video: registrazione già avviata (Export → Video); autoplay: il trainer gioca la combo da solo.
 */
function practice(app, combo, { video = null, autoplay = false } = {}) {
  const deck = comboDeck(combo);
  const trainer = new ComboTrainer(combo, {
    notify: (text, kind) => toast(text, { kind: kind === "error" ? "error" : "ok", ms: 3200 }),
    onRestart: () => practice(app, combo),
    strict: !!settings.comboStrict,
    onStrictChange: (on) => (settings.comboStrict = on),
    autoplay,
    // Auto-play dal menu (o per il video): si guarda la combo fino alla fine, senza poterlo spegnere.
    lockAuto: autoplay,
  });
  const session = startDuel(app, deck, combo, trainer, autoplay ? `Auto-play: ${combo.name}` : `Practice: ${combo.name}`);
  // Durante l'auto-play il duello non accetta i clic del giocatore (resta solo l'interruttore dell'auto-play).
  trainer.onAutoChange = (on) => [session.view.el, session.view.floatBar].forEach((el) => el.classList.toggle("autoplaying", on));
  trainer.onAutoChange(autoplay);
  // Combo completa: tag sulle carte, poi "Play again" (o fine del video in auto-play).
  trainer.onComplete = () => {
    if (combo.tags?.length) session.view.board.setTags(combo.tags);
    if (video && autoplay) setTimeout(() => recording?.stop(), 3500);
    else setTimeout(() => !session.over && session.showLocalRematch({ text: "Combo complete! Practice it again?", label: "Play again", keepPlaying: true }), 1200);
  };
  const recording = video ? attachVideo(session, trainer, video, combo.name) : null;
}

/** Duello per il Combo Trainer: controller = ComboTrainer o ComboRecorder. Restituisce la sessione. */
function startDuel(app, deck, combo, controller, title) {
  const me = combo.first ? 0 : 1;
  const opp = 1 - me;
  const s = cleanSetup(combo.setup) ?? emptySetup();
  // Mano dell'avversario: quella dello stato di partenza (con le hand trap) e, per le combo vecchie,
  // le carte delle interruzioni che non ci sono.
  const oppHand = [...(s.opp.hand ?? []), ...interruptsOutsideBoard(combo)];
  const oppTop = [...oppHand, ...(s.opp.deckTop ?? [])];
  const decks = [];
  decks[me] = { main: deck.main, extra: deck.extra };
  decks[opp] = { main: oppTop, extra: s.opp.extra ?? [] };
  const pair = (mine, theirs) => {
    const a = [];
    a[me] = mine;
    a[opp] = theirs;
    return a;
  };
  const controllers = pair("local", "trainer");
  const names = pair(settings.name, "Opponent");
  app.current?.destroy?.();
  const session = new DuelSession({
    controllers,
    me,
    names,
    reveal: false,
    timer: "off",
    sleeves: pair(validSleeve(settings.sleeve), null),
    pendulums: pair(pendulumIcons(), null),
    trainer: controller,
    duel: {
      flags: String(DUEL_MODES.MR5.flags),
      seed: [...crypto.getRandomValues(new BigUint64Array(4))].map((x) => String(x || 1n)),
      lp: 8000,
      hand: 5,
      draw: 1,
      decks,
      shuffle: pair(true, false),
      // La mano, poi le carte scelte per la cima del Deck (stato di partenza).
      top: pair([...combo.hand, ...(s.me.deckTop ?? [])], oppTop),
      handSize: pair(combo.hand.length, oppHand.length),
      noTurnDraw: pair(false, true),
      place: [...placeCards(me, s.me), ...placeCards(opp, s.opp)],
    },
    onExit: () => showComboTrainer(app),
    // Fine del duello (o "Play again" a combo completa): si ricomincia con la stessa mano.
    onLocalRematch: controller instanceof ComboTrainer ? (old) => { old.destroy(); practice(app, combo); } : null,
  });
  app.current = session;
  // Sottotitoli sul campo per ogni passo (anche nei video).
  controller.caption = (text, kind) => session.view.caption(text, kind);
  session.start(clear(app.root));
  toast(title);
  return session;
}

/** Carte dello stato di partenza per il motore (vedi DuelEngine.start, cfg.place). */
function placeCards(player, side) {
  const out = [];
  for (const x of side.field ?? []) {
    // Mostro Pendulum scoperto nella prima o nell'ultima zona Magie/Trappole: è una scala (zona Pendulum).
    if ((x.zone === "s0" || x.zone === "s4") && x.pos !== "set" && isPendulum(x.code)) {
      out.push({ player, code: x.code, location: LOC.PZONE, sequence: x.zone === "s0" ? 0 : 1 });
      continue;
    }
    const location = x.zone[0] === "m" ? LOC.MZONE : LOC.SZONE;
    const sequence = x.zone === "f" ? 5 : +x.zone.slice(1);
    const monster = location === LOC.MZONE;
    const position = x.pos === "set" ? (monster ? POS.FACEDOWN_DEFENSE : POS.FACEDOWN) : x.pos === "def" && monster ? POS.FACEUP_DEFENSE : POS.FACEUP_ATTACK;
    out.push({ player, code: x.code, location, sequence, position });
  }
  for (const code of side.gy ?? []) out.push({ player, code, location: LOC.GRAVE, sequence: 0, position: POS.FACEUP_ATTACK });
  for (const code of side.banished ?? []) out.push({ player, code, location: LOC.REMOVED, sequence: 0, position: POS.FACEUP_ATTACK });
  return out;
}

/**
 * Registrazione video già avviata: "■ Stop" nel pannello del trainer; fermandola (o uscendo dal duello)
 * si apre l'anteprima con Download e Share.
 */
function attachVideo(session, trainer, cap, name) {
  let done = false;
  const started = Date.now();
  const btn = h("button.btn.small.ghost.video-btn.rec", { title: "Stop the recording" });
  const paint = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    btn.textContent = `■ Stop ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const tick = setInterval(paint, 500);
  paint();
  const stop = async () => {
    if (done) return;
    done = true;
    clearInterval(tick);
    btn.remove();
    const { blob, ext } = await cap.stop();
    if (blob.size) showVideo(blob, ext, name);
  };
  btn.onclick = stop;
  trainer.btns?.prepend(btn);
  session.view.caption(`🎬 ${name}`, "done");
  cap.done.then(stop); // condivisione interrotta dal browser
  // Uscendo dal duello la registrazione si chiude e si mostra il video.
  const destroy = session.destroy.bind(session);
  session.destroy = (...args) => {
    stop();
    return destroy(...args);
  };
  return { stop };
}

/** Anteprima del video registrato, con Download e (se il sistema lo permette) Share. */
function showVideo(blob, ext, name) {
  const url = URL.createObjectURL(blob);
  const fileName = `${name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "combo"}.${ext}`;
  const file = new File([blob], fileName, { type: blob.type });
  const canShare = !!navigator.canShare?.({ files: [file] });
  const m = openModal({
    title: "Combo video",
    className: "wide",
    body: [h("video.combo-video", { src: url, controls: true, playsInline: true }), h("p.muted.small", `${fileName} · ${(blob.size / 1048576).toFixed(1)} MB`)],
    actions: [
      { label: "Close", value: null },
      ...(canShare ? [{ label: "Share", onClick: () => navigator.share({ files: [file], title: name }).catch(() => {}) }] : []),
      {
        label: "Download",
        primary: true,
        onClick: () => {
          const a = h("a", { href: url, download: fileName });
          document.body.append(a);
          a.click();
          a.remove();
        },
      },
    ],
  });
  m.result.then(() => setTimeout(() => URL.revokeObjectURL(url), 60_000));
}
