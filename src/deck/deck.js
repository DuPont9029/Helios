// Mazzi: formati .ydk / ydke:// / codice Omega / lista per nome, salvataggio locale e validazione con le banlist.
import { db, getCard, isExtraDeckCard } from "../data/db.js";
import { TYPE } from "../core/constants.js";

const KEY = "ygoweb.decks";

export function emptyDeck(name = "New Deck") {
  return { id: crypto.randomUUID(), name, main: [], extra: [], side: [] };
}

// ------------------------------------------------------------- .ydk

export function parseYdk(text, name = "Imported Deck") {
  const deck = emptyDeck(name);
  let part = "main";
  // Si legge a token, non a righe: funziona anche se gli a capo sono andati persi incollando.
  // I commenti ("#created by ...") finiscono al primo codice o alla sezione successiva.
  for (const tok of text.split(/\s+/)) {
    if (!tok) continue;
    if (tok.startsWith("#main")) part = "main";
    else if (tok.startsWith("#extra")) part = "extra";
    else if (tok.startsWith("!side")) part = "side";
    else if (/^\d+$/.test(tok)) deck[part].push(parseInt(tok, 10));
  }
  return deck;
}

// ------------------------------------------------------------- codice di YGO Omega
// base64 → deflate "raw" → [n. carte Main+Extra (1 byte), n. carte Side (1 byte), codici uint32 little-endian].
// Main ed Extra sono mescolati e si separano per tipo di carta. Le versioni recenti aggiungono dopo il Side
// una carta "copertina" non contata, che si ignora.

export async function parseOmega(code, name = "Imported Deck") {
  let bytes;
  try {
    const bin = atob(code.trim().replace(/-/g, "+").replace(/_/g, "/"));
    const stream = new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error("Invalid Omega deck code");
  }
  if (bytes.length < 2) throw new Error("Invalid Omega deck code");
  const [mainExtra, side] = bytes;
  if (mainExtra > 75 || side > 15 || bytes.length < 2 + (mainExtra + side) * 4) throw new Error("Invalid Omega deck code");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const deck = emptyDeck(name);
  for (let i = 0; i < mainExtra + side; i++) {
    const c = view.getUint32(2 + i * 4, true);
    if (i >= mainExtra) deck.side.push(c);
    else if (isExtraDeckCard(getCard(c))) deck.extra.push(c);
    else deck.main.push(c);
  }
  return deck;
}

export async function toOmega(deck) {
  const codes = [...deck.main, ...deck.extra, ...deck.side];
  const raw = new Uint8Array(2 + codes.length * 4);
  raw[0] = deck.main.length + deck.extra.length;
  raw[1] = deck.side.length;
  const view = new DataView(raw.buffer);
  codes.forEach((c, i) => view.setUint32(2 + i * 4, c, true));
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return btoa(String.fromCharCode(...out));
}

// ------------------------------------------------------------- lista per nome ("Recipe" di Omega)
// Righe "3 Nome carta" (anche "3x Nome"), con intestazioni come "Monster", "Extra", "Side".

const normName = (n) => n.toLowerCase().normalize("NFKC").replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\u2018\u2019\u201c\u201d"']/g, "").replace(/\s+/g, " ").trim();
let byName = null;

export function parseRecipe(text, name = "Imported Deck") {
  if (!byName) {
    byName = new Map();
    // Prima le carte "originali" (senza alias), così vince il codice principale e non un'arte alternativa.
    for (const c of [...db.list].sort((a, b) => (a.alias ? 1 : 0) - (b.alias ? 1 : 0))) {
      const k = normName(c.name);
      if (!byName.has(k)) byName.set(k, c.code);
    }
  }
  const deck = emptyDeck(name);
  const missing = [];
  let section = "main";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (!m) {
      if (/side/i.test(line)) section = "side";
      else if (/extra/i.test(line)) section = "extra";
      else if (/monster|spell|trap|main/i.test(line)) section = "main";
      continue;
    }
    const code = byName.get(normName(m[2]));
    if (!code) {
      missing.push(m[2]);
      continue;
    }
    const part = section === "side" ? "side" : isExtraDeckCard(getCard(code)) ? "extra" : "main";
    for (let i = 0; i < Math.min(3, +m[1]); i++) deck[part].push(code);
  }
  return { deck, missing };
}

// ------------------------------------------------------------- riconoscimento automatico

/**
 * Importa un mazzo da testo incollato: ydke://, contenuto .ydk, codice Omega o lista per nome.
 * @returns {Promise<{ deck, format, missing: string[] }>}
 */
export async function parseDeckText(text, name = "Imported Deck") {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("Nothing to import: the text is empty");
  if (t.startsWith("ydke://")) return { deck: parseYdke(t, name), format: "ydke", missing: [] };
  if (/#main|#extra|!side/.test(t) || /^[\d\s]+$/.test(t)) {
    return { deck: parseYdk(t, name), format: "ydk", missing: [] };
  }
  if (/^[A-Za-z0-9+/=_-]{16,}$/.test(t)) return { deck: await parseOmega(t, name), format: "omega", missing: [] };
  const { deck, missing } = parseRecipe(t, name);
  if (!deck.main.length && !deck.extra.length && !deck.side.length) throw new Error("Unrecognized format. Paste a .ydk, a ydke:// link, an Omega deck code or a card list (e.g. \"3 Ash Blossom & Joyous Spring\").");
  return { deck, format: "recipe", missing };
}

