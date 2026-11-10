// Statistiche globali di una versione di un cube (formato di draft), raccolte sui relay Nostr.
// Ogni giocatore pubblica, per ogni draft giocato, un record pubblico e senza nomi: l'impronta della versione del
// cube (formatHash), le sue scelte (oggetto, round, numero della scelta), il mazzo con cui ha giocato e le partite
// vinte e perse. Evento NIP-78 (kind 30078) sostituibile: un record per draft, aggiornato a ogni risultato.
// Chi apre le statistiche raccoglie i record di tutti per quell'impronta (anche dei draft a cui non ha partecipato).
import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { identity, fromHex } from "./identity.js";
import { eloRelays } from "./elo.js";
import { sharedPool } from "./social.js";
import { getCard } from "../data/db.js";
import { bundleCover } from "../draft/format.js";

const KIND = 30078;
const TAG = (hash) => `helios-cube-${hash}`;
const now = () => Math.floor(Date.now() / 1000);

let ownPool = null;
const pool = () => sharedPool() ?? (ownPool ??= new SimplePool({ enablePing: true, enableReconnect: true }));

/** Record del draft (solo le mie scelte: i bot e gli altri giocatori pubblicano i loro, i bot non contano). */
function runStats(run) {
  const binder = run.seats?.[run.me]?.binder ?? [];
  const won = run.results.filter((r) => r.won).length;
  const lost = run.results.length - won;
  const deck = run.deck && run.deck.main.length ? [...run.deck.main, ...run.deck.extra] : null;
  return {
    v: 1,
    cube: { id: run.format.id, rev: run.format.rev ?? 1, hash: run.format.hash },
    picks: binder.map((x) => [x.id, x.round, x.pickNo ?? 0]),
    deck: run.results.length ? deck : null,
    won,
    lost,
  };
}

/** Pubblica (o aggiorna) il record del draft. Senza impronta (draft giocati prima delle versioni) non si pubblica. */
export async function publishRunStats(run) {
  if (!run?.format?.hash) return;
  const { sk } = identity();
  const content = JSON.stringify(runStats(run));
  const ev = finalizeEvent({ kind: KIND, created_at: now(), tags: [["d", `helios-cube-stats:${run.id}`], ["t", TAG(run.format.hash)]], content }, fromHex(sk));
  await Promise.allSettled(pool().publish(eloRelays(), ev));
}

/** Pubblica senza aspettare né fermarsi sugli errori (i relay possono non rispondere). */
export const shareRunStats = (run) => publishRunStats(run).catch((e) => console.warn("Cube stats not published:", e));

/**
 * Statistiche della versione con impronta `hash`. f = il formato (nomi dei bundle e delle carte). Per ogni bundle,
 * carta singola e carta nei mazzi: quante volte è stato scelto, la scelta media, il win rate delle partite dei mazzi
 * che l'hanno giocato e un punteggio per la classifica.
 */
export async function fetchCubeStats(hash, f) {
  const evs = await pool().querySync(eloRelays(), { kinds: [KIND], "#t": [TAG(hash)], limit: 3000 }, { maxWait: 8000 });
  // L'ultimo record di ogni draft (autore + d).
  const latest = new Map();
  for (const ev of evs) {
    if (!verifyEvent(ev)) continue;
    const d = ev.tags.find((t) => t[0] === "d")?.[1];
    const key = `${ev.pubkey}:${d}`;
    if (!latest.has(key) || latest.get(key).created_at < ev.created_at) latest.set(key, ev);
  }
  const recs = [];
  for (const ev of latest.values()) {
    try {
      const r = JSON.parse(ev.content);
      if (r?.v === 1 && r.cube?.hash === hash && Array.isArray(r.picks)) recs.push({ ...r, author: ev.pubkey });
    } catch {
      /* record non valido */
    }
  }
  const items = new Map(); // id → { picked, pickSum, wins, games }
  const cards = new Map(); // codice → { wins, games, inDecks }
  const item = (id) => items.get(id) ?? (items.set(id, { picked: 0, pickSum: 0, wins: 0, games: 0 }), items.get(id));
  const bundlesById = new Map(f.bundles.map((b) => [b.id, b]));
  const singlesById = new Map(f.singles.map((s) => [s.id, s]));
  let matches = 0;
  for (const r of recs) {
    for (const [id, , pickNo] of r.picks) {
      const x = item(id);
      x.picked++;
      x.pickSum += +pickNo || 0;
    }
    const games = (+r.won || 0) + (+r.lost || 0);
    if (!Array.isArray(r.deck) || !games) continue;
    matches += games;
    const inDeck = new Map();
    for (const c of r.deck) inDeck.set(c, (inDeck.get(c) ?? 0) + 1);
    for (const code of inDeck.keys()) {
      const c = cards.get(code) ?? { wins: 0, games: 0, inDecks: 0 };
      c.wins += +r.won || 0;
      c.games += games;
      c.inDecks++;
      cards.set(code, c);
    }
    // Un bundle "giocato": almeno metà delle sue carte nel mazzo; una carta singola: la carta nel mazzo.
    for (const [id, round] of r.picks) {
      const b = round === 1 ? bundlesById.get(id) : null;
      const s = round === 2 ? singlesById.get(id) : null;
      const all = b ? [...b.main, ...b.extra] : s ? [s.code] : [];
      if (!all.length) continue;
      const used = all.filter((c) => inDeck.has(c)).length;
      if (used * 2 >= all.length) {
        const x = item(id);
        x.wins += +r.won || 0;
        x.games += games;
      }
    }
  }
  // Punteggio: win rate "prudente" (con poche partite tende al 50%) e quanto presto viene scelto.
  const score = (x, avgPick) => {
    const wr = (x.wins + 2.5) / (x.games + 5);
    const early = avgPick == null ? 0.5 : 1 - Math.min(14, Math.max(0, avgPick - 1)) / 14;
    return 0.6 * wr + 0.4 * early;
  };
  const rank = (list) => list.sort((a, b) => b.score - a.score).map((x, i) => ({ ...x, rank: i + 1 }));
  const entry = (x, extra) => {
    const avgPick = x.picked ? x.pickSum / x.picked : null;
    return { ...extra, picked: x.picked, avgPick, wins: x.wins, games: x.games, winRate: x.games ? x.wins / x.games : null, score: score(x, avgPick) };
  };
  const bundles = rank(f.bundles.filter((b) => items.has(b.id)).map((b) => entry(items.get(b.id), { id: b.id, label: b.name, cover: bundleCover(b) })));
  const singles = rank(f.singles.filter((s) => items.has(s.id)).map((s) => entry(items.get(s.id), { id: s.id, code: s.code, label: getCard(s.code)?.name ?? `#${s.code}` })));
  const cardList = rank([...cards].map(([code, c]) => ({ code, label: getCard(code)?.name ?? `#${code}`, picked: c.inDecks, avgPick: null, wins: c.wins, games: c.games, winRate: c.games ? c.wins / c.games : null, score: (c.wins + 2.5) / (c.games + 5) })));
  return { drafts: recs.length, players: new Set(recs.map((r) => r.author)).size, matches, bundles, singles, cards: cardList, at: Date.now() };
}
