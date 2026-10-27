// Classifica ELO senza server: i risultati delle partite classificate sono firmati da entrambi i giocatori
// (identity.js) e pubblicati come eventi Nostr sui relay pubblici; ogni client scarica gli eventi, verifica
// le firme e calcola da sé la classifica, con le stesse regole per tutti.
//
// Una partita classificata ha:
//  - un "start" firmato da entrambi prima di giocare (id della partita = impronta del seed comune, giocatori
//    e nomi): prova che i due hanno accettato di giocarla;
//  - un "result" firmato da entrambi a fine duello (il vincitore lo calcola ognuno con il proprio motore,
//    che è deterministico: se non coincide, nessuno dei due firma);
//  - chi esce (Leave, Surrender, chiusura della scheda) perde: la sua firma della sconfitta è pronta da inizio
//    partita e parte subito, l'avversario la controfirma e il risultato si pubblica come gli altri;
//  - se uno sparisce senza firmare, una "abandon" pubblicata dall'altro con lo start firmato da entrambi:
//    vale come vittoria per chi resta; se entrambi dichiarano l'abbandono dell'altro, perdono tutti e due.
// Regole del rating: tutti partono da 1500, K = 32; contano al massimo 5 partite al giorno contro lo stesso
// avversario (contro le partite "pilotate" tra due account propri).
import { schnorr } from "@noble/secp256k1";
import { settings } from "../data/settings.js";
import { identity, canonical, sha256Hex, signHash, verifyHash, fromHex, toHex } from "./identity.js";

export const APP = "helios-elo";
const VERSION = 1;
const TAG = "helios-elo-v1";
const KIND = 30078; // NIP-78: dati di un'applicazione (non compaiono nei feed social)
export const START_RATING = 1500;
const K = 32;
const PER_PAIR_PER_DAY = 5;
const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://offchain.pub", "wss://relay.snort.social"];
const OUTBOX = "ygoweb.eloOutbox";

/** Relay usati per la classifica (Settings → eloRelays, uno per riga, sostituisce quelli predefiniti). */
export function eloRelays() {
  const custom = String(settings.eloRelays ?? "").split(/\s+/).filter((u) => /^wss?:\/\//.test(u));
  return custom.length ? custom : DEFAULT_RELAYS;
}

// ---------------------------------------------------------------- contenuti firmati

const HEX64 = /^[0-9a-f]{64}$/;
const cleanName = (n) => String(n ?? "").slice(0, 40) || "Duelist";

/** Start della partita: stesso contenuto (e hash) per i due giocatori. players: [{ pk, name }]. */
export function startContent(match, players) {
  const ps = players.map((p) => ({ pk: p.pk, name: cleanName(p.name) })).sort((a, b) => a.pk.localeCompare(b.pk));
  return { app: APP, v: VERSION, type: "start", match, players: ps };
}
export const hashOf = (content) => sha256Hex(canonical(content));

/** Risultato: winner = chiave pubblica del vincitore, null = pareggio. */
export function resultContent(start, startHash, winner) {
  return { app: APP, v: VERSION, type: "result", match: start.match, start: startHash, winner };
}

function validStart(s) {
  return s && s.app === APP && s.v === VERSION && s.type === "start" && HEX64.test(s.match) && Array.isArray(s.players) && s.players.length === 2 &&
    s.players.every((p) => p && HEX64.test(p.pk) && typeof p.name === "string" && p.name.length <= 40) && s.players[0].pk < s.players[1].pk;
}

// ---------------------------------------------------------------- eventi Nostr (NIP-01)

async function signEvent(content, tags) {
  const { pk, sk } = identity();
  const ev = { pubkey: pk, created_at: Math.floor(Date.now() / 1000), kind: KIND, tags, content };
  const id = await sha256Hex(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]));
  return { ...ev, id, sig: toHex(await schnorr.signAsync(fromHex(id), fromHex(sk))) };
}

async function validEvent(ev) {
  if (!ev || ev.kind !== KIND || typeof ev.content !== "string" || !HEX64.test(ev.pubkey) || !Array.isArray(ev.tags)) return false;
  const id = await sha256Hex(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]));
  return id === ev.id && (await verifyHash(ev.sig, id, ev.pubkey));
}

