// Formati di draft (Draft → editor): il pool curato dall'host e le sue regole, salvati nel browser.
// Una modalità decide come si usa il pool; per ora c'è l'Helios Bundle Draft (round 1 bundle, round 2 carte singole,
// vedi "Helios Bundle Draft — Implementation Guide.md"), le altre sono annunciate come "coming soon".
//
// Formato:
//   { id, name, mode, version, updated,
//     rarities: [{ id, name, color }]            dalla più bassa alla più alta; decide solo la scelta automatica allo
//                                                scadere del tempo e l'animazione quando si apre un pacchetto
//     bundles:  [{ id, name, rarity, tags, main: [codici], extra: [codici] }]   round 1
//     singles:  [{ id, code, rarity, tags }]                                    round 2
//     rules:    [{ id, round, kind: "apart" | "atLeast" | "atMost", a?, b?, tag?, n? }]  regole dei pacchetti }
import { getCard, isExtraDeckCard } from "../data/db.js";

const KEY = "ygoweb.drafts";
export const FORMAT_VERSION = 1;
export const PACK_SIZE = 15;
// Un bundle deve avere almeno tante carte del Main Deck (le carte dell'Extra Deck non contano).
export const BUNDLE_MIN_MAIN = 2;

/** Modalità di draft: l'editor e (più avanti) il tavolo si adattano alla modalità del formato. */
export const DRAFT_MODES = [
  { id: "bundle", name: "H.B.D.", full: "Helios Bundle Draft", sub: "Helios Bundle Draft · round 1 bundles, round 2 single cards · 15 + 15 picks", available: true },
  { id: "cube", name: "Cube Draft", sub: "Three rounds of single cards from your cube", available: false },
  { id: "sealed", name: "Sealed", sub: "Open packs, build a deck from what you get", available: false },
  { id: "rochester", name: "Rochester Draft", sub: "Packs opened face-up on the table", available: false },
  { id: "winston", name: "Winston Draft", sub: "Two players, piles that grow until someone takes them", available: false },
  { id: "grid", name: "Grid Draft", sub: "Take a row or a column of a 3×3 grid", available: false },
];
export const modeOf = (id) => DRAFT_MODES.find((m) => m.id === id) ?? DRAFT_MODES[0];

/** Rarità di partenza di un formato nuovo (il creatore le cambia, aggiunge e toglie come vuole). */
export const DEFAULT_RARITIES = [
  { name: "Common", color: "#9aa3b2" },
  { name: "Rare", color: "#38c6ff" },
  { name: "Super Rare", color: "#b56cff" },
  { name: "Ultra Rare", color: "#ffc52e" },
  { name: "Secret Rare", color: "#ff5ac8" },
];

export const RULE_KINDS = {
  apart: "Never in the same pack",
  atLeast: "At least N items with a tag",
  atMost: "At most N items with a tag",
};

export const newId = () => Math.random().toString(36).slice(2, 10);

export function newFormat(mode = "bundle", name = "New Draft") {
  return {
    id: newId(),
    name,
    mode,
    version: FORMAT_VERSION,
    updated: Date.now(),
    rarities: DEFAULT_RARITIES.map((r) => ({ id: newId(), ...r })),
    bundles: [],
    singles: [],
    rules: [],
  };
}

export const newBundle = (rarity = null) => ({ id: newId(), name: "New bundle", rarity, tags: [], main: [], extra: [] });
export const newSingle = (code, rarity = null) => ({ id: newId(), code, rarity, tags: [] });

// ---------------------------------------------------------------- salvataggio

export function loadFormats() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.map(cleanFormat).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function saveFormats(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** Salva (o aggiunge) un formato. */
export function storeFormat(f) {
  const list = loadFormats();
  const i = list.findIndex((x) => x.id === f.id);
  const copy = { ...structuredClone(f), updated: Date.now() };
  if (i >= 0) list[i] = copy;
  else list.unshift(copy);
  saveFormats(list);
  return copy;
}

export function deleteFormat(id) {
  saveFormats(loadFormats().filter((f) => f.id !== id));
}

// ---------------------------------------------------------------- import / export

const FILE_TYPE = "helios-draft";

export function exportFormat(f) {
  return JSON.stringify({ type: FILE_TYPE, version: FORMAT_VERSION, format: f }, null, 1);
}

/** Legge un file esportato: un formato pulito con un id nuovo (non sovrascrive quello da cui è stato esportato). */
export function importFormat(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("not a draft file (invalid JSON)");
  }
  if (data?.type !== FILE_TYPE || !data.format) throw new Error("not a Helios draft file");
  if (data.version > FORMAT_VERSION) throw new Error("made with a newer version of Helios");
  const f = cleanFormat(data.format);
  if (!f) throw new Error("the draft file is damaged");
  return { ...f, id: newId() };
}

