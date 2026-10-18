// Partite "best of N" (al meglio di N duelli, N scelto dall'host): punteggio e testi.
// wins = [mie, dell'avversario] dal punto di vista di questo client; un pareggio non conta.

export const MAX_BEST_OF = 99;

/**
 * Numero di duelli della partita: dispari (una partita pari potrebbe finire in parità), da 1 (duello singolo)
 * a MAX_BEST_OF. Un numero pari sale al dispari successivo (4 → 5).
 */
export function clampBestOf(n) {
  const v = Math.min(MAX_BEST_OF, Math.max(1, Math.floor(+n) || 1));
  return v % 2 ? v : Math.min(MAX_BEST_OF, v + 1);
}

export const bestOfLabel = (n) => (n > 1 ? `Best of ${n}` : "Single Duel");

export function newSeries(bestOf) {
  return { bestOf: clampBestOf(bestOf), game: 1, wins: [0, 0], over: false };
}

// Vince chi arriva per primo alla maggioranza dei duelli (es. 2 su 3, 3 su 5, 4 su 7).
const needed = (s) => Math.floor(s.bestOf / 2) + 1;

/**
 * Registra l'esito di un duello ("me", "opp" o null = pareggio). Un pareggio non conta né come vittoria
 * né come sconfitta: lo stesso Game si ripete (il numero non avanza).
 */
export function recordGame(s, outcome) {
  if (outcome === "me") s.wins[0]++;
  else if (outcome === "opp") s.wins[1]++;
  s.over = s.wins.some((w) => w >= needed(s));
  if (!s.over && outcome) s.game++;
}

/** Testo per il pannello del duello: "Best of 3 · Game 2 · 1–0". */
export const seriesLabel = (s) => `${bestOfLabel(s.bestOf)} · Game ${s.game} · ${s.wins[0]}–${s.wins[1]}`;
