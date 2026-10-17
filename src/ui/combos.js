// Combo Trainer: per ogni mazzo si salvano più combo (mano iniziale, passi con le scelte precise, hand trap
// dell'avversario, stato di partenza, tag sulle carte) e le si prova in un duello dove il trainer controlla
// i passi e l'avversario interrompe dove deciso.
import { h, clear, icon } from "./dom.js";
import { cardFace } from "./card.js";
import { openModal, toast, confirmModal, alertModal } from "./modal.js";
import { db, getCard, cardName, isExtraDeckCard } from "../data/db.js";
import { settings } from "../data/settings.js";
import { validSleeve } from "../data/sleeve.js";
import { pendulumIcons } from "../data/pendulum.js";
import { loadDecks, saveDecks, parseRecipe } from "../deck/deck.js";
import { DUEL_MODES, LOC, POS, TYPE } from "../core/constants.js";
import { DuelSession } from "../duel/session.js";
import {
  ComboTrainer, ComboRecorder, STEP_ACTIONS, NO_CARD, stepText, detailText, cleanStep, cleanSetup,
  loadCombos, saveCombos, comboToCode, comboFromCode,
} from "../duel/trainer.js";
import { DEFAULT_BOOKMARKS } from "../data/default-bookmarks.js";
import { canRecordVideo, startVideo } from "./video-capture.js";

const uid = () => Math.random().toString(36).slice(2, 10);
const byName = (a, b) => cardName(a).localeCompare(cardName(b));
const uniq = (codes) => [...new Set(codes)];
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function showComboTrainer(app, { review } = {}) {
  const decks = loadDecks();
  // Al primo avvio i mazzi starter non sono ancora salvati e ricevono un id nuovo a ogni lettura:
  // li si salva, così le combo restano legate al loro mazzo.
  if (decks.length && !localStorage.getItem("ygoweb.decks")) saveDecks(decks);
  const root = clear(app.root);
  if (!decks.length) {
    root.append(h("div.page", h("div.page-head", h("button.btn.ghost.round.page-back", { title: "Menu (right-click)", onclick: () => app.home() }, icon("chevron_left")), h("h1", "Combo Trainer")), h("p.muted", "Create a Deck in the Deck Editor first.")));
    return;
  }
  let all = loadCombos();
  const deckSel = h("select.select", decks.map((d) => h("option", { value: d.id }, `${d.name} (${d.main.length}/${d.extra.length})`)));
  deckSel.value = decks.some((d) => d.id === settings.lastDeck) ? settings.lastDeck : decks[0].id;
  const list = h("div.combo-list");
  const deck = () => decks.find((d) => d.id === deckSel.value);
  const combos = () => all[deckSel.value] ?? [];
  const store = (items) => {
    all = { ...all, [deckSel.value]: items };
    saveCombos(all);
    render();
  };

  function summary(c) {
    const parts = [c.first ? "Going first" : "Going second", `${plural(c.hand.length, "card")} in hand`, plural(c.steps.length, "step")];
    if (c.interrupts.length) parts.push(plural(c.interrupts.length, "hand trap"));
    if (hasSetup(c.setup)) parts.push("custom board state");
    if (c.tags?.length) parts.push(plural(c.tags.length, "tag"));
    return parts.join(" · ");
  }

  function render() {
    const items = combos();
    clear(list).append(
      ...(items.length
        ? items.map((c) =>
            h(
              "div.combo-row",
              h("div.combo-hand", c.hand.slice(0, 6).map((code) => cardFace(code))),
              h("div.combo-info", h("b", c.name), h("div.muted.small", summary(c))),
              h(
                "div.combo-actions",
                h("button.btn.primary", { onclick: () => practice(app, deck(), c) }, icon("play_arrow"), " Practice"),
                h("button.btn", { title: "Share the combo or record a video of it", onclick: () => exportCombo(app, deck(), c) }, icon("ios_share"), " Export"),
                h("button.btn", { onclick: () => editCombo(deck(), c).then((v) => v && store(items.map((x) => (x.id === v.id ? v : x)))) }, icon("edit"), " Edit"),
                h("button.btn.danger", {
                  title: "Delete",
                  onclick: async () => (await confirmModal("Delete combo", `Delete "${c.name}"?`, "Delete", "Cancel", { danger: true })) && store(items.filter((x) => x.id !== c.id)),
                }, icon("delete"))
              )
            )
          )
        : [h("p.muted", "No combos for this Deck yet. Create one with \"New combo\".")])
    );
  }

  /** "New combo": si sceglie se scrivere i passi o registrarli giocando. */
  async function newCombo() {
    const how = await openModal({
      title: "New combo",
      body: [h("p", "How do you want to create the combo?")],
      className: "combo-method",
      actions: [
        { label: "Cancel", value: null },
        { label: "Write the steps", value: "write" },
        { label: "Record by playing", value: "record", primary: true },
      ],
    }).result;
    if (how === "write") editCombo(deck(), null).then((v) => v && store([...combos(), v]));
    if (how === "record") {
      const setup = await editCombo(deck(), null, { setup: true });
      if (setup) record(app, deck(), setup);
    }
  }

  deckSel.addEventListener("change", () => {
    settings.lastDeck = deckSel.value;
    render();
  });
  root.append(
    h(
      "div.page.combos",
      h("div.page-head", h("button.btn.ghost.round.page-back", { title: "Menu (right-click)", onclick: () => app.home() }, icon("chevron_left")), h("h1", "Combo Trainer")),
      h(
        "div.card-box.combo-top",
        h("label.field", h("span", "Deck"), deckSel),
        h("button.btn.primary", { onclick: () => newCombo() }, icon("add"), " New combo"),
        h("button.btn", { title: "Import a combo code (from the clipboard or pasted)", onclick: () => importCombo().then((v) => v && store([...combos(), v])) }, icon("download"), " Import")
      ),
      h(
        "p.muted.small",
        "Write or record the steps of a combo, then practice it: the trainer checks each step (and the cards, zones and answers you choose) and warns you when you do something else. " +
          "In Strict mode wrong moves are blocked. Hand traps: after the chosen step the opponent uses that card (it starts in their hand) at the first chance; then it's free play."
      ),
      list
    )
  );
  render();
  // Fine registrazione: si apre l'editor con i passi registrati (si possono rivedere e aggiungere hand trap).
  if (review) {
    deckSel.value = review.deckId;
    render();
    editCombo(deck(), review.combo).then((v) => v && store([...combos(), v]));
  }
}

