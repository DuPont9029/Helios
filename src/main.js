import "./styles/main.css";
import "./styles/duel.css";
import "./styles/field-crypt.css";
import "./styles/field-3d.css";
import { h, clear, icon, measureRectScale } from "./ui/dom.js";
import { loadDatabase, db, getCard } from "./data/db.js";
import { settings } from "./data/settings.js";
import { showEditor, showDeckList } from "./ui/editor.js";
import { showLocalSetup, showOnline } from "./ui/play.js";
import { showSettings } from "./ui/settings-page.js";
import { loadDecks } from "./deck/deck.js";
import { cardFace } from "./ui/card.js";
import { fullscreenButton } from "./ui/fullscreen.js";
import { seedBookmarks, pruneForbiddenBookmarks } from "./data/bookmarks.js";
import { updateBanlists } from "./data/banlist-update.js";
import { toast, openModal } from "./ui/modal.js";
import { startSocial, onInvite, onInviteCancel, onFriendRequest, replyInvite, statusChanged, goingOffline, onlineCount, onSocialChange } from "./net/social.js";
import { showComboTrainer } from "./ui/combos.js";
import { showHdpc } from "./ui/hdpc.js";
import { version } from "../package.json";

// PWA: Helios si può installare come app sul desktop (manifest + service worker in public/).
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  document.querySelectorAll(".install-app").forEach((b) => (b.hidden = false));
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  document.querySelectorAll(".install-app").forEach((b) => (b.hidden = true));
});
// Nel file singolo (npm run standalone) niente service worker: la pagina non ha file da mettere in cache.
if ("serviceWorker" in navigator && import.meta.env.PROD && import.meta.env.MODE !== "standalone") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("Service worker:", e)));
}

const app = {
  root: document.getElementById("app"),
  current: null,
  onLeave: null,
  home,
};

// Nei menu (Settings, lista dei mazzi, Online) il tasto destro torna indietro come la freccia in alto.
// Non vale nell'editor di un mazzo (lì il destro sposta le carte al Side) né nei duelli; con una finestra
// aperta o nei campi di testo resta il comportamento normale.
document.addEventListener("contextmenu", (e) => {
  if (document.querySelector(".modal-backdrop:not(.closing)")) return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  // Deck editor aperto sopra la pagina (Side Deck, decklist di una combo): il destro è suo.
  if (document.querySelector(".side-editor-layer")) return;
  const back = app.root.querySelector(".page-back");
  if (!back) return;
  e.preventDefault();
  back.click();
});

function leaveCurrent() {
  app.onLeave?.();
  app.onLeave = null;
  if (app.current) {
    app.current.destroy?.();
    app.current = null;
  }
}

/** Pulsante "Install app" (compare solo se il browser permette di installare la PWA). */
function installButton() {
  return h("button.btn.ghost.install-app", {
    hidden: !installPrompt,
    title: "Install Helios as an app on this computer",
    onclick: async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      document.querySelectorAll(".install-app").forEach((b) => (b.hidden = true));
    },
  }, icon("install_desktop"), " Install app");
}

/** Amici online nella home: porta alla scheda Friends della pagina Online. */
function friendsBadge(go) {
  const b = h("button.friends-badge", { title: "Friends", onclick: go(() => showOnline(app, { tab: "social" })) });
  const draw = () => {
    const n = onlineCount();
    b.replaceChildren(icon("group"), n ? ` ${n} online` : " Friends");
    b.classList.toggle("on", n > 0);
  };
  draw();
  const off = onSocialChange(() => (b.isConnected ? draw() : off()));
  return b;
}

