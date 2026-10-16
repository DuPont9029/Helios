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
import { ComboTrainer, STEP_ACTIONS, stepText, loadCombos, saveCombos } from "../duel/trainer.js";
import { DEFAULT_BOOKMARKS } from "../data/default-bookmarks.js";

const uid = () => Math.random().toString(36).slice(2, 10);
const byName = (a, b) => cardName(a).localeCompare(cardName(b));
const uniq = (codes) => [...new Set(codes)];

export function showComboTrainer(app) {
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
        h("button.btn.primary", { onclick: () => editCombo(deck(), null).then((v) => v && store([...combos(), v])) }, icon("add"), " New combo")
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

/** Editor di una combo; restituisce la combo salvata o null. */
function editCombo(deck, combo) {
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

  function renderSteps() {
    clear(stepsEl).append(
      ...c.steps.map((s, i) => {
        const act = h("select.select", Object.entries(STEP_ACTIONS).map(([k, l]) => h("option", { value: k }, l)));
        act.value = s.kind;
        act.addEventListener("change", () => (s.kind = act.value));
        const card = cardOptions(deckCards, s.code);
        card.addEventListener("change", () => (s.code = +card.value));
        const move = (d) => () => {
          const j = i + d;
          if (j < 0 || j >= c.steps.length) return;
          [c.steps[i], c.steps[j]] = [c.steps[j], c.steps[i]];
          renderSteps();
        };
        return h(
          "li.combo-step-row",
          act,
          card,
          h("button.btn.small.ghost", { title: "Move up", onclick: move(-1) }, icon("arrow_upward")),
          h("button.btn.small.ghost", { title: "Move down", onclick: move(1) }, icon("arrow_downward")),
          h("button.btn.small.ghost", { title: "Remove", onclick: () => { c.steps.splice(i, 1); c.interrupts.forEach((x) => (x.after = Math.min(x.after, c.steps.length))); renderSteps(); } }, icon("close"))
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
    title: combo ? "Edit combo" : "New combo",
    className: "wide combo-editor",
    body: [
      h("div.form-grid", h("label.field", h("span", "Name"), name), h("label.field", h("span", "Turn"), first)),
      h("h3.combo-sec", "Starting hand"),
      handEl,
      poolEl,
      h("h3.combo-sec", "Steps"),
      stepsEl,
      h("button.btn.small", { onclick: () => { c.steps.push({ kind: "activate", code: deckCards[0] }); renderSteps(); } }, icon("add"), " Add step"),
      h("h3.combo-sec", "Interruptions"),
      h("p.muted.small", "The card starts in the opponent's hand: use hand traps (or traps that can be activated from the hand, like Infinite Impermanence)."),
      intsEl,
      h("button.btn.small", { onclick: () => { c.interrupts.push({ after: Math.min(1, c.steps.length), code: interruptCandidates()[0] }); renderInts(); } }, icon("bolt"), " Add interruption"),
    ],
    actions: [
      { label: "Cancel", value: null },
      {
        label: "Save",
        primary: true,
        onClick: (close) => {
          c.name = name.value.trim() || "Combo";
          c.first = first.value === "1";
          if (!c.hand.length) return alertModal("Starting hand", "Add at least one card to the starting hand.");
          if (!c.steps.length) return alertModal("Steps", "Add at least one step.");
          close(c);
        },
      },
    ],
  });
  return m.result.then((v) => v ?? null);
}

/** Avvia l'allenamento: la mano della combo, l'avversario con le carte di interruzione in mano. */
function practice(app, deck, combo) {
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
  const trainer = new ComboTrainer(combo, {
    notify: (text, kind) => toast(text, { kind: kind === "error" ? "error" : "ok", ms: 3200 }),
    onRestart: () => practice(app, deck, combo),
  });
  app.current?.destroy?.();
  const session = new DuelSession({
    controllers,
    me,
    names,
    reveal: false,
    timer: "off",
    sleeves: pair(validSleeve(settings.sleeve), null),
    trainer,
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
  session.start(clear(app.root));
  toast(`Practice: ${combo.name}`);
}

