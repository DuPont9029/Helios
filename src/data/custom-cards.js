// Carte personalizzate: fatte nel client (ui/custom-cards.js) con i loro dati e il loro script Lua, salvate nel
// browser (IndexedDB: l'artwork pesa) e aggiunte al database delle carte (db.cards, db.list), così si usano come le
// altre: deck builder, duelli, replay. Il motore le riceve dopo l'avvio (EngineClient → comando "custom" del worker).
// Online ognuno manda all'avversario le carte personalizzate del proprio mazzo (dati, script e artwork piccolo,
// net/match.js): le vede e il suo motore le gioca uguali. L'immagine della carta la disegna ogni client dai dati.
//
// Una carta: { v, code, name, desc, type, attribute, race, level, atk, def, lscale, rscale, linkMarker, setcodes,
// strings, script, art, updated }. level = Level, Rank o Link Rating; atk/def -2 = "?".
import { db } from "./db.js";
import { parseCard } from "../core/carddata.js";
import { TYPE } from "../core/constants.js";
import { customImages, customArts } from "./card-images.js";
import { renderCardImage, compactArt } from "../ui/card-render.js";

// Codici delle carte personalizzate: sopra quelli delle carte vere (e dei token) e sotto 2^31: il motore passa i codici
// come interi a 32 bit con segno (oltre, la carta non si trova più e diventa una carta senza dati).
export const CUSTOM_MIN = 2_000_000_000;
const CUSTOM_MAX = 2_147_000_000;
export const isCustomCode = (code) => Number.isInteger(code) && code >= CUSTOM_MIN && code <= CUSTOM_MAX;
export const CARD_PREFIX = "HELIOS-CARD:";
export const SOURCE_CUSTOM = 3;

// Limiti (anche per quelle che arrivano dall'avversario): script e artwork restano piccoli.
const MAX_SCRIPT = 32_000;
// Artwork salvato qui alla qualità migliore (fino a 1200 px); a chi lo riceve arriva ridotto (customCardsForSending).
const MAX_ART = 2_500_000; // caratteri del data URL
const MAX_PEND = 1000;
const MAX_DESC = 3000;

const local = new Map(); // carte salvate qui (codice → carta)
const remote = new Map(); // carte ricevute in questa sessione (avversario, replay importati)

// ---------------------------------------------------------------- IndexedDB

const IDB = "helios-custom-cards";
const STORE = "cards";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "code" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDo(mode, fn) {
  const d = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Browser storage unavailable"));
    });
  } finally {
    d.close();
  }
}

// ---------------------------------------------------------------- dati

const int = (v, lo, hi, d = 0) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

/** Carta pulita (tipi e limiti giusti) o null: per quelle salvate, importate o mandate dall'avversario. */
export function cleanCard(c) {
  if (!c || typeof c !== "object" || !isCustomCode(c.code)) return null;
  const type = int(c.type, 0, 0x7ffffff, 0);
  if (!(type & (TYPE.MONSTER | TYPE.SPELL | TYPE.TRAP))) return null;
  const art = typeof c.art === "string" && c.art.length <= MAX_ART && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(c.art) ? c.art : null;
  return {
    v: 1,
    code: c.code,
    name: str(c.name, 60).trim() || "Custom card",
    desc: str(c.desc, MAX_DESC),
    pendText: str(c.pendText, MAX_PEND), // testo del riquadro Pendulum
    type: type & ~TYPE.TOKEN & ~TYPE.SKILL,
    attribute: int(c.attribute, 0, 0x7f),
    race: int(c.race, 0, 0x7ffffff),
    level: int(c.level, 0, 13),
    atk: int(c.atk, -2, 1_000_000),
    def: int(c.def, -2, 1_000_000),
    lscale: int(c.lscale, 0, 13),
    rscale: int(c.rscale, 0, 13),
    linkMarker: int(c.linkMarker, 0, 0x1ff),
    setcodes: Array.isArray(c.setcodes) ? c.setcodes.filter((x) => int(x, 1, 0xffff, 0)).slice(0, 4) : [],
    strings: Array.isArray(c.strings) ? c.strings.slice(0, 16).map((s) => str(s, 200)) : [],
    script: str(c.script, MAX_SCRIPT),
    // lo script segue il tipo della carta (procedure di evocazione) finché non lo si modifica a mano
    scriptAuto: c.scriptAuto === true,
    art,
    updated: int(c.updated, 0, 1e15, 0),
  };
}

