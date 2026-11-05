// Draft giocati, salvati nel browser: i pool di tutti i posti, il mio mazzo e i risultati delle partite.
// Regole del mazzo (dalla guida): Main Deck almeno 30, Extra Deck al massimo 15, tutto il resto del pool è il
// sideboard, nessun limite di copie oltre a quelle draftate, nessuna banlist. Il mazzo si costruisce liberamente fino
// alla prima partita; poi resta fisso e tra un duello e l'altro si scambiano carte con il sideboard una per una
// (Main ed Extra Deck tengono la loro dimensione per tutta la partita).
import { getCard, isExtraDeckCard } from "../data/db.js";
import { artBase } from "../deck/deck.js";
import { newId } from "./format.js";
import { poolCards } from "./table.js";
import { seededRandom } from "./packs.js";
import { tourState, outSeats, pairId } from "./tournament.js";

const KEY = "ygoweb.draftRuns";
export const DRAFT_DECK = { minMain: 30, maxExtra: 15 };

export function loadRuns() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveRuns(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export const getRun = (id) => loadRuns().find((r) => r.id === id) ?? null;

export function storeRun(run) {
  const list = loadRuns().filter((r) => r.id !== run.id);
  list.unshift(run);
  saveRuns(list);
  return run;
}

export function deleteRun(id) {
  saveRuns(loadRuns().filter((r) => r.id !== id));
}

/** Draft finito: un run con i pool dei posti (dal tavolo) e il mio mazzo di partenza (tutto nel sideboard). */
export function newRun(table, { me = 0, bestOf = 3, botDecks = [], side = null } = {}) {
  const f = table.format;
  return {
    id: newId(),
    created: Date.now(),
    format: { id: f.id, name: f.name, mode: f.mode, rarities: f.rarities, rev: f.rev ?? 1, hash: f.hash ?? null },
    bestOf,
    me,
    seats: table.seats.map((s, i) => ({ name: s.name, bot: s.bot, binder: s.binder.map(stripItem), deck: s.bot ? botDecks[i] : null })),
    deck: side ? trackedDraftDeck(table.seats[me].binder, side) : emptyDraftDeck(table.seats[me].binder),
    locked: false,
    results: [], // le mie partite: { id, opp: posto, wins: [mie, sue], won, at, replay: null }
    botMatches: null, // partite tra bot (testa o croce), vedi botMatches()
  };
}

const stripItem = (x) => ({ uid: x.uid, id: x.id, round: x.round, label: x.label, rarity: x.rarity, main: x.main, extra: x.extra, pickNo: x.pickNo, ...(x.cover ? { cover: x.cover } : {}) });

/** Mazzo tenuto durante il draft: tutto il pool nel mazzo tranne le carte messe nel Side (side: codici, con le copie). */
export function trackedDraftDeck(binder, side) {
  const { main, extra } = poolCards(binder);
  const left = new Map();
  for (const c of side) left.set(c, (left.get(c) ?? 0) + 1);
  const keep = (c) => {
    const n = left.get(c) ?? 0;
    if (!n) return true;
    left.set(c, n - 1);
    return false;
  };
  const deckMain = main.filter(keep);
  const deckExtra = extra.filter(keep);
  return { main: deckMain, extra: deckExtra, side: [...withoutOnce([...main, ...extra], [...deckMain, ...deckExtra])] };
}
const withoutOnce = (codes, minus) => {
  const left = new Map();
  for (const c of minus) left.set(c, (left.get(c) ?? 0) + 1);
  return codes.filter((c) => {
    const n = left.get(c) ?? 0;
    if (!n) return true;
    left.set(c, n - 1);
    return false;
  });
};

/** Mazzo vuoto: tutto il pool nel sideboard. */
export function emptyDraftDeck(binder) {
  const { main, extra } = poolCards(binder);
  return { main: [], extra: [], side: [...main, ...extra] };
}

const count = (list) => {
  const m = new Map();
  for (const c of list) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
};

/** Problemi del mazzo rispetto alle regole del draft e al pool (lista vuota = valido). */
export function draftDeckErrors(deck, binder) {
  const errs = [];
  if (deck.main.length < DRAFT_DECK.minMain) errs.push(`Main Deck: ${deck.main.length} cards, at least ${DRAFT_DECK.minMain}.`);
  if (deck.extra.length > DRAFT_DECK.maxExtra) errs.push(`Extra Deck: ${deck.extra.length} cards, at most ${DRAFT_DECK.maxExtra}.`);
  const wrongMain = deck.main.filter((c) => isExtraDeckCard(getCard(c)));
  const wrongExtra = deck.extra.filter((c) => !isExtraDeckCard(getCard(c)));
  if (wrongMain.length) errs.push(`Extra Deck monsters in the Main Deck: ${[...new Set(wrongMain)].map((c) => getCard(c)?.name).join(", ")}.`);
  if (wrongExtra.length) errs.push(`Main Deck cards in the Extra Deck: ${[...new Set(wrongExtra)].map((c) => getCard(c)?.name).join(", ")}.`);
  // Solo carte del pool, nel numero draftato.
  // Per carta base: un artwork alternativo scelto nel deck builder è la stessa carta del pool.
  const { main, extra } = poolCards(binder);
  const have = count([...main, ...extra].map(artBase));
  const used = count([...deck.main, ...deck.extra, ...deck.side].map(artBase));
  for (const [c, n] of used) if (n > (have.get(c) ?? 0)) errs.push(`${getCard(c)?.name ?? c}: ${n} copies used, ${have.get(c) ?? 0} drafted.`);
  return errs;
}

/** Side tra i duelli: stesse carte del mazzo bloccato, Main ed Extra Deck della stessa dimensione. */
export function sideErrors(deck, locked) {
  const errs = [];
  if (deck.main.length !== locked.main.length) errs.push(`The Main Deck must stay at ${locked.main.length} cards (now ${deck.main.length}).`);
  if (deck.extra.length !== locked.extra.length) errs.push(`The Extra Deck must stay at ${locked.extra.length} cards (now ${deck.extra.length}).`);
  return errs;
}

/** Le mie partite: vinte e perse. */
export function runRecord(run) {
  const won = run.results.filter((r) => r.won).length;
  return { played: run.results.length, won, lost: run.results.length - won };
}

/**
 * Partite tra bot (una per coppia), decise a testa o croce game per game fino a quando uno arriva alle vittorie che
 * servono nel best of. Si decidono una volta sola e restano nel run.
 */
export function botMatches(run, rnd = null) {
  if (run.botMatches) return run.botMatches;
  // Draft online: stesso seme per tutti, così ognuno vede gli stessi risultati tra i bot.
  rnd ??= run.seed != null ? seededRandom(run.seed) : Math.random;
  const need = Math.ceil(run.bestOf / 2);
  const bots = run.seats.map((s, i) => (s.bot && !s.gone ? i : -1)).filter((i) => i >= 0);
  run.botMatches = [];
  for (let x = 0; x < bots.length; x++)
    for (let y = x + 1; y < bots.length; y++) {
      const wins = [0, 0];
      while (wins[0] < need && wins[1] < need) wins[rnd() < 0.5 ? 0 : 1]++;
      run.botMatches.push({ id: run.seed != null ? `bot-${x}-${y}` : newId(), a: bots[x], b: bots[y], wins, coin: true, at: run.created, replay: null });
    }
  return run.botMatches;
}

/**
 * Tutte le partite del tavolo nello stesso formato: { id, a, b, wins: [di a, di b], coin, at, replay }.
 * replay: posto per il replay della partita (non ancora registrato).
 */
export function allMatches(run) {
  const mine = run.results.map((r) => ({ id: r.id ?? `${r.opp}-${r.at}`, a: run.me, b: r.opp, wins: r.wins, coin: false, at: r.at, replay: r.replay ?? null }));
  if (!run.online) return [...mine, ...botMatches(run)];
  // Torneo online: anche le partite degli altri (dai record sui relay), una per coppia; via quelle dei bot tolti e
  // dei giocatori tolti con un voto che ha deciso di non contarle.
  const st = tourState(run);
  const pairs = new Set(mine.map((m) => pairId(m.a, m.b)));
  const others = st.results.filter((m) => !pairs.has(pairId(m.a, m.b)));
  const drop = (i) => st.bots.has(i) || st.removed.get(i)?.keep === false;
  return [...mine, ...others, ...botMatches(run)].filter((m) => !drop(m.a) && !drop(m.b));
}

/** Partite che restano da giocare (round robin: tutti contro tutti, una partita per coppia, tra chi è ancora dentro). */
export function matchesLeft(run) {
  const out = run.online ? outSeats(run) : new Set(run.seats.map((s, i) => (s.gone ? i : -1)));
  const n = run.seats.filter((_, i) => !out.has(i)).length;
  return (n * (n - 1)) / 2 - allMatches(run).filter((m) => !out.has(m.a) && !out.has(m.b)).length;
}

/**
 * Classifica: percentuale di match vinti, a pari merito la percentuale di game vinti.
 * [{ seat, name, bot, played, won, lost, games: [vinti, persi], mwr, gwr }] dal primo all'ultimo. Chi è fuori dal
 * torneo non è in classifica (le partite contro di lui contano per gli altri, se il voto le ha tenute).
 */
export function standings(run) {
  const out = run.online ? outSeats(run) : new Set(run.seats.map((s, i) => (s.gone ? i : -1)));
  const rows = run.seats.map((s, seat) => (out.has(seat) ? null : { seat, name: s.name, bot: s.bot, played: 0, won: 0, lost: 0, games: [0, 0] }));
  for (const m of allMatches(run)) {
    const aWon = m.wins[0] > m.wins[1];
    const add = (r, won, gw, gl) => {
      if (!r) return;
      r.played++;
      won ? r.won++ : r.lost++;
      r.games[0] += gw;
      r.games[1] += gl;
    };
    add(rows[m.a], aWon, m.wins[0], m.wins[1]);
    add(rows[m.b], !aWon, m.wins[1], m.wins[0]);
  }
  const rate = (w, t) => (t ? w / t : 0);
  const live = rows.filter(Boolean);
  for (const r of live) {
    r.mwr = rate(r.won, r.played);
    r.gwr = rate(r.games[0], r.games[0] + r.games[1]);
  }
  return live.sort((x, y) => y.mwr - x.mwr || y.gwr - x.gwr || y.played - x.played);
}