const hasSetup = (s) => !!s && [s.me, s.opp].some((x) => x && Object.values(x).some((v) => v?.length));

/** Esportazione: codice da condividere o video della combo (giocata dal trainer o dal giocatore). */
async function exportCombo(app, deck, c) {
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
    practice(app, deck, c, { video: cap, autoplay });
  };
  await openModal({
    title: `Export "${c.name}"`,
    className: "combo-export",
    body: [
      h("p.muted.small", "Share code: import it in another Helios client (Combo Trainer → Import)."),
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
    openModal({ title: "Share combo", body: [h("p.muted.small", "Copy this code and import it in another Helios client (Combo Trainer → Import)."), h("textarea.input.combo-code", { readOnly: true, rows: 5, value: code, onfocus: (e) => e.target.select() })], actions: [{ label: "Close", value: null, primary: true }] });
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
 * Hand trap suggerite quando la ricerca è vuota (stanno in mano all'avversario, quindi niente Extra Deck):
 * mostri e trappole dei preferiti predefiniti e i preferiti del giocatore. Ash Blossom per prima, se c'è.
 */
const ASH = 14558127;
function handTrapSuggestions() {
  const { deck } = parseRecipe(DEFAULT_BOOKMARKS);
  const list = uniq([...deck.main, ...(settings.bookmarks ?? [])]).filter((c) => getCard(c) && !isExtraDeckCard(getCard(c))).sort(byName);
  return list.includes(ASH) ? [ASH, ...list.filter((c) => c !== ASH)] : list;
}

/**
 * Finestra di ricerca di una carta nel database. Restituisce il codice scelto o null.
 * @param suggest codici mostrati quando la ricerca è vuota; @param filter (card) -> bool
 */
export function pickCard({ title = "Choose a card", suggest = [], filter = () => true, hint = "" } = {}) {
  const input = h("input.input", { placeholder: "Search by name or text…", autocomplete: "off" });
  const list = h("div.announce-list.card-search-list");
  const candidates = db.list.filter((c) => c.source !== 1 && filter(c));
  const row = (code) => h("button.announce-row", { onclick: () => m.close(code) }, cardFace(code), h("span", cardName(code)));
  const render = () => {
    const q = input.value.trim().toLowerCase();
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
  ...[0, 1, 2, 3, 4].map((i) => [`s${i}`, `Spell & Trap Zone ${i + 1}`]),
  ["f", "Field Zone"],
];
const POSITIONS = [["atk", "Face-up Attack / face-up"], ["def", "Face-up Defense"], ["set", "Face-down (Set)"]];
const TAG_SUGGESTIONS = ["Omni-negate", "Negate", "Pop", "Floodgate", "Interruption", "Banish", "Bounce", "Spin", "Follow-up", "Recursion", "Search", "Protection", "Extender", "Hand trap check"];
const isMonster = (code) => ((getCard(code)?.type ?? 0) & TYPE.MONSTER) !== 0;
const isFieldSpell = (code) => ((getCard(code)?.type ?? 0) & TYPE.FIELD) !== 0;

/** Zona più adatta libera per una carta (mostri nelle zone mostri, magie di terreno nella Field Zone...). */
function freeZone(list, code) {
  const taken = new Set(list.map((x) => x.zone));
  const pref = isFieldSpell(code) ? ["f"] : isMonster(code) ? ["m2", "m1", "m3", "m0", "m4", "m5", "m6"] : ["s2", "s1", "s3", "s0", "s4"];
  return pref.find((z) => !taken.has(z)) ?? ZONES.map(([z]) => z).find((z) => !taken.has(z)) ?? null;
}

const emptySetup = () => ({ me: { field: [], gy: [], banished: [] }, opp: { field: [], gy: [], banished: [], hand: [], deckTop: [], extra: [] } });

/**
 * Editor di una combo; restituisce la combo salvata o null.
 * setup: solo nome, turno, mano e stato di partenza, per iniziare una registrazione.
 */
function editCombo(deck, combo, { setup = false } = {}) {
  const c = combo ? structuredClone(combo) : { id: uid(), name: "New combo", first: true, hand: [], steps: [], interrupts: [], tags: [] };
  c.tags ??= [];
  c.setup = { ...emptySetup(), ...(cleanSetup(c.setup) ?? {}) };
  const name = h("input.input", { value: c.name, maxLength: 60 });
  const first = h("select.select", h("option", { value: "1" }, "Going first"), h("option", { value: "0" }, "Going second"));
  first.value = c.first ? "1" : "0";
  const mainCards = uniq(deck.main).sort(byName);
  const deckCards = uniq([...deck.main, ...deck.extra]).sort(byName);
  const handEl = h("div.combo-hand-pick");
  const poolEl = h("div.combo-pool");
  const stepsEl = h("ol.combo-steps-edit");
  const intsEl = h("div.combo-ints-edit");
  const setupEl = h("div.combo-setup");
  const tagsEl = h("div.combo-tags-edit");
  const copies = (code) => deck.main.filter((x) => x === code).length;

  // ---- annulla / ripeti (Ctrl+Z, Ctrl+Y o Ctrl+Shift+Z)
  const history = [];
  let at = -1;
  const state = () => JSON.stringify({ name: c.name, first: c.first, hand: c.hand, steps: c.steps, interrupts: c.interrupts, setup: c.setup, tags: c.tags });
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
    renderAll();
    paintHistory();
  };
  const undo = () => at > 0 && restore(history[--at]);
  const redo = () => at < history.length - 1 && restore(history[++at]);
  name.addEventListener("change", snap);
  first.addEventListener("change", () => { c.first = first.value === "1"; snap(); });

  const cardBtn = (code, onPick, opts = {}) =>
    h("button.btn.card-pick-btn", { title: "Choose a card", onclick: () => pickCard(opts).then((v) => v && onPick(v)) }, code ? cardName(code) : opts.empty ?? "Choose a card…");

  function renderHand() {
    clear(handEl).append(
      ...(c.hand.length ? c.hand.map((code, i) => h("button.combo-card.chosen", { title: "Remove from the hand", onclick: () => { c.hand.splice(i, 1); renderHand(); snap(); } }, cardFace(code))) : [h("span.muted.small", "Click the cards below to add them to the starting hand.")])
    );
    clear(poolEl).append(
      ...mainCards.map((code) => {
        const left = copies(code) - c.hand.filter((x) => x === code).length;
        return h(`button.combo-card${left <= 0 ? ".used" : ""}`, { title: cardName(code), disabled: left <= 0, onclick: () => { if (c.hand.length < 10) { c.hand.push(code); renderHand(); snap(); } } }, cardFace(code));
      })
    );
  }

  // Le hand trap restano agganciate al passo dopo cui erano (after = quanti passi prima di loro).
  function insertStep(i) {
    c.steps.splice(i, 0, { kind: "activate", code: deckCards[0] });
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

  function renderSteps() {
    clear(stepsEl).append(
      ...c.steps.map((s, i) => {
        const act = h("select.select.step-kind", Object.entries(STEP_ACTIONS).map(([k, l]) => h("option", { value: k }, l)));
        act.value = s.kind;
        const card = h("select.select", deckCards.map((code) => h("option", { value: code }, cardName(code))));
        if (s.code) card.value = String(s.code);
        card.addEventListener("change", () => { s.code = +card.value; snap(); });
        // End Phase: nessuna carta da scegliere.
        const syncCard = () => (card.style.visibility = NO_CARD.has(s.kind) ? "hidden" : "");
        act.addEventListener("change", () => {
          s.kind = act.value;
          if (!NO_CARD.has(s.kind) && !s.code) s.code = +card.value;
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
          h("button", { onclick: () => { closeMenus(); addDetail(s); } }, icon("ads_click"), " Add a precise choice…"),
          h("button.danger", { onclick: () => removeStep(i) }, icon("delete"), " Delete step")
        );
        const more = h("button.btn.small.ghost.step-more", { title: "Step options", onclick: (e) => { e.stopPropagation(); const open = menu.hidden; closeMenus(); menu.hidden = !open; } }, icon("more_vert"));
        // Maniglia a destra: si trascina il passo per riordinarlo.
        const handle = h("span.step-drag", { title: "Drag to reorder" }, icon("drag_indicator"));
        const details = s.details?.length
          ? h(
              "ul.step-details",
              s.details.map((d, j) =>
                h("li", h("span", detailText(d)), h("button.btn.small.ghost", { title: "Remove this choice", onclick: () => { s.details.splice(j, 1); renderSteps(); snap(); } }, icon("close")))
              )
            )
          : null;
        const row = h("li.combo-step-row", h("div.step-line", more, h("span.step-num", `${i + 1}.`), act, card, handle), menu, details);
        handle.addEventListener("pointerdown", () => (row.draggable = true));
        row.addEventListener("dragstart", (e) => {
          dragFrom = i;
          row.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(i));
        });
        row.addEventListener("dragend", () => {
          row.draggable = false;
          row.classList.remove("dragging");
          stepsEl.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
        });
        row.addEventListener("dragover", (e) => {
          if (dragFrom == null) return;
          e.preventDefault();
          const r = row.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          row.classList.toggle("drop-after", after);
          row.classList.toggle("drop-before", !after);
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          if (dragFrom == null) return;
          const r = row.getBoundingClientRect();
          let to = e.clientY > r.top + r.height / 2 ? i + 1 : i;
          if (dragFrom < to) to--;
          const from = dragFrom;
          dragFrom = null;
          moveStep(from, to);
        });
        return row;
      })
    );
    renderInts();
  }

  /** Aggiunge a mano una scelta precisa al passo (in registrazione si salvano da sole). */
  async function addDetail(s) {
    const type = h("select.select", h("option", { value: "cards" }, "Select cards (targets, costs, materials…)"), h("option", { value: "zone" }, "Zone to use"), h("option", { value: "pos" }, "Battle position"), h("option", { value: "yesno" }, "Optional effect: Yes / No"));
    const codes = [];
    const chosen = h("div.detail-cards");
    const paintCodes = () => clear(chosen).append(...(codes.length ? codes.map((code, i) => h("button.chip", { title: "Remove", onclick: () => { codes.splice(i, 1); paintCodes(); } }, cardName(code), " ×")) : [h("span.muted.small", "No cards yet.")]));
    const addCard = h("button.btn.small", { onclick: () => pickCard({ title: "Card to select", suggest: deckCards }).then((v) => { if (v) { codes.push(v); paintCodes(); } }) }, icon("add"), " Add card");
    const zone = h("select.select", ZONES.map(([z, l]) => h("option", { value: z }, l)));
    const whose = h("select.select", h("option", { value: "1" }, "Your zone"), h("option", { value: "0" }, "Opponent's zone"));
    const pos = h("select.select", [[POS.FACEUP_ATTACK, "Face-up Attack"], [POS.FACEUP_DEFENSE, "Face-up Defense"], [POS.FACEDOWN_DEFENSE, "Face-down Defense"]].map(([v, l]) => h("option", { value: v }, l)));
    const yes = h("select.select", h("option", { value: "1" }, "Yes, use it"), h("option", { value: "0" }, "No"));
    const parts = { cards: h("div.detail-part", chosen, addCard), zone: h("div.detail-part", zone, whose), pos: h("div.detail-part", pos), yesno: h("div.detail-part", yes) };
    const sync = () => Object.entries(parts).forEach(([k, el]) => (el.hidden = k !== type.value));
    type.addEventListener("change", sync);
    paintCodes();
    sync();
    const d = await openModal({
      title: `Precise choice for: ${stepText(s)}`,
      className: "combo-detail",
      body: [h("p.muted.small", "Choices are checked in order during the step (and used by auto-play)."), h("label.field", h("span", "Type"), type), ...Object.values(parts)],
      actions: [
        { label: "Cancel", value: null },
        {
          label: "Add",
          primary: true,
          onClick: (close) => {
            if (type.value === "cards") return codes.length ? close({ t: "cards", codes: [...codes].sort((a, b) => a - b) }) : alertModal("Select cards", "Add at least one card.");
            if (type.value === "zone") {
              const z = zone.value;
              return close({ t: "zone", places: [{ mine: whose.value === "1", loc: z === "f" ? "s" : z[0], seq: z === "f" ? 5 : +z.slice(1) }] });
            }
            if (type.value === "pos") return close({ t: "pos", pos: +pos.value });
            return close({ t: "yesno", yes: yes.value === "1" });
          },
        },
      ],
    }).result;
    if (!d) return;
    (s.details ??= []).push(d);
    renderSteps();
    snap();
  }

  function renderInts() {
    clear(intsEl).append(
      ...c.interrupts.map((it, i) => {
        const after = h("select.select", h("option", { value: 0 }, "From the start"), c.steps.map((s, j) => h("option", { value: j + 1 }, `After step ${j + 1}: ${stepText(s)}`)));
        after.value = String(Math.min(it.after, c.steps.length));
        after.addEventListener("change", () => { it.after = +after.value; snap(); });
        const card = cardBtn(it.code, (v) => { it.code = v; renderInts(); snap(); }, handTrapPick());
        return h("div.combo-int-row", h("span", "⚡"), after, h("span.muted", "the opponent uses"), card, h("button.btn.small.ghost", { title: "Remove", onclick: () => { c.interrupts.splice(i, 1); renderInts(); snap(); } }, icon("close")));
      })
    );
  }
  const handTrapPick = () => ({
    title: "Hand trap",
    hint: "The card starts in the opponent's hand: use hand traps (or traps that can be activated from the hand, like Infinite Impermanence).",
    suggest: handTrapSuggestions(),
    filter: (card) => !isExtraDeckCard(card),
  });

  // ---- stato di partenza (carte già in gioco, mano e Deck dell'avversario)
  function cardList(arr, { title, suggest, filter, ordered = false }) {
    return h(
      "div.setup-list",
      arr.map((code, i) => h("button.chip", { title: "Remove", onclick: () => { arr.splice(i, 1); renderSetup(); snap(); } }, ordered ? `${i + 1}. ` : "", cardName(code), " ×")),
      h("button.btn.small.ghost", { onclick: () => pickCard({ title, suggest, filter }).then((v) => { if (v) { arr.push(v); renderSetup(); snap(); } }) }, icon("add"), " Add")
    );
  }
  function fieldList(list, suggest) {
    const rows = list.map((x, i) => {
      const zone = h("select.select", ZONES.map(([z, l]) => h("option", { value: z, disabled: z !== x.zone && list.some((y) => y.zone === z) }, l)));
      zone.value = x.zone;
      zone.addEventListener("change", () => { x.zone = zone.value; renderSetup(); snap(); });
      const pos = h("select.select", POSITIONS.map(([p, l]) => h("option", { value: p }, l)));
      pos.value = x.pos;
      pos.addEventListener("change", () => { x.pos = pos.value; snap(); });
      return h("div.setup-field-row", cardBtn(x.code, (v) => { x.code = v; renderSetup(); snap(); }, { title: "Card on the field", suggest }), zone, pos, h("button.btn.small.ghost", { title: "Remove", onclick: () => { list.splice(i, 1); renderSetup(); snap(); } }, icon("close")));
    });
    const add = h("button.btn.small.ghost", {
      onclick: () => pickCard({ title: "Card on the field", suggest }).then((v) => {
        if (!v) return;
        const zone = freeZone(list, v);
        if (!zone) return alertModal("Field", "All zones are already used.");
        list.push({ code: v, zone, pos: isMonster(v) || isFieldSpell(v) ? "atk" : "set" });
        renderSetup();
        snap();
      }),
    }, icon("add"), " Add card to the field");
    return h("div.setup-field", rows, add);
  }
  function renderSetup() {
    const s = c.setup;
    const mine = deckCards;
    clear(setupEl).append(
      h(
        "div.setup-col",
        h("h4", "You"),
        h("span.muted.small", "Field"), fieldList(s.me.field, mine),
        h("span.muted.small", "GY"), cardList(s.me.gy, { title: "Card in your GY", suggest: mine }),
        h("span.muted.small", "Banished"), cardList(s.me.banished, { title: "Your banished card", suggest: mine })
      ),
      h(
        "div.setup-col",
        h("h4", "Opponent"),
        h("span.muted.small", "Field"), fieldList(s.opp.field, []),
        h("span.muted.small", "Hand (besides the hand traps)"), cardList(s.opp.hand, { title: "Card in the opponent's hand", filter: (card) => !isExtraDeckCard(card) }),
        h("span.muted.small", "Top of the Deck (1 = top card)"), cardList(s.opp.deckTop, { title: "Card on top of the opponent's Deck", filter: (card) => !isExtraDeckCard(card), ordered: true }),
        h("span.muted.small", "Extra Deck"), cardList(s.opp.extra, { title: "Card in the opponent's Extra Deck", filter: (card) => isExtraDeckCard(card) }),
        h("span.muted.small", "GY"), cardList(s.opp.gy, { title: "Card in the opponent's GY" }),
        h("span.muted.small", "Banished"), cardList(s.opp.banished, { title: "Opponent's banished card" })
      )
    );
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
        return h("div.combo-tag-row", cardBtn(t.code, (v) => { t.code = v; renderTags(); snap(); }, { title: "Card on the final board", suggest: deckCards }), text, h("button.btn.small.ghost", { title: "Remove", onclick: () => { c.tags.splice(i, 1); renderTags(); snap(); } }, icon("close")));
      })
    );
  }

  function renderAll() {
    renderHand();
    renderSteps();
    renderSetup();
    renderTags();
  }

  renderAll();
  snap();
  const collapsible = (title, el, open) => h("details.combo-fold", { open }, h("summary.combo-sec", title), el);
  const m = openModal({
    title: setup ? "Record a combo" : combo?.id && !combo.recorded ? "Edit combo" : "New combo",
    className: "wide combo-editor",
    body: [
      h("div.combo-editor-tools", undoBtn, redoBtn, h("span.muted.small", "Ctrl+Z / Ctrl+Y")),
      h("div.form-grid", h("label.field", h("span", "Name"), name), h("label.field", h("span", "Turn"), first)),
      h("h3.combo-sec", "Starting hand"),
      handEl,
      poolEl,
      collapsible("Starting board state", h("div", h("p.muted.small", "Cards already in play when the combo starts (e.g. a monster you control, the opponent's board, the top card of their Deck)."), setupEl), hasSetup(c.setup)),
      ...(setup ? [h("p.muted.small", "Then you play the combo: every action you choose (Summons, Sets, activations, End Phase) is recorded as a step, with the cards, zones and answers you pick.")] : []),
      ...(setup
        ? []
        : [
            h("h3.combo-sec", "Steps"),
            stepsEl,
            h("button.btn.small", { onclick: () => insertStep(c.steps.length) }, icon("add"), " Add step"),
            h("h3.combo-sec", "Hand Traps"),
            h("p.muted.small", "The card starts in the opponent's hand: use hand traps (or traps that can be activated from the hand, like Infinite Impermanence)."),
            intsEl,
            h("button.btn.small", {
              onclick: () => pickCard(handTrapPick()).then((v) => { if (v) { c.interrupts.push({ after: Math.min(1, c.steps.length), code: v }); renderInts(); snap(); } }),
            }, icon("bolt"), " Add hand trap"),
            collapsible("Board tags", h("div", h("p.muted.small", "Labels shown above the cards of the final board when the combo is complete (also in videos): the role of each card, like Pop or Omni-negate."), tagsEl, h("button.btn.small", { onclick: () => { c.tags.push({ code: deckCards[0], text: "" }); renderTags(); snap(); } }, icon("sell"), " Add tag")), c.tags.length > 0),
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
          if (!c.hand.length) return alertModal("Starting hand", "Add at least one card to the starting hand.");
          if (!setup && !c.steps.length) return alertModal("Steps", "Add at least one step.");
          delete c.recorded;
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
    if (!(e.ctrlKey || e.metaKey) || e.target.closest?.("input, textarea")) return;
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

/** Registrazione: si gioca con la mano scelta (avversario passivo) e "Finish" apre l'editor con i passi. */
function record(app, deck, setup) {
  const recorder = new ComboRecorder(setup, {
    notify: (text, kind) => toast(text, { kind: kind === "error" ? "error" : "ok", ms: 2200 }),
    onFinish: (result) => {
      app.current?.destroy?.();
      app.current = null;
      showComboTrainer(app, { review: { deckId: deck.id, combo: { ...result, interrupts: [], recorded: true } } });
    },
  });
  startDuel(app, deck, { ...setup, interrupts: [] }, recorder, `Recording: ${setup.name}`);
}

/**
 * Avvia l'allenamento: la mano della combo, l'avversario con le hand trap in mano.
 * video: registrazione già avviata (Export → Video); autoplay: il trainer gioca la combo da solo.
 */
function practice(app, deck, combo, { video = null, autoplay = false } = {}) {
  const trainer = new ComboTrainer(combo, {
    notify: (text, kind) => toast(text, { kind: kind === "error" ? "error" : "ok", ms: 3200 }),
    onRestart: () => practice(app, deck, combo),
    strict: !!settings.comboStrict,
    onStrictChange: (on) => (settings.comboStrict = on),
    autoplay,
  });
  const session = startDuel(app, deck, combo, trainer, autoplay ? `Auto-play: ${combo.name}` : `Practice: ${combo.name}`);
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
  const oppHand = [...combo.interrupts.map((it) => it.code), ...(s.opp.hand ?? [])];
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
      top: pair(combo.hand, oppTop),
      handSize: pair(combo.hand.length, oppHand.length),
      noTurnDraw: pair(false, true),
      place: [...placeCards(me, s.me), ...placeCards(opp, s.opp)],
    },
    onExit: () => showComboTrainer(app),
    // Fine del duello (o "Play again" a combo completa): si ricomincia con la stessa mano.
    onLocalRematch: controller instanceof ComboTrainer ? (old) => { old.destroy(); practice(app, deck, combo); } : null,
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
