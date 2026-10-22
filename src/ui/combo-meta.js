// Informazioni di una combo per le schede del Trainer (ispirate a ygopocket.com/combos): difficoltà, formato,
// archetipi, OTK, statistiche calcolate dai passi e board finale. Il board finale si salva quando la combo
// arriva a "Combo complete" (in pratica o in auto-play); finché manca si usano i tag della combo.
import { NO_CARD } from "../duel/trainer.js";
import { getCard } from "../data/db.js";
import { TYPE } from "../core/constants.js";

export const DIFFICULTIES = ["Beginner", "Intermediate", "Advanced", "Expert"];
export const FORMATS = ["TCG", "OCG", "Master Duel", "Genesys", "Other"];

/** Carte del board finale: quello salvato a fine combo, altrimenti le carte con un tag. */
export function endBoard(c) {
  if (Array.isArray(c.endBoard) && c.endBoard.length) return c.endBoard;
  return [...new Set((c.tags ?? []).map((t) => t.code).filter(Boolean))];
}

/** Statistiche dai passi: summon, carte prese dal Deck, carte in mano alla fine (se note). */
export function comboStats(c) {
  const steps = c.steps ?? [];
  const normal = steps.filter((s) => s.kind === "summon").length;
  const special = steps.filter((s) => s.kind === "spsummon" || s.kind === "pendulum").length;
  const fromDeck = steps.flatMap((s) => s.details ?? []).filter((d) => d.deck === true || (Array.isArray(d.deck) && d.deck.length)).length;
  return {
    starters: c.hand?.length ?? 0,
    steps: steps.length,
    board: endBoard(c).length,
    normal,
    special,
    fromDeck,
    handEnd: Number.isInteger(c.endHand) ? c.endHand : null,
    // Stime, come su ygopocket: Nibiru dalla 5ª summon dell'avversario nel turno, Droll se si prendono più carte dal Deck.
    nibiru: normal + special >= 5,
    droll: fromDeck >= 2,
  };
}

/** Archetipi della combo: quelli scritti, altrimenti quelli più comuni tra le carte dei passi. */
export function archetypes(c) {
  if (Array.isArray(c.archetypes) && c.archetypes.length) return c.archetypes;
  return [];
}

/** Testo per la ricerca e i filtri. */
export function comboCodes(c) {
  return {
    start: new Set(c.hand ?? []),
    uses: new Set([...(c.hand ?? []), ...(c.steps ?? []).filter((s) => !NO_CARD.has(s.kind)).map((s) => s.code)]),
    end: new Set(endBoard(c)),
  };
}

/** Starter più frequenti tra le combo (per la striscia "Popular starters"). */
export function popularStarters(combos, n = 16) {
  const count = new Map();
  for (const c of combos) for (const code of new Set(c.hand ?? [])) count.set(code, (count.get(code) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || (getCard(a[0])?.name ?? "").localeCompare(getCard(b[0])?.name ?? "")).slice(0, n).map(([code, k]) => ({ code, count: k }));
}

/** Carte sul campo del giocatore a fine combo (dallo stato del duello): mostri, magie/trappole, Terreno. */
export function boardFromSnapshot(snapshot, me) {
  const ps = snapshot?.players?.[me];
  if (!ps) return [];
  const codes = [...(ps.mzone ?? []), ...(ps.szone ?? [])].filter((x) => x?.code).map((x) => x.code);
  // Prima i mostri dell'Extra Deck, poi gli altri mostri, poi magie e trappole.
  const rank = (code) => {
    const t = getCard(code)?.type ?? 0;
    return t & (TYPE.FUSION | TYPE.SYNCHRO | TYPE.XYZ | TYPE.LINK) ? 0 : t & TYPE.MONSTER ? 1 : 2;
  };
  return codes.sort((a, b) => rank(a) - rank(b)).slice(0, 13);
}