// Normalizza un formato letto da fuori (file, localStorage, rete): solo i campi noti, con i tipi giusti.
const str = (v, max = 80) => (typeof v === "string" ? v.slice(0, max) : "");
const codes = (v) => (Array.isArray(v) ? v.filter((c) => Number.isInteger(c) && c > 0).slice(0, 200) : []);
const tags = (v) => (Array.isArray(v) ? [...new Set(v.map((t) => str(t, 30).trim()).filter(Boolean))].slice(0, 20) : []);
const colorOk = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : "#9aa3b2");

export function cleanFormat(f) {
  if (!f || typeof f !== "object") return null;
  const rarities = (Array.isArray(f.rarities) ? f.rarities : [])
    .filter((r) => r && typeof r.id === "string")
    .slice(0, 30)
    .map((r) => ({ id: str(r.id, 20), name: str(r.name, 40) || "Rarity", color: colorOk(r.color) }));
  const known = new Set(rarities.map((r) => r.id));
  const rarity = (v) => (known.has(v) ? v : null);
  const bundles = (Array.isArray(f.bundles) ? f.bundles : []).slice(0, 2000).map((b) => ({
    id: str(b?.id, 20) || newId(),
    name: str(b?.name, 60) || "Bundle",
    rarity: rarity(b?.rarity),
    tags: tags(b?.tags),
    main: codes(b?.main),
    extra: codes(b?.extra),
  }));
  const singles = (Array.isArray(f.singles) ? f.singles : [])
    .slice(0, 5000)
    .filter((s) => Number.isInteger(s?.code) && s.code > 0)
    .map((s) => ({ id: str(s.id, 20) || newId(), code: s.code, rarity: rarity(s.rarity), tags: tags(s.tags) }));
  const rules = (Array.isArray(f.rules) ? f.rules : []).slice(0, 100).flatMap((r) => {
    if (!r || !RULE_KINDS[r.kind]) return [];
    const base = { id: str(r.id, 20) || newId(), round: r.round === 2 ? 2 : 1, kind: r.kind };
    if (r.kind === "apart") return [{ ...base, a: str(r.a, 20), b: str(r.b, 20) }];
    return [{ ...base, tag: str(r.tag, 30).trim(), n: Math.max(0, Math.min(PACK_SIZE, Math.round(+r.n) || 0)) }];
  });
  return {
    id: str(f.id, 20) || newId(),
    name: str(f.name, 60) || "Draft",
    mode: DRAFT_MODES.some((m) => m.id === f.mode) ? f.mode : "bundle",
    version: FORMAT_VERSION,
    updated: Number.isFinite(f.updated) ? f.updated : Date.now(),
    rarities,
    bundles,
    singles,
    rules,
  };
}

// ---------------------------------------------------------------- oggetti dei due round

/** Oggetti del round (1 = bundle, 2 = singole): { id, rarity, tags, label, codes }. */
export function roundItems(f, round) {
  return round === 1
    ? f.bundles.map((b) => ({ id: b.id, rarity: b.rarity, tags: b.tags, label: b.name, codes: [...b.main, ...b.extra], item: b }))
    : f.singles.map((s) => ({ id: s.id, rarity: s.rarity, tags: s.tags, label: getCard(s.code)?.name ?? `#${s.code}`, codes: [s.code], item: s }));
}

/** Posizione della rarità (più alta = più rara); senza rarità -1, sotto tutte le altre. */
export const rarityRank = (f, id) => f.rarities.findIndex((r) => r.id === id);
export const rarityOf = (f, id) => f.rarities.find((r) => r.id === id) ?? null;

/** Tutti i tag usati nel formato (per i suggerimenti). */
export function allTags(f) {
  return [...new Set([...f.bundles, ...f.singles].flatMap((x) => x.tags))].sort((a, b) => a.localeCompare(b));
}

/** Carte del bundle nella parte sbagliata (un mostro dell'Extra Deck nel Main o viceversa). */
export function misplaced(b) {
  return [...b.main.filter((c) => isExtraDeckCard(getCard(c))), ...b.extra.filter((c) => getCard(c) && !isExtraDeckCard(getCard(c)))];
}
