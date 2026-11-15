// Carte collegate (come "Related Cards" di Master Duel), ricavate dal testo delle carte:
//  - le carte che una carta nomina tra virgolette ("Power Patron DoomZ");
//  - le carte che la nominano;
//  - gli archetipi: i suoi e quelli nominati tra virgolette ("Power Patron" monster), con le carte che ne fanno parte.
// L'indice si costruisce alla prima richiesta (una passata sul testo di tutte le carte).
import { db, getCard } from "./db.js";
import { TYPE } from "../core/constants.js";

let index = null;

// Artwork alternativo (stessa carta, altro codice): non conta come carta a sé.
const isAltArt = (c) => c.alias && Math.abs(c.alias - c.code) < 20 && getCard(c.alias);
const QUOTED = /"([^"\n]{2,80})"/g;

function build() {
  const byName = new Map();
  const cards = db.list.filter((c) => !isAltArt(c) && !(c.type & TYPE.SKILL));
  for (const c of cards) if (!byName.has(c.name.toLowerCase())) byName.set(c.name.toLowerCase(), c.code);
  const setNames = new Map(Object.entries(db.strings.setname ?? {}).map(([code, name]) => [+code, String(name)]));
  // Archetipi recenti senza nome nelle stringhe di EDOPro: il nome è la frase tra virgolette (non il nome di una
  // carta) contenuta nei nomi di più carte di quell'archetipo, es. "Radiant Typhoon".
  const unnamed = new Map();
  for (const c of cards) for (const x of c.setcodes) if (!setNames.has(x)) (unnamed.get(x) ?? unnamed.set(x, []).get(x)).push(c);
  for (const [set, mem] of unnamed) {
    const names = mem.map((c) => c.name.toLowerCase());
    let best = null;
    let score = 0;
    for (const c of mem) {
      for (const [, raw] of (c.desc ?? "").matchAll(QUOTED)) {
        const q = raw.trim();
        if (byName.has(q.toLowerCase())) continue;
        const n = names.filter((x) => x.includes(q.toLowerCase())).length;
        if (n > score) [best, score] = [q, n];
      }
    }
    if (best && score >= Math.max(2, mem.length / 3)) setNames.set(set, best);
  }
  const setByName = new Map([...setNames].map(([code, name]) => [name.toLowerCase(), code]));
  const mentions = new Map();
  const mentionedBy = new Map();
  const sets = new Map(); // carta → archetipi nominati nel testo
  const add = (map, k, v) => (map.get(k) ?? map.set(k, new Set()).get(k)).add(v);
  for (const c of cards) {
    for (const [, raw] of (c.desc ?? "").matchAll(QUOTED)) {
      const name = raw.trim().toLowerCase();
      const code = byName.get(name);
      if (code && code !== c.code && getCard(code)?.name !== c.name) {
        add(mentions, c.code, code);
        add(mentionedBy, code, c.code);
      } else if (setByName.has(name)) add(sets, c.code, setByName.get(name));
    }
  }
  return { cards, mentions, mentionedBy, sets, setNames, members: new Map() };
}

/** Un setcode di una carta appartiene all'archetipo s (anche i sotto-archetipi: 0x1048 è anche 0x48). */
const inSet = (x, s) => (x & 0xfff) === (s & 0xfff) && (x & s & 0xf000) === (s & 0xf000);

function membersOf(set) {
  const idx = index;
  if (!idx.members.has(set)) idx.members.set(set, idx.cards.filter((c) => c.setcodes.some((x) => inSet(x, set))).map((c) => c.code));
  return idx.members.get(set);
}

/**
 * Carte collegate a una carta: { mentions, mentionedBy, archetypes: [{ set, name, codes }] }. Le carte stesse
 * (e i loro artwork alternativi) non compaiono; dentro ogni gruppo prima le più popolari.
 */
export function relatedCards(code) {
  index ??= build();
  const c = getCard(code);
  if (!c) return { mentions: [], mentionedBy: [], archetypes: [] };
  const base = isAltArt(c) ? c.alias : c.code;
  const self = (x) => x === base || getCard(x)?.alias === base;
  const pop = (list) => [...list].filter((x) => !self(x)).sort((a, b) => (getCard(b)?.pop ?? 0) - (getCard(a)?.pop ?? 0));
  const sets = new Set([...(getCard(base)?.setcodes ?? []), ...(index.sets.get(base) ?? [])]);
  return {
    mentions: pop(index.mentions.get(base) ?? []),
    mentionedBy: pop(index.mentionedBy.get(base) ?? []),
    archetypes: [...sets]
      .map((set) => ({ set, name: index.setNames.get(set) ?? null, codes: pop(membersOf(set)) }))
      .filter((a) => a.name && a.codes.length),
  };
}
