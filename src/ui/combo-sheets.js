// Spreadsheet del Combo Trainer (come quelli di masterduelmeta): più combo di un mazzo raggruppate per
// starter (la mano iniziale), con una decklist d'esempio e le carte che servono per farle tutte.
// Né le combo né gli spreadsheet dipendono dai mazzi salvati: le loro decklist sono copie.
import { h, clear, icon } from "./dom.js";
import { cardFace } from "./card.js";
import { openModal, toast, confirmModal, alertModal } from "./modal.js";
import { cardName } from "../data/db.js";
import { settings } from "../data/settings.js";
import { parseDeckText, saveDecks, loadDecks, emptyDeck, sortDeckPart } from "../deck/deck.js";
import { sheetCards, sheetToCode, sheetFromCode, isSheetCode, NOTES_MAX } from "../duel/trainer.js";
import { openDecklistEditor, openDeckViewer } from "./editor.js";

const uid = () => Math.random().toString(36).slice(2, 10);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const tally = (codes) => codes.reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map());

/**
 * Scheda "Spreadsheets" del Trainer: elenco o, con sheetId, uno spreadsheet aperto nel viewer (mode "view",
 * sola lettura: guardare e allenarsi) o nell'editor (mode "edit").
 * ctx: vedi showComboTrainer (archivio, mazzi, editor, allenamento...).
 */
export function renderSheets(panel, ctx, sheetId, mode = "view") {
  const sheet = sheetId && ctx.store.sheets.find((s) => s.id === sheetId);
  const go = (s, m = "view") => {
    ctx.setView({ tab: "sheets", sheetId: s?.id ?? null, sheetMode: m });
    renderSheets(clear(panel), ctx, s?.id ?? null, m);
  };
  if (sheet) return mode === "edit" ? renderSheet(panel, ctx, sheet, go) : renderSheetView(panel, ctx, sheet, go);
  ctx.setView({ sheetId: null });
  const open = (s) => go(s, "view");
  // Schede come quelle delle combo (banner con starter → numero di combo → decklist), nei colori degli
  // spreadsheet: rosso scuro e celeste.
  const faces = (codes, max) => [...codes.slice(0, max).map((code) => h("div.cc-face", { title: cardName(code) }, cardFace(code))), codes.length > max ? h("div.cc-more", `+${codes.length - max}`) : null];
  const list = ctx.store.sheets.map((s) => {
    const { combos, groups } = sheetCombos(ctx, s);
    const starters = [...groups.values()].map((g) => g[0].hand[0]).filter(Boolean);
    const need = sheetCards(combos);
    const sample = s.sample?.main ?? [];
    return h(
      "div.cc-card.sheet-card",
      h(
        "div.cc-banner",
        h("div.cc-side", h("div.cc-label", "Starters", h("b", groups.size)), h("div.cc-faces", starters.length ? faces(starters, 3) : h("span.muted.small", "No combos yet"))),
        h("div.cc-mid", h("span.cc-pill", plural(combos.length, "combo"))),
        h("div.cc-side.end", h("div.cc-label", "Sample deck", h("b", sample.length || "—")), h("div.cc-faces", sample.length ? faces(sample, 3) : h("span.muted.small", "No sample decklist")))
      ),
      h(
        "div.cc-body",
        h("div.cc-title", h("span.cc-dot"), h("b", s.name)),
        s.notes ? h("div.muted.small.sheet-card-notes", s.notes) : null,
        h("div.cc-stats",
          h("span", icon("view_list"), h("b", combos.length), " Combos"),
          h("span", icon("flag"), h("b", groups.size), " Starters"),
          h("span", icon("style"), h("b", need.main.length + need.extra.length), " Cards")),
        h(
          "div.cc-actions",
          h("button.btn.primary", { onclick: () => open(s) }, icon("table_view"), " Open"),
          h("button.btn", { onclick: () => go(s, "edit") }, icon("edit"), " Edit"),
          h("button.btn", { title: "Share the spreadsheet with its combos", onclick: () => exportSheet(ctx, s) }, icon("ios_share"), " Export"),
          h("button.btn.danger", {
            title: "Delete the spreadsheet (its combos stay in the Trainer)",
            onclick: async () => {
              if (!(await confirmModal("Delete spreadsheet", `Delete "${s.name}"? Its combos are not deleted.`, "Delete", "Cancel", { danger: true }))) return;
              ctx.store.sheets = ctx.store.sheets.filter((x) => x.id !== s.id);
              ctx.save();
            },
          }, icon("delete"))
        )
      )
    );
  });
  const create = async () => {
    const s = await newSheet(ctx);
    if (s) go(s, "edit");
  };
  const importIt = async () => {
    const s = await importSheet(ctx);
    if (s) open(s);
  };
  if (!list.length) {
    panel.append(
      h(
        "div.combo-empty",
        h("div.combo-empty-head", h("h2", "Build a spreadsheet"), h("p.muted", "Collect the combos of a Deck by starter (the cards you open), like a combo guide: with a sample decklist and every card you need to play them.")),
        h(
          "div.combo-start-grid",
          h("button.combo-start.primary", { onclick: create }, h("span.combo-start-icon", icon("table_view")), h("b", "New spreadsheet"), h("span", "Start from one of your Decks as the sample decklist, or from nothing.")),
          h("button.combo-start", { onclick: importIt }, h("span.combo-start-icon", icon("download")), h("b", "Import a code"), h("span", "Add a spreadsheet shared from another Helios client, with all its combos.")),
          h("div.combo-start.info", h("span.combo-start-icon", icon("checklist")), h("b", "Grouped by starter"), h("span", "Combos with the same starting hand stay together, with their variants and every card you need."))
        )
      )
    );
    return;
  }
  panel.append(
    h(
      "div.combo-toolbar",
      h("div.combo-toolbar-title", h("h2", "Your spreadsheets"), h("span.muted.small", plural(list.length, "spreadsheet"))),
      h("button.btn", { title: "Import a spreadsheet code (from the clipboard or pasted)", onclick: importIt }, icon("download"), " Import"),
      h("button.btn.primary", { onclick: create }, icon("add"), " New spreadsheet")
    ),
    h("div.combo-list", list)
  );
}

