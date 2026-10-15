// Partite "best of" (al meglio di 3 o 5 duelli): punteggio e testi.
// wins = [mie, dell'avversario] dal punto di vista di questo client; un pareggio non conta.

export const BEST_OF = { 1: "Single Duel", 3: "Best of 3", 5: "Best of 5" };

export function newSeries(bestOf) {
  const n = [1, 3, 5].includes(+bestOf) ? +bestOf : 1;
  return { bestOf: n, game: 1, wins: [0, 0], over: false };
}

const needed = (s) => Math.floor(s.bestOf / 2) + 1;

/** Registra l'esito di un duello ("me", "opp" o null = pareggio). */
export function recordGame(s, outcome) {
  if (outcome === "me") s.wins[0]++;
  else if (outcome === "opp") s.wins[1]++;
  s.over = s.wins.some((w) => w >= needed(s));
  if (!s.over) s.game++;
}

/** Testo per il pannello del duello: "Best of 3 · Game 2 · 1–0". */
export const seriesLabel = (s) => `${BEST_OF[s.bestOf]} · Game ${s.game} · ${s.wins[0]}–${s.wins[1]}`;
