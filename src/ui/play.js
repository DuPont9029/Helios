// Schermate di avvio partita: contro CPU, prova in solitario, online P2P.
import { h, clear, icon } from "./dom.js";
import { openModal, toast, alertModal, confirmModal } from "./modal.js";
import { db } from "../data/db.js";
import { settings } from "../data/settings.js";
import { loadDecks, validateDeck, banlistByName } from "../deck/deck.js";
import { DUEL_MODES } from "../core/constants.js";
import { DuelSession } from "../duel/session.js";
import { TIMER_PRESETS } from "../duel/clock.js";
import { validSleeve } from "../data/sleeve.js";
import { connectViaServer, createInvite, acceptInvite, completeInvite, waitOpen, signalingAvailable } from "../net/signaling.js";
import { LinkMux, negotiate } from "../net/match.js";
import { unpackSignal } from "../net/peer.js";
import { clipboardWatchable, copyText, watchClipboard } from "../net/clipboard.js";
import "../styles/play.css";

// ---------------------------------------------------------------- componenti comuni

function deckSelect(decks, selectedId) {
  const sel = h("select.select", decks.map((d) => h("option", { value: d.id }, `${d.name} (${d.main.length}/${d.extra.length})`)));
  if (selectedId && decks.some((d) => d.id === selectedId)) sel.value = selectedId;
  return sel;
}

function optionsForm({ host = true } = {}) {
  const mode = h("select.select", Object.entries(DUEL_MODES).map(([k, m]) => h("option", { value: k }, m.label)));
  const banlist = h("select.select", h("option", { value: "" }, "No banlist"), db.banlists.map((b) => h("option", { value: b.name }, b.name)));
  banlist.value = settings.lastBanlist ?? db.banlists[0]?.name ?? "";
  const lp = h("input.input", { type: "number", value: 8000, min: 1, max: 999999, step: 500 });
  const hand = h("input.input", { type: "number", value: 5, min: 0, max: 20 });
  const draw = h("input.input", { type: "number", value: 1, min: 0, max: 10 });
  const unofficial = h("input", { type: "checkbox" });
  const timer = h("select.select", Object.entries(TIMER_PRESETS).map(([k, t]) => h("option", { value: k }, t ? t.label : "Off")));
  timer.value = settings.lastTimer in TIMER_PRESETS ? settings.lastTimer : "omega";
  const el = h(
    "div.form-grid",
    h("label.field", h("span", "Rules"), mode),
    h("label.field", h("span", "Banlist"), banlist),
    h("label.field", h("span", "Life Points"), lp),
    h("label.field", h("span", "Starting hand"), hand),
    h("label.field", h("span", "Draws per turn"), draw),
    h("label.field", h("span", "Timer"), timer),
    h("label.check", unofficial, "Allow unofficial cards (anime/custom)")
  );
  if (!host) el.hidden = true;
  return {
    el,
    read() {
      settings.lastBanlist = banlist.value;
      settings.lastTimer = timer.value;
      return {
        mode: mode.value,
        flags: String(DUEL_MODES[mode.value].flags),
        banlist: banlist.value || null,
        lp: Math.max(1, +lp.value || 8000),
        hand: Math.max(0, +hand.value || 0),
        draw: Math.max(0, +draw.value || 0),
        allowUnofficial: unofficial.checked,
        timer: timer.value,
      };
    },
  };
}

function checkDeck(deck, options) {
  const errors = validateDeck(deck, options.banlist ? banlistByName(options.banlist) : null, { allowUnofficial: options.allowUnofficial });
  if (errors.length) {
    alertModal("Invalid Deck", errors.slice(0, 10).join("\n"));
    return false;
  }
  return true;
}

