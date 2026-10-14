import "./styles/main.css";
import "./styles/duel.css";
import { h, clear, icon } from "./ui/dom.js";
import { loadDatabase, db, getCard } from "./data/db.js";
import { settings } from "./data/settings.js";
import { showEditor, showDeckList } from "./ui/editor.js";
import { showLocalSetup, showOnline } from "./ui/play.js";
import { showSettings } from "./ui/settings-page.js";
import { loadDecks } from "./deck/deck.js";
import { cardFace } from "./ui/card.js";

const app = {
  root: document.getElementById("app"),
  current: null,
  onLeave: null,
  home,
};

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
        h("button.btn.ghost.round", { title: "Settings", onclick: go(() => showSettings(app)) }, icon("settings"))
      ),
      h(
        "nav.menu",
        item("Online Duel", "P2P via WebRTC · STUN/TURN", () => showOnline(app)),
        item("Vs CPU", "Test your decks", () => showLocalSetup(app, { vsCpu: true })),
        item("Test Duel", "You control both players", () => showLocalSetup(app, { vsCpu: false })),
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

async function boot() {
  const status = h("div.boot-status", "Loading…");
  app.root.append(h("div.boot", h("div.logo.big", h("span.logo-mark", "◆"), h("span", "HELI"), h("b", "OS")), status));
  try {
    await loadDatabase((t) => (status.textContent = t));
    if (location.hash === "#ai-vs-ai") return aiVsAi();
    home();
  } catch (e) {
    console.error(e);
    status.classList.add("error");
    status.textContent = e.message;
  }
}

boot();
