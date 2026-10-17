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
import { seedBookmarks } from "./data/bookmarks.js";
import { showComboTrainer } from "./ui/combos.js";

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

function home() {
  leaveCurrent();
  const root = clear(app.root);
  const go = (fn) => () => { leaveCurrent(); fn(); };
  const item = (title, sub, onClick) =>
    h("button.menu-item", { onclick: go(onClick) }, h("span.menu-title", title), h("span.menu-sub", sub));
  const m = db.manifest ?? {};
  root.append(
    h(
      "div.home",
      h(
        "header.home-head",
        h("div.logo", h("span.logo-mark", "◆"), h("span", "HELI"), h("b", "OS"), h("small", "v0.1")),
        h("div.home-user", "Welcome,", h("b", settings.name)),
        fullscreenButton(),
        h("button.btn.ghost.round", { title: "Settings", onclick: go(() => showSettings(app)) }, icon("settings"))
      ),
      h(
        "nav.menu",
        item("Online Duel", "P2P via WebRTC · STUN/TURN", () => showOnline(app)),
        item("Vs CPU", "Test your decks", () => showLocalSetup(app, { vsCpu: true })),
        item("Test Duel", "You control both players", () => showLocalSetup(app, { vsCpu: false })),
        item("Combo Trainer", "Practice your combos and play around interruptions", () => showComboTrainer(app)),
        item("Deck", `${loadDecks().length} decks · ${db.cards.size.toLocaleString("en-US")} cards`, () => showDeckList(app)),
        item("Settings", "Name, network, graphics", () => showSettings(app))
      ),
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
    if (location.hash === "#ai-vs-ai") return aiVsAi();
    home();
  } catch (e) {
    console.error(e);
    status.classList.add("error");
    status.textContent = e.message;
  }
}

boot();
