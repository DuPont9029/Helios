// Titoli dei giocatori dal rating ELO, presi dagli scacchi (FIDE e classi USCF) con un titolo di Helios al posto del
// FIDE Master. Le soglie sono riportate alla scala di Helios: tutti partono da 1500 con K = 32 (src/net/elo.js).
// Da Candidate Master in su il titolo resta anche se il rating scende: vale il rating più alto mai raggiunto
// (peak, calcolato da tutti i client dalle stesse partite pubbliche); salendo si viene promossi.
export const TITLES = [
  { min: 1900, abbr: "GM", name: "Grandmaster", color: "#ffcf3b" },
  { min: 1800, abbr: "IM", name: "International Master", color: "#ff7ad9" },
  { min: 1700, abbr: "HM", name: "Helios Master", color: "#9b8cff" },
  { min: 1600, abbr: "CM", name: "Candidate Master", color: "#5fe3ff" },
  { min: 1550, abbr: "EX", name: "Expert", color: "#7dffb0" },
  { min: 1500, abbr: "A", name: "Class A", color: "#c3cad6" },
  { min: 1450, abbr: "B", name: "Class B", color: "#d9a46c" },
  { min: -Infinity, abbr: "C", name: "Class C", color: "#b07a52" },
];
export const UNRATED = { min: null, abbr: "—", name: "Unrated", color: "#8b93a7" };
/** Da qui in su il titolo è per sempre. */
export const KEEP_FROM = 1600;
/** Titoli con la sigla davanti al nome (come GM negli scacchi). */
export const MASTER_TITLES = new Set(["GM", "IM", "HM", "CM"]);

const index = (rating) => TITLES.findIndex((t) => rating >= t.min);

/**
 * Titolo del giocatore: { abbr, name, color, min, next, kept } (kept: tenuto dal rating più alto, sopra quello di
 * adesso). Unrated senza partite classificate.
 */
export function titleOf(rating, games, peak = rating) {
  if (!games) return { ...UNRATED, next: TITLES.at(-3), kept: false };
  let i = index(rating);
  let kept = false;
  if (peak >= KEEP_FROM && index(peak) < i) {
    i = index(peak);
    kept = true;
  }
  return { ...TITLES[i], next: i > 0 ? TITLES[i - 1] : null, kept };
}