/** Home; section "training" = sottomenu con le modalità di allenamento. */
function home(section = null) {
  leaveCurrent();
  const root = clear(app.root);
  const go = (fn) => () => { leaveCurrent(); fn(); };
  const item = (title, sub, onClick) =>
    h("button.menu-item", { onclick: go(onClick) }, h("span.menu-title", title), h("span.menu-sub", sub));
  const m = db.manifest ?? {};
  const training = section === "training";
  const nav = training
    ? h(
        "nav.menu",
        h("button.btn.ghost.round.page-back.menu-back", { title: "Back (right-click)", onclick: () => home() }, icon("chevron_left")),
        h("div.menu-section", "Training"),
        item("Test Duel", "You control both players", () => showLocalSetup(app, { vsCpu: false })),
        item("Trainer", "Write, record and practice your combos, play around hand traps", () => showComboTrainer(app)),
        item("Vs CPU", "Test your decks", () => showLocalSetup(app, { vsCpu: true })),
        item("HDPC", "Hypergeometric Distribution Probability Calculator: odds of opening your cards", () => showHdpc(app))
      )
    : h(
        "nav.menu",
        item("Online Duel", "P2P via WebRTC · STUN/TURN", () => showOnline(app)),
        item("Deck", `${loadDecks().length} decks · ${db.cards.size.toLocaleString("en-US")} cards`, () => showDeckList(app)),
        h("button.menu-item", { onclick: () => home("training") }, h("span.menu-title", "Training"), h("span.menu-sub", "Test Duel · Trainer · Vs CPU · HDPC")),
        item("Settings", "Name, network, graphics", () => showSettings(app))
      );
  root.append(
    h(
      "div.home",
      h(
        "header.home-head",
        h("div.logo", h("span.logo-mark", "◆"), h("span", "HELI"), h("b", "OS"), h("small", `v${version.replace(/\.0$/, "")}`), h("span.beta-badge", { title: "Beta: some features may still change or have bugs" }, "BETA")),
        h("div.home-user", "Welcome,", h("b", settings.name), friendsBadge(go)),
        installButton(),
        fullscreenButton(),
        h("button.btn.ghost.round", { title: "Settings", onclick: go(() => showSettings(app)) }, icon("settings"))
      ),
      nav,
      h("div.emblem", h("i"), h("i"), h("i"), h("b")),
      h("aside.home-side", deckPanel(go)),
      h(
        "footer.home-foot",
        h("span", `Cards ${db.cards.size.toLocaleString("en-US")} · data ${m.version ?? "—"} · ocgcore WASM engine`),
        h("span", "Unofficial, non-profit client. Yu-Gi-Oh! is a trademark of Konami.")
      )
    )
  );
}

// Riquadro "Mazzo attivo": scelta del mazzo usato di default nei duelli.
function deckPanel(go) {
  const decks = loadDecks();
  const box = h("section.home-deck");
  const render = () => {
    const deck = decks.find((d) => d.id === settings.lastDeck) ?? decks[0];
    const select = h(
      "select.select.small",
      { onchange: (e) => { settings.lastDeck = e.target.value; render(); } },
      decks.map((d) => h("option", { value: d.id, selected: d.id === deck?.id }, d.name))
    );
    const lead = deck?.main.find((c) => getCard(c)) ?? 0;
    clear(box).append(
      ...[
        h("div.home-deck-card", cardFace(lead)),
        h(
          "div.home-deck-info",
          h("span.label", "Active deck"),
          decks.length ? select : h("b", "No decks"),
          deck && h("div.deck-stats", h("span", h("b", deck.main.length), " Main"), h("span", h("b", deck.extra.length), " Extra"), h("span", h("b", deck.side.length), " Side")),
          h("button.btn.small", { onclick: go(() => showEditor(app)) }, icon("edit"), " Edit")
        ),
      ]
    );
  };
  render();
  return box;
}

// Test del motore nel browser: due IA giocano con i mazzi starter.
async function aiVsAi() {
  const { DuelSession } = await import("./duel/session.js");
  const { DUEL_MODES } = await import("./core/constants.js");
  const [a, b] = db.starters;
  const session = new DuelSession({
    controllers: ["ai", "ai"], me: 0, names: ["AI 1", "AI 2"], reveal: true,
    duel: { flags: String(DUEL_MODES.MR5.flags), seed: ["1", "2", "3", "4"], lp: 8000, hand: 5, draw: 1, decks: [a, b] },
    onExit: home,
  });
  app.current = session;
  session.start(clear(app.root));
}

// Stessa schermata su ogni dispositivo: l'interfaccia è disegnata per la finestra del browser su un
// MacBook Pro 14" (circa 1512×860 punti) e viene scalata con uno zoom uniforme. L'altezza di riferimento
// resta sempre 860 punti; la larghezza si adatta all'aspetto dello schermo, con un minimo di 1180.
// --vh/--vw sostituiscono vh/vw nel CSS: sono l'1% della finestra *dopo* lo zoom.
// Il duello invece è una "tela" fissa di 1180×860 (vedi .duel-screen in duel.css), scalata per starci tutta:
// il campo è identico su ogni schermo (riempie la colonna centrale, come su un Mac con la barra laterale
// del browser aperta), con al massimo due bande ai lati sugli schermi larghi o sopra e sotto su quelli alti.
const REF_HEIGHT = 860;
const MIN_WIDTH = 1180;
const DUEL_WIDTH = 1180;

// ---------------------------------------------------------------- amici e inviti (src/net/social.js)

