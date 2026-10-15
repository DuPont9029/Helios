// Preferiti predefiniti: aggiunti ai preferiti di ogni giocatore una sola volta per carta.
// settings.bookmarksSeeded ricorda le carte predefinite già proposte: se il giocatore ne toglie una
// non torna dopo gli aggiornamenti; se l'aveva già tra i preferiti non viene duplicata né spostata.
import { settings } from "./settings.js";
import { getCard } from "./db.js";
import { parseRecipe } from "../deck/deck.js";
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
