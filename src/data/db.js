// Database carte, stringhe e banlist caricati da public/data (vedi scripts/build-data.mjs).
import { parseCard } from "../core/carddata.js";
import { ATTRIBUTES, RACES, TYPE, TYPE_EXTRA } from "../core/constants.js";
import { STANDALONE, loadArchive, archiveText } from "./bundle.js";

export const DATA_URL = new URL("data/", document.baseURI).href;

export const db = {
  cards: new Map(),
  list: [],
  strings: { system: {}, victory: {}, counter: {}, setname: {} },
  banlists: [],
  starters: [],
  manifest: null,
};

export async function loadDatabase(onProgress = () => {}) {
  // Helios in un solo file: i dati sono nell'archivio incorporato nella pagina.
  const pack = STANDALONE ? await loadArchive() : null;
  const get = async (name) => {
    if (pack) return JSON.parse(archiveText(pack, name));
    const res = await fetch(DATA_URL + name);
    if (!res.ok) throw new Error(`Could not load ${name} (HTTP ${res.status}). Did you run "npm run data"?`);
    return res.json();
  };
  onProgress("Loading the card database…");
  const [cards, strings, banlists, starters, manifest] = await Promise.all([
    get("cards.json"), get("strings.json"), get("banlists.json"), get("starter-decks.json"), get("manifest.json"),
  ]);
  for (const row of cards) {
    const c = parseCard(row);
    c.search = (c.name + "\n" + c.desc).toLowerCase();
    db.cards.set(c.code, c);
  }
  db.list = [...db.cards.values()].sort((a, b) => a.name.localeCompare(b.name));
  db.strings = strings;
  db.banlists = banlists;
  db.starters = starters;
  db.manifest = manifest;
}

export const getCard = (code) => db.cards.get(code) ?? null;
export const cardName = (code) => getCard(code)?.name ?? `#${code}`;

export function sysString(id) {
  return db.strings.system[id] ?? `[${id}]`;
}

/**
 * Sostituisce i segnaposto in stile printf delle stringhe di EDOPro (%ls, %s, %d, %X) con args, in ordine.
 * Quelli senza valore diventano "questa carta" (testo) o "?" (numeri).
 */
export function formatString(text, args = []) {
  let i = 0;
  return text.replace(/%(ls|s|d|X|x)/g, (_, t) => (i < args.length ? String(args[i++]) : t === "ls" || t === "s" ? "this card" : "?"));
}

/**
 * Descrizione di un effetto/opzione: (codice << 20) | indice, oppure stringa di sistema.
 * args riempie i segnaposto (es. [nome carta, zona] per "Use the effect of "%ls" from [%ls]?").
 */
export function descString(desc, args = []) {
  const d = BigInt(desc ?? 0);
  if (d === 0n) return "";
  const code = Number(d >> 20n);
  const idx = Number(d & 0xfffffn);
  if (code === 0) return formatString(sysString(idx), args);
  const card = getCard(code);
  if (!card) return `[${code}:${idx}]`;
  return formatString(card.strings[idx] || card.name, args);
}

/**
 * Testo di una HINT_SELECTMSG: di solito una descrizione, ma può essere il codice della carta
 * coinvolta (es. la carta da posizionare). In quel caso usa la stringa di sistema `cardMsg`.
 */
export function hintString(hint, cardMsg = 0) {
  const n = Number(hint);
  const card = Number.isSafeInteger(n) && n < 2 ** 32 ? getCard(n) : null;
  if (card) return cardMsg ? formatString(sysString(cardMsg), [card.name]) : card.name;
  return descString(hint);
}

export function counterName(type) {
  return db.strings.counter[type] ?? `Counter ${type.toString(16)}`;
}

export function victoryString(reason) {
  return db.strings.victory[reason] ?? "";
}

export const isExtraDeckCard = (c) => !!c && (c.type & TYPE_EXTRA) !== 0;
export const isMonster = (c) => !!c && (c.type & TYPE.MONSTER) !== 0;

export function attributeName(attr) {
  return ATTRIBUTES.filter(([bit]) => attr & bit).map(([, n]) => n).join("/") || "—";
}

export function raceName(race) {
  return RACES.filter(([bit]) => race & bit).map(([, n]) => n).join("/") || "—";
}

const TYPE_NAMES = [
  [TYPE.NORMAL, "Normal"], [TYPE.EFFECT, "Effect"], [TYPE.FUSION, "Fusion"], [TYPE.RITUAL, "Ritual"],
  [TYPE.SPIRIT, "Spirit"], [TYPE.UNION, "Union"], [TYPE.GEMINI, "Gemini"], [TYPE.TUNER, "Tuner"],
  [TYPE.SYNCHRO, "Synchro"], [TYPE.TOKEN, "Token"], [TYPE.QUICKPLAY, "Quick-Play"], [TYPE.CONTINUOUS, "Continuous"],
  [TYPE.EQUIP, "Equip"], [TYPE.FIELD, "Field"], [TYPE.COUNTER, "Counter"], [TYPE.FLIP, "Flip"],
  [TYPE.TOON, "Toon"], [TYPE.XYZ, "Xyz"], [TYPE.PENDULUM, "Pendulum"], [TYPE.LINK, "Link"],
];

export function typeLine(c) {
  const parts = TYPE_NAMES.filter(([bit]) => c.type & bit).map(([, n]) => n);
  if (c.type & TYPE.MONSTER) return `[${raceName(c.race)} / ${parts.join(" / ")}]`;
  if (c.type & TYPE.SPELL) return `${parts.join(" ") || "Normal"} Spell`;
  if (c.type & TYPE.TRAP) return `${parts.join(" ") || "Normal"} Trap`;
  return parts.join(" / ");
}

export function statLine(c) {
  if (!(c.type & TYPE.MONSTER)) return "";
  const v = (n) => (n < 0 ? "?" : n);
  if (c.type & TYPE.LINK) return `LINK-${c.level}  ATK ${v(c.atk)}`;
  const lvl = c.type & TYPE.XYZ ? `Rank ${c.level}` : `Level ${c.level}`;
  const scale = c.type & TYPE.PENDULUM ? `  Scale ${c.lscale}/${c.rscale}` : "";
  return `${lvl}  ${attributeName(c.attribute)}  ATK ${v(c.atk)} / DEF ${v(c.def)}${scale}`;
}

/** Nome dell'archetipo dato un setcode (usa le stringhe "!setname"). */
export function setName(code) {
  return db.strings.setname[code] ?? null;
}