const inDuel = () => !!app.root.querySelector(":scope > .duel-screen");
const activeDeckName = () => {
  const decks = loadDecks();
  return (decks.find((d) => d.id === settings.lastDeck) ?? decks[0])?.name ?? "none";
};
const openInvites = new Map(); // id → finestra dell'invito
onInvite((inv) => {
  if (openInvites.has(inv.id)) return;
  // In duello non si interrompe: l'amico riceve "busy".
  if (inDuel()) {
    replyInvite(inv, false, "in a Duel");
    toast(`${inv.name} invited you to a Duel, but you are in a Duel`, { ms: 5000 });
    return;
  }
  const r = inv.rules;
  const left = h("span");
  const m = openModal({
    title: "Duel invite",
    className: "friend-invite",
    dismissable: false,
    body: [
      h("p", h("b", inv.name), " invites you to a Duel."),
      h("ul.invite-rules", h("li", r.mode), h("li", `Banlist: ${r.banlist}`), h("li", `Timer: ${r.timer}`), r.bestOf > 1 ? h("li", `Match: best of ${r.bestOf}`) : null, h("li", r.ranked ? "Ranked (ELO), if you enable it too" : "Not ranked")),
      h("p.muted.small", `You play with your active Deck (${activeDeckName()}). `, left),
    ],
    actions: [{ label: "Decline", value: false }, { label: "Accept", primary: true, value: true }],
  });
  openInvites.set(inv.id, m);
  const tick = () => (left.textContent = `Expires in ${Math.max(0, inv.expires - Math.floor(Date.now() / 1000))} s.`);
  tick();
  const timer = setInterval(() => (inv.expires * 1000 <= Date.now() ? m.close("expired") : tick()), 1000);
  document.title = `(invite) ${document.title.replace(/^\(invite\) /, "")}`;
  m.result.then((v) => {
    clearInterval(timer);
    openInvites.delete(inv.id);
    document.title = document.title.replace(/^\(invite\) /, "");
    if (v === "cancelled") return toast(`${inv.name} withdrew the invite`);
    if (v === "expired") return toast(`The invite from ${inv.name} expired`);
    replyInvite(inv, v === true);
    if (v !== true) return;
    leaveCurrent();
    showOnline(app, { join: inv.room });
  });
});
onInviteCancel(({ id }) => openInvites.get(id)?.close("cancelled"));
onFriendRequest(({ name }) => toast(`${name} wants to be your friend (Online Duel → Friends & Ranking)`, { ms: 6000 }));
// Inizio e fine di un duello: lo stato per gli amici cambia subito.
let wasInDuel = false;
new MutationObserver(() => {
  if (inDuel() !== wasInDuel) {
    wasInDuel = inDuel();
    statusChanged();
  }
}).observe(app.root, { childList: true });
window.addEventListener("pagehide", goingOffline);

function fitScreen() {
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  const duel = !!app.root.querySelector(":scope > .duel-screen");
  const k = Math.min(3, Math.max(0.3, Math.min(hgt / REF_HEIGHT, w / (duel ? DUEL_WIDTH : MIN_WIDTH))));
  const root = document.documentElement;
  root.style.zoom = k;
  root.style.setProperty("--vh", `${hgt / k / 100}px`);
  root.style.setProperty("--vw", `${w / k / 100}px`);
  if (document.body) measureRectScale();
}
fitScreen();
window.addEventListener("resize", fitScreen);
// Entrando e uscendo dal duello cambia la larghezza di riferimento.
new MutationObserver(fitScreen).observe(app.root, { childList: true });

async function boot() {
  const status = h("div.boot-status", "Loading…");
  app.root.append(h("div.boot", h("div.logo.big", h("span.logo-mark", "◆"), h("span", "HELI"), h("b", "OS")), status));
  try {
    await loadDatabase((t) => (status.textContent = t));
    seedBookmarks();
    // Banlist aggiornate da ProjectIgnis/LFLists (senza aspettare: si gioca subito con quelle che ci sono);
    // le carte proibite escono dai preferiti.
    const prune = () => {
      const out = pruneForbiddenBookmarks();
      if (out.length) toast(`${out.length === 1 ? "1 forbidden card was" : `${out.length} forbidden cards were`} removed from your Bookmarks`);
    };
    prune();
    updateBanlists().then((changed) => {
      if (!changed) return;
      toast("Banlists updated");
      prune();
    });
    if (location.hash === "#ai-vs-ai") return aiVsAi();
    startSocial({ status: () => (inDuel() ? "duel" : "online") });
    home();
  } catch (e) {
    console.error(e);
    status.classList.add("error");
    status.textContent = e.message;
  }
}

boot();
