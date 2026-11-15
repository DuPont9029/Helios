// Banlist personalizzate: fatte dal giocatore (da zero o partendo da una banlist ufficiale), salvate nel browser e
// aggiunte in fondo a db.banlists, così valgono ovunque si sceglie una banlist (deck builder, duelli, partite online).
// Online l'host manda la banlist intera insieme alle regole (options.customBanlist, vedi net/guard.js): l'ospite
// non deve averla. Si condividono anche come codice "HELIOS-BANLIST:".
// Una banlist: { id, name, whitelist, cards: { codice: limite 0-3 } } (whitelist: le carte non elencate sono proibite).
import { db } from "./db.js";

const KEY = "helios.customBanlists";
export const BANLIST_PREFIX = "HELIOS-BANLIST:";
const MAX_CARDS = 20000;

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.map(clean).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    throw new Error("The browser storage is full: the banlist was not saved");
  }
  syncCustomBanlists();
}

/** Banlist personalizzate salvate. */
export const customBanlists = () => read();

/**
 * Le banlist personalizzate in fondo a db.banlists (al posto di quelle di prima): da chiamare dopo il caricamento
 * dei dati e dopo ogni aggiornamento delle banlist ufficiali.
 */
export function syncCustomBanlists() {
  const official = (db.banlists ?? []).filter((b) => !b.custom);
  db.banlists = [...official, ...read().map((c) => ({ name: c.name, whitelist: c.whitelist, cards: c.cards, custom: true, id: c.id }))];
}

/**
 * Banlist personalizzata dell'host di una partita online (l'ospite non ce l'ha): vale per questa sessione, al posto
 * di una sua con lo stesso nome; non si salva (la prossima syncCustomBanlists la toglie).
 */
export function useRemoteBanlist(b) {
  db.banlists = [...db.banlists.filter((x) => !(x.custom && x.name === b.name)), { name: b.name, whitelist: b.whitelist, cards: b.cards, custom: true, remote: true }];
}

/** Opzioni del duello: la banlist personalizzata scelta, da mandare all'ospite (undefined se è ufficiale). */
export function customBanlistFor(name) {
  const b = name ? db.banlists.find((x) => x.custom && x.name === name) : null;
  return b ? { name: b.name, whitelist: b.whitelist === true, cards: b.cards } : undefined;
}

/** Nome libero: diverso da quello delle banlist ufficiali e delle altre personalizzate. */
function freeName(name, id) {
  const base = String(name || "Custom banlist").trim().slice(0, 50) || "Custom banlist";
  const taken = new Set((db.banlists ?? []).filter((b) => !(b.custom && b.id === id)).map((b) => b.name));
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base} (${i})`;
  return n;
}

/** Salva (nuova o modificata) e restituisce la banlist salvata. */
export function saveCustomBanlist(b) {
  const list = read();
  const id = b.id ?? crypto.randomUUID().slice(0, 12);
  const item = clean({ ...b, id, name: freeName(b.name, id) });
  if (!item) throw new Error("Invalid banlist");
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list[i] = item;
  else list.push(item);
  write(list);
  return item;
}

export function deleteCustomBanlist(id) {
  write(read().filter((b) => b.id !== id));
}

// ---------------------------------------------------------------- controllo (anche per i dati dall'esterno)

/** Banlist pulita (tipi e limiti giusti) o null. Va bene anche per quella mandata dall'host. */
export function clean(b) {
  if (!b || typeof b !== "object" || typeof b.name !== "string" || !b.name.trim() || !b.cards || typeof b.cards !== "object") return null;
  const entries = Object.entries(b.cards);
  if (entries.length > MAX_CARDS) return null;
  const cards = {};
  for (const [k, v] of entries) {
    if (!/^\d{1,10}$/.test(k) || !Number.isInteger(v) || v < 0 || v > 3) return null;
    cards[k] = v;
  }
  return { id: typeof b.id === "string" ? b.id.slice(0, 40) : undefined, name: b.name.trim().slice(0, 60), whitelist: b.whitelist === true, cards };
}

/** Impronta del contenuto (per distinguere due banlist con lo stesso nome, es. nel matchmaking). */
export function banlistHash(b) {
  const s = JSON.stringify([b.whitelist === true, Object.entries(b.cards).sort(([x], [y]) => +x - +y)]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

// ---------------------------------------------------------------- codice

const toB64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function banlistToCode(b) {
  return BANLIST_PREFIX + toB64(new TextEncoder().encode(JSON.stringify({ v: 1, name: b.name, whitelist: b.whitelist === true, cards: b.cards })));
}

/** Banlist da un codice (errore leggibile se non è valido); non la salva. */
export function banlistFromCode(text) {
  const s = String(text ?? "").trim().replace(/\s+/g, "");
  if (!s.startsWith(BANLIST_PREFIX)) throw new Error("This is not a Helios banlist code (it starts with HELIOS-BANLIST:)");
  let b;
  try {
    b = clean(JSON.parse(new TextDecoder().decode(fromB64(s.slice(BANLIST_PREFIX.length)))));
  } catch {
    b = null;
  }
  if (!b) throw new Error("The banlist code is damaged: copy it again, all of it");
  delete b.id;
  return b;
}
