// Draft: la pagina con i formati di draft dell'host e l'editor (ispirato a CubeCobra). Un formato ha una modalità
// (per ora l'Helios Bundle Draft), le rarità decise dal creatore, il pool dei due round e le regole dei pacchetti.
// Il gioco vero e proprio (tavolo, bot, partite) arriva nelle fasi successive.
import { h, clear, icon, download, pickFile } from "./dom.js";
import { openModal, confirmModal, alertModal, toast } from "./modal.js";
import { cardFace } from "./card.js";
import { openCardCollector } from "./editor.js";
import { getCard, isExtraDeckCard } from "../data/db.js";
import {
  DRAFT_MODES, BUNDLE_MIN_MAIN, RULE_KINDS, PACK_SIZE, modeOf, newFormat, newBundle, newSingle, newId,
  loadFormats, storeFormat, deleteFormat, exportFormat, importFormat, roundItems, rarityOf, allTags, misplaced,
} from "../draft/format.js";
import { makePack, formatErrors, readiness, ruleText } from "../draft/packs.js";
import { loadRuns, deleteRun, runRecord, storeRun } from "../draft/runs.js";
import { openBotDraftSetup } from "./draft-table.js";
import { liveDraft, rejoinDraft, forgetLiveDraft } from "./draft-online.js";

/** Draft online lasciato a metà (pagina chiusa, collegamento perso): si può rientrare con il proprio posto. */
function liveBanner(app) {
  const live = liveDraft();
  if (!live) return null;
  const el = h(
    "div.draft-live",
    icon("wifi_off"),
    h("div", h("b", "Draft in progress"), h("span.muted.small", ` ${live.start?.format?.name ?? ""} · room ${live.code} · your seat is played by the timer until you come back`)),
    h("button.btn.primary", { onclick: () => rejoinDraft(app) }, icon("login"), " Rejoin"),
    h("button.btn.ghost", { onclick: () => { forgetLiveDraft(); el.remove(); } }, "Forget")
  );
  return el;
}

const fileName = (f) => `${f.name.replace(/[^\w\- ]+/g, "").trim() || "draft"}.helios-draft.json`;

// ---------------------------------------------------------------- pagina Draft

export function showDraft(app) {
  const root = clear(app.root);
  const list = h("div.draft-formats");
  const refresh = () => {
    const formats = loadFormats();
    clear(list).append(
      ...(formats.length
        ? formats.map((f) => formatTile(f))
        : [h("p.muted.draft-empty", "No draft formats yet. Create one, or import a file someone shared with you.")])
    );
  };
  const formatTile = (f) => {
    const mode = modeOf(f.mode);
    const errs = formatErrors(f, { bundleMinMain: BUNDLE_MIN_MAIN });
    const missing = readiness(f);
    const status = errs.length
      ? h("span.draft-status.bad", { title: errs.join("\n") }, icon("error"), " Has problems")
      : missing.length
        ? h("span.draft-status.warn", { title: missing.join("\n") }, icon("pending"), " Not ready")
        : h("span.draft-status.ok", icon("check_circle"), " Ready");
    const thumbs = [...f.bundles.flatMap((b) => b.main.slice(0, 1)), ...f.singles.map((s) => s.code)].slice(0, 6);
    return h(
      "div.draft-format",
      h("div.draft-format-cards", thumbs.map((c) => cardFace(c))),
      h(
        "div.draft-format-info",
        h("b.draft-format-name", f.name),
        h("span.muted.small", mode.name),
        h("span.small", `${f.bundles.length} bundles · ${f.singles.length} singles · ${f.rarities.length} rarities`),
        status
      ),
      h(
        "div.draft-format-actions",
        h("button.btn.small.primary", { onclick: () => showDraftEditor(app, f) }, icon("edit"), " Edit"),
        h("button.btn.small", { title: "Save as a file to share", onclick: () => download(fileName(f), exportFormat(f), "application/json") }, icon("download"), " Export"),
        h("button.btn.small", {
          title: "Make a copy",
          onclick: () => {
            storeFormat({ ...structuredClone(f), id: newId(), name: `${f.name} (copy)` });
            refresh();
          },
        }, icon("content_copy")),
        h("button.btn.small.danger", {
          title: "Delete",
          onclick: async () => {
            if (!(await confirmModal("Delete the draft format?", `"${f.name}" will be deleted from this browser.`, "Delete", "Cancel", { danger: true }))) return;
            deleteFormat(f.id);
            refresh();
          },
        }, icon("delete"))
      )
    );
  };
  const create = async () => {
    const mode = await chooseMode();
    if (!mode) return;
    const f = newFormat(mode, `New ${modeOf(mode).name}`);
    showDraftEditor(app, f, { isNew: true });
  };
  const doImport = async () => {
    const file = await pickFile(".json,application/json");
    if (!file) return;
    try {
      const f = importFormat(await file.text());
      storeFormat(f);
      toast(`"${f.name}" imported`);
      refresh();
    } catch (e) {
      toast(`Cannot import: ${e.message}`, { kind: "error" });
    }
  };
  refresh();
  root.append(
    h(
      "div.page.draft-page",
      h("div.page-head", h("button.btn.ghost.round.page-back", { title: "Back (right-click)", onclick: () => app.home("duel") }, icon("chevron_left")), h("h1", "Limited", h("small.page-sub", "Draft decks with friends from a card pool you curate"))),
      h(
        "section.draft-section",
        h("h2", "Play"),
        h(
          "div.draft-play",
          h("button.draft-mode", { onclick: () => openBotDraftSetup(app) }, h("b", "Draft vs bots"), h("span.muted.small", "Draft alone at a table of bots, then play vs the CPU")),
          h("button.draft-mode", { onclick: () => openBotDraftSetup(app, { online: true }) }, h("b", "Host a draft"), h("span.muted.small", "Open a room and draft online with your friends")),
          h("button.draft-mode", { onclick: async () => (await import("./draft-online.js")).joinDraft(app) }, h("b", "Join a draft"), h("span.muted.small", "Enter the room code of a friend"))
        ),
        liveBanner(app)
      ),
      runsSection(app),
      h(
        "section.draft-section",
        h("div.draft-section-head", h("h2", "Limited formats"), h("button.btn.primary", { onclick: create }, icon("add"), " New format"), h("button.btn", { onclick: doImport }, icon("upload_file"), " Import")),
        h("p.muted.small", "A format is the pool of your draft (the cube) with its rarities and pack rules. Players get it from the host when the draft starts."),
        list
      )
    )
  );
}

