// Schermate di avvio partita: contro CPU, prova in solitario, online P2P.
import { h, clear, icon } from "./dom.js";
import { openModal, toast, alertModal, confirmModal, promptModal } from "./modal.js";
import { db } from "../data/db.js";
import { settings } from "../data/settings.js";
import { loadDecks, validateDeck, banlistByName } from "../deck/deck.js";
import { DUEL_MODES } from "../core/constants.js";
import { DuelSession } from "../duel/session.js";
import { TIMER_PRESETS } from "../duel/clock.js";
import { MAX_BEST_OF, clampBestOf, newSeries } from "../duel/series.js";
import { validSleeve } from "../data/sleeve.js";
import { pendulumIcons } from "../data/pendulum.js";
import { openSideEditor } from "./editor.js";
import { connectViaServer, createInvite, acceptInvite, completeInvite, waitOpen, signalingAvailable, resolveIceServers } from "../net/signaling.js";
import { connectViaNostr, isNostrCode } from "../net/nostr-room.js";
import { LinkMux, negotiate } from "../net/match.js";
import { findMatch, watchSeeks, queueOf, MM_PROTO } from "../net/matchmaking.js";
import { leaderboard, republishOutbox, START_RATING } from "../net/elo.js";
import { identity, shortKey, npubOf, pubkeyFrom } from "../net/identity.js";
import { relayStatus, socialState, presenceOf, addFriend, acceptRequest, declineRequest, removeFriend, renameFriend, rememberOpponent, onSocialChange, sendInvite, cancelInvite, onInviteReply, syncProfile, INVITE_SECONDS } from "../net/social.js";
import { unpackSignal } from "../net/peer.js";
import { watchFriend, reportsBox } from "./coaching.js";
import { clipboardWatchable, copyText, watchClipboard } from "../net/clipboard.js";
import "../styles/play.css";

// Codice di una stanza online: 6 caratteri (server di segnalazione) o 8 (Nostr), senza 0/O e 1/I.
const ROOM_CODE = /^(?:[A-HJ-NP-Z2-9]{6}|[A-HJ-NP-Z2-9]{8})$/;

// ---------------------------------------------------------------- componenti comuni

function deckSelect(decks, selectedId) {
  const sel = h("select.select", decks.map((d) => h("option", { value: d.id }, `${d.name} (${d.main.length}/${d.extra.length})`)));
  if (selectedId && decks.some((d) => d.id === selectedId)) sel.value = selectedId;
  return sel;
}

// Preset delle impostazioni di gioco: quelli già pronti (formati comuni) e quelli salvati dal giocatore
// (settings.gamePresets). La banlist si cerca per nome, così il preset vale anche con le liste nuove.
const banlistLike = (re) => db.banlists.find((b) => re.test(b.name))?.name ?? "";
const BUILTIN_PRESETS = [
  ["Standard TCG", () => ({ mode: "MR5", banlist: banlistLike(/TCG/), lp: 8000, hand: 5, draw: 1, bestOf: 1 })],
  ["TCG match (best of 3)", () => ({ mode: "MR5", banlist: banlistLike(/TCG/), lp: 8000, hand: 5, draw: 1, bestOf: 3, timer: "omega" })],
  ["Standard OCG", () => ({ mode: "MR5", banlist: banlistLike(/OCG/), lp: 8000, hand: 5, draw: 1, bestOf: 1 })],
  ["GOAT format", () => ({ mode: "GOAT", banlist: banlistLike(/GOAT/), lp: 8000, hand: 5, draw: 1, bestOf: 1 })],
  ["Genesys (100 points)", () => ({ mode: "MR5", banlist: banlistLike(/^Genesys$/), pointCap: 100, lp: 8000, hand: 5, draw: 1, bestOf: 1 })],
  ["Speed Duel", () => ({ mode: "SPEED", banlist: banlistLike(/Speed/), lp: 4000, hand: 4, draw: 1, bestOf: 1 })],
  ["No banlist", () => ({ mode: "MR5", banlist: "", lp: 8000, hand: 5, draw: 1, bestOf: 1 })],
];
const userPresets = () => (Array.isArray(settings.gamePresets) ? settings.gamePresets.filter((p) => p?.name && p.values) : []);

