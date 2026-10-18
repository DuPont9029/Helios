// Registra l'app vera (npm run dev -- --port 5199), scena per scena. Le attese sono marcate "cut" per il montaggio.
//   node record/record.mjs [scena...]   (senza argomenti: tutte, nell'ordine; i dati di prova si caricano alla prima apertura)
import { launch, BASE, WORK, click, moveTo, type, startClip, readJson } from "./rec-lib.mjs";

const C = { ostinato: 9113513, bloom: 84988419, refrain: 64881644, shopina: 5908650, ash: 14558127, couplet: 90276649, sonata: 76990617 };
const melodious = readJson("./melodious.json");
const starter = readJson("../../../public/data/starter-decks.json")[0];

// ── dati di prova: il mazzo Melodious, una combo con Ash Blossom nella mano dell'avversario, la sua variante
//    senza hand trap (con i tag della board finale) e uno spreadsheet che le raccoglie
const details = [
  { t: "zone", places: [{ mine: true, loc: "s", seq: 2 }] },
  { t: "cards", codes: [C.bloom] },
  { t: "pick", code: C.refrain, deck: true },
  { t: "pick", code: C.shopina, deck: true },
  { t: "zone", places: [{ mine: true, loc: "m", seq: 6 }] },
  { t: "pos", pos: 1 },
];
const cards = { main: melodious.main, extra: melodious.extra, side: [] };
const emptySide = { field: [], gy: [], banished: [], deckTop: [] };
const line = {
  id: "bloom", name: "Bloom Diva line", first: true, hand: [C.ostinato], cards,
  steps: [{ kind: "activate", code: C.ostinato, details, note: "No monsters on your field: the materials can come from the Deck" }],
  setup: { me: emptySide, opp: { ...emptySide, hand: [C.ash], extra: [] } },
  interrupts: [{ after: 0, code: C.ash }],
  tags: [{ code: C.bloom, text: "Beatstick" }],
  notes: "One-card line: Ostinato fuses from the Deck. Play around Ash Blossom.",
};
const free = { ...structuredClone(line), id: "bloom-free", parent: "bloom", branch: "No hand traps", setup: undefined, interrupts: [] };
const seed = {
  "ygoweb.decks": [{ id: "melodious", name: "Melodious", main: melodious.main, extra: melodious.extra, side: [] }, { id: "dm", name: starter.name, main: starter.main, extra: starter.extra, side: [] }],
  "ygoweb.settings": { name: "DuPont9029", lastDeck: "melodious", comboStrict: true },
  "ygoweb.combos": {
    v: 2,
    combos: [line, free],
    sheets: [{ id: "guide", name: "Melodious guide", notes: "Start with Ostinato on an empty board. Keep Called by the Grave for Ash Blossom.", combos: ["bloom", "bloom-free"], sample: { main: melodious.main, extra: melodious.extra, side: [] } }],
  },
};

const only = process.argv.slice(2);
const { browser, page } = await launch(seed);
page.setDefaultTimeout(30000);

async function scene(name, fn) {
  if (only.length && !only.includes(name)) return;
  console.log(`▶ ${name}`);
  const clip = await startClip(page, name);
  const cut = async (label, wait) => { clip.mark(`cut:${label}`); await wait(); clip.mark(`end:${label}`); };
  try {
    await fn({ mark: clip.mark, cut });
  } catch (err) {
    await page.screenshot({ path: `${WORK}/fail-${name}.png` });
    throw err;
  } finally {
    console.log(`  ${JSON.stringify(await clip.stop())}`);
  }
}
const pause = (ms) => page.waitForTimeout(ms);
/** Pulsante visibile con quel testo (l'ultimo: es. quello della finestra aperta sopra la pagina). */
const btn = (text, scope = "body") => page.locator(`${scope} button:visible`, { hasText: text }).last();
const home = async (cut) => {
  await page.goto(BASE);
  await cut("load", () => page.waitForSelector(".menu-item"));
  await pause(600);
};
const toTrainer = async () => {
  await click(page, page.locator(".menu-item", { hasText: "Training" }), 700);
  await pause(500);
  await click(page, page.locator(".menu-item", { hasText: "Trainer" }), 600);
  await pause(700);
};
/** Carta nella finestra di scelta aperta (o nella parte del deck builder). */
const modalCard = (code) => page.locator(`.modal-backdrop:not(.closing) .card[data-code="${code}"]`).last();
const handCard = (code) => page.locator(`.hand-0 .card[data-code="${code}"]`).first();
const pickZone = (i = 0) => page.locator(".zone.pickable").nth(i);
const comboRow = (i) => page.locator(".combo-row").nth(i);