function startSession(app, cfg) {
  const container = clear(app.root);
  const session = new DuelSession({ ...cfg, onExit: () => app.home() });
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
          const a = decks.find((d) => d.id === mine.value);
          const noDeck = !vsCpu && opponent.value === "none";
          const b = noDeck ? { name: "No Deck", main: [], extra: [] } : decks.find((d) => d.id === other.value);
          if (!checkDeck(a, options)) return;
          if (!vsCpu && !noDeck && !checkDeck(b, options)) return;
          settings.lastDeck = a.id;
          let meFirst;
          if (vsCpu) meFirst = first.value === "coin" ? Math.random() < 0.5 : first.value === "me";
          else {
            meFirst = await askFirst(a, b);
            if (meFirst == null) return; // annullato: resta aperta la configurazione
          }
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
            startSession(app, {
              controllers, me, names, reveal: !vsCpu, timer: options.timer, sleeves,
              // Test Duel: "Rematch" a fine duello, chiedendo di nuovo chi inizia.
              onLocalRematch: vsCpu ? null : async (old) => {
                const again = await askFirst(a, b);
                if (again == null) return;
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
  let result;
  try {
    result = await negotiate(match.mux, {
      host: match.host,
      name: settings.name,
      deck: match.deck,
      sleeve: validSleeve(settings.sleeve),
      options: match.options,
      chooseFirst: coinToss(toss),
      iFirst,
    });
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
  if (!result.sameData) {
    toast("Warning: you and your opponent have different database/script versions. Desyncs may occur.", { kind: "error", ms: 9000 });
  }
  const controllers = result.me === 0 ? ["local", "remote"] : ["remote", "local"];
  // Rivincita: la sessione precedente si chiude solo ora (senza chiudere il collegamento).
  if (old) {
    old.destroy({ keepLink: true });
    if (app.current === old) app.current = null;
  }
  startSession(app, {
    controllers, me: result.me, names: result.names, reveal: false, duel: result.duel, timer: result.options.timer, sleeves: result.sleeves, mux: match.mux,
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

export function showOnline(app) {
  const decks = loadDecks();
  if (!decks.length) return alertModal("No Decks", "Create a Deck in the Deck Editor.");
  const root = clear(app.root);
  const name = h("input.input", { value: settings.name, maxLength: 24, oninput: (e) => (settings.name = e.target.value.trim() || "Duelist") });
  const deck = deckSelect(decks, settings.lastDeck);
  deck.addEventListener("change", () => (settings.lastDeck = deck.value));
  const opts = optionsForm();
  const status = h("div.status-box", "Choose how to connect to the other player.");
  const setStatus = (t, kind = "") => {
    status.textContent = t;
    status.className = `status-box ${kind}`;
  };
  let cancel = () => {};

  const getDeck = () => decks.find((d) => d.id === deck.value);

  // Dopo il collegamento WebRTC: accordo sul duello e avvio.
  const onConnected = async (link, host) => {
    stopWatch();
    const mux = new LinkMux(link);
    const route = await link.routeInfo().catch(() => null);
    const via = route ? (route.local === "relay" || route.remote === "relay" ? "via TURN (relay)" : route.local === "host" && route.remote === "host" ? "over local network" : "direct P2P (STUN)") : "";
    setStatus(`Connected ${via}${route?.rtt != null ? `, ping ${route.rtt} ms` : ""}. Agreeing on rules...`, "ok");
    // Mazzo e regole restano quelli del primo accordo anche per le rivincite.
    const match = { mux, host, deck: getDeck(), options: host ? opts.read() : undefined };
    try {
      await playMatch(app, match);
    } catch (err) {
      console.error(err);
      setStatus(err.message, "error");
      link.close();
    }
  };

  // --- Stanza sul server di segnalazione
  const roomInput = h("input.input.code", { placeholder: "CODE", maxLength: 12, oninput: (e) => (e.target.value = e.target.value.toUpperCase()) });
  const roomCode = h("div.room-code");
  const viaServer = (room) => {
    cancel();
    if (room === null && !checkDeck(getDeck(), opts.read())) return;
    const c = connectViaServer({ room, onStatus: (t) => setStatus(t) });
    cancel = c.cancel;
    c.room.then((code) => {
      if (!room) roomCode.textContent = code;
    });
    c.ready.then(({ link, host }) => onConnected(link, host)).catch((e) => setStatus(e.message, "error"));
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
    if (watcher || paneHost.firstChild !== tabs[1].body) return;
    watcher = watchClipboard({
      onText: onClipboard,
      onDenied: () => {
        watcher = null;
        clipHint.textContent = "Clipboard access denied: paste the codes manually.";
      },
    });
    clipHint.textContent = "Codes are copied automatically, and the other player's code is pasted as soon as you copy it.";
  };

  const tabs = [
    {
      id: "server",
      label: "Online Room",
      body: h(
        "div.online-pane",
        h("p.muted", "Create a Room and send the 6-character code to your opponent: the connection info is exchanged automatically. Once connected, the Duel runs directly between the browsers."),
        h("div.row-group",
          h("div.card-box", h("h3", "Create a Room"), h("p.muted.small", "Get a code to give to your opponent. You set the rules."), h("button.btn.primary", { onclick: () => viaServer(null) }, "Create Room"), roomCode),
          h("div.card-box", h("h3", "Join a Room"), roomInput, h("button.btn.primary", { onclick: () => roomInput.value.trim() && viaServer(roomInput.value.trim()) }, "Join"))
        )
      ),
    },
    {
      id: "invite",
      label: "Invite code (no server)",
      body: h(
        "div.online-pane",
        h("p.muted", "Fallback without a signaling server: you exchange two long codes (e.g. via chat). Paste them quickly: the connection may fail if the exchange takes more than about a minute."),
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
      ),
    },
  ];
  const tabBar = h("div.tabs.big");
  const paneHost = h("div");
  const show = (id) => {
    tabBar.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === id));
    clear(paneHost).append(tabs.find((t) => t.id === id).body);
    if (id === "invite") startWatch();
    else stopWatch();
  };
  for (const t of tabs) tabBar.append(h("button.tab", { dataset: { tab: t.id }, onclick: () => show(t.id) }, t.label));
  show("server");
  // Senza server di segnalazione (es. sito su GitHub Pages) si passa subito al codice invito.
  signalingAvailable().then((ok) => {
    if (ok) return;
    const pane = tabs[0].body;
    pane.prepend(h("div.status-box.error", "No signaling server found at this address, so Online Rooms are unavailable. Use the invite code, or set a signaling server in Settings."));
    if (paneHost.firstChild === pane) show("invite");
  });

  root.append(
    h(
      "div.page.online",
      h("div.page-head", h("button.btn.ghost.round.page-back", { title: "Menu (right-click)", onclick: () => { cancel(); stopWatch(); hostLink?.close(); app.home(); } }, icon("chevron_left")), h("h1", "Online Duel")),
      h("div.online-grid",
        h("div.card-box",
          h("h3", "Your Profile"),
          h("label.field", h("span", "Name"), name),
          h("label.field", h("span", "Deck"), deck),
          h("h3", "Rules (set by the host)"),
          opts.el,
          h("p.muted.small", `Data: ${db.manifest?.version ?? "?"} · Both players must have the same data version.`)
        ),
        h("div", tabBar, paneHost, status)
      )
    )
  );
  app.onLeave = () => {
    cancel();
    stopWatch();
  };
}

export { confirmModal };