/** Manda l'evento ai relay; restituisce quanti l'hanno accettato. */
function publishEvent(ev, relays = eloRelays()) {
  return Promise.all(relays.map((url) => new Promise((resolve) => {
    let ws;
    const done = (ok) => {
      clearTimeout(timer);
      try { ws?.close(); } catch { /* già chiuso */ }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 6000);
    try {
      ws = new WebSocket(url);
    } catch {
      return done(false);
    }
    ws.onopen = () => ws.send(JSON.stringify(["EVENT", ev]));
    ws.onmessage = (m) => {
      try {
        const [type, id, ok] = JSON.parse(m.data);
        if (type === "OK" && id === ev.id) done(ok === true);
      } catch { /* messaggio non valido */ }
    };
    ws.onerror = () => done(false);
  }))).then((r) => r.filter(Boolean).length);
}

/** Tutti gli eventi della classifica dai relay (al massimo `ms` di attesa per relay). */
function fetchEvents(relays = eloRelays(), ms = 7000) {
  const byId = new Map();
  return Promise.all(relays.map((url) => new Promise((resolve) => {
    let ws;
    const sub = `elo-${Math.random().toString(36).slice(2, 8)}`;
    const done = () => {
      clearTimeout(timer);
      try { ws?.close(); } catch { /* già chiuso */ }
      resolve();
    };
    const timer = setTimeout(done, ms);
    try {
      ws = new WebSocket(url);
    } catch {
      return done();
    }
    ws.onopen = () => ws.send(JSON.stringify(["REQ", sub, { kinds: [KIND], "#t": [TAG], limit: 5000 }]));
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (msg[0] === "EVENT" && msg[1] === sub && msg[2]?.id) byId.set(msg[2].id, msg[2]);
        if (msg[0] === "EOSE" && msg[1] === sub) done();
      } catch { /* messaggio non valido */ }
    };
    ws.onerror = done;
  }))).then(() => [...byId.values()]);
}

// ---------------------------------------------------------------- pubblicazione

