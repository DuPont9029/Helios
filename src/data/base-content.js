// Contenuti base del gioco: i mazzi starter (public/data/starter-decks.json, vedi scripts/build-data.mjs) come
// "Base decks" di livello base, sempre disponibili anche dopo averli cancellati dai propri mazzi, e una combo
// per ognuno nel Trainer (provate con l'auto-play: arrivano a "Combo complete!").
import { db } from "./db.js";
import { settings } from "./settings.js";

/** Mazzi e combo base pronti da mostrare: per ora no (le schermate mostrano "Coming soon"). */
export const BASE_READY = false;

/** Livello dei mazzi base (se starter-decks.json non lo indica). */
const LEVELS = { "Starter - Dark Magician": "Basic", "Starter - Blue-Eyes": "Basic" };

// Mazzi base cancellati dal giocatore (settings.hiddenBaseDecks: nomi): spariscono con le loro combo base,
// finché non li si ripristina dalla schermata Deck.
const hidden = () => new Set(Array.isArray(settings.hiddenBaseDecks) ? settings.hiddenBaseDecks : []);
export function hideBaseDeck(name) {
  settings.hiddenBaseDecks = [...hidden(), name];
}
export function restoreBaseDecks() {
  settings.hiddenBaseDecks = [];
}
export const hiddenBaseDecks = () => hidden().size;

/** Mazzi base (senza quelli cancellati): { id, name, level, main, extra, side }. */
export function baseDecks() {
  if (!BASE_READY) return [];
  const off = hidden();
  return (db.starters ?? []).filter((d) => !off.has(d.name)).map((d) => ({
    id: `base:${d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: d.name,
    level: d.level ?? LEVELS[d.name] ?? "Basic",
    main: [...d.main],
    extra: [...d.extra],
    side: [...(d.side ?? [])],
  }));
}

// Combo dei mazzi base (decklist = il mazzo base). Le scelte precise seguono i tipi del core: "cards" per le
// ricerche con conferma, "pick" per le carte scelte una alla volta (costi, materiali).
const COMBOS = [
  {
    id: "base-blue-eyes",
    deck: "Starter - Blue-Eyes",
    name: "Blue-Eyes Spirit Dragon on turn 1",
    notes: "Basic line: reveal Blue-Eyes White Dragon to Special Summon Alternative, Normal Summon Sage with Eyes of Blue and add The White Stone of Ancients, then use Sage (a Level 1 Tuner) and Alternative for Blue-Eyes Spirit Dragon. Set your traps and keep Blue-Eyes White Dragon in your hand.",
    hand: [38517737, 89631133, 8240199, 44095762, 4206964],
    steps: [
      { kind: "spsummon", code: 38517737 },
      { kind: "summon", code: 8240199 },
      { kind: "activate", code: 8240199, details: [{ t: "cards", codes: [71039903] }] },
      { kind: "spsummon", code: 59822133, details: [{ t: "pick", code: 8240199 }, { t: "pick", code: 38517737 }] },
      { kind: "set", code: 44095762 },
      { kind: "set", code: 4206964 },
    ],
    tags: [{ code: 59822133, text: "GY negate" }],
  },
  {
    id: "base-dark-magician",
    deck: "Starter - Dark Magician",
    name: "Dark Magician on turn 1",
    notes: "Basic line: Magician's Rod adds Dark Magical Circle, Apprentice Illusion Magician (discard Trap Hole) adds Dark Magician, then Magicians' Souls sends a Dark Magician from the Deck to the GY and brings it back. Set Dark Magical Circle and Mirror Force; next turn Dark Magician in your hand is another summon.",
    hand: [7084129, 30603688, 97631303, 44095762, 4206964],
    steps: [
      { kind: "summon", code: 7084129 },
      { kind: "activate", code: 7084129, details: [{ t: "cards", codes: [47222536] }] },
      { kind: "spsummon", code: 30603688, details: [{ t: "pick", code: 4206964 }] },
      { kind: "activate", code: 30603688 },
      { kind: "activate", code: 97631303, details: [{ t: "cards", codes: [36996508] }, { t: "option", desc: "102373841174531" }, { t: "yesno", yes: true }, { t: "cards", codes: [36996508] }] },
      { kind: "set", code: 47222536 },
      { kind: "set", code: 44095762 },
    ],
    tags: [{ code: 36996508, text: "Beatstick" }, { code: 30603688, text: "+2000 ATK in battle" }],
  },
];

/** Combo base (in sola lettura nel Trainer), con la decklist del loro mazzo base; quelle senza mazzo si saltano. */
export function baseCombos() {
  if (!BASE_READY) return [];
  return COMBOS.flatMap(({ deck, ...c }) => {
    const d = (db.starters ?? []).find((x) => x.name === deck);
    if (!d || hidden().has(d.name)) return [];
    const empty = () => ({ field: [], gy: [], banished: [], deckTop: [] });
    return [{
      ...structuredClone(c),
      first: true,
      base: true,
      deckName: d.name,
      interrupts: [],
      setup: { me: empty(), opp: { ...empty(), hand: [], extra: [] } },
      cards: { main: [...d.main], extra: [...d.extra], side: [] },
    }];
  });
}