function optionsForm({ host = true } = {}) {
  const mode = h("select.select", Object.entries(DUEL_MODES).map(([k, m]) => h("option", { value: k }, m.label)));
  const banlist = h("select.select", h("option", { value: "" }, "No banlist"), db.banlists.map((b) => h("option", { value: b.name }, b.name)));
  banlist.value = settings.lastBanlist ?? db.banlists[0]?.name ?? "";
  const lp = h("input.input", { type: "number", value: 8000, min: 1, max: 999999, step: 500 });
  const hand = h("input.input", { type: "number", value: 5, min: 0, max: 20 });
  const draw = h("input.input", { type: "number", value: 1, min: 0, max: 10 });
  const unofficial = h("input", { type: "checkbox" });
  const timer = h("select.select", Object.entries(TIMER_PRESETS).map(([k, t]) => h("option", { value: k }, t ? t.label : "Off")));
  // Partita al meglio di 3 o 5 duelli (online la sceglie l'host).
  // Partita al meglio di N duelli (N a scelta; 1 = duello singolo). Con N > 1 tra i duelli si fa il side deck.
  const bestOf = h("input.input", { type: "number", min: 1, max: MAX_BEST_OF, step: 2, value: clampBestOf(settings.lastBestOf ?? 1), title: "Best of N Duels, N odd (1 = single Duel). With more than 1, you side deck between the Duels." });
  // Solo numeri dispari: un valore pari scritto a mano diventa il dispari successivo.
  bestOf.addEventListener("change", () => (bestOf.value = clampBestOf(bestOf.value)));
  timer.value = settings.lastTimer in TIMER_PRESETS ? settings.lastTimer : "omega";
  // Genesys: tetto dei punti del mazzo (100 di norma, chi organizza può sceglierne un altro).
  const pointCap = h("input.input", { type: "number", min: 0, max: 10000, step: 5, value: settings.lastPointCap ?? 100, title: "Maximum total points of the Main, Extra and Side Deck" });
  const capField = h("label.field", h("span", "Point cap"), pointCap);
  const pointsList = () => !!banlistByName(banlist.value)?.points;
  const drawCap = () => (capField.hidden = !pointsList());
  banlist.addEventListener("change", drawCap);
  const capValue = () => Math.max(0, Math.min(10000, Math.round(+pointCap.value) || 0));

  const values = () => ({ mode: mode.value, banlist: banlist.value, lp: +lp.value, hand: +hand.value, draw: +draw.value, timer: timer.value, bestOf: clampBestOf(bestOf.value), unofficial: unofficial.checked, ...(pointsList() ? { pointCap: capValue() } : {}) });
  const apply = (v) => {
    if (v.mode in DUEL_MODES) mode.value = v.mode;
    if (v.banlist === "" || db.banlists.some((b) => b.name === v.banlist)) banlist.value = v.banlist;
    if (v.lp) lp.value = v.lp;
    if (v.hand != null) hand.value = v.hand;
    if (v.draw != null) draw.value = v.draw;
    if (v.timer in TIMER_PRESETS) timer.value = v.timer;
    if (v.bestOf) bestOf.value = clampBestOf(v.bestOf);
    unofficial.checked = !!v.unofficial;
    if (Number.isInteger(v.pointCap)) pointCap.value = v.pointCap;
    drawCap();
  };
  const preset = h("select.select");
  const delPreset = h("button.btn.small.ghost", { title: "Delete this saved preset" }, icon("delete"));
  const drawPresets = (value = "") => {
    clear(preset).append(
      h("option", { value: "" }, "Custom"),
      h("optgroup", { label: "Formats" }, BUILTIN_PRESETS.map(([name], i) => h("option", { value: `b${i}` }, name))),
      userPresets().length ? h("optgroup", { label: "Your presets" }, userPresets().map((p, i) => h("option", { value: `u${i}` }, p.name))) : null
    );
    preset.value = value;
    delPreset.hidden = !preset.value.startsWith("u");
  };
  preset.addEventListener("change", () => {
    const k = preset.value;
    if (k.startsWith("b")) apply(BUILTIN_PRESETS[+k.slice(1)][1]());
    if (k.startsWith("u")) apply(userPresets()[+k.slice(1)].values);
    delPreset.hidden = !k.startsWith("u");
    settings.lastPreset = k.startsWith("u") ? userPresets()[+k.slice(1)].name : k;
  });
  // Un campo cambiato a mano: non è più il preset scelto.
  for (const x of [mode, banlist, lp, hand, draw, timer, bestOf, unofficial, pointCap]) x.addEventListener("change", () => { drawPresets(""); settings.lastPreset = ""; });
  const savePreset = h("button.btn.small.ghost", {
    title: "Save these settings as a preset",
    onclick: async () => {
      const name = (await promptModal("Save preset", "Preset name", ""))?.trim().slice(0, 40);
      if (!name) return;
      const list = userPresets().filter((p) => p.name !== name);
      settings.gamePresets = [...list, { name, values: values() }];
      settings.lastPreset = name;
      drawPresets(`u${settings.gamePresets.length - 1}`);
      toast(`Preset saved: "${name}"`);
    },
  }, icon("save"), " Save preset");
  delPreset.addEventListener("click", async () => {
    const p = userPresets()[+preset.value.slice(1)];
    if (!p || !(await confirmModal("Delete preset", `Delete the preset "${p.name}"?`, "Delete", "Cancel", { danger: true }))) return;
    settings.gamePresets = userPresets().filter((x) => x !== p);
    settings.lastPreset = "";
    drawPresets("");
  });
  // Si riparte dall'ultimo preset scelto (se esiste ancora).
  const last = settings.lastPreset ?? "";
  const lastUser = userPresets().findIndex((p) => p.name === last);
  const start = lastUser >= 0 ? `u${lastUser}` : /^b\d+$/.test(last) && BUILTIN_PRESETS[+last.slice(1)] ? last : "";
  drawPresets(start);
  if (start.startsWith("u")) apply(userPresets()[lastUser].values);
  else if (start) apply(BUILTIN_PRESETS[+start.slice(1)][1]());

  const el = h(
    "div.form-grid",
    h("div.field.preset-row", h("span", "Preset"), h("div.preset-tools", preset, savePreset, delPreset)),
    h("label.field", h("span", "Rules"), mode),
    h("label.field", h("span", "Banlist"), banlist),
    capField,
    h("label.field", h("span", "Life Points"), lp),
    h("label.field", h("span", "Starting hand"), hand),
    h("label.field", h("span", "Draws per turn"), draw),
    h("label.field", h("span", "Timer"), timer),
    h("label.field", h("span", "Match: best of"), bestOf),
    h("label.check", unofficial, "Allow unofficial cards (anime/custom)")
  );
  if (!host) el.hidden = true;
  drawCap();
  return {
    el,
    /** Imposta le regole (es. quelle di chi sta cercando un duello nel matchmaking). */
    set(v) {
      apply(v);
      drawPresets("");
    },
    read() {
      settings.lastBanlist = banlist.value;
      settings.lastTimer = timer.value;
      settings.lastBestOf = clampBestOf(bestOf.value);
      if (pointsList()) settings.lastPointCap = capValue();
      return {
        bestOf: clampBestOf(bestOf.value),
        mode: mode.value,
        flags: String(DUEL_MODES[mode.value].flags),
        banlist: banlist.value || null,
        lp: Math.max(1, +lp.value || 8000),
        hand: Math.max(0, +hand.value || 0),
        draw: Math.max(0, +draw.value || 0),
        allowUnofficial: unofficial.checked,
        timer: timer.value,
        ...(pointsList() ? { pointCap: capValue() } : {}),
      };
    },
  };
}

function checkDeck(deck, options) {
  const errors = validateDeck(deck, options.banlist ? banlistByName(options.banlist) : null, { allowUnofficial: options.allowUnofficial, pointCap: options.pointCap });
  if (errors.length) {
    alertModal("Invalid Deck", errors.slice(0, 10).join("\n"));
    return false;
  }
  return true;
}

function startSession(app, cfg) {
  const container = clear(app.root);
  const session = new DuelSession({ onExit: () => app.home(), ...cfg });
  app.current = session;
  session.start(container);
}

const randSeed = () => [...crypto.getRandomValues(new BigUint64Array(4))].map((x) => String(x || 1n));

// ---------------------------------------------------------------- contro CPU / solitario

/** Duello di prova: chiede chi inizia. true = giocatore 1, false = giocatore 2, null = annullato. */
function askFirst(a, b) {
  return openModal({
    title: "Who goes first?",
    body: [h("p", `Player 1: ${a.name}\nPlayer 2: ${b.name}`)],
    actions: [
      { label: "Cancel", value: null },
      { label: "Player 2 goes first", value: false },
      { label: "Player 1 goes first", value: true, primary: true },
    ],
  }).result.then((v) => (v === undefined ? null : v));
}