/** Draft già giocati: si riprende il mazzo e le partite. */
function runsSection(app) {
  const box = h("section.draft-section");
  const draw = () => {
    const runs = loadRuns();
    clear(box).append(
      ...(runs.length
        ? [
            h("h2", "Your drafts"),
            h(
              "div.draft-runs",
              runs.map((r) => {
                const rec = runRecord(r);
                return h(
                  "div.draft-run",
                  h("div.draft-format-cards", r.deck.main.slice(0, 3).map((c) => cardFace(c))),
                  h(
                    "div.draft-format-info",
                    h("b.draft-format-name", r.format.name),
                    h("span.muted.small", `${new Date(r.created).toLocaleString()} · ${r.seats.length} seats`),
                    h("span.small", `Deck ${r.deck.main.length} + ${r.deck.extra.length} · ${rec.won}–${rec.lost} in matches${r.locked ? " · locked" : ""}`)
                  ),
                  h(
                    "div.draft-format-actions",
                    h("button.btn.small.primary", { onclick: async () => (await import("./draft-deck.js")).showDraftDeck(app, r.id) }, icon("style"), " Open"),
                    h("button.btn.small.danger", { title: "Delete", onclick: () => removeRun(r) }, icon("delete"))
                  )
                );
              })
            ),
          ]
        : []),
      // Draft online salvati nel backup privato sui relay (es. da un altro browser): si riprendono qui.
      h(
        "div.draft-restore",
        h("button.btn.ghost.small", { onclick: restore }, icon("cloud_download"), " Restore online drafts from Nostr"),
        h("span.muted.small", "Your pools, decks and matches of online drafts are backed up encrypted: only you can read them.")
      )
    );
  };
  // Draft online: si può cancellare anche il backup privato sui relay Nostr (se no, si potrebbe ripristinare).
  async function removeRun(r) {
    if (!r.online) {
      if (await confirmModal("Delete this draft?", "Its pool, deck and results are deleted.", "Delete", "Cancel", { danger: true })) {
        deleteRun(r.id);
        draw();
      }
      return;
    }
    const choice = await openModal({
      title: "Delete this draft?",
      className: "danger",
      body: [
        h("p", "Its pool, deck and results are deleted from this browser."),
        h("p.muted.small", "This online draft is also backed up on the Nostr relays (encrypted, only you can read it). \"Only here\" keeps the backup, so you can restore the draft later; \"Also from Nostr\" deletes it too. The tournament results stay for the other players."),
      ],
      actions: [
        { label: "Cancel", value: null },
        { label: "Only here", value: "local" },
        { label: "Also from Nostr", value: "all", danger: true },
      ],
    }).result;
    if (!choice) return;
    deleteRun(r.id);
    draw();
    if (choice === "all") {
      const { deleteBackup } = await import("../net/tournament-store.js");
      const ok = await deleteBackup(r.id).catch(() => false);
      toast(ok ? "Draft deleted, also from the Nostr relays" : "Draft deleted here; the relays did not answer, the backup may still be there", ok ? {} : { kind: "error" });
    } else toast("Draft deleted (the backup on Nostr is kept)");
  }

  async function restore() {
    toast("Looking for your backups on the relays…");
    const { fetchBackups } = await import("../net/tournament-store.js");
    const found = await fetchBackups();
    const have = new Set(loadRuns().map((r) => r.id));
    const fresh = found.filter((r) => !have.has(r.id));
    if (!found.length) return toast("No backups found for your identity", { kind: "error" });
    if (!fresh.length) return toast(`All your ${found.length} online draft(s) are already here`);
    for (const r of fresh) storeRun(r);
    toast(`Restored ${fresh.length} online draft(s)`);
    draw();
  }
  draw();
  return box;
}

