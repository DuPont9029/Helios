// Fa giocare due IA con i mazzi starter direttamente nel core (Node), due volte
// con lo stesso seed, e verifica che le partite siano identiche (determinismo
// necessario per il lockstep P2P).
import fs from "node:fs";
import path from "node:path";
import createCore from "../src/core/ocgcore.js";
import { DuelEngine } from "../src/core/engine.js";
import { parseCard } from "../src/core/carddata.js";
import { SimpleAI } from "../src/core/ai.js";
import { DUEL_MODES, MSG } from "../src/core/constants.js";

const DATA = path.resolve(import.meta.dirname, "../public/data");
const cards = new Map(JSON.parse(fs.readFileSync(path.join(DATA, "cards.json"), "utf8")).map((r) => [r[0], parseCard(r)]));
const decks = JSON.parse(fs.readFileSync(path.join(DATA, "starter-decks.json"), "utf8"));
const lib = await createCore({ sync: true });

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function play(seed) {
  const errors = [];
  const missing = new Set();
  const engine = new DuelEngine(lib, {
    getCard: (code) => cards.get(code) ?? null,
    readScript: (name) => {
      try { return fs.readFileSync(path.join(DATA, "script", name), "utf8"); }
      catch { missing.add(name); return null; }
    },
    log: (type, text) => errors.push(`[${type}] ${text}`),
  });
  engine.start({
    flags: DUEL_MODES.MR5.flags, seed: [seed, 2n, 3n, 4n], lp: 8000, hand: 5, draw: 1,
    decks: [decks[0], decks[1]],
  });
  const ais = [0, 1].map((p) => new SimpleAI({ getCard: (c) => cards.get(c), allCards: cards.values(), random: mulberry(Number(seed) + p) }));
  const trace = [];
  const seen = {};
  let steps = 0, retries = 0;
  while (true) {
    const { messages, prompt, ended } = engine.run();
    for (const m of messages) { seen[m.type] = (seen[m.type] ?? 0) + 1; if (m.type === MSG.RETRY) retries++; }
    if (ended || !prompt) break;
    if (engine.turn > 40 || ++steps > 5000) break;
    const resp = ais[prompt.player].respond(prompt, { turn: engine.turn });
    engine.respond(resp);
    trace.push(engine.checksum());
  }
  const snap = engine.snapshot();
  engine.destroy();
  return { trace, turn: engine.turn, winner: engine.winner, lp: snap.players.map((p) => p.lp), steps, retries, errors, missing, seen };
}

const t0 = performance.now();
const a = play(42n);
const t1 = performance.now();
const b = play(42n);
console.log(`partita: ${a.steps} risposte, ${a.turn} turni, vincitore ${a.winner}, LP ${a.lp}, retry ${a.retries}, ${(t1 - t0).toFixed(0)} ms`);
console.log("messaggi visti:", Object.keys(a.seen).length, "tipi");
if (a.missing.size) console.log("script mancanti:", [...a.missing].join(", "));
if (a.errors.length) console.log("errori script:", a.errors.slice(0, 10));
const same = a.trace.length === b.trace.length && a.trace.every((h, i) => h === b.trace[i]);
console.log(same ? "OK determinismo: le due partite sono identiche" : "ERRORE: partite divergenti");
const c = play(7n);
console.log(`seconda partita (seed 7): ${c.steps} risposte, ${c.turn} turni, vincitore ${c.winner}, LP ${c.lp}, retry ${c.retries}`);
if (c.errors.length) console.log("errori script:", c.errors.slice(0, 10));
process.exit(same && !a.errors.length ? 0 : 1);