export function showLocalSetup(app, { vsCpu }) {
  const decks = loadDecks();
  if (!decks.length) return alertModal("No Decks", "Create a Deck in the Deck Editor.");
  const mine = deckSelect(decks, settings.lastDeck);
  const other = deckSelect(decks, decks[1]?.id);
  const opts = optionsForm();
  const first = h("select.select", h("option", { value: "coin" }, "Coin toss"), h("option", { value: "me" }, "I go first"), h("option", { value: "other" }, "Opponent goes first"));
  // Solo contro la CPU: si può pescare nell'ordine del mazzo (per provare una mano precisa). Online si mescola sempre.
  const draws = h("select.select",
    h("option", { value: "random" }, "Shuffled (random draws)"),
    h("option", { value: "ordered" }, "In Deck order (first card = first draw)"));
  draws.value = settings.lastDrawOrder === "ordered" ? "ordered" : "random";
  // Duello di prova: ordine di pesca per entrambi i giocatori e giocatore 2 senza mazzo (passa sempre).
  const testDraws = h("select.select",
    h("option", { value: "random" }, "Shuffled"),
    h("option", { value: "ordered" }, "In Deck order (first card = first draw)"));
  testDraws.value = settings.testDrawOrder === "ordered" ? "ordered" : "random";
  const opponent = h("select.select",
    h("option", { value: "deck" }, "With a Deck"),
    h("option", { value: "none" }, "No Deck (always passes)"));
  opponent.value = settings.testOpponent === "none" ? "none" : "deck";
  const otherField = h("label.field", h("span", vsCpu ? "CPU Deck" : "Player 2 Deck"), other);
  const syncOpponent = () => (otherField.hidden = !vsCpu && opponent.value === "none");
  opponent.addEventListener("change", syncOpponent);
  syncOpponent();
  openModal({
    title: vsCpu ? "Vs CPU" : "Test Duel (you control both players)",
    className: "wide",
    body: [
      // Nel duello di prova chi inizia si sceglie sempre all'avvio (vedi askFirst).
      h("div.form-grid",
        h("label.field", h("span", vsCpu ? "Your Deck" : "Player 1 Deck"), mine),
        !vsCpu && h("label.field", h("span", "Player 2"), opponent),
        otherField,
        vsCpu && h("label.field", h("span", "Who goes first"), first),
        vsCpu && h("label.field", h("span", "Your draws"), draws),
        !vsCpu && h("label.field", h("span", "Draws (both players)"), testDraws)),
      opts.el,
      vsCpu && h("p.muted.small", "The CPU is a simple AI: it plays legal moves but is not a real challenge. Useful for testing Decks."),
    ],
    actions: [
      { label: "Cancel", value: null },
      {
        label: "Start Duel",
        primary: true,
        onClick: async (close) => {
          const options = opts.read();
          let a = decks.find((d) => d.id === mine.value);
          const noDeck = !vsCpu && opponent.value === "none";
          let b = noDeck ? { name: "No Deck", main: [], extra: [], side: [] } : decks.find((d) => d.id === other.value);
          const savedA = a;
          const savedB = b;
          if (!checkDeck(a, options)) return;
          if (!vsCpu && !noDeck && !checkDeck(b, options)) return;
          settings.lastDeck = a.id;
          let meFirst;
          if (vsCpu) meFirst = first.value === "coin" ? Math.random() < 0.5 : first.value === "me";
          else {
            meFirst = await askFirst(a, b);
            if (meFirst == null) return; // annullato: resta aperta la configurazione
          }
          // Partita al meglio di N: punteggio condiviso tra i duelli (giocatore 1 / umano = "me").
          let series = newSeries(options.bestOf);
          // Avvio del duello; il duello di prova si può rigiocare con gli stessi mazzi (rivincita).
          const launch = (meFirst) => {
            const decksByTurn = meFirst ? [a, b] : [b, a];
            const me = meFirst ? 0 : 1;
            const names = [];
            names[me] = settings.name;
            names[1 - me] = vsCpu ? "CPU" : "Player 2";
            const controllers = [];
            controllers[me] = "local";
            controllers[1 - me] = vsCpu ? "ai" : noDeck ? "pass" : "local";
            toast(meFirst ? "You go first!" : `${names[1 - me]} goes first`);
            // Mazzo in ordine solo per il giocatore contro la CPU; il mazzo della CPU è sempre mescolato.
            if (vsCpu) settings.lastDrawOrder = draws.value;
            const shuffle = [true, true];
            if (vsCpu && draws.value === "ordered") shuffle[me] = false;
            if (!vsCpu) {
              settings.testDrawOrder = testDraws.value;
              settings.testOpponent = opponent.value;
              if (testDraws.value === "ordered") shuffle.fill(false);
            }
            // Senza mazzo il giocatore 2 non pesca mai (un mazzo vuoto altrimenti farebbe perdere il duello).
            const noDraw = [false, false];
            if (noDeck) noDraw[1 - me] = true;
            const sleeves = [null, null];
            sleeves[me] = validSleeve(settings.sleeve);
            const pendulums = [null, null];
            pendulums[me] = pendulumIcons();
            startSession(app, {
              onExit: () => app.home("training"),
              // Tra i duelli della partita si apre il Side Deck (se c'è almeno un mazzo con carte nel Side).
              sideDeck: series.bestOf > 1,
              controllers, me, names, reveal: !vsCpu, timer: options.timer, sleeves, pendulums,
              match: series,
              // Duello successivo della partita: si fa il side deck, poi inizia chi ha perso (pareggio: stesso ordine).
              onNextGame: async (old) => {
                const p1 = old.cfg.me;
                const next = old.winner === p1 ? false : old.winner === 1 - p1 ? true : meFirst;
                const side = { banlist: options.banlist, allowUnofficial: options.allowUnofficial, pointCap: options.pointCap, game: series.game };
                // Formato con side deck: la schermata si apre sempre, anche con il Side Deck vuoto.
                // Dal side deck ci si può arrendere: la partita finisce (nel Test Duel perde chi si arrende).
                const sa = await openSideEditor(a, { ...side, who: vsCpu ? "" : "Player 1" });
                if (sa.surrendered) return old.concludeMatch({ won: false, why: vsCpu ? "You surrendered the match" : "Player 1 surrendered the match" });
                a = sa;
                if (!vsCpu && !noDeck) {
                  const sb = await openSideEditor(b, { ...side, who: "Player 2" });
                  if (sb.surrendered) return old.concludeMatch({ won: true, why: "Player 2 surrendered the match" });
                  b = sb;
                }
                old.destroy();
                launch(next);
              },
              // Test Duel: "Rematch" a fine duello (o a fine partita), chiedendo di nuovo chi inizia.
              onLocalRematch: vsCpu ? null : async (old) => {
                const again = await askFirst(a, b);
                if (again == null) return;
                series = newSeries(options.bestOf);
                // Partita nuova: si torna ai mazzi salvati (senza i cambi del side deck).
                a = savedA;
                b = savedB;
                old.destroy();
                launch(again);
              },
              duel: {
                flags: options.flags, seed: randSeed(), lp: options.lp, hand: options.hand, draw: options.draw,
                decks: decksByTurn.map((d) => ({ main: d.main, extra: d.extra })), shuffle, noDraw,
              },
            });
          };
          close();
          launch(meFirst);
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- online

/** Vinto il lancio della moneta: si sceglie se iniziare. Perso: una finestra spiega che sceglie l'avversario. */
function coinToss(state) {
  return (won) => {
    if (!won) {
      state.lost = openModal({
        title: "You lost the coin flip",
        className: "coin-lost",
        dismissable: false,
        body: [h("p", "Your opponent won the coin toss and is choosing whether to go first or second..."), h("div.coin-wait", h("span.spinner"))],
      });
      return Promise.resolve(null);
    }
    return openModal({
      title: "You won the coin toss!",
      dismissable: false,
      body: [h("p", "Do you want to go first or second?")],
      actions: [{ label: "Go second", value: false }, { label: "Go first", value: true, primary: true }],
    }).result;
  };
}

/**
 * Accordo sul duello (seed commit-reveal, lancio della moneta) e avvio della sessione sul collegamento già aperto.
 * Usata sia per il primo duello sia per le rivincite (stesso mux, partita successiva).
 */
async function playMatch(app, match, old = null) {
  const toss = {};
  // Rivincita: chi ha perso inizia per primo, senza lancio della moneta (pareggio: si lancia la moneta).
  const prev = old && (old.winner === 0 || old.winner === 1) ? old.winner : null;
  const iFirst = prev == null ? null : prev !== old.cfg.me;
  // Duello successivo di una partita al meglio di N: prima il side deck (l'avversario aspetta il nostro "hello").
  const nextGame = !!(old && match.series && !match.series.over);
  // Resa dell'avversario dal suo side deck: la partita finisce, chiudendo il nostro side deck o l'attesa.
  let side = null;
  let conceded = null;
  const opponentConceded = new Promise((resolve) => match.mux.on("concede", () => resolve((conceded = true))));
  const endByConcede = () => {
    side?.close({ surrendered: false, opponent: true });
    old?.concludeMatch({ won: true, why: "Your opponent surrendered the match" });
    return null;
  };
  if (nextGame) {
    const opts = match.host ? match.options : match.lastOptions;
    side = openSideEditor(match.deck, { banlist: opts?.banlist, allowUnofficial: opts?.allowUnofficial, pointCap: opts?.pointCap, game: match.series.game });
    const d = await Promise.race([side, opponentConceded.then(() => ({ opponent: true }))]);
    if (d.opponent || conceded) return endByConcede();
    if (d.surrendered) {
      match.mux.send({ t: "concede" });
      old.concludeMatch({ won: false, why: "You surrendered the match" });
      return null;
    }
    match.deck = d;
  } else if (old) match.deck = match.savedDeck ?? match.deck;
  match.savedDeck ??= match.deck;
  let result;
  try {
    const talk = negotiate(match.mux, {
      host: match.host,
      name: settings.name,
      deck: match.deck,
      sleeve: validSleeve(settings.sleeve),
      pendulum: pendulumIcons(),
      options: match.options,
      ranked: !!settings.ranked,
      chooseFirst: coinToss(toss),
      iFirst,
      // Mentre l'avversario fa il side deck il suo "hello" può tardare.
      helloTimeout: nextGame || old ? 15 * 60 * 1000 : undefined,
    });
    result = await Promise.race([talk, opponentConceded.then(() => null)]);
    if (!result) return endByConcede();
  } catch (err) {
    toss.lost?.close();
    throw err;
  }
  if (toss.lost) {
    // Arrivata la scelta dell'avversario: la si mostra un attimo, poi la finestra si chiude da sola.
    const m = toss.lost;
    m.body.replaceChildren(h("p.coin-result", result.me === 0 ? "Your opponent chose to go second: you go first!" : "Your opponent chose to go first: you go second."));
    setTimeout(() => m.close(), 1800);
  } else if (iFirst != null) toast(iFirst ? "Rematch: you lost the last Duel, so you go first" : "Rematch: your opponent lost the last Duel, so they go first");
  else toast(result.me === 0 ? "You go first!" : "Your opponent goes first");
  if (result.opponent) rememberOpponent(result.opponent.pk, result.opponent.name);
  if (settings.ranked) toast(result.ranked ? "Ranked Duel: the result counts for the ELO ranking" : "This Duel is not ranked (your opponent did not enable Ranked)", { kind: result.ranked ? "ok" : "info", ms: 4000 });
  if (!result.sameData) {
    toast("Warning: you and your opponent have different database/script versions. Desyncs may occur.", { kind: "error", ms: 9000 });
  }
  // Partita al meglio di N (opzione dell'host): punteggio condiviso dalle rivincite, nuova a partita finita.
  match.lastOptions = result.options;
  if (!match.series || match.series.over) match.series = newSeries(result.options.bestOf);
  const controllers = result.me === 0 ? ["local", "remote"] : ["remote", "local"];
  // Rivincita: la sessione precedente si chiude solo ora (senza chiudere il collegamento).
  if (old) {
    old.destroy({ keepLink: true });
    if (app.current === old) app.current = null;
  }
  startSession(app, {
    controllers, me: result.me, names: result.names, reveal: false, duel: result.duel, timer: result.options.timer, sleeves: result.sleeves, pendulums: result.pendulums, mux: match.mux,
    ranked: result.ranked,
    sideDeck: match.series.bestOf > 1,
    match: match.series,
    onRematch: (old) => {
      // Sincrono rispetto al messaggio "rematch": da qui in poi i messaggi appartengono alla partita nuova.
      match.mux.newGame();
      playMatch(app, match, old).catch((err) => {
          console.error(err);
          old.rematchFailed(err.message);
          match.mux.close();
        });
    },
  });
}

/** Stato di un amico da mostrare: testo e classe del pallino. */
function presenceLabel(f) {
  const p = presenceOf(f);
  if (p.status === "pending") return ["Request sent", "pending"];
  if (p.status === "online") return ["Online", "online"];
  if (p.status === "duel") return ["In a Duel", "duel"];
  if (!p.lastSeen) return ["Offline", "offline"];
  const m = Math.round((Date.now() / 1000 - p.lastSeen) / 60);
  return [m < 60 ? `Last seen ${m} min ago` : m < 48 * 60 ? `Last seen ${Math.round(m / 60)} h ago` : `Last seen ${Math.round(m / 1440)} days ago`, "offline"];
}

/**
 * Pagina dei duelli online. join: codice di una stanza in cui entrare subito (invito di un amico accettato);
 * tab: scheda da aprire ("match", "manual", "social"; valgono anche i nomi vecchi).
 */
export function showOnline(app, { join = null, tab = null } = {}) {
  const decks = loadDecks();
  if (!decks.length) return alertModal("No Decks", "Create a Deck in the Deck Editor.");
  const root = clear(app.root);
  const name = h("input.input", { value: settings.name, maxLength: 24, oninput: (e) => (settings.name = e.target.value.trim() || "Duelist") });
  const deck = deckSelect(decks, settings.lastDeck);
  deck.addEventListener("change", () => (settings.lastDeck = deck.value));
  const opts = optionsForm();
  const rankedBox = h("input", { type: "checkbox", checked: !!settings.ranked, onchange: (e) => (settings.ranked = e.target.checked) });
  const status = h("div.status-box", "Choose how to connect to the other player.");
  // Schermata a tutto schermo del matchmaking (mm-scene.js), aperta da Find a Duel fino all'inizio del duello.
  let mmScene = null;
  const setStatus = (t, kind = "") => {
    status.textContent = t;
    status.className = `status-box ${kind}`;
    if (mmScene) kind === "error" ? mmScene.failed(t) : mmScene.status(t, kind);
  };
  let cancel = () => {};

  const getDeck = () => decks.find((d) => d.id === deck.value);

  // Dopo il collegamento WebRTC: accordo sul duello e avvio.
  const onConnected = async (link, host) => {
    stopWatch();
    invited = null;
    clearTimeout(inviteTimer);
    const mux = new LinkMux(link);
    const route = await link.routeInfo().catch(() => null);
    const via = route?.local === "nostr" ? "through the Nostr relays (slower than P2P)" : route ? (route.local === "relay" || route.remote === "relay" ? "via TURN (relay)" : route.local === "host" && route.remote === "host" ? "over local network" : "direct P2P (STUN)") : "";
    setStatus(`Connected ${via}${route?.rtt != null ? `, ping ${route.rtt} ms` : ""}. Agreeing on rules...`, "ok");
    // Matchmaking: il collegamento P2P si vede formarsi, poi la schermata lascia il posto al duello.
    if (mmScene) {
      const sc = mmScene;
      sc.connected(route);
      await new Promise((r) => setTimeout(r, 1600));
      if (mmScene !== sc) return link.close(); // annullato nel frattempo
      closeMmScene();
    }
    // Mazzo e regole restano quelli del primo accordo anche per le rivincite.
    const match = { mux, host, deck: getDeck(), options: host ? opts.read() : undefined };
    // Mazzo non valido (es. oltre il massimo di carte): non si gioca. L'host lo controlla con le sue regole,
    // l'ospite senza banlist (quella dell'host la controlla l'host).
    const errors = validateDeck(match.deck, host && match.options.banlist ? banlistByName(match.options.banlist) : null, { allowUnofficial: host ? match.options.allowUnofficial : true, pointCap: host ? match.options.pointCap : undefined });
    if (errors.length) {
      setStatus(`Your Deck cannot be used: ${errors.slice(0, 3).join(" · ")}`, "error");
      link.close();
      return;
    }
    try {
      await playMatch(app, match);
    } catch (err) {
      console.error(err);
      setStatus(err.message, "error");
      link.close();
    }
  };

  // --- Stanza online: sul server di segnalazione (codice di 6 caratteri) oppure decentralizzata sui relay Nostr
  // (8 caratteri), come scelto in Settings. Per entrare conta il codice: uno di 8 caratteri è sempre una stanza Nostr.
  const useNostr = settings.roomMode === "nostr";
  const roomInput = h("input.input.code", { placeholder: "CODE", maxLength: 12, oninput: (e) => (e.target.value = e.target.value.toUpperCase()) });
  const roomCode = h("div.room-code");
  const roomHint = h("p.muted.small.clip-hint");
  let usedRoom = null;
  // forceNostr: stanza decentralizzata anche se in Settings è scelto il server (inviti agli amici).
  // quiet: il codice non va negli appunti (lo riceve l'amico invitato). Restituisce il codice della stanza.
  const viaServer = async (room, { forceNostr = false, quiet = false } = {}) => {
    cancel();
    if (room === null && !checkDeck(getDeck(), opts.read())) return null;
    const nostr = room ? isNostrCode(room) : useNostr || forceNostr;
    let c;
    if (nostr) {
      setStatus("Preparing STUN/TURN...");
      const iceServers = await resolveIceServers();
      c = connectViaNostr({ room, iceServers, forceRelay: settings.forceRelay, onStatus: (t) => setStatus(t) });
    } else c = connectViaServer({ room, onStatus: (t) => setStatus(t) });
    cancel = c.cancel;
    c.room.then(async (code) => {
      if (room || quiet) return;
      roomCode.textContent = code;
      // Come per i codici invito: il codice della stanza va subito negli appunti, pronto da mandare.
      ownCodes.add(code);
      if (await copyText(code)) {
        watcher?.seen(code);
        setStatus(`Room ${code} created and copied to the clipboard: send it to your opponent and wait here.`, "ok");
      }
    });
    c.ready.then(({ link, host }) => onConnected(link, host)).catch((e) => setStatus(e.message, "error"));
    return c.room;
  };

  // --- Codice invito (nessun server)
  const inviteOut = h("textarea.code-area", { readOnly: true, placeholder: "Your invite code will appear here" });
  const answerIn = h("textarea.code-area", { placeholder: "Paste the other player's response code here" });
  const inviteIn = h("textarea.code-area", { placeholder: "Paste the invite code you received here" });
  const answerOut = h("textarea.code-area", { readOnly: true, placeholder: "Your response code will appear here" });
  const clipHint = h("p.muted.small.clip-hint");
  let hostLink = null;
  const FAILED_HINT = "If it keeps failing, make sure both players use the published site (it has the Cloudflare TURN relay) and that TURN is set to \"Cloudflare\" in Settings.";
  // La connessione dell'host è fallita o è stata chiusa: si riparte da un invito nuovo.
  const resetHost = (why) => {
    hostLink?.close();
    hostLink = null;
    inviteOut.value = "";
    answerIn.value = "";
    setStatus(`${why}\nGenerate a new invite code and send it to the other player again.\n${FAILED_HINT}`, "error");
  };
  const copy = (ta) => {
    navigator.clipboard?.writeText(ta.value).then(() => {
      watcher?.seen(ta.value);
      toast("Copied to clipboard");
    }, () => ta.select());
  };

  // Codici generati da noi: negli appunti non vanno scambiati per quelli dell'altro giocatore.
  const ownCodes = new Set();
  let usedInvite = null;
  /** Copia subito il nostro codice e lo ricorda; restituisce il messaggio da mostrare. */
  const autoCopy = async (code, what) => {
    ownCodes.add(code);
    const ok = await copyText(code);
    if (ok) watcher?.seen(code);
    return ok ? `Your ${what} code was copied to the clipboard: send it to the other player.` : `Copy your ${what} code with the button below and send it to the other player.`;
  };

  const hostGenerate = async () => {
    if (!checkDeck(getDeck(), opts.read())) return;
    hostLink?.close();
    setStatus("Gathering ICE candidates (STUN/TURN)...");
    try {
      const { link, code } = await createInvite();
      hostLink = link;
      inviteOut.value = code;
      answerIn.value = "";
      const msg = await autoCopy(code, "invite");
      setStatus(`${msg}\n${watcher ? "When you copy their response code, it will be pasted here automatically." : "Then paste their response below and press Connect."}`, "ok");
      waitOpen(link, 10 * 60 * 1000).then(() => onConnected(link, true)).catch((e) => hostLink === link && resetHost(e.message));
    } catch (e) {
      setStatus(e.message, "error");
    }
  };

  const hostConnect = async () => {
    if (!hostLink) return setStatus("Generate the invite code first", "error");
    if (hostLink.closed) return resetHost("This invite is no longer valid (the previous connection attempt failed).");
    if (hostLink.pc.signalingState === "stable") return setStatus("Already connecting with this invite: wait a few seconds.");
    try {
      await completeInvite(hostLink, answerIn.value);
      setStatus("Connecting...");
    } catch (e) {
      setStatus("Invalid response code: " + e.message, "error");
    }
  };

  const guestRespond = async () => {
    setStatus("Preparing response...");
    try {
      const invite = inviteIn.value.trim();
      const { link, code } = await acceptInvite(invite);
      usedInvite = invite;
      answerOut.value = code;
      const msg = await autoCopy(code, "response");
      setStatus(`${msg}\nThen wait for the host to connect.`, "ok");
      waitOpen(link, 10 * 60 * 1000).then(() => onConnected(link, false)).catch((e) => setStatus(`${e.message}\nAsk the host for a new invite code and generate a new response.\n${FAILED_HINT}`, "error"));
    } catch (e) {
      setStatus("Invalid invite code: " + e.message, "error");
    }
  };

  /** Tipo di un codice negli appunti: "offer" (invito), "answer" (risposta) o null se non è un codice. */
  const codeKind = async (text) => {
    if (text.length < 80 || !/^[A-Za-z0-9_\-\s]+$/.test(text)) return null;
    try {
      return (await unpackSignal(text))?.sdp?.type ?? null;
    } catch {
      return null;
    }
  };

  // Lettura automatica degli appunti mentre la scheda del codice invito è aperta.
  let watcher = null;
  const stopWatch = () => {
    watcher?.stop();
    watcher = null;
  };
  const onClipboard = async (text, initial) => {
    if (ownCodes.has(text)) return;
    // Codice di una stanza (6 caratteri: server di segnalazione, 8: Nostr) copiato dall'avversario.
    if (ROOM_CODE.test(text) && paneHost.firstChild === manualBody) {
      if (text === usedRoom) return;
      roomInput.value = text;
      if (initial) {
        setStatus(`A Room code (${text}) was found in the clipboard and pasted: press "Join" to enter.`, "ok");
      } else {
        usedRoom = text;
        setStatus(`Room code ${text} found in the clipboard: joining...`, "ok");
        viaServer(text);
      }
      return;
    }
    const kind = await codeKind(text);
    if (kind === "answer" && hostLink && !hostLink.closed && hostLink.pc.signalingState !== "stable") {
      answerIn.value = text;
      setStatus("Response code found in the clipboard: connecting...", "ok");
      await hostConnect();
    } else if (kind === "offer" && !hostLink && text !== usedInvite) {
      inviteIn.value = text;
      if (initial) {
        // Era già negli appunti prima di aprire la scheda: potrebbe essere vecchio, si chiede conferma.
        setStatus("An invite code was found in the clipboard and pasted below: press \"Generate response\" to use it.", "ok");
      } else {
        setStatus("Invite code found in the clipboard: generating your response...", "ok");
        await guestRespond();
      }
    }
  };
  const startWatch = async () => {
    if (watcher) return;
    clipHint.textContent = "";
    if (!(await clipboardWatchable())) {
      clipHint.textContent = "Paste the codes manually (this browser does not allow reading the clipboard automatically).";
      return;
    }
    if (watcher) return;
    watcher = watchClipboard({
      onText: onClipboard,
      onDenied: () => {
        watcher = null;
        clipHint.textContent = "Clipboard access denied: paste the codes manually.";
      },
    });
    clipHint.textContent = "Codes are copied automatically, and the other player's code is pasted as soon as you copy it.";
    roomHint.textContent = "Your Room code is copied automatically; when you copy your opponent's code it is pasted here and you join by yourself.";
  };

  // Classifica ELO (dai relay Nostr): si carica aprendo la scheda.
  const rankBody = h("div.online-pane.ranking");
  const loadRanking = async () => {
    clear(rankBody).append(h("p.muted", "Loading the ranking from the Nostr relays…"));
    republishOutbox().catch(() => {});
    try {
      const { players, games } = await leaderboard();
      const me = identity().pk;
      const mine = players.find((p) => p.pk === me);
      clear(rankBody).append(
        h("p.muted.small", "Ranked Duels are signed by both players and published on public Nostr relays; every client checks the signatures and computes the same ranking. Start: 1500, K = 32; at most 5 Duels a day against the same opponent count. Leaving a ranked Duel (Leave, Surrender, closing the tab or the connection) counts as a loss; if both players claim the other left, both lose."),
        h("div.rank-me", h("b", mine ? `Your rating: ${mine.rating}` : `Your rating: ${START_RATING} (no ranked Duels yet)`), mine ? h("span.muted", ` · ${mine.wins}W ${mine.losses}L ${mine.draws}D`) : null, h("span.muted.small", ` · key ${shortKey(me)}`)),
        players.length
          ? h("table.rank-table",
              h("tr", h("th", "#"), h("th", "Player"), h("th", "Rating"), h("th", "Duels"), h("th", "W / L / D"), h("th", { title: "Duels lost by leaving" }, "Left")),
              players.slice(0, 100).map((p, i) => h(`tr${p.pk === me ? ".me" : ""}`, h("td", i + 1), h("td", { title: p.pk }, p.name, h("span.muted.small", ` ${shortKey(p.pk)}`)), h("td", h("b", p.rating)), h("td", p.games), h("td", `${p.wins} / ${p.losses} / ${p.draws}`), h("td", p.abandons))))
          : h("p.muted", "No ranked Duels yet."),
        h("p.muted.small", `${games.length} ranked Duels counted.`),
        h("button.btn", { onclick: loadRanking }, icon("refresh"), " Reload")
      );
    } catch (e) {
      clear(rankBody).append(h("p.status-box.error", `Ranking unavailable: ${e.message}`), h("button.btn", { onclick: loadRanking }, "Retry"));
    }
  };

  // --- Matchmaking con sconosciuti (src/net/matchmaking.js): coda per regole sui relay Nostr.
  const mmBody = h("div.online-pane.matchmaking");
  const mmStatus = h("p.mm-status.muted");
  const mmList = h("div.mm-queues");
  const mmBtn = h("button.btn.primary.mm-search");
  let search = null;
  let stopSeeks = null;
  const rulesNow = () => {
    const o = opts.read();
    return { mode: o.mode, banlist: o.banlist || "", timer: o.timer, bestOf: o.bestOf, lp: o.lp, hand: o.hand, draw: o.draw, unofficial: o.allowUnofficial, ranked: !!settings.ranked, ...(o.pointCap != null ? { pointCap: o.pointCap } : {}) };
  };
  const rulesText = (r) => [
    DUEL_MODES[r.mode]?.label ?? r.mode,
    r.banlist ? (r.pointCap != null ? `${r.banlist} (${r.pointCap} points)` : r.banlist) : "No banlist",
    TIMER_PRESETS[r.timer]?.label ?? "No timer",
    r.bestOf > 1 ? `best of ${r.bestOf}` : null,
    r.lp !== 8000 || r.hand !== 5 || r.draw !== 1 ? `${r.lp} LP, hand ${r.hand}, draw ${r.draw}` : null,
    r.unofficial ? "unofficial cards" : null,
    r.ranked ? "Ranked" : null,
  ].filter(Boolean).join(" · ");
  const drawMmButton = () => {
    mmBtn.replaceChildren(icon(search ? "close" : "search"), search ? " Stop searching" : " Find a Duel");
    mmBtn.className = `btn ${search ? "" : "primary "}mm-search`;
  };
  let relayTimer = 0;
  let joinTimer = 0;
  const closeMmScene = () => {
    clearInterval(relayTimer);
    clearTimeout(joinTimer);
    mmScene?.close();
    mmScene = null;
  };
  /** Annulla dalla schermata: la ricerca o, dopo l'abbinamento, la connessione in corso. */
  const cancelFromScene = () => {
    const searching = !!search;
    closeMmScene();
    if (searching) stopSearch("Search stopped.");
    else {
      cancel();
      mmStatus.textContent = "Cancelled.";
      setStatus("Choose how to connect to the other player.");
    }
  };
  const openMmScene = async (rules) => {
    const { openMatchScene } = await import("./mm-scene.js");
    mmScene = openMatchScene({ name: settings.name, rules: rulesText(rules), onCancel: cancelFromScene });
    const relays = () => mmScene?.relays(relayStatus());
    relays();
    relayTimer = setInterval(relays, 2000);
  };
  const stopSearch = (why) => {
    closeMmScene();
    search?.stop();
    search = null;
    drawMmButton();
    if (why) mmStatus.textContent = why;
  };
  mmBtn.addEventListener("click", async () => {
    if (search) return stopSearch("Search stopped.");
    const o = opts.read();
    if (!checkDeck(getDeck(), o)) return;
    withdrawInvite();
    cancel();
    const rules = rulesNow();
    mmStatus.textContent = "Joining the queue…";
    await openMmScene(rules);
    let lastRelay = null;
    const s = await findMatch({
      rules,
      data: db.manifest?.version ?? "?",
      name: settings.name,
      onStatus: (t) => {
        mmStatus.textContent = t;
        mmScene?.status(t);
      },
      onEvent: (e) => {
        if (e.t === "recv") lastRelay = e.relay;
        mmScene?.event(e);
      },
      // La stanza la crea chi propone, con le regole della coda.
      createRoom: async () => {
        opts.set(rules);
        const code = await viaServer(null, { forceNostr: true, quiet: true });
        if (!code) throw new Error("invalid Deck");
        return code;
      },
      onMatch: ({ room, host, opponent }) => {
        search = null;
        drawMmButton();
        mmStatus.textContent = `Matched with ${opponent.name}!`;
        mmScene?.matched(opponent, lastRelay);
        // Se l'altro client non arriva nella stanza, non si aspetta per sempre.
        joinTimer = setTimeout(() => {
          if (!mmScene) return;
          cancel();
          setStatus(`${opponent.name} did not connect. Press Back and search again.`, "error");
        }, 45000);
        setStatus(host ? `Matched with ${opponent.name}: waiting for them in Room ${room}…` : `Matched with ${opponent.name}: joining their Room…`, "ok");
        if (!host) viaServer(room);
      },
    });
    search = s;
    drawMmButton();
    // Annullato mentre si entrava nella coda.
    if (!mmScene) stopSearch("Search stopped.");
  });
  const drawQueues = async (list) => {
    if (!mmBody.isConnected) return;
    const mine = await queueOf(rulesNow(), db.manifest?.version ?? "?");
    const me = identity().pk;
    const groups = new Map();
    for (const s of list) {
      if (s.pk === me) continue;
      if (!groups.has(s.queue)) groups.set(s.queue, { rules: s.rules, data: s.data, players: [] });
      groups.get(s.queue).players.push(s);
    }
    const sameData = (g) => g.data === (db.manifest?.version ?? "?");
    const rows = [...groups.entries()].sort((a, b) => b[1].players.length - a[1].players.length);
    clear(mmList).append(
      h("h3", "Searching now"),
      rows.length
        ? h("ul.friend-list", rows.map(([q, g]) => h("li.friend-row",
            h(`span.presence-dot.${q === mine ? "online" : "offline"}`),
            h("div.friend-info", { title: g.players.map((p) => p.name + (p.proto === MM_PROTO ? "" : p.proto < MM_PROTO ? " (older Helios: needs to reload)" : " (newer Helios: reload to play with them)")).join(", ") }, h("b", `${g.players.length} player${g.players.length === 1 ? "" : "s"}`), h("span.muted.small", ` ${rulesText(g.rules)}${sameData(g) ? "" : " · other data version"}${g.players.some((p) => p.proto !== MM_PROTO) ? " · other Helios version" : ""}`)),
            q === mine
              ? h("span.muted.small", "Your rules")
              : h("button.btn.small", { disabled: !sameData(g) || !!search, title: sameData(g) ? "Use these rules (the Ranked checkbox too)" : "They use another version of the card data", onclick: () => { opts.set(g.rules); settings.ranked = g.rules.ranked; rankedBox.checked = g.rules.ranked; toast("Rules set: press Find a Duel"); watchQueues(); } }, "Use these rules"))))
        : h("p.muted.small", "Nobody else is searching right now. Start searching: whoever opens this tab sees you here.")
    );
  };
  let lastSeeks = [];
  const watchQueues = () => {
    stopSeeks ??= watchSeeks((list) => drawQueues((lastSeeks = list)));
    drawQueues(lastSeeks);
  };
  // Regole cambiate: la coda è un'altra (si smette di cercare in quella vecchia).
  const rulesChanged = () => {
    if (search) stopSearch("Rules changed: press Find a Duel again to search with the new ones.");
    drawQueues(lastSeeks);
  };
  opts.el.addEventListener("change", rulesChanged);
  rankedBox.addEventListener("change", rulesChanged);
  drawMmButton();
  mmBody.append(
    h("p.muted", "Play against anyone looking for a Duel right now, with the same rules as you (left panel). No server: players meet on public Nostr relays, then the Duel runs peer-to-peer. Your name and player key are visible to the other players searching."),
    h("div.card-box.mm-box", mmBtn, mmStatus),
    mmList
  );

  // --- Amici (src/net/social.js): richieste, chi è online, inviti in una stanza Nostr.
  const friendsBody = h("div.online-pane.friends");
  let invited = null; // invito mandato in attesa di risposta: { pk, id, name }
  let inviteTimer = 0;
  const withdrawInvite = () => {
    if (!invited) return;
    cancelInvite(invited.pk, invited.id);
    invited = null;
    clearTimeout(inviteTimer);
  };
  const inviteFriend = async (f) => {
    const o = opts.read();
    if (!checkDeck(getDeck(), o)) return;
    withdrawInvite();
    setStatus(`Creating a Room for ${f.name}…`);
    const code = await viaServer(null, { forceNostr: true, quiet: true });
    if (!code) return;
    const rules = {
      mode: DUEL_MODES[o.mode]?.label ?? o.mode,
      banlist: o.banlist ? (o.pointCap != null ? `${o.banlist} (${o.pointCap} points)` : o.banlist) : "No banlist",
      timer: TIMER_PRESETS[o.timer]?.label ?? "No timer",
      bestOf: o.bestOf,
      ranked: !!settings.ranked,
    };
    try {
      const id = await sendInvite(f.pk, code, rules);
      invited = { pk: f.pk, id, name: f.name };
      setStatus(`Invite sent to ${f.name}: waiting for an answer…`, "ok");
      clearTimeout(inviteTimer);
      inviteTimer = setTimeout(() => {
        if (invited?.id !== id) return;
        withdrawInvite();
        cancel();
        setStatus(`${f.name} did not answer the invite.`, "error");
      }, INVITE_SECONDS * 1000);
    } catch (e) {
      cancel();
      setStatus(e.message, "error");
    }
  };
  const offReply = onInviteReply((r) => {
    if (!invited || r.id !== invited.id || r.from !== invited.pk) return;
    if (r.accept) return setStatus(`${invited.name} accepted: connecting…`, "ok");
    const who = invited.name;
    invited = null;
    clearTimeout(inviteTimer);
    cancel();
    setStatus(`${who} declined the invite${r.reason ? ` (${r.reason})` : ""}.`, "error");
  });
  const friendCode = () => npubOf(identity().pk);
  const addInput = h("input.input.mono", { placeholder: "Friend code (npub1…)", onkeydown: (e) => e.key === "Enter" && addBtn.click() });
  const addBtn = h("button.btn.primary", {
    onclick: async () => {
      const pk = pubkeyFrom(addInput.value);
      if (!pk) return toast("Paste your friend's code: it starts with npub1", { kind: "error" });
      try {
        await addFriend(pk);
        addInput.value = "";
        toast("Friend request sent");
      } catch (e) {
        toast(e.message, { kind: "error" });
      }
    },
  }, icon("person_add"), " Add");
  const friendRow = (f) => {
    const [label, dot] = presenceLabel(f);
    const canInvite = dot === "online";
    // In duello (contro la CPU o online), se lo permette: lo si guarda e se ne segnalano gli errori.
    const watch = dot === "duel" ? presenceOf(f).watch : null;
    return h("li.friend-row",
      h(`span.presence-dot.${dot}`, { title: label }),
      h("div.friend-info", h("b", f.name), h("span.muted.small", { title: f.pk }, ` ${shortKey(f.pk)} · ${label}`)),
      watch ? h("button.btn.small", { title: `Watch ${f.name}'s Duel and report their mistakes`, onclick: () => watchFriend(app, f, watch) }, icon("visibility"), " Watch") : null,
      f.status === "friend" ? h("button.btn.small.primary", { disabled: !canInvite, title: canInvite ? "Invite to a Duel with the rules on the left" : "You can invite a friend when they are online", onclick: () => inviteFriend(f) }, icon("swords"), " Invite") : null,
      h("button.btn.small.ghost", { title: "Rename", onclick: async () => { const n = await promptModal("Rename friend", "Name", f.name); if (n?.trim()) renameFriend(f.pk, n); } }, icon("edit")),
      h("button.btn.small.ghost", { title: "Remove from friends", onclick: async () => { if (await confirmModal("Remove friend", `Remove ${f.name} from your friends? They will no longer see when you are online.`, "Remove", "Cancel", { danger: true })) removeFriend(f.pk); } }, icon("person_remove"))
    );
  };
  const drawFriends = () => {
    const { friends, requests, recent } = socialState();
    const order = { online: 0, duel: 1, offline: 2, pending: 3 };
    const sorted = [...friends].sort((a, b) => order[presenceLabel(a)[1]] - order[presenceLabel(b)[1]] || a.name.localeCompare(b.name));
    clear(friendsBody).append(...[
      h("p.muted", "Add friends with their friend code, see when they are online and invite them to a Duel. No server and no account: your friends list is encrypted and saved on the Nostr relays with your player key (Settings → Profile), only friends can see when you are online."),
      h("div.card-box.friend-code",
        h("h3", "Your friend code"),
        h("div.row", h("code.mono.friend-npub", { title: friendCode() }, friendCode()), h("button.btn.small", { onclick: () => copyText(friendCode()).then((ok) => toast(ok ? "Friend code copied" : "Copy failed")) }, icon("content_copy"), " Copy")),
        h("div.row", addInput, addBtn)
      ),
      requests.length
        ? h("div.card-box", h("h3", `Friend requests (${requests.length})`),
            h("ul.friend-list", requests.map((r) => h("li.friend-row",
              h("span.presence-dot.pending"),
              h("div.friend-info", h("b", r.name), h("span.muted.small", { title: r.pk }, ` ${shortKey(r.pk)}`)),
              h("button.btn.small.primary", { onclick: () => acceptRequest(r.pk) }, icon("check"), " Accept"),
              h("button.btn.small.ghost", { onclick: () => declineRequest(r.pk) }, icon("close"), " Decline")))))
        : null,
      h("div.card-box", h("h3", `Friends (${friends.filter((f) => f.status === "friend").length})`),
        sorted.length ? h("ul.friend-list", sorted.map(friendRow)) : h("p.muted.small", "No friends yet: send your friend code to someone, or add a recent opponent below.")),
      reportsBox(),
      recent.length
        ? h("div.card-box", h("h3", "Recent opponents"),
            h("ul.friend-list", recent.map((r) => h("li.friend-row",
              h("span.presence-dot.offline"),
              h("div.friend-info", h("b", r.name), h("span.muted.small", { title: r.pk }, ` ${shortKey(r.pk)}`)),
              h("button.btn.small", { onclick: () => addFriend(r.pk, r.name).then(() => toast("Friend request sent"), (e) => toast(e.message, { kind: "error" })) }, icon("person_add"), " Add friend")))))
        : null,
    ].filter(Boolean));
  };
  // La lista si ridisegna quando cambia (richieste, presenza), ma non mentre si scrive il codice di un amico.
  const offSocial = onSocialChange(() => {
    if (friendsBody.isConnected && document.activeElement !== addInput) drawFriends();
  });

  // Scheda "Manual matchmaking": stanza con codice e codice invito, una sotto l'altra.
  const roomPane = h(
    "section.online-pane",
    h("h3.pane-head", "Online Room (no server)"),
    h("p.muted", "Create a Room and send the code to your opponent: the connection info is exchanged automatically and the Duel runs directly between the two browsers (peer-to-peer). No game server is involved: the Room is only used to meet. 8-character codes are serverless Rooms on public Nostr relays; 6-character codes use a signaling server. Choose where new Rooms are created in Settings."),
    roomHint,
    h("div.row-group",
      h("div.card-box", h("h3", "Create a Room"), h("p.muted.small", "Get a code to give to your opponent. You set the rules."), h("button.btn.primary", { onclick: () => viaServer(null) }, "Create Room"), roomCode),
      h("div.card-box", h("h3", "Join a Room"), roomInput, h("button.btn.primary", { onclick: () => roomInput.value.trim() && viaServer(roomInput.value.trim()) }, "Join"))
    )
  );
  const manualBody = h(
    "div.online-manual",
    roomPane,
    h(
      "section.online-pane",
      h("h3.pane-head", "Invite code (no server)"),
      h("p.muted", "Also peer-to-peer and serverless: instead of a Room you exchange two long codes (e.g. via chat). Paste them quickly: the connection may fail if the exchange takes more than about a minute."),
      clipHint,
      h("div.row-group",
        h("div.card-box",
          h("h3", "1. You host"),
          h("button.btn.primary", { onclick: hostGenerate }, "Generate invite code"),
          inviteOut,
          h("button.btn", { onclick: () => copy(inviteOut) }, "Copy invite"),
          answerIn,
          h("button.btn.primary", { onclick: hostConnect }, "Connect")
        ),
        h("div.card-box",
          h("h3", "2. You're invited"),
          inviteIn,
          h("button.btn.primary", { onclick: guestRespond }, "Generate response"),
          answerOut,
          h("button.btn", { onclick: () => copy(answerOut) }, "Copy response")
        )
      )
    )
  );
  // Scheda "Friends & Ranking": amici, poi la classifica ELO.
  const socialBody = h("div.online-social", friendsBody, h("h3.pane-head", "Ranking (ELO)"), rankBody);
  const tabs = [
    { id: "match", label: "Find a Duel", body: mmBody, onShow: watchQueues },
    { id: "manual", label: "Manual matchmaking", body: manualBody },
    { id: "social", label: "Friends & Ranking", body: socialBody, onShow: () => { drawFriends(); syncProfile().catch(() => {}); loadRanking(); } },
  ];
  const tabBar = h("div.tabs.big");
  const paneHost = h("div");
  const show = (id) => {
    tabBar.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === id));
    clear(paneHost).append(tabs.find((t) => t.id === id).body);
    tabs.find((t) => t.id === id).onShow?.();
    // Gli appunti si osservano in entrambe le schede: codici stanza e codici invito si incollano da soli.
    startWatch();
  };
  for (const t of tabs) tabBar.append(h("button.tab", { dataset: { tab: t.id }, onclick: () => show(t.id) }, t.label));
  // Nomi vecchi delle schede (link e chiamate di prima).
  const alias = { server: "manual", invite: "manual", friends: "social", ranking: "social" };
  tab = alias[tab] ?? tab;
  show(tabs.some((t) => t.id === tab) ? tab : "match");
  // Server di segnalazione scelto ma irraggiungibile (es. sito su GitHub Pages): si propongono le alternative.
  if (!useNostr) {
    signalingAvailable().then((ok) => {
      if (ok) return;
      roomPane.prepend(h("div.status-box.error", "No signaling server found, so you can only join decentralized Rooms (8-character codes). To create Rooms without a server, choose \"Nostr relays\" for Online Rooms in Settings, or use the invite code."));
    });
  }

  root.append(
    h(
      "div.page.online",
      h("div.page-head", h("button.btn.ghost.round.page-back", { title: "Menu (right-click)", onclick: () => { stopSearch(); stopSeeks?.(); withdrawInvite(); cancel(); stopWatch(); hostLink?.close(); app.home(); } }, icon("chevron_left")), h("h1", "Online Duel")),
      h("div.online-grid",
        h("div.card-box",
          h("h3", "Your Profile"),
          h("label.field", h("span", "Name"), name),
          h("label.field", h("span", "Deck"), deck),
          h("label.check", { title: "The Duel counts for the ELO ranking only if both players enable this" },
            rankedBox, "Ranked Duel (ELO)"),
          h("p.muted.small", "Ranked: the result, your name and your player key are published on public Nostr relays (see Settings → Profile)."),
          h("h3", "Rules (set by the host)"),
          opts.el,
          h("p.muted.small", `Data: ${db.manifest?.version ?? "?"} · Both players must have the same data version.`)
        ),
        h("div", tabBar, paneHost, status)
      )
    )
  );
  app.onLeave = () => {
    stopSearch();
    stopSeeks?.();
    withdrawInvite();
    offReply();
    offSocial();
    cancel();
    stopWatch();
  };
  // Invito di un amico accettato: si entra subito nella sua stanza.
  if (join) {
    show("manual");
    roomInput.value = join;
    usedRoom = join;
    viaServer(join);
  }
}

export { confirmModal };
