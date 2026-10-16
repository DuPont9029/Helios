// Combo Trainer: per ogni mazzo si salvano più combo (mano iniziale, passi, interruzioni dell'avversario)
// e le si prova in un duello dove il trainer controlla i passi e l'avversario interrompe dove deciso.
import { h, clear, icon } from "./dom.js";
import { cardFace } from "./card.js";
import { openModal, toast, confirmModal, alertModal } from "./modal.js";
import { getCard, cardName, isExtraDeckCard } from "../data/db.js";
import { settings } from "../data/settings.js";
import { validSleeve } from "../data/sleeve.js";
import { loadDecks, saveDecks, parseRecipe } from "../deck/deck.js";
import { DUEL_MODES } from "../core/constants.js";
import { DuelSession } from "../duel/session.js";
import { ComboTrainer, ComboRecorder, STEP_ACTIONS, NO_CARD, stepText, loadCombos, saveCombos, comboToCode, comboFromCode } from "../duel/trainer.js";
import { DEFAULT_BOOKMARKS } from "../data/default-bookmarks.js";
import { canRecordVideo, startVideo } from "./video-capture.js";

const uid = () => Math.random().toString(36).slice(2, 10);
const byName = (a, b) => cardName(a).localeCompare(cardName(b));
const uniq = (codes) => [...new Set(codes)];

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

  function render() {
    const items = combos();
    clear(list).append(
      ...(items.length
        ? items.map((c) =>
            h(
              "div.combo-row",
              h("div.combo-hand", c.hand.slice(0, 6).map((code) => cardFace(code))),
              h(
                "div.combo-info",
                h("b", c.name),
                h("div.muted.small", `${c.first ? "Going first" : "Going second"} · ${c.hand.length} card${c.hand.length === 1 ? "" : "s"} in hand · ${c.steps.length} step${c.steps.length === 1 ? "" : "s"}${c.interrupts.length ? ` · ${c.interrupts.length} interruption${c.interrupts.length === 1 ? "" : "s"}` : ""}`)
              ),
              h(
                "div.combo-actions",
                h("button.btn.primary", { onclick: () => practice(app, deck(), c) }, icon("play_arrow"), " Practice"),
                h("button.btn", { title: "Copy a code to share this combo", onclick: () => shareCombo(c) }, icon("share"), " Share"),
                h("button.btn", { onclick: () => editCombo(deck(), c).then((v) => v && store(items.map((x) => (x.id === v.id ? v : x)))) }, icon("edit"), " Edit"),
                h("button.btn.danger", {
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
        "Write the steps of a combo, then practice it: the trainer checks each step and warns you when you do something else. " +
          "Interruptions: after the chosen step the opponent uses that card (it starts in their hand) at the first chance; then it's free play."
      ),
      list
    )
  );
  render();
  // Fine registrazione: si apre l'editor con i passi registrati (si possono rivedere e aggiungere interruzioni).
  if (review) {
    deckSel.value = review.deckId;
    render();
    editCombo(deck(), review.combo).then((v) => v && store([...combos(), v]));
  }
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

/**
 * Carte proposte come interruzioni (stanno in mano all'avversario, quindi niente Extra Deck): mostri e
 * trappole dei preferiti predefiniti e i preferiti del giocatore. Ash Blossom per prima, se c'è.
 */
const ASH = 14558127;
function interruptCandidates() {
  const { deck } = parseRecipe(DEFAULT_BOOKMARKS);
  const list = uniq([...deck.main, ...(settings.bookmarks ?? [])]).filter((c) => getCard(c) && !isExtraDeckCard(getCard(c))).sort(byName);
  return list.includes(ASH) ? [ASH, ...list.filter((c) => c !== ASH)] : list;
}

/**
 * Editor di una combo; restituisce la combo salvata o null.
 * setup: solo nome, turno e mano iniziale, per iniziare una registrazione.
 */
function editCombo(deck, combo, { setup = false } = {}) {
  const c = combo ? structuredClone(combo) : { id: uid(), name: "New combo", first: true, hand: [], steps: [], interrupts: [] };
  const name = h("input.input", { value: c.name, maxLength: 60 });
  const first = h("select.select", h("option", { value: "1" }, "Going first"), h("option", { value: "0" }, "Going second"));
  first.value = c.first ? "1" : "0";
  const mainCards = uniq(deck.main).sort(byName);
  const deckCards = uniq([...deck.main, ...deck.extra]).sort(byName);
  const handEl = h("div.combo-hand-pick");
  const poolEl = h("div.combo-pool");
  const stepsEl = h("ol.combo-steps-edit");
  const intsEl = h("div.combo-ints-edit");
  const copies = (code) => deck.main.filter((x) => x === code).length;

  const cardOptions = (codes, value) => {
    const sel = h("select.select", codes.map((code) => h("option", { value: code }, cardName(code))));
    if (value) sel.value = String(value);
    return sel;
  };

  function renderHand() {
    clear(handEl).append(
      ...(c.hand.length ? c.hand.map((code, i) => h("button.combo-card.chosen", { title: "Remove from the hand", onclick: () => { c.hand.splice(i, 1); renderHand(); } }, cardFace(code))) : [h("span.muted.small", "Click the cards below to add them to the starting hand.")])
    );
    clear(poolEl).append(
      ...mainCards.map((code) => {
        const left = copies(code) - c.hand.filter((x) => x === code).length;
        return h(`button.combo-card${left <= 0 ? ".used" : ""}`, { title: cardName(code), disabled: left <= 0, onclick: () => { if (c.hand.length < 10) { c.hand.push(code); renderHand(); } } }, cardFace(code));
      })
    );
  }

  // Le interruzioni restano agganciate al passo dopo cui erano (after = quanti passi prima di loro).
  function insertStep(at) {
    c.steps.splice(at, 0, { kind: "activate", code: deckCards[0] });
    c.interrupts.forEach((x) => { if (x.after > at) x.after++; });
    renderSteps();
  }
  function removeStep(at) {
    c.steps.splice(at, 1);
    c.interrupts.forEach((x) => { if (x.after > at) x.after--; });
    renderSteps();
  }

  function renderSteps() {
    clear(stepsEl).append(
      ...c.steps.map((s, i) => {
        const act = h("select.select", Object.entries(STEP_ACTIONS).map(([k, l]) => h("option", { value: k }, l)));
        act.value = s.kind;
        const card = cardOptions(deckCards, s.code);
        card.addEventListener("change", () => (s.code = +card.value));
        // End Phase: nessuna carta da scegliere.
        const syncCard = () => (card.style.visibility = NO_CARD.has(s.kind) ? "hidden" : "");
        act.addEventListener("change", () => {
          s.kind = act.value;
          if (!NO_CARD.has(s.kind) && !s.code) s.code = +card.value;
          syncCard();
          renderInts();
        });
        syncCard();
        const move = (d) => () => {
          const j = i + d;
          if (j < 0 || j >= c.steps.length) return;
          [c.steps[i], c.steps[j]] = [c.steps[j], c.steps[i]];
          renderSteps();
        };
        // ⋮: aggiunge un passo subito sopra o subito sotto questo, senza doverlo spostare dal fondo.
        const more = h("button.btn.small.ghost.step-more", { title: "Add a step above or below", onclick: (e) => { e.stopPropagation(); toggleMenu(); } }, icon("more_vert"));
        const menu = h(
          "div.step-menu",
          { hidden: true },
          h("button", { onclick: () => insertStep(i) }, icon("vertical_align_top"), " Add step above"),
          h("button", { onclick: () => insertStep(i + 1) }, icon("vertical_align_bottom"), " Add step below")
        );
        const toggleMenu = () => {
          const open = menu.hidden;
          stepsEl.querySelectorAll(".step-menu").forEach((x) => (x.hidden = true));
          menu.hidden = !open;
        };
        return h(
          "li.combo-step-row",
          act,
          card,
          h("button.btn.small.ghost", { title: "Move up", onclick: move(-1) }, icon("arrow_upward")),
          h("button.btn.small.ghost", { title: "Move down", onclick: move(1) }, icon("arrow_downward")),
          h("button.btn.small.ghost", { title: "Remove", onclick: () => removeStep(i) }, icon("close")),
          more,
          menu
        );
      })
    );
    renderInts();
  }

  function renderInts() {
    const candidates = interruptCandidates();
    clear(intsEl).append(
      ...c.interrupts.map((it, i) => {
        const after = h("select.select", h("option", { value: 0 }, "From the start"), c.steps.map((s, j) => h("option", { value: j + 1 }, `After step ${j + 1}: ${stepText(s)}`)));
        after.value = String(Math.min(it.after, c.steps.length));
        after.addEventListener("change", () => (it.after = +after.value));
        const card = cardOptions(uniq([it.code, ...candidates]).filter(Boolean), it.code);
        card.addEventListener("change", () => (it.code = +card.value));
        return h("div.combo-int-row", h("span", "⚡"), after, h("span.muted", "the opponent uses"), card, h("button.btn.small.ghost", { title: "Remove", onclick: () => { c.interrupts.splice(i, 1); renderInts(); } }, icon("close")));
      })
    );
  }

  renderHand();
  renderSteps();
  const m = openModal({
    title: setup ? "Record a combo" : combo?.id && !combo.recorded ? "Edit combo" : "New combo",
    className: "wide combo-editor",
    body: [
      h("div.form-grid", h("label.field", h("span", "Name"), name), h("label.field", h("span", "Turn"), first)),
      h("h3.combo-sec", "Starting hand"),
      handEl,
      poolEl,
      ...(setup ? [h("p.muted.small", "Then you play the combo: every action you choose (Summons, Sets, activations, End Phase) is recorded as a step.")] : []),
      ...(setup ? [] : [h("h3.combo-sec", "Steps"),
      stepsEl,
      h("button.btn.small", { onclick: () => { c.steps.push({ kind: "activate", code: deckCards[0] }); renderSteps(); } }, icon("add"), " Add step"),
      h("h3.combo-sec", "Interruptions"),
      h("p.muted.small", "The card starts in the opponent's hand: use hand traps (or traps that can be activated from the hand, like Infinite Impermanence)."),
      intsEl,
      h("button.btn.small", { onclick: () => { c.interrupts.push({ after: Math.min(1, c.steps.length), code: interruptCandidates()[0] }); renderInts(); } }, icon("bolt"), " Add interruption")]),
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
          close(c);
        },
      },
    ],
  });
  // Clic fuori dal menu ⋮: si chiude.
  m.el.addEventListener("click", (e) => {
    if (!e.target.closest(".step-menu, .step-more")) stepsEl.querySelectorAll(".step-menu").forEach((x) => (x.hidden = true));
  });
  return m.result.then((v) => v ?? null);
}

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

/** Avvia l'allenamento: la mano della combo, l'avversario con le carte di interruzione in mano. */
function practice(app, deck, combo) {
  const trainer = new ComboTrainer(combo, {
    notify: (text, kind) => toast(text, { kind: kind === "error" ? "error" : "ok", ms: 3200 }),
    onRestart: () => practice(app, deck, combo),
  });
  startDuel(app, deck, combo, trainer, `Practice: ${combo.name}`);
}

/** Duello per il Combo Trainer: controller = ComboTrainer o ComboRecorder. */
function startDuel(app, deck, combo, controller, title) {
  const me = combo.first ? 0 : 1;
  const opp = 1 - me;
  const decks = [];
  decks[me] = { main: deck.main, extra: deck.extra };
  decks[opp] = { main: combo.interrupts.map((it) => it.code), extra: [] };
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
    trainer: controller,
    duel: {
      flags: String(DUEL_MODES.MR5.flags),
      seed: [...crypto.getRandomValues(new BigUint64Array(4))].map((x) => String(x || 1n)),
      lp: 8000,
      hand: 5,
      draw: 1,
      decks,
      shuffle: pair(true, false),
      top: pair(combo.hand, null),
      handSize: pair(combo.hand.length, decks[opp].main.length),
      noTurnDraw: pair(false, true),
    },
    onExit: () => showComboTrainer(app),
  });
  app.current = session;
  // Sottotitoli sul campo per ogni passo (anche nei video) e pulsante per registrare il video.
  controller.caption = (text, kind) => session.view.caption(text, kind);
  const video = videoButton(session, combo.name);
  if (video) controller.btns?.prepend(video);
  session.start(clear(app.root));
  toast(title);
}

/**
 * "⏺ Video": registra il duello (il browser chiede di condividere la scheda), con i passi come sottotitoli.
 * Fermandolo (o uscendo dal duello) si apre l'anteprima con Download e Share.
 */
function videoButton(session, name) {
  if (!canRecordVideo()) return null;
  let cap = null;
  let started = 0;
  let tick = null;
  const btn = h("button.btn.small.ghost.video-btn", { title: "Record a video of the combo, with the steps as subtitles" });
  const paint = () => {
    btn.classList.toggle("rec", !!cap);
    if (!cap) return (btn.textContent = "⏺ Video");
    const s = Math.floor((Date.now() - started) / 1000);
    btn.textContent = `■ Stop ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const finish = async (c) => {
    if (cap !== c) return;
    cap = null;
    clearInterval(tick);
    paint();
    const { blob, ext } = await c.stop();
    if (blob.size) showVideo(blob, ext, name);
  };
  btn.onclick = async () => {
    if (cap) return finish(cap);
    try {
      const c = await startVideo(session.view.el);
      cap = c;
      started = Date.now();
      tick = setInterval(paint, 500);
      paint();
      session.view.caption(`🎬 ${name}`, "done");
      c.done.then(() => finish(c)); // condivisione interrotta dal browser
    } catch (e) {
      // NotAllowedError: l'utente ha annullato. NotReadableError: manca il permesso di sistema (es. macOS).
      if (e?.name === "NotReadableError") {
        alertModal("Video recording", "The browser could not capture the screen. On macOS allow it in System Settings → Privacy & Security → Screen & System Audio Recording (enable your browser), then restart the browser.");
      } else if (e?.name !== "NotAllowedError") toast(e.message || "Unable to record the video", { kind: "error" });
    }
  };
  // Uscendo dal duello la registrazione si chiude e si mostra il video.
  const destroy = session.destroy.bind(session);
  session.destroy = (...args) => {
    if (cap) finish(cap);
    return destroy(...args);
  };
  paint();
  return btn;
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