/** Starter di una combo: le carte della mano iniziale (in ordine), come chiave. */
const starterKey = (c) => [...c.hand].sort((a, b) => a - b).join(",");

async function newSheet(ctx) {
  const name = h("input.input", { value: "New spreadsheet", maxLength: 60 });
  const picker = decklistPicker(ctx.decks, { emptyLabel: "None (add it later)" });
  const v = await openModal({
    title: "New spreadsheet",
    body: [h("label.field", h("span", "Name"), name), h("label.field", h("span", "Sample decklist"), picker.el), h("p.muted.small", "A copy of the list: new combos of the spreadsheet start from it.")],
    actions: [{ label: "Cancel", value: null }, { label: "Create", primary: true, onClick: (close) => close(true) }],
  }).result;
  if (!v) return null;
  const sample = await picker.read();
  if (!sample) return null;
  const s = {
    id: uid(),
    name: name.value.trim() || "Spreadsheet",
    notes: "",
    combos: [],
    sample: sample.main.length || sample.extra.length ? { main: sortDeckPart(sample.main), extra: sortDeckPart(sample.extra), side: sortDeckPart(sample.side ?? []) } : null,
  };
  ctx.store.sheets.push(s);
  ctx.save();
  return s;
}

/** Combo dello spreadsheet (quelle che esistono ancora) e i loro gruppi per starter. */
function sheetCombos(ctx, sheet) {
  const combos = sheet.combos.map((id) => ctx.store.combos.find((c) => c.id === id)).filter(Boolean);
  const groups = new Map();
  for (const c of combos) {
    const k = starterKey(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  return { combos, groups };
}

const comboTitle = (c) => (c.parent ? `${c.name} — ${c.branch || "Variant"}` : c.name);
const comboInfo = (c) => [c.first ? "Going first" : "Going second", plural(c.steps.length, "step"), c.interrupts.length ? plural(c.interrupts.length, "interruption") : ""].filter(Boolean).join(" · ");
const starterHead = (list) =>
  h("div.sheet-starter-head", h("div.combo-hand", list[0].hand.map((code) => h("div", { title: cardName(code) }, cardFace(code)))), h("div.sheet-starter-names", h("div.cc-label", "Starter", h("b", list.length), list.length === 1 ? "combo" : "combos"), h("span.small", list[0].hand.length ? list[0].hand.map(cardName).join(", ") : "No starting hand")));
const deckSummary = (list) => h("div.decklist-summary", h("span", h("b", list.main.length), " Main"), h("span", h("b", list.extra.length), " Extra"), list.side ? h("span", h("b", list.side.length), " Side") : null);

/** Carte necessarie dello spreadsheet nel deck builder in sola lettura (in rosso quelle che mancano nella sample). */
function viewNeed(sheet, combos) {
  const need = sheetCards(combos);
  const have = tally([...(sheet.sample?.main ?? []), ...(sheet.sample?.extra ?? [])]);
  const short = new Map([...tally([...need.main, ...need.extra])].filter(([code, n]) => sheet.sample && (have.get(code) ?? 0) < n).map(([code, n]) => [code, { kind: "short", count: n - (have.get(code) ?? 0) }]));
  const missing = [...short.values()].reduce((a, m) => a + m.count, 0);
  return openDeckViewer({
    main: need.main,
    extra: need.extra,
    title: sheet.name,
    subtitle: "Cards needed",
    marks: short,
    legend: `All the cards the combos use, with the copies needed by the combo that uses the most.${sheet.sample ? ` In red: ${missing ? `missing from the sample decklist (${plural(missing, "card")})` : "nothing is missing from the sample decklist"}.` : ""}`,
  });
}

/**
 * Viewer di uno spreadsheet (sola lettura): note, combo per starter da guardare e provare, carte necessarie
 * e decklist d'esempio nel deck builder. Edit apre l'editor, Export il codice da condividere.
 */
function renderSheetView(panel, ctx, sheet, go) {
  const { combos, groups } = sheetCombos(ctx, sheet);
  const need = sheetCards(combos);
  const comboLine = (c) =>
    h(
      "div.sheet-combo",
      h("div.combo-info", h("b", comboTitle(c)), h("div.muted.small", comboInfo(c))),
      h(
        "div.combo-actions",
        h("button.btn.small.primary", { onclick: () => ctx.practice(c) }, icon("play_arrow"), " Practice"),
        h("button.btn.small", { title: "The trainer plays the combo by itself", onclick: () => ctx.practice(c, { autoplay: true }) }, icon("smart_display"), " Auto-play"),
        h("button.btn.small", { onclick: () => ctx.schema(c) }, icon("view_timeline"), " View")
      )
    );
  panel.append(
    ...[
      h(
        "div.combo-toolbar",
        h("button.btn.ghost.round", { title: "All spreadsheets", onclick: () => go(null) }, icon("chevron_left")),
        h("div.combo-toolbar-title", h("h2", sheet.name), h("span.muted.small", `${plural(combos.length, "combo")} · ${plural(groups.size, "starter")}`)),
        h("button.btn", { title: "Share the spreadsheet with its combos", onclick: () => exportSheet(ctx, sheet) }, icon("ios_share"), " Export"),
        h("button.btn.primary", { onclick: () => go(sheet, "edit") }, icon("edit"), " Edit")
      ),
      sheet.notes ? h("p.schema-notes", sheet.notes) : null,
      h("h3.combo-sec", "Combos by starter"),
      groups.size
        ? h("div.sheet-starters", [...groups.values()].map((list) => h("div.sheet-starter", starterHead(list), list.map(comboLine))))
        : h("p.muted", "No combos yet: add them with Edit."),
      h("h3.combo-sec", "Cards needed"),
      need.main.length || need.extra.length
        ? [deckSummary(need), h("div.sheet-tools", h("button.btn", { onclick: () => viewNeed(sheet, combos) }, icon("style"), " View in the Deck Builder"))]
        : h("p.muted.small", "No cards yet."),
      h("h3.combo-sec", "Sample decklist"),
      sheet.sample
        ? [
            deckSummary(sheet.sample),
            h("div.sheet-tools", h("button.btn", { onclick: () => openDeckViewer({ ...sheet.sample, title: sheet.name, subtitle: "Sample decklist" }) }, icon("style"), " View in the Deck Builder")),
          ]
        : h("p.muted.small", "No sample decklist."),
    ]
      .flat(Infinity)
      .filter(Boolean)
  );
}

/** Esportazione: codice da condividere con tutte le combo (Trainer → Spreadsheets → Import). */
async function exportSheet(ctx, sheet) {
  const { combos } = sheetCombos(ctx, sheet);
  const code = await sheetToCode(sheet, combos);
  const show = () =>
    openModal({
      title: `Share "${sheet.name}"`,
      body: [h("p.muted.small", `The code contains the spreadsheet and its ${plural(combos.length, "combo")}: import it in another Helios client (Trainer → Spreadsheets → Import).`), h("textarea.input.combo-code", { readOnly: true, rows: 6, value: code, onfocus: (e) => e.target.select() })],
      actions: [{ label: "Close", value: null, primary: true }],
    });
  await openModal({
    title: `Export "${sheet.name}"`,
    body: [h("p.muted.small", `Share code: the spreadsheet with its notes, sample decklist and ${plural(combos.length, "combo")} (variants included). Import it in another Helios client (Trainer → Spreadsheets → Import).`)],
    actions: [
      { label: "Close", value: null },
      { label: "Show the code", onClick: (close) => { close(); show(); } },
      {
        label: "Copy share code",
        primary: true,
        onClick: (close) => {
          close();
          if (!navigator.clipboard?.writeText) return show();
          navigator.clipboard.writeText(code).then(() => toast(`Spreadsheet code copied: "${sheet.name}"`), show);
        },
      },
    ],
  }).result;
}

/** Importa uno spreadsheet (dagli appunti o incollato): crea le sue combo e lo spreadsheet, che restituisce. */
async function importSheet(ctx) {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    /* appunti non accessibili: si chiede di incollare */
  }
  if (!isSheetCode(text)) {
    const area = h("textarea.input.combo-code", { rows: 5, placeholder: "HELIOS-SHEET:..." });
    const v = await openModal({ title: "Import spreadsheet", body: [h("p.muted.small", "Paste the spreadsheet code:"), area], actions: [{ label: "Cancel", value: null }, { label: "Import", primary: true, onClick: (close) => close(area.value) }] }).result;
    if (!v) return null;
    text = v;
  }
  let data;
  try {
    data = await sheetFromCode(text);
  } catch (e) {
    alertModal("Import spreadsheet", e.message);
    return null;
  }
  // Combo nuove (id nuovi); le varianti restano sotto la loro combo originale.
  const ids = data.combos.map(() => uid());
  data.combos.forEach(({ parentIndex, ...c }, i) => {
    const root = parentIndex != null && data.combos[parentIndex]?.parentIndex == null ? ids[parentIndex] : null;
    ctx.store.combos.push({ ...c, id: ids[i], ...(root ? { parent: root } : {}) });
  });
  const s = { id: uid(), name: data.name, notes: data.notes, combos: ids, sample: data.sample };
  ctx.store.sheets.push(s);
  ctx.save();
  toast(`Spreadsheet imported: "${s.name}" (${plural(ids.length, "combo")})`);
  return s;
}

/** Editor di uno spreadsheet: nome, note, combo (nuove, esistenti, importate), decklist d'esempio. */
function renderSheet(panel, ctx, sheet, go) {
  const combos = sheet.combos.map((id) => ctx.store.combos.find((c) => c.id === id)).filter(Boolean);
  const back = () => go(null);

  const name = h("input.input", { value: sheet.name, maxLength: 60, onchange: () => { sheet.name = name.value.trim() || sheet.name; ctx.save(); } });
  const notes = h("textarea.input.combo-notes", { value: sheet.notes ?? "", rows: 2, maxLength: NOTES_MAX, placeholder: "Notes: game plan, which starters to keep, what to side…", onchange: () => { sheet.notes = notes.value.trim(); ctx.save(); } });

  // ---- combo raggruppate per starter
  const groups = new Map();
  for (const c of combos) {
    const k = starterKey(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const comboLine = (c) =>
    h(
      "div.sheet-combo",
      h("div.combo-info", h("b", c.parent ? `${c.name} — ${c.branch || "Variant"}` : c.name), h("div.muted.small", [c.first ? "Going first" : "Going second", plural(c.steps.length, "step"), c.interrupts.length ? plural(c.interrupts.length, "hand trap") : ""].filter(Boolean).join(" · "))),
      h(
        "div.combo-actions",
        h("button.btn.small.primary", { onclick: () => ctx.practice(c) }, icon("play_arrow"), " Practice"),
        h("button.btn.small", { onclick: () => ctx.schema(c) }, icon("view_timeline"), " View"),
        h("button.btn.small", { onclick: () => ctx.edit(c).then((v) => v && ctx.put(v)) }, icon("edit"), " Edit"),
        h("button.btn.small", {
          title: "New variant of this combo, added to the spreadsheet",
          onclick: () => ctx.fork(c).then((v) => {
            if (!v) return;
            sheet.combos.push(v.id);
            ctx.save();
          }),
        }, icon("fork_right"), " Fork"),
        h("button.btn.small.ghost", { title: "Remove from the spreadsheet (the combo is not deleted)", onclick: () => { sheet.combos = sheet.combos.filter((id) => id !== c.id); ctx.save(); } }, icon("close"))
      )
    );
  const starters = [...groups.values()].map((list) =>
    h(
      "div.sheet-starter",
      h("div.sheet-starter-head", h("div.combo-hand", list[0].hand.map((code) => h("div", { title: cardName(code) }, cardFace(code)))), h("div.sheet-starter-names", h("div.cc-label", "Starter", h("b", list.length), list.length === 1 ? "combo" : "combos"), h("span.small", list[0].hand.length ? list[0].hand.map(cardName).join(", ") : "No starting hand"))),
      list.map(comboLine)
    )
  );

  // ---- carte necessarie e decklist d'esempio
  const need = sheetCards(combos);
  const have = tally([...(sheet.sample?.main ?? []), ...(sheet.sample?.extra ?? [])]);
  // Copie che mancano nella decklist d'esempio (evidenziate in rosso).
  const short = new Map([...tally([...need.main, ...need.extra])].filter(([code, n]) => sheet.sample && (have.get(code) ?? 0) < n).map(([code, n]) => [code, { kind: "short", count: n - (have.get(code) ?? 0) }]));
  const missing = [...tally([...need.main, ...need.extra])].reduce((a, [code, n]) => a + Math.max(0, n - (have.get(code) ?? 0)), 0);
  // Le decklist si guardano e si modificano nella schermata del deck builder: qui solo un riepilogo.
  const summary = (list) => h("div.decklist-summary", h("span", h("b", list.main.length), " Main"), h("span", h("b", list.extra.length), " Extra"), list.side ? h("span", h("b", list.side.length), " Side") : null);
  const viewNeed = () =>
    openDeckViewer({
      main: need.main,
      extra: need.extra,
      title: sheet.name,
      subtitle: "Cards needed",
      marks: short,
      legend: `All the cards the combos use, with the copies needed by the combo that uses the most.${sheet.sample ? ` In red: ${missing ? `missing from the sample decklist (${plural(missing, "card")})` : "nothing is missing from the sample decklist"}.` : ""}`,
    });
  const setSample = (s) => {
    sheet.sample = s ? { main: sortDeckPart(s.main), extra: sortDeckPart(s.extra), side: sortDeckPart(s.side ?? []) } : null;
    ctx.save();
  };

  // append del DOM: le sezioni fatte di più elementi (array) si appiattiscono.
  const parts = [
    h(
      "div.card-box.sheet-head",
      h("button.btn.ghost.round", { title: "All spreadsheets", onclick: back }, icon("chevron_left")),
      h("label.field", h("span", "Spreadsheet"), name),
      h("div.sheet-head-actions", h("button.btn", { title: "Share the spreadsheet with its combos", onclick: () => exportSheet(ctx, sheet) }, icon("ios_share"), " Export"), h("button.btn.primary", { onclick: () => go(sheet, "view") }, icon("visibility"), " Done: view"))
    ),
    notes,
    h("h3.combo-sec", `Combos (${combos.length}) · ${plural(groups.size, "starter")}`),
    h(
      "div.sheet-tools",
      h("button.btn.primary", { onclick: () => ctx.newCombo({ sheet }) }, icon("add"), " New combo"),
      h("button.btn", { onclick: () => addExisting(ctx, sheet) }, icon("playlist_add"), " Add existing combos"),
      h("button.btn", {
        title: "Import a combo code into the spreadsheet",
        onclick: () => ctx.importCombo().then((v) => {
          if (!v) return;
          const c = ctx.put(v);
          sheet.combos.push(c.id);
          ctx.save();
        }),
      }, icon("download"), " Import")
    ),
    starters.length ? h("div.sheet-starters", starters) : h("p.muted", "No combos yet: write or record a new one, or add combos you already have."),
    h("h3.combo-sec", "Cards needed"),
    h("p.muted.small", "All the cards the combos use, with the copies needed by the combo that uses the most." + (sheet.sample ? ` Compared with the sample decklist: ${missing ? `${plural(missing, "card")} missing.` : "nothing is missing."}` : "")),
    need.main.length || need.extra.length
      ? [summary(need), h("div.sheet-tools", h("button.btn", { onclick: viewNeed }, icon("style"), " View in the Deck Builder"))]
      : h("p.muted.small", "No cards yet."),
    h("h3.combo-sec", "Sample decklist"),
    sheet.sample ? summary(sheet.sample) : h("p.muted.small", "No sample decklist yet."),
    h(
      "div.sheet-tools",
      h("button.btn.primary", {
        onclick: async () => {
          const v = await openDecklistEditor(sheet.sample ?? { main: [], extra: [], side: [] }, { title: `${sheet.name} — sample decklist` });
          if (v) setSample(v);
        },
      }, icon("style"), " Open in the Deck Builder"),
      h("button.btn", {
        onclick: async () => {
          const d = await chooseDeck(ctx);
          if (d) setSample(d);
        },
      }, icon("style"), " Use a saved Deck"),
      h("button.btn", { onclick: () => pasteDeck().then((d) => d && setSample(d)) }, icon("content_paste"), " Paste a Deck"),
      h("button.btn", {
        title: "Add the missing cards needed by the combos to the sample decklist",
        disabled: !missing,
        onclick: () => {
          const s = sheet.sample ?? { main: [], extra: [], side: [] };
          const cur = tally([...s.main, ...s.extra]);
          for (const [code, n] of tally(need.main)) for (let i = cur.get(code) ?? 0; i < n; i++) s.main.push(code);
          for (const [code, n] of tally(need.extra)) for (let i = cur.get(code) ?? 0; i < n; i++) s.extra.push(code);
          setSample(s);
          toast(`Added ${plural(missing, "card")} to the sample decklist`);
        },
      }, icon("playlist_add_check"), " Add the missing cards"),
      h("button.btn", {
        title: "Save the sample decklist as a new Deck in the Deck Editor",
        disabled: !sheet.sample,
        onclick: () => {
          const d = { ...emptyDeck(sheet.name), main: [...sheet.sample.main], extra: [...sheet.sample.extra], side: [...sheet.sample.side] };
          saveDecks([...loadDecks(), d]);
          ctx.decks.push(d);
          toast(`Deck saved: "${d.name}"`);
        },
      }, icon("save"), " Save as Deck"),
      sheet.sample ? h("button.btn.ghost", { onclick: () => setSample(null) }, icon("close"), " Remove") : null
    ),
  ];
  panel.append(...parts.flat(Infinity).filter(Boolean));
}

/** Aggiunge allo spreadsheet combo già salvate. */
async function addExisting(ctx, sheet) {
  const inSheet = new Set(sheet.combos);
  const candidates = ctx.store.combos.filter((c) => !inSheet.has(c.id));
  if (!candidates.length) return alertModal("Add combos", "All your combos are already in this spreadsheet.");
  const ordered = candidates;
  const picked = new Set();
  const rows = ordered.map((c) => {
    const box = h("input", { type: "checkbox", onchange: () => (box.checked ? picked.add(c.id) : picked.delete(c.id)) });
    return h(
      "label.sheet-pick",
      box,
      h("div.combo-hand", c.hand.slice(0, 5).map((code) => cardFace(code))),
      h("div", h("b", c.parent ? `${c.name} — ${c.branch || "Variant"}` : c.name), h("div.muted.small", `${c.first ? "Going first" : "Going second"} · ${plural(c.steps.length, "step")}`))
    );
  });
  const ok = await openModal({
    title: `Add combos to "${sheet.name}"`,
    className: "wide",
    body: [h("div.sheet-pick-list", rows)],
    actions: [{ label: "Cancel", value: null }, { label: "Add", primary: true, onClick: (close) => close(true) }],
  }).result;
  if (!ok || !picked.size) return;
  sheet.combos.push(...ordered.filter((c) => picked.has(c.id)).map((c) => c.id));
  ctx.save();
}

/** Mazzo salvato da usare come decklist d'esempio. */
async function chooseDeck(ctx) {
  if (!ctx.decks.length) {
    alertModal("Decks", "You have no saved Decks.");
    return null;
  }
  const sel = h("select.select", ctx.decks.map((d) => h("option", { value: d.id }, `${d.name} (${d.main.length}/${d.extra.length}/${d.side.length})`)));
  const v = await openModal({
    title: "Sample decklist",
    body: [h("label.field", h("span", "Deck"), sel)],
    actions: [{ label: "Cancel", value: null }, { label: "Use", primary: true, onClick: (close) => close(sel.value) }],
  }).result;
  const d = v && ctx.decks.find((x) => x.id === v);
  return d ? { main: [...d.main], extra: [...d.extra], side: [...d.side] } : null;
}

/**
 * Scelta di una decklist da copiare: un mazzo salvato, la decklist d'esempio di uno spreadsheet (sample),
 * una incollata o nessuna. read() restituisce { main, extra, side } (vuota per "nessuna") o null se annullata.
 */
export function decklistPicker(decks, { sample = null, empty = true, emptyLabel = "Empty (add the cards later)" } = {}) {
  const el = h(
    "select.select",
    sample ? h("option", { value: "sample" }, "Sample decklist of the spreadsheet") : null,
    decks.map((d) => h("option", { value: `deck:${d.id}` }, `${d.name} (${d.main.length}/${d.extra.length})`)),
    h("option", { value: "paste" }, "Paste a Deck (ydke://, .ydk, Omega code, card list)…"),
    empty ? h("option", { value: "empty" }, emptyLabel) : null
  );
  const last = decks.find((d) => d.id === settings.lastDeck) ?? decks[0];
  el.value = sample ? "sample" : last ? `deck:${last.id}` : empty ? "empty" : "paste";
  const copy = (d) => ({ main: [...d.main], extra: [...d.extra], side: [...(d.side ?? [])] });
  const read = async () => {
    if (el.value === "sample") return copy(sample);
    if (el.value === "empty") return { main: [], extra: [], side: [] };
    if (el.value === "paste") return pasteDeck();
    const d = decks.find((x) => `deck:${x.id}` === el.value);
    return d ? copy(d) : null;
  };
  return { el, read };
}

/** Decklist incollata: ydke://, .ydk, codice Omega o lista per nome (come nel deck editor). */
async function pasteDeck() {
  const area = h("textarea.input.combo-code", { rows: 6, placeholder: "ydke://…, a .ydk, an Omega code or a card list" });
  const text = await openModal({
    title: "Paste a Deck",
    body: [area],
    actions: [{ label: "Cancel", value: null }, { label: "Use", primary: true, onClick: (close) => close(area.value) }],
  }).result;
  if (!text) return null;
  try {
    const { deck, missing } = await parseDeckText(text);
    if (missing.length) toast(`Unknown cards: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`, { kind: "error", ms: 5000 });
    return deck;
  } catch (e) {
    alertModal("Paste a Deck", e.message);
    return null;
  }
}
