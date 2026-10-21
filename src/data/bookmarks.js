// Preferiti predefiniti: aggiunti ai preferiti di ogni giocatore una sola volta per carta.
// settings.bookmarksSeeded ricorda le carte predefinite già proposte: se il giocatore ne toglie una
// non torna dopo gli aggiornamenti; se l'aveva già tra i preferiti non viene duplicata né spostata.
import { settings } from "./settings.js";
import { db, getCard } from "./db.js";
import { parseRecipe, banlistByName, cardLimit } from "../deck/deck.js";
import { DEFAULT_BOOKMARKS } from "./default-bookmarks.js";

// Stessa carta anche se salvata con un'arte alternativa.
const base = (code) => {
  const c = getCard(code);
  return c?.alias && Math.abs(c.alias - code) < 20 ? c.alias : code;
};

export function seedBookmarks() {
  const { deck, missing } = parseRecipe(DEFAULT_BOOKMARKS);
  if (missing.length) console.warn("Default bookmarks not found in the card database:", missing);
  const seeded = new Set(settings.bookmarksSeeded ?? []);
  const fresh = [...deck.main, ...deck.extra].filter((c) => !seeded.has(c));
  if (!fresh.length) return;
  const marks = settings.bookmarks ?? [];
  const have = new Set(marks.map(base));
  // In fondo alla lista: quella del giocatore resta com'è.
  settings.bookmarks = [...marks, ...fresh.filter((c) => !have.has(base(c)))];
  settings.bookmarksSeeded = [...seeded, ...fresh];
}

/**
 * Toglie dai preferiti le carte proibite (limite 0) nella banlist in uso nel deck builder (o la prima, TCG).
 * Solo quelle proibite esplicitamente: nelle liste "whitelist" (es. GOAT) le carte non elencate restano.
 * Restituisce le carte tolte.
 */
export function pruneForbiddenBookmarks() {
  const list = banlistByName(settings.lastBanlist) ?? db.banlists[0];
  const marks = settings.bookmarks ?? [];
  if (!list || !marks.length) return [];
  const removed = marks.filter((code) => (list.whitelist ? list.cards[String(code)] === 0 : cardLimit(list, code) === 0));
  if (removed.length) settings.bookmarks = marks.filter((code) => !removed.includes(code));
  return removed;
}
