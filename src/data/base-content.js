// Contenuti base del gioco: i "Base decks" di livello base (default-decks.js), sempre disponibili anche dopo averli
// cancellati dai propri mazzi (al primo avvio se ne trova una copia tra i propri), e una combo per ognuno nel Trainer
// (provate con l'auto-play: arrivano a "Combo complete!").
import { settings } from "./settings.js";
import { DEFAULT_DECKS } from "./default-decks.js";

/** Base decks pronti da mostrare nella schermata Deck. */
export const BASE_DECKS_READY = true;
/** Combo base nel Trainer pronte: per ora no (il Trainer mostra "Coming soon"). */
export const BASE_READY = false;

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
  if (!BASE_DECKS_READY) return [];
  const off = hidden();
  return DEFAULT_DECKS.filter((d) => !off.has(d.name)).map((d) => ({
    id: `base:${d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: d.name,
    level: d.level ?? "Basic",
    main: [...d.main],
    extra: [...d.extra],
    side: [...(d.side ?? [])],
  }));
}

// Combo dei mazzi base (decklist = il mazzo base, per nome). Le scelte precise seguono i tipi del core: "cards" per
// le ricerche con conferma, "pick" per le carte scelte una alla volta (costi, materiali). Da preparare per i Base
// decks di default-decks.js (quelle dei vecchi mazzi starter non valgono più).
const COMBOS = [];

/** Combo base (in sola lettura nel Trainer), con la decklist del loro mazzo base; quelle senza mazzo si saltano. */
export function baseCombos() {
  if (!BASE_READY) return [];
  return COMBOS.flatMap(({ deck, ...c }) => {
    const d = DEFAULT_DECKS.find((x) => x.name === deck);
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