/** Riga del database (formato di scripts/build-data.mjs, vedi core/carddata.js). */
export function cardRow(c) {
  const link = !!(c.type & TYPE.LINK);
  const level = (c.level & 0xff) | ((c.lscale & 0xff) << 24) | ((c.rscale & 0xff) << 16);
  // Pendulum: nel testo della carta come in quelle ufficiali (effetto Pendulum, poi quello del mostro).
  const desc = c.type & TYPE.PENDULUM && c.pendText ? `[ Pendulum Effect ]\n${c.pendText}\n----------------------------------------\n[ Monster Effect ]\n${c.desc}` : c.desc;
  return [c.code, 0x3, 0, c.setcodes, c.type, c.atk, link ? c.linkMarker : c.def, level, c.race, c.attribute, 0, c.name, desc, c.strings, SOURCE_CUSTOM];
}

/** La carta entra nel database del client (o lo aggiorna) con la sua immagine. */
async function register(c) {
  const card = parseCard(cardRow(c));
  card.search = (card.name + "\n" + card.desc).toLowerCase();
  card.custom = true;
  db.cards.set(card.code, card);
  const i = db.list.findIndex((x) => x.code === card.code);
  if (i >= 0) db.list.splice(i, 1);
  // db.list è in ordine di nome: la carta va al suo posto.
  const at = db.list.findIndex((x) => x.name.localeCompare(card.name) > 0);
  db.list.splice(at < 0 ? db.list.length : at, 0, card);
  if (c.art) customArts.set(c.code, c.art);
  else customArts.delete(c.code);
  try {
    customImages.set(c.code, await renderCardImage(c));
  } catch {
    customImages.delete(c.code); // senza immagine resta la cornice disegnata in CSS
  }
}

function unregister(code) {
  db.cards.delete(code);
  const i = db.list.findIndex((x) => x.code === code);
  if (i >= 0) db.list.splice(i, 1);
  customImages.delete(code);
  customArts.delete(code);
}

/** All'avvio (dopo loadDatabase): le carte personalizzate salvate entrano nel database. */
export async function loadCustomCards() {
  let all = [];
  try {
    all = (await idbDo("readonly", (s) => s.getAll())) ?? [];
  } catch {
    return;
  }
  for (const raw of all) {
    const c = cleanCard(raw);
    if (!c) continue;
    local.set(c.code, c);
    await register(c);
  }
}

/** Carte personalizzate salvate qui, dalla più recente. */
export const customCards = () => [...local.values()].sort((a, b) => b.updated - a.updated);

export const getCustomCard = (code) => remote.get(code) ?? local.get(code) ?? null;

/** Codice nuovo, libero. */
export function newCustomCode() {
  for (;;) {
    const code = CUSTOM_MIN + Math.floor(Math.random() * (CUSTOM_MAX - CUSTOM_MIN));
    if (!db.cards.has(code)) return code;
  }
}

/** Salva (nuova o modificata) e la mette nel database. Restituisce la carta salvata. */
export async function saveCustomCard(raw) {
  const c = cleanCard({ ...raw, updated: Date.now() });
  if (!c) throw new Error("Invalid card");
  await idbDo("readwrite", (s) => s.put(c));
  local.set(c.code, c);
  remote.delete(c.code);
  await register(c);
  return c;
}

export async function deleteCustomCard(code) {
  await idbDo("readwrite", (s) => s.delete(code));
  local.delete(code);
  if (!remote.has(code)) unregister(code);
}

// Stessa carta mandata da entrambi i giocatori in due versioni: vince la più recente (a parità, il contenuto). Tutti e
// due i client scelgono la stessa, così i motori restano uguali.
const newer = (a, b) => a.updated > b.updated || (a.updated === b.updated && JSON.stringify(a) > JSON.stringify(b));