// ── 1. Home
await scene("home", async ({ cut }) => {
  await home(cut);
  await pause(1200);
  await moveTo(page, page.locator(".menu-item", { hasText: "Online Duel" }), 900);
  await pause(500);
  await moveTo(page, page.locator(".menu-item", { hasText: "Deck" }).first(), 500);
  await pause(400);
  await click(page, page.locator(".menu-item", { hasText: "Training" }), 600);
  await pause(1500);
  await moveTo(page, page.locator(".menu-item", { hasText: "Trainer" }), 700);
  await pause(1200);
});

// ── 2. Deck builder
await scene("deck", async ({ cut }) => {
  await home(cut);
  await click(page, btn("Edit", ".home-deck"), 900);
  await cut("editor", () => page.waitForSelector(".deck-part .deck-card"));
  await pause(1200);
  await click(page, page.locator(".search-panel input[type=search]").first(), 700);
  await type(page, "Melodious", 70);
  await pause(1300);
  const results = page.locator(".search-panel .result-card, .search-panel .result-row");
  await moveTo(page, results.nth(0), 600);
  await pause(900);
  await moveTo(page, results.nth(5), 500);
  await pause(900);
  await moveTo(page, page.locator(".deck-part.extra .deck-card").nth(4), 800);
  await pause(1200);
  await moveTo(page, page.locator(".deck-part.main .deck-card").nth(2), 700);
  await pause(1200);
});

// ── 3. Registrazione di una combo giocandola
await scene("record", async ({ cut }) => {
  await home(cut);
  await toTrainer();
  await click(page, btn("New combo"), 800);
  await pause(1100);
  await click(page, page.locator(".modal .combo-start", { hasText: "Record by playing" }), 800);
  await pause(900);
  const name = page.locator(".combo-editor input.input").first();
  await click(page, name, 600);
  await page.keyboard.press("ControlOrMeta+a");
  await type(page, "Ostinato into Bloom Diva", 45);
  await pause(400);
  await click(page, page.locator(".combo-hand-pick + .sheet-tools button"), 700);
  await cut("picker", () => page.waitForSelector(".side-editor-layer .deck-part.main .deck-card"));
  await pause(900);
  await click(page, page.locator(`.side-editor-layer .deck-part.main .card[data-code="${C.ostinato}"]`).first(), 800);
  await pause(800);
  await click(page, btn("Done", ".side-editor-layer"), 700);
  await pause(800);
  await click(page, btn("Start recording", ".modal-actions"), 800);
  await cut("duel", () => page.waitForSelector(`.hand-0 .card[data-code="${C.ostinato}"]`, { timeout: 60000 }));
  await pause(1500);
  await click(page, handCard(C.ostinato), 800);
  await pause(500);
  await click(page, btn("Activate", ".action-menu"), 500);
  await pause(900);
  await click(page, pickZone(2), 700);
  await cut("chain", () => modalCard(C.bloom).waitFor());
  await pause(900);
  await click(page, modalCard(C.bloom), 700);
  await cut("materials", () => modalCard(C.refrain).waitFor());
  await pause(700);
  await click(page, modalCard(C.refrain), 700);
  await pause(700);
  await click(page, modalCard(C.shopina), 700);
  await cut("zone", () => pickZone().waitFor());
  await pause(500);
  await click(page, page.locator(".zone.emz.pickable").last(), 700);
  await cut("pos", () => page.locator(".modal-backdrop:not(.closing) .position-card").first().waitFor());
  await pause(500);
  await click(page, page.locator(".modal-backdrop:not(.closing) .position-card").first(), 600);
  await cut("resolve", () => page.waitForSelector(".trainer-step"));
  await pause(2200);
  await click(page, btn("Finish", ".trainer-panel"), 800);
  await cut("editor", () => page.waitForSelector(".combo-editor .detail-row"));
  await pause(1200);
  await moveTo(page, page.locator(".combo-editor .detail-row").nth(2), 800);
  await pause(1500);
  await click(page, btn("Save", ".combo-editor .modal-actions"), 800);
  await pause(1500);
});