export function toYdk(deck) {
  return ["#created by Helios", "#main", ...deck.main, "#extra", ...deck.extra, "!side", ...deck.side, ""].join("\n");
}

// ------------------------------------------------------------- ydke://

function b64ToCodes(s) {
  const bin = atob(s);
  const view = new DataView(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) view.setUint8(i, bin.charCodeAt(i));
  const out = [];
  for (let i = 0; i + 4 <= bin.length; i += 4) out.push(view.getUint32(i, true));
  return out;
}

function codesToB64(codes) {
  const view = new DataView(new ArrayBuffer(codes.length * 4));
  codes.forEach((c, i) => view.setUint32(i * 4, c, true));
  let bin = "";
  for (let i = 0; i < view.byteLength; i++) bin += String.fromCharCode(view.getUint8(i));
  return btoa(bin);
}

export function parseYdke(url, name = "Imported Deck") {
  const m = url.trim().match(/^ydke:\/\/([^!]*)!([^!]*)!([^!]*)!?/);
  if (!m) throw new Error("Invalid ydke:// URL");
  return { ...emptyDeck(name), main: b64ToCodes(m[1]), extra: b64ToCodes(m[2]), side: b64ToCodes(m[3]) };
}

export function toYdke(deck) {
  return `ydke://${codesToB64(deck.main)}!${codesToB64(deck.extra)}!${codesToB64(deck.side)}!`;
}

// ------------------------------------------------------------- storage

const OLD_STARTER_NAMES = { "Starter - Mago Nero": "Starter - Dark Magician", "Starter - Drago Bianco": "Starter - Blue-Eyes" };

export function loadDecks() {
  try {
    const decks = JSON.parse(localStorage.getItem(KEY) || "null");
    if (Array.isArray(decks) && decks.length) {
      // Mazzi starter salvati quando l'interfaccia era in italiano: allinea il nome.
      for (const d of decks) d.name = OLD_STARTER_NAMES[d.name] ?? d.name;
      return decks;
    }
  } catch {
    /* ignore */
  }
  // Primo avvio: copia i mazzi starter.
  return db.starters.map((d) => ({ ...emptyDeck(d.name), main: [...d.main], extra: [...d.extra], side: [...d.side] }));
}

export function saveDecks(decks) {
  try {
    localStorage.setItem(KEY, JSON.stringify(decks));
  } catch (e) {
    console.warn("failed to save decks", e);
  }
}

// ------------------------------------------------------------- regole

export function banlistByName(name) {
  return db.banlists.find((b) => b.name === name) ?? null;
}

/** Limite di copie per una carta (3 = libera, 0 = proibita). */
export function cardLimit(banlist, code) {
  if (!banlist) return 3;
  const c = getCard(code);
  const key = String(c?.alias && banlist.cards[c.alias] !== undefined ? c.alias : code);
  if (banlist.cards[key] !== undefined) return banlist.cards[key];
  return banlist.whitelist ? 0 : 3;
}

const baseCode = (code) => {
  const c = getCard(code);
  // Le versioni alternative (alias) contano come la stessa carta.
  return c?.alias && Math.abs(c.alias - code) < 20 ? c.alias : code;
};

/** Restituisce l'elenco dei problemi del mazzo (vuoto = valido). */
export function validateDeck(deck, banlist, { allowUnofficial = false } = {}) {
  const errors = [];
  if (deck.main.length < 40) errors.push(`Main Deck: ${deck.main.length}/40 cards minimum`);
  if (deck.main.length > 60) errors.push(`Main Deck: ${deck.main.length}/60 cards maximum`);
  if (deck.extra.length > 15) errors.push(`Extra Deck: ${deck.extra.length}/15 cards maximum`);
  if (deck.side.length > 15) errors.push(`Side Deck: ${deck.side.length}/15 cards maximum`);
  const counts = new Map();
  for (const code of [...deck.main, ...deck.extra, ...deck.side]) {
    const c = getCard(code);
    if (!c) {
      errors.push(`Unknown card: ${code}`);
      continue;
    }
    if (c.type & TYPE.TOKEN) errors.push(`${c.name}: tokens cannot be in the deck`);
    if (!allowUnofficial && c.source === 1) errors.push(`${c.name}: unofficial card`);
    const k = baseCode(code);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const code of deck.main) if (isExtraDeckCard(getCard(code))) errors.push(`${getCard(code).name} belongs in the Extra Deck`);
  for (const code of deck.extra) if (getCard(code) && !isExtraDeckCard(getCard(code))) errors.push(`${getCard(code).name} is not an Extra Deck card`);
  for (const [code, n] of counts) {
    const limit = Math.min(3, cardLimit(banlist, code));
    if (n > limit) errors.push(`${getCard(code)?.name}: ${n} copies (maximum ${limit})`);
  }
  return [...new Set(errors)];
}

export function sortDeckPart(codes) {
  const rank = (c) => (c.type & TYPE.MONSTER ? 0 : c.type & TYPE.SPELL ? 1 : 2);
  return [...codes].sort((a, b) => {
    const ca = getCard(a);
    const cb = getCard(b);
    if (!ca || !cb) return 0;
    return rank(ca) - rank(cb) || (ca.type & TYPE_ORDER) - (cb.type & TYPE_ORDER) || cb.level - ca.level || ca.name.localeCompare(cb.name);
  });
}
const TYPE_ORDER = TYPE.FUSION | TYPE.SYNCHRO | TYPE.XYZ | TYPE.LINK;