/** Scelta della modalità di un formato nuovo: le modalità non ancora pronte sono "coming soon". */
function chooseMode() {
  const m = openModal({
    title: "New Limited format",
    className: "draft-mode-modal",
    body: [
      h("p.muted", "Choose the mode:"),
      h(
        "div.draft-modes",
        DRAFT_MODES.map((mode) =>
          h(
            `button.draft-mode${mode.available ? "" : ".soon"}`,
            { disabled: !mode.available, onclick: () => m.close(mode.id) },
            h("b", mode.name, mode.available ? null : h("span.soon-badge", "Coming soon")),
            h("span.muted.small", mode.sub)
          )
        )
      ),
    ],
    actions: [{ label: "Cancel", value: null }],
  });
  return m.result;
}

// ---------------------------------------------------------------- editor

export function showDraftEditor(app, original, { isNew = false } = {}) {
  const root = clear(app.root);
  const f = structuredClone(original);
  let saved = isNew ? "" : JSON.stringify(f);
  const dirty = () => JSON.stringify(f) !== saved;
  let tab = "bundles";

  const rarityLabel = (id) => {
    const r = rarityOf(f, id);
    return h("span.rarity-chip", { style: `--rc: ${r?.color ?? "#5b6070"}` }, r?.name ?? "No rarity");
  };
  const raritySelect = (value, onchange) => {
    const s = h(
      "select.select",
      { onchange: () => onchange(s.value || null) },
      h("option", { value: "" }, "No rarity"),
      [...f.rarities].reverse().map((r) => h("option", { value: r.id }, r.name))
    );
    s.value = value ?? "";
    return s;
  };
  // Gruppi per rarità, dalla più alta (in fondo "senza rarità", solo se serve). Ci sono anche le rarità vuote: si
  // trascina un oggetto su un gruppo per dargli quella rarità.
  const byRarity = (items) => {
    const groups = [...f.rarities].reverse().map((r) => ({ r, items: items.filter((x) => x.rarity === r.id) }));
    const none = items.filter((x) => !rarityOf(f, x.rarity));
    if (none.length) groups.push({ r: null, items: none });
    return groups;
  };
  const DRAG = "text/x-draft-item";
  const draggable = (el, x) => {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(DRAG, x.id);
      e.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    return el;
  };
  const rarityGroup = (g, list, tile, empty) => {
    const box = h(
      "div.draft-group",
      h("div.draft-group-head", rarityLabel(g.r?.id), h("span.muted.small", `${g.items.length}`)),
      g.items.length ? h(list, g.items.map(tile)) : h("div.draft-drop-hint.muted.small", empty)
    );
    box.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes(DRAG)) return;
      e.preventDefault();
      box.classList.add("drop");
    });
    box.addEventListener("dragleave", (e) => !box.contains(e.relatedTarget) && box.classList.remove("drop"));
    box.addEventListener("drop", (e) => {
      box.classList.remove("drop");
      const id = e.dataTransfer.getData(DRAG);
      const x = [...f.bundles, ...f.singles].find((y) => y.id === id);
      if (!x) return;
      e.preventDefault();
      x.rarity = g.r?.id ?? null;
      update();
    });
    return box;
  };
  // Carte uguali una volta sola, con il numero di copie.
  const stacked = (codes) => {
    const n = new Map();
    for (const c of codes) n.set(c, (n.get(c) ?? 0) + 1);
    return [...n].map(([code, k]) => h("span.draft-stack", { title: `${getCard(code)?.name ?? ""}${k > 1 ? ` ×${k}` : ""}` }, cardFace(code), k > 1 ? h("b.draft-copies", `×${k}`) : null));
  };
  const tagsInput = (tags, onchange) => {
    const id = `tags-${newId()}`;
    return [
      h("input.input", {
        value: tags.join(", "),
        placeholder: "e.g. power, starter, handtrap",
        list: id,
        onchange: (e) => onchange([...new Set(e.target.value.split(",").map((t) => t.trim()).filter(Boolean))]),
      }),
      h("datalist", { id }, allTags(f).map((t) => h("option", { value: t }))),
    ];
  };

  // ------------------------------------------------------------ testata
  const nameIn = h("input.input.draft-name", { value: f.name, maxLength: 60, oninput: () => { f.name = nameIn.value; changed(); } });
  const saveBtn = h("button.btn.primary", { onclick: () => save() });
  const issuesEl = h("div.draft-issues");
  function changed() {
    const d = dirty();
    saveBtn.replaceChildren(icon("save"), d ? " Save" : " Saved");
    saveBtn.classList.toggle("dirty", d);
    const errs = formatErrors(f, { bundleMinMain: BUNDLE_MIN_MAIN });
    const missing = readiness(f);
    clear(issuesEl).append(
      ...errs.map((e) => h("div.draft-issue.bad", icon("error"), e)),
      ...missing.map((e) => h("div.draft-issue.warn", icon("pending"), `${e} The format can be saved, but not used for a draft yet.`))
    );
    renderTabs();
  }
  function save() {
    const errs = formatErrors(f, { bundleMinMain: BUNDLE_MIN_MAIN });
    if (errs.length) return alertModal("Fix these problems to save", errs.join("\n"));
    f.name = f.name.trim() || "Draft";
    nameIn.value = f.name;
    storeFormat(f);
    saved = JSON.stringify(f);
    toast("Format saved");
    changed();
  }
  async function leave() {
    if (dirty()) {
      const v = await openModal({
        title: "Unsaved changes",
        body: [h("p", `"${f.name}" has unsaved changes.`)],
        actions: [{ label: "Cancel", value: null }, { label: "Discard", danger: true, value: "discard" }, { label: "Save", primary: true, value: "save" }],
      }).result;
      if (!v) return;
      if (v === "save") {
        save();
        if (dirty()) return; // non salvato (problemi da sistemare)
      }
    }
    window.removeEventListener("beforeunload", onUnload);
    showDraft(app);
  }
  const onUnload = (e) => {
    if (!dirty()) return;
    e.preventDefault();
    e.returnValue = "";
  };
  window.addEventListener("beforeunload", onUnload);
  app.onLeave = () => window.removeEventListener("beforeunload", onUnload);

  // ------------------------------------------------------------ schede
  const tabsEl = h("div.draft-tabs");
  const body = h("div.draft-body");
  const TABS = [
    ["bundles", () => `Round 1 · Bundles (${f.bundles.length})`],
    ["singles", () => `Round 2 · Singles (${f.singles.length})`],
    ["rarities", () => `Rarities (${f.rarities.length})`],
    ["rules", () => `Pack rules (${f.rules.length})`],
    ["sample", () => "Sample pack"],
  ];
  function renderTabs() {
    clear(tabsEl).append(
      ...TABS.map(([key, label]) => h(`button.draft-tab${tab === key ? ".on" : ""}`, { onclick: () => { tab = key; renderTabs(); render(); } }, label()))
    );
  }
  function render() {
    clear(body).append(...({ bundles: bundlesView, singles: singlesView, rarities: raritiesView, rules: rulesView, sample: sampleView })[tab]().filter(Boolean));
  }
  const update = () => {
    changed();
    render();
  };

  // ------------------------------------------------------------ round 1: bundle
  let bundleQuery = "";
  function bundlesView() {
    const q = bundleQuery.toLowerCase();
    const shown = f.bundles.filter((b) => !q || b.name.toLowerCase().includes(q) || b.tags.some((t) => t.toLowerCase().includes(q)) || [...b.main, ...b.extra].some((c) => getCard(c)?.name.toLowerCase().includes(q)));
    const search = h("input.input.draft-search", { value: bundleQuery, placeholder: "Search bundles, cards or tags", oninput: (e) => { bundleQuery = e.target.value; const pos = e.target.selectionStart; render(); const el = body.querySelector(".draft-search"); el.focus(); el.setSelectionRange(pos, pos); } });
    return [
      h(
        "div.draft-toolbar",
        h("button.btn.primary", { onclick: createBundle }, icon("add"), " New bundle"),
        search,
        h("span.muted.small", `Each bundle is one pick in Round 1 and gives all its cards (at least ${BUNDLE_MIN_MAIN} Main Deck cards). Drag a bundle onto a rarity to change it.`)
      ),
      f.bundles.length && !shown.length ? h("p.muted.draft-empty", "No bundle matches the search.") : null,
      !f.bundles.length ? h("p.muted.draft-empty", "No bundles yet: add the packages of Round 1 (a core of Main Deck cards plus its Extra Deck bosses).") : null,
      ...(f.bundles.length ? byRarity(shown).map((g) => rarityGroup(g, "div.draft-bundles", bundleTile, "Drop a bundle here")) : []),
    ];
  }
  function bundleTile(b) {
    const bad = b.main.length < BUNDLE_MIN_MAIN;
    const cards = stacked([...b.main, ...b.extra]);
    return draggable(h(
      `button.draft-bundle${bad ? ".bad" : ""}`,
      { style: `--rc: ${rarityOf(f, b.rarity)?.color ?? "#5b6070"}`, onclick: () => editBundle(b) },
      h("div.draft-bundle-head", h("b", b.name), h("span.muted.small", `Main ${b.main.length} · Extra ${b.extra.length}`)),
      h("div.draft-bundle-cards", cards.slice(0, 10), cards.length > 10 ? h("span.more", `+${cards.length - 10}`) : null),
      b.tags.length ? h("div.draft-tags", b.tags.map((t) => h("span.tag", t))) : null,
      bad ? h("span.draft-bundle-warn", icon("error"), ` Needs ${BUNDLE_MIN_MAIN}+ Main Deck cards`) : null
    ), b);
  }
  // Bundle nuovo: prima le carte (si apre subito la ricerca), poi nome, rarità e tag. Annullato senza carte: niente bundle.
  async function createBundle() {
    const b = newBundle(f.rarities[0]?.id ?? null);
    if (!(await editCards(b, true))) return;
    f.bundles.unshift(b);
    const first = getCard(b.main[0] ?? b.extra[0]);
    if (first) b.name = first.name;
    update();
    editBundle(b);
  }
  async function editCards(b, fresh = false) {
    const out = await openCardCollector({
      title: fresh ? "New bundle" : b.name,
      subtitle: "Bundle cards",
      noBanlist: true,
      parts: [
        { key: "main", label: "Main Deck", hint: `at least ${BUNDLE_MIN_MAIN}`, cards: b.main, filter: (c) => !isExtraDeckCard(c) },
        { key: "extra", label: "Extra Deck", hint: "bosses of the bundle", cards: b.extra, filter: (c) => isExtraDeckCard(c) },
      ],
    });
    if (!out || (fresh && !out.main.length && !out.extra.length)) return false;
    b.main = out.main;
    b.extra = out.extra;
    if (!fresh) update();
    return true;
  }
  function editBundle(b) {
    const cardsEl = h("div.draft-bundle-detail");
    const paint = () =>
      clear(cardsEl).append(
        h("div.small.muted", `Main Deck (${b.main.length})`),
        h("div.draft-card-row", stacked(b.main)),
        h("div.small.muted", `Extra Deck (${b.extra.length})`),
        h("div.draft-card-row", stacked(b.extra))
      );
    paint();
    const nameIn = h("input.input", { value: b.name, maxLength: 60, oninput: (e) => { b.name = e.target.value || "Bundle"; update(); } });
    const wrong = misplaced(b);
    const m = openModal({
      title: "Bundle",
      className: "draft-bundle-modal",
      body: [
        h("label.field", h("span", "Name"), nameIn),
        h("div.row", h("label.field", h("span", "Rarity"), raritySelect(b.rarity, (v) => { b.rarity = v; update(); })), h("label.field.grow", h("span", "Tags (for the pack rules)"), tagsInput(b.tags, (t) => { b.tags = t; update(); }))),
        wrong.length ? h("p.draft-issue.bad", icon("error"), `Wrong section: ${wrong.map((c) => getCard(c)?.name).join(", ")}`) : null,
        cardsEl,
      ],
      actions: [
        { label: "Delete", danger: true, onClick: async (close) => { if (await confirmModal("Delete the bundle?", `"${b.name}" will be removed.`, "Delete", "Cancel", { danger: true })) { f.bundles = f.bundles.filter((x) => x !== b); update(); close(); } } },
        { label: "Duplicate", onClick: (close) => { const c = { ...structuredClone(b), id: newId(), name: `${b.name} (copy)` }; f.bundles.splice(f.bundles.indexOf(b) + 1, 0, c); update(); close(); } },
        { label: "Edit cards", onClick: async (close) => { close(); await editCards(b); editBundle(b); } },
        { label: "Done", primary: true, value: true },
      ],
    });
    setTimeout(() => nameIn.select(), 30);
    return m.result;
  }

  // ------------------------------------------------------------ round 2: carte singole
  let singleQuery = "";
  function singlesView() {
    const q = singleQuery.toLowerCase();
    const shown = f.singles.filter((s) => !q || getCard(s.code)?.name.toLowerCase().includes(q) || s.tags.some((t) => t.toLowerCase().includes(q)));
    const search = h("input.input.draft-search", { value: singleQuery, placeholder: "Search cards or tags", oninput: (e) => { singleQuery = e.target.value; const pos = e.target.selectionStart; render(); const el = body.querySelector(".draft-search"); el.focus(); el.setSelectionRange(pos, pos); } });
    return [
      h(
        "div.draft-toolbar",
        h("button.btn.primary", { onclick: editSingles }, icon("library_add"), " Add or move cards"),
        search,
        h("span.muted.small", "One pick = one card. Click a card for its rarity and tags, or drag it onto another rarity.")
      ),
      f.singles.length && !shown.length ? h("p.muted.draft-empty", "No card matches the search.") : null,
      !f.singles.length ? h("p.muted.draft-empty", "No single cards yet: add the generic Extra Deck monsters and the staples of Round 2.") : null,
      ...(f.singles.length ? byRarity(shown).map((g) => rarityGroup(g, "div.draft-singles", singleTile, "Drop a card here")) : []),
    ];
  }
  function singleTile(s) {
    return draggable(h("button.draft-single", { title: getCard(s.code)?.name ?? "", style: `--rc: ${rarityOf(f, s.rarity)?.color ?? "#5b6070"}`, onclick: () => editSingle(s) }, cardFace(s.code), s.tags.length ? h("span.draft-single-tags", s.tags.join(", ")) : null), s);
  }
  // Tutte le singole nella ricerca carte, una parte per rarità: si aggiungono, si tolgono e si spostano di rarità.
  async function editSingles() {
    const groups = [...f.rarities].reverse().map((r) => ({ key: `r_${r.id}`, label: r.name, rarity: r.id }));
    groups.push({ key: "none", label: "No rarity", rarity: null });
    const out = await openCardCollector({
      title: f.name,
      subtitle: "Round 2 cards by rarity · right-click a card to move it to the next rarity",
      noBanlist: true,
      contextNext: true,
      parts: groups.map((g) => ({ key: g.key, label: g.label, cards: f.singles.filter((s) => (rarityOf(f, s.rarity) ? s.rarity : null) === g.rarity).map((s) => s.code) })),
    });
    if (!out) return;
    // Le carte rimaste tengono i loro tag (prima con la stessa rarità, poi con un'altra).
    const old = [...f.singles];
    const take = (code, rarity) => {
      const i = old.findIndex((s) => s.code === code && s.rarity === rarity);
      const j = i >= 0 ? i : old.findIndex((s) => s.code === code);
      return j >= 0 ? old.splice(j, 1)[0] : null;
    };
    f.singles = groups.flatMap((g) => out[g.key].map((code) => {
      const prev = take(code, g.rarity);
      return prev ? { ...prev, rarity: g.rarity } : newSingle(code, g.rarity);
    }));
    update();
  }
  function editSingle(s) {
    openModal({
      title: getCard(s.code)?.name ?? "Card",
      className: "draft-single-modal",
      body: [
        h("div.draft-single-big", cardFace(s.code)),
        h("label.field", h("span", "Rarity"), raritySelect(s.rarity, (v) => { s.rarity = v; update(); })),
        h("label.field", h("span", "Tags (for the pack rules)"), tagsInput(s.tags, (t) => { s.tags = t; update(); })),
      ],
      actions: [
        { label: "Remove", danger: true, onClick: (close) => { f.singles = f.singles.filter((x) => x !== s); update(); close(); } },
        { label: "Done", primary: true, value: true },
      ],
    });
  }

  // ------------------------------------------------------------ rarità
  function raritiesView() {
    const count = (id) => [f.bundles.filter((b) => b.rarity === id).length, f.singles.filter((s) => s.rarity === id).length];
    const none = [f.bundles.filter((b) => !rarityOf(f, b.rarity)).length, f.singles.filter((s) => !rarityOf(f, s.rarity)).length];
    const move = (i, d) => {
      const j = i + d;
      if (j < 0 || j >= f.rarities.length) return;
      [f.rarities[i], f.rarities[j]] = [f.rarities[j], f.rarities[i]];
      update();
    };
    const remove = async (r) => {
      const [nb, ns] = count(r.id);
      let to = null;
      if (nb + ns) {
        const others = f.rarities.filter((x) => x !== r);
        const sel = h("select.select", h("option", { value: "" }, "No rarity"), [...others].reverse().map((x) => h("option", { value: x.id }, x.name)));
        const ok = await openModal({
          title: `Delete "${r.name}"?`,
          body: [h("p", `${nb} bundles and ${ns} cards have this rarity. Give them:`), sel],
          actions: [{ label: "Cancel", value: false }, { label: "Delete", danger: true, onClick: (close) => close(true) }],
        }).result;
        if (!ok) return;
        to = sel.value || null;
      }
      for (const x of [...f.bundles, ...f.singles]) if (x.rarity === r.id) x.rarity = to;
      f.rarities = f.rarities.filter((x) => x !== r);
      update();
    };
    return [
      h(
        "div.draft-toolbar",
        h("button.btn.primary", { onclick: () => { f.rarities.push({ id: newId(), name: `Rarity ${f.rarities.length + 1}`, color: "#7fd1a8" }); update(); } }, icon("add"), " Add rarity"),
        h("span.muted.small", "From the lowest (top) to the highest (bottom). Rarity never changes what a pack contains: it only decides the automatic pick when the timer runs out (the highest rarity in the pack) and the animation when an item is revealed.")
      ),
      h(
        "div.draft-rarities",
        f.rarities.map((r, i) => {
          const [nb, ns] = count(r.id);
          return h(
            "div.draft-rarity",
            { style: `--rc: ${r.color}` },
            h("span.draft-rarity-rank", `${i + 1}`),
            h("input", { type: "color", value: r.color, title: "Color", oninput: (e) => { r.color = e.target.value; changed(); e.target.closest(".draft-rarity").style.setProperty("--rc", r.color); } }),
            h("input.input", { value: r.name, maxLength: 40, onchange: (e) => { r.name = e.target.value.trim() || "Rarity"; update(); } }),
            h("span.muted.small.draft-rarity-count", `${nb} bundles · ${ns} cards`),
            h("button.btn.small.ghost", { title: "Lower", disabled: i === 0, onclick: () => move(i, -1) }, icon("arrow_upward")),
            h("button.btn.small.ghost", { title: "Higher", disabled: i === f.rarities.length - 1, onclick: () => move(i, 1) }, icon("arrow_downward")),
            h("button.btn.small.danger", { title: "Delete", onclick: () => remove(r) }, icon("delete"))
          );
        })
      ),
      none[0] + none[1] ? h("p.muted.small", `${none[0]} bundles and ${none[1]} cards have no rarity: they count as lower than every rarity.`) : null,
    ];
  }

  // ------------------------------------------------------------ regole dei pacchetti
  function rulesView() {
    const tagList = `rule-tags-${newId()}`;
    const itemSelect = (round, value, onchange) => {
      const s = h("select.select", { onchange: () => onchange(s.value) }, h("option", { value: "" }, "Choose…"), roundItems(f, round).map((x) => h("option", { value: x.id }, x.label)));
      s.value = value ?? "";
      return s;
    };
    const ruleRow = (r) => {
      const fields =
        r.kind === "apart"
          ? [itemSelect(r.round, r.a, (v) => { r.a = v; changed(); }), h("span.muted", "and"), itemSelect(r.round, r.b, (v) => { r.b = v; changed(); })]
          : [
              h("input.input.draft-rule-n", { type: "number", min: 0, max: PACK_SIZE, value: r.n, onchange: (e) => { r.n = Math.max(0, Math.min(PACK_SIZE, Math.round(+e.target.value) || 0)); e.target.value = r.n; changed(); } }),
              h("span.muted", "with the tag"),
              h("input.input.draft-rule-tag", { value: r.tag, list: tagList, placeholder: "tag", onchange: (e) => { r.tag = e.target.value.trim(); changed(); } }),
            ];
      const round = h("select.select", { onchange: () => { r.round = +round.value; if (r.kind === "apart") r.a = r.b = ""; update(); } }, h("option", { value: 1 }, "Round 1"), h("option", { value: 2 }, "Round 2"));
      round.value = r.round;
      const kind = h("select.select", { onchange: () => { Object.assign(r, kind.value === "apart" ? { kind: "apart", a: "", b: "" } : { kind: kind.value, tag: r.tag ?? "", n: r.n ?? 1 }); if (r.kind !== "apart") { delete r.a; delete r.b; } else { delete r.tag; delete r.n; } update(); } }, Object.entries(RULE_KINDS).map(([k, v]) => h("option", { value: k }, v)));
      kind.value = r.kind;
      return h("div.draft-rule", round, kind, ...fields, h("button.btn.small.danger", { title: "Delete the rule", onclick: () => { f.rules = f.rules.filter((x) => x !== r); update(); } }, icon("delete")));
    };
    return [
      h(
        "div.draft-toolbar",
        h("button.btn.primary", { onclick: () => { f.rules.push({ id: newId(), round: 1, kind: "atMost", tag: "", n: 1 }); update(); } }, icon("add"), " Add rule"),
        h("span.muted.small", "Optional constraints on every pack, checked when you save: rules that cannot all be met are not accepted. Tags are set on bundles and cards.")
      ),
      h("datalist", { id: tagList }, allTags(f).map((t) => h("option", { value: t }))),
      f.rules.length ? h("div.draft-rules", f.rules.map(ruleRow)) : h("p.muted.draft-empty", "No rules: packs are 15 items drawn at random from the pool of the round."),
    ];
  }

  // ------------------------------------------------------------ pacchetto di prova
  let sampleRound = 1;
  let sample = null;
  function sampleView() {
    const round = h("select.select", { onchange: () => { sampleRound = +round.value; sample = null; render(); } }, h("option", { value: 1 }, "Round 1 · bundles"), h("option", { value: 2 }, "Round 2 · singles"));
    round.value = sampleRound;
    const nameOf = (id) => roundItems(f, sampleRound).find((x) => x.id === id)?.label ?? "?";
    return [
      h(
        "div.draft-toolbar",
        round,
        h("button.btn.primary", { onclick: () => { sample = makePack(f, sampleRound); if (!sample) toast("The pool of this round is empty", { kind: "error" }); render(); } }, icon("casino"), " Open a sample pack"),
        h("span.muted.small", `${PACK_SIZE} items drawn at random with the pack rules, as in the draft.`)
      ),
      sample?.dropped.length ? h("div.draft-issue.warn", icon("warning"), `Rules dropped for this pack: ${sample.dropped.map((r) => ruleText(r, nameOf)).join("; ")}`) : null,
      sample
        ? h(
            "div.draft-sample",
            sample.items
              .slice()
              .sort((a, b) => f.rarities.findIndex((r) => r.id === b.rarity) - f.rarities.findIndex((r) => r.id === a.rarity))
              .map((x) =>
                sampleRound === 1
                  ? h("div.draft-bundle.sample", { style: `--rc: ${rarityOf(f, x.rarity)?.color ?? "#5b6070"}` }, h("div.draft-bundle-head", h("b", x.label), rarityLabel(x.rarity)), h("div.draft-bundle-cards", stacked(x.codes).slice(0, 10)))
                  : h("div.draft-single.sample", { style: `--rc: ${rarityOf(f, x.rarity)?.color ?? "#5b6070"}`, title: x.label }, cardFace(x.codes[0]))
              )
          )
        : null,
    ];
  }

  // ------------------------------------------------------------ pagina
  root.append(
    h(
      "div.page.draft-editor",
      h(
        "div.page-head",
        h("button.btn.ghost.round.page-back", { title: "Back (right-click)", onclick: leave }, icon("chevron_left")),
        nameIn,
        h("span.draft-mode-badge", { title: modeOf(f.mode).full ?? "" }, modeOf(f.mode).name),
        h("span.grow"),
        h("button.btn", { title: "Save as a file to share", onclick: () => download(fileName(f), exportFormat(f), "application/json") }, icon("download"), " Export"),
        saveBtn
      ),
      issuesEl,
      tabsEl,
      body
    )
  );
  changed();
  render();
}