// ── 4. Editor: sotto-passi, stato di partenza con la hand trap dell'avversario
await scene("edit", async ({ cut }) => {
  await home(cut);
  await toTrainer();
  await click(page, comboRow(0).locator("button", { hasText: "Edit" }), 900);
  await pause(900);
  const body = page.locator(".combo-editor .modal-body");
  await body.evaluate((el) => el.scrollTo({ top: el.querySelector(".combo-steps-edit").offsetTop - 120, behavior: "smooth" }));
  await pause(1300);
  await moveTo(page, page.locator(".detail-row").nth(1), 700);
  await pause(900);
  await click(page, page.locator(".step-fold").first(), 700);
  await pause(900);
  await click(page, page.locator(".step-fold").first(), 600);
  await pause(800);
  await body.evaluate((el) => el.scrollTo({ top: el.querySelector(".combo-setup").offsetTop - 140, behavior: "smooth" }));
  await pause(1300);
  await moveTo(page, page.locator(".int-use").first(), 800);
  await pause(1600);
  await click(page, btn("Cancel", ".combo-editor .modal-actions"), 800);
  await pause(800);
});

// ── 5. Allenamento: l'avversario interrompe con Ash Blossom
await scene("practice", async ({ cut }) => {
  await home(cut);
  await toTrainer();
  await click(page, comboRow(0).locator("button", { hasText: "Practice" }), 900);
  await cut("duel", () => page.waitForSelector(`.hand-0 .card[data-code="${C.ostinato}"]`, { timeout: 60000 }));
  await pause(1600);
  await click(page, handCard(C.ostinato), 800);
  await pause(500);
  await click(page, btn("Activate", ".action-menu"), 500);
  await pause(800);
  await click(page, pickZone(2), 700);
  await cut("ash", () => page.waitForSelector(".trainer-status.interrupted", { timeout: 30000 }));
  await pause(3500);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Leave")?.click());
  await pause(400);
  await page.evaluate(() => [...document.querySelectorAll(".modal-backdrop.top .modal-actions button")].find((b) => /leave/i.test(b.textContent))?.click());
  await pause(800);
});

// ── 6. Auto-play della variante, fino alla board finale con i tag
await scene("auto", async ({ cut }) => {
  await home(cut);
  await toTrainer();
  await click(page, comboRow(1).locator("button", { hasText: "Auto-play" }), 900);
  await cut("duel", () => page.waitForSelector(".trainer-panel", { timeout: 60000 }));
  await page.waitForSelector(".trainer-status.complete", { timeout: 60000 });
  await pause(3500);
});

// ── 7. Spreadsheet: viewer e carte necessarie nel deck builder
await scene("sheet", async ({ cut }) => {
  await home(cut);
  await toTrainer();
  await click(page, page.locator(".tab", { hasText: "Spreadsheets" }), 700);
  await pause(900);
  await click(page, btn("Open"), 700);
  await pause(2200);
  // Il primo: le carte necessarie (l'altro è la decklist d'esempio).
  await click(page, page.locator("button:visible", { hasText: "View in the Deck Builder" }).first(), 800);
  await cut("viewer", () => page.waitForSelector(".side-editor-layer .deck-card"));
  await pause(1500);
  await moveTo(page, page.locator(".side-editor-layer .deck-card").nth(1), 700);
  await pause(1500);
  await click(page, btn("Close", ".side-editor-layer"), 700);
  await pause(800);
  await moveTo(page, btn("Export"), 700);
  await pause(1000);
});

// ── 8. HDPC: probabilità di aprire gli starter
await scene("hdpc", async ({ cut }) => {
  await home(cut);
  await click(page, page.locator(".menu-item", { hasText: "Training" }), 700);
  await pause(500);
  await click(page, page.locator(".menu-item", { hasText: "HDPC" }), 600);
  await pause(1200);
  await click(page, btn("Choose in the Deck Builder"), 700);
  await cut("picker", () => page.waitForSelector(".side-editor-layer .deck-part.main .deck-card"));
  await pause(800);
  for (const code of [C.ostinato, C.couplet, C.refrain]) {
    await click(page, page.locator(`.side-editor-layer .deck-part.main .card[data-code="${code}"]`).first(), 650);
    await pause(450);
  }
  await click(page, btn("Done", ".side-editor-layer"), 700);
  await pause(1400);
  await moveTo(page, page.locator(".hdpc-result"), 800);
  await pause(2200);
});

// ── 9. Online: P2P, nessun server di gioco
await scene("online", async ({ cut }) => {
  await home(cut);
  await click(page, page.locator(".menu-item", { hasText: "Online Duel" }), 800);
  await pause(1500);
  await moveTo(page, btn("Create Room"), 800);
  await pause(1200);
  await moveTo(page, btn("Join"), 700);
  await pause(1500);
});

await browser.close();