const outbox = () => {
  try {
    const v = JSON.parse(localStorage.getItem(OUTBOX) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const saveOutbox = (list) => {
  try {
    localStorage.setItem(OUTBOX, JSON.stringify(list.slice(-500)));
  } catch { /* storage pieno */ }
};

/** Pubblica un record (risultato o abbandono); resta anche nel browser per ripubblicarlo se i relay non rispondono. */
async function publishRecord(record) {
  const other = record.start.players.map((p) => p.pk).find((pk) => pk !== identity().pk);
  const ev = await signEvent(JSON.stringify(record), [["d", `${APP}:${record.start.match}`], ["t", TAG], ["p", other]]);
  const list = outbox().filter((e) => !(e.pubkey === ev.pubkey && e.tags.some((t) => t[0] === "d" && t[1] === `${APP}:${record.start.match}`)));
  saveOutbox([...list, ev]);
  return publishEvent(ev);
}

/** Ripubblica gli eventi rimasti nel browser (es. i relay erano irraggiungibili quando si è giocato). */
export async function republishOutbox() {
  for (const ev of outbox()) await publishEvent(ev);
}

/**
 * Partita classificata in corso (una per duello). Si crea dopo l'accordo iniziale con l'identità
 * dell'avversario; si chiude con `finished(winnerPk)` (risultato firmato da entrambi) o `abandoned()`.
 * send(msg): manda un messaggio all'avversario (LinkMux), handle(msg) riceve i suoi "rank-*".
 */
export class RankedGame {
  constructor({ match, me, opp, send, onStatus = () => {} }) {
    this.start = startContent(match, [me, opp]);
    this.me = me.pk;
    this.opp = opp.pk;
    this.send = send;
    this.onStatus = onStatus;
    this.startSigs = {};
    this.resultSigs = {};
    this.done = false;
  }

  /** Firma lo start e lo manda; resolve quando ha anche quello (valido) dell'avversario. */
  async begin(nextStart) {
    this.startHash = await hashOf(this.start);
    this.startSigs[this.me] = await signHash(this.startHash);
    this.send({ t: "rank-start", sig: this.startSigs[this.me] });
    const m = await nextStart();
    if (!(await verifyHash(m.sig, this.startHash, this.opp))) throw new Error("Your opponent's ranked signature is not valid: this Duel is not ranked");
    this.startSigs[this.opp] = m.sig;
    // Firma della propria sconfitta, pronta per quando si esce (deve partire subito, anche chiudendo la scheda).
    this.loss = resultContent(this.start, this.startHash, this.opp);
    this.lossHash = await hashOf(this.loss);
    this.lossSig = await signHash(this.lossHash);
    // Hash della sconfitta dell'avversario: se arriva la sua firma, si è arreso o è uscito.
    this.winHash = await hashOf(resultContent(this.start, this.startHash, this.me));
  }

  /** Si esce dal duello: si manda la firma della propria sconfitta (sincrono, va bene anche alla chiusura). */
  resign() {
    if (this.done || this.resultHash || !this.lossSig) return;
    this.result = this.loss;
    this.resultHash = this.lossHash;
    this.resultSigs[this.me] = this.lossSig;
    this.send({ t: "rank-result", hash: this.lossHash, sig: this.lossSig });
  }

  /** Fine del duello con un vincitore (o pareggio): si firma il risultato e lo si manda all'avversario. */
  async finished(winner) {
    if (this.done || this.resultHash) return;
    this.result = resultContent(this.start, this.startHash, winner);
    this.resultHash = await hashOf(this.result);
    this.resultSigs[this.me] = await signHash(this.resultHash);
    this.send({ t: "rank-result", hash: this.resultHash, sig: this.resultSigs[this.me] });
    this.onStatus("Ranked: waiting for your opponent's signature…");
    if (this.pendingOpp) await this.receiveResult(this.pendingOpp);
  }

  /** Firma del risultato dall'avversario: se coincide con il nostro, si pubblica. */
  async receiveResult(m) {
    if (this.done) return;
    // L'avversario firma la propria sconfitta prima che il duello finisca qui: è uscito, si vince.
    if (!this.resultHash && m.hash === this.winHash) {
      this.pendingOpp = m;
      return this.finished(this.me);
    }
    if (!this.resultHash) return void (this.pendingOpp = m);
    if (m.hash !== this.resultHash || !(await verifyHash(m.sig, this.resultHash, this.opp))) {
      this.onStatus("Ranked: your opponent's result differs from yours, the Duel does not count", "error");
      return;
    }
    this.resultSigs[this.opp] = m.sig;
    this.done = true;
    const n = await publishRecord({ kind: "result", start: this.start, startSigs: this.startSigs, result: this.result, resultSigs: this.resultSigs });
    this.onStatus(n ? `Ranked result saved (${n} relays)` : "Ranked result signed: it will be published when the relays are reachable", n ? "ok" : "error");
  }

  /** L'avversario se n'è andato (o non firma): si pubblica la vittoria per abbandono. */
  async abandoned() {
    if (this.done || !this.startSigs[this.opp]) return;
    // Dopo un duello perso (o pari) non si dichiara l'abbandono dell'avversario: conta solo per chi ha vinto
    // o per chi resta quando l'altro esce durante il duello.
    if (this.result && this.result.winner !== this.me) return;
    this.done = true;
    const n = await publishRecord({ kind: "abandon", start: this.start, startSigs: this.startSigs, winner: this.me });
    this.onStatus(n ? "Ranked: your opponent left, the win is recorded" : "Ranked: win by abandonment saved, it will be published later", n ? "ok" : "error");
  }
}

// ---------------------------------------------------------------- classifica

/** Record valido dall'evento (firme dell'evento, dello start e del risultato), o null. */
async function recordOf(ev) {
  if (!(await validEvent(ev))) return null;
  let r;
  try {
    r = JSON.parse(ev.content);
  } catch {
    return null;
  }
  if (!r || !validStart(r.start) || !r.startSigs) return null;
  const pks = r.start.players.map((p) => p.pk);
  if (!pks.includes(ev.pubkey)) return null;
  const startHash = await hashOf(r.start);
  for (const pk of pks) if (!(await verifyHash(r.startSigs[pk], startHash, pk))) return null;
  if (r.kind === "result") {
    const want = resultContent(r.start, startHash, r.result?.winner ?? null);
    if (!(want.winner === null || pks.includes(want.winner)) || canonical(want) !== canonical(r.result)) return null;
    const h = await hashOf(want);
    for (const pk of pks) if (!(await verifyHash(r.resultSigs?.[pk], h, pk))) return null;
    return { match: r.start.match, start: r.start, kind: "result", winner: want.winner, at: ev.created_at };
  }
  if (r.kind === "abandon" && r.winner === ev.pubkey) return { match: r.start.match, start: r.start, kind: "abandon", winner: r.winner, at: ev.created_at };
  return null;
}

/** Partite valide (una per id), in ordine di tempo, secondo le regole sopra. */
async function matches(events) {
  const byMatch = new Map();
  for (const ev of events) {
    const r = await recordOf(ev);
    if (!r) continue;
    if (!byMatch.has(r.match)) byMatch.set(r.match, []);
    byMatch.get(r.match).push(r);
  }
  const out = [];
  for (const rs of byMatch.values()) {
    const results = rs.filter((r) => r.kind === "result");
    const at = Math.min(...rs.map((r) => r.at));
    if (results.length) out.push({ ...results[0], at });
    else {
      const winners = new Set(rs.map((r) => r.winner));
      if (winners.size === 1) out.push({ ...rs[0], at }); // abbandono non contestato
      else out.push({ ...rs[0], at, bothLose: true }); // entrambi dichiarano l'abbandono dell'altro: perdono tutti e due
    }
  }
  return out.sort((a, b) => a.at - b.at || a.match.localeCompare(b.match));
}

/**
 * Classifica dai relay (più gli eventi propri non ancora pubblicati).
 * Restituisce { players: [{ pk, name, rating, games, wins, losses, draws, abandons }], games: [...] }.
 */
export async function leaderboard() {
  const evs = await fetchEvents();
  const seen = new Set(evs.map((e) => e.id));
  for (const e of outbox()) if (!seen.has(e.id)) evs.push(e);
  const list = await matches(evs);
  const players = new Map();
  const player = (p) => {
    if (!players.has(p.pk)) players.set(p.pk, { pk: p.pk, name: p.name, rating: START_RATING, games: 0, wins: 0, losses: 0, draws: 0, abandons: 0 });
    const x = players.get(p.pk);
    x.name = p.name; // l'ultimo nome usato
    return x;
  };
  const perPairDay = new Map();
  const games = [];
  for (const m of list) {
    const [a, b] = m.start.players.map(player);
    const key = `${a.pk}:${b.pk}:${Math.floor(m.at / 86400)}`;
    const n = (perPairDay.get(key) ?? 0) + 1;
    perPairDay.set(key, n);
    if (n > PER_PAIR_PER_DAY) continue;
    if (m.bothLose) {
      // Abbandono contestato: per entrambi conta come una sconfitta contro l'altro.
      const ea = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      const da = -K * ea;
      const db = -K * (1 - ea);
      a.rating += da;
      b.rating += db;
      for (const x of [a, b]) {
        x.games++;
        x.losses++;
        x.abandons++;
      }
      games.push({ match: m.match, at: m.at, a: a.pk, b: b.pk, winner: null, kind: "abandon-both", delta: Math.round(da) });
      continue;
    }
    const sa = m.winner === null ? 0.5 : m.winner === a.pk ? 1 : 0;
    const ea = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
    const delta = K * (sa - ea);
    a.rating += delta;
    b.rating -= delta;
    for (const [x, s] of [[a, sa], [b, 1 - sa]]) {
      x.games++;
      if (s === 1) x.wins++;
      else if (s === 0) x.losses++;
      else x.draws++;
    }
    if (m.kind === "abandon") (m.winner === a.pk ? b : a).abandons++;
    games.push({ match: m.match, at: m.at, a: a.pk, b: b.pk, winner: m.winner, kind: m.kind, delta: Math.round(delta) });
  }
  const ranked = [...players.values()].filter((p) => p.games > 0).map((p) => ({ ...p, rating: Math.round(p.rating) })).sort((x, y) => y.rating - x.rating || y.games - x.games);
  return { players: ranked, games: games.reverse() };
}