/**
 * Carte ricevute (dall'avversario online, da un replay o da un codice da guardare): valgono per questa sessione e
 * hanno la precedenza su una versione salvata qui, perché il motore deve giocare le stesse dell'altro giocatore.
 * sent: le carte che ho mandato io all'avversario (per le carte che abbiamo entrambi, vedi newer). Restituisce i
 * codici registrati.
 */
export async function useRemoteCards(list, sent = []) {
  const out = [];
  for (const raw of Array.isArray(list) ? list.slice(0, 120) : []) {
    const c = cleanCard(raw);
    if (!c) continue;
    const mine = cleanCard(sent.find((x) => x?.code === c.code));
    if (mine && newer(mine, c)) {
      // vale la mia (anche per lui): torna quella, se prima ne era registrata un'altra
      if (remote.has(c.code)) {
        remote.delete(c.code);
        if (local.has(c.code)) await register(local.get(c.code));
      }
      continue;
    }
    remote.set(c.code, c);
    await register(c);
    out.push(c.code);
  }
  return out;
}

/** Le carte personalizzate tra questi codici (per mandarle all'avversario o metterle in un replay). */
export function customCardsIn(codes, { art = true } = {}) {
  const seen = new Set();
  const out = [];
  for (const code of codes ?? []) {
    if (!isCustomCode(code) || seen.has(code)) continue;
    seen.add(code);
    const c = getCustomCard(code);
    if (c) out.push(art ? c : { ...c, art: null });
  }
  return out;
}

/**
 * Le carte personalizzate tra questi codici, pronte da mandare (all'avversario, in un replay): l'artwork si riduce
 * finché il tutto sta in budget caratteri; se non basta, si mandano senza (la carta si disegna lo stesso).
 */
export async function customCardsForSending(codes, budget = 250_000) {
  const list = customCardsIn(codes);
  if (!list.length) return [];
  for (const [size, q] of [[420, 0.85], [300, 0.78], [200, 0.7]]) {
    const out = [];
    for (const c of list) out.push(c.art ? { ...c, art: await compactArt(c.art, size, q).catch(() => null) } : c);
    if (JSON.stringify(out).length <= budget) return out;
  }
  return customCardsIn(codes, { art: false });
}

/** Per il motore (comando "custom" del worker): righe del database e script di tutte le carte personalizzate. */
export function enginePayload() {
  const all = new Map([...local, ...remote]);
  return {
    rows: [...all.values()].map(cardRow),
    scripts: Object.fromEntries([...all.values()].map((c) => [`c${c.code}.lua`, c.script || defaultScript(c)])),
  };
}

/** Script minimo: i mostri Normali non hanno effetti; agli altri serve almeno initial_effect. */
export function defaultScript(c) {
  return `-- ${c.name}\nlocal s,id=GetID()\nfunction s.initial_effect(c)\nend\n`;
}

// ---------------------------------------------------------------- codice da condividere

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
const toB64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** Codice di una o più carte (con script e artwork). */
export async function cardsToCode(cards) {
  const json = new TextEncoder().encode(JSON.stringify({ v: 1, cards }));
  return CARD_PREFIX + toB64(await pipe(json, new CompressionStream("gzip")));
}

/** Carte da un codice (errore leggibile se non è valido); non le salva. */
export async function cardsFromCode(text) {
  const s = String(text ?? "").trim().replace(/\s+/g, "");
  if (!s.startsWith(CARD_PREFIX)) throw new Error("This is not a Helios card code (it starts with HELIOS-CARD:)");
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(await pipe(fromB64(s.slice(CARD_PREFIX.length)), new DecompressionStream("gzip"))));
  } catch {
    throw new Error("The card code is damaged: copy it again, all of it");
  }
  const cards = (Array.isArray(data?.cards) ? data.cards : []).map(cleanCard).filter(Boolean);
  if (!cards.length) throw new Error("The code has no valid cards");
  return cards;
}
