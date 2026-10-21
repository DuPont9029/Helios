// Controllo dei messaggi che arrivano dall'avversario (invite code e Online Room passano tutti da LinkMux).
// L'avversario può avere un client modificato: ogni messaggio deve avere il tipo, i campi e le dimensioni
// previsti, altrimenti si scarta. Le regole del duello (chi può dichiarare un timeout, quanto tempo gli
// resta...) sono in DuelSession; qui c'è la forma dei messaggi e delle opzioni scelte dall'host.
import { DUEL_MODES } from "../core/constants.js";
import { TIMER_PRESETS } from "../duel/clock.js";
import { MAX_BEST_OF } from "../duel/series.js";
import { db } from "../data/db.js";

const isInt = (v, min = -Infinity, max = Infinity) => Number.isInteger(v) && v >= min && v <= max;
const isStr = (v, max) => typeof v === "string" && v.length <= max;
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const codes = (a, max) => Array.isArray(a) && a.length <= max && a.every((c) => isInt(c, 1, 2 ** 32));
const HEX64 = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
const HOUR = 3600 * 1000;

/** Forma di ogni tipo di messaggio: true se va bene. I tipi che non sono qui si scartano. */
const SHAPES = {
  hello: (m) =>
    isInt(m.v, 0, 1000) && isStr(m.name ?? "", 200) && isStr(m.data ?? "", 100) && isStr(m.commit, 64) && HEX64.test(m.commit) &&
    isObj(m.deck) && codes(m.deck.main, 60) && codes(m.deck.extra, 15) && (m.options === undefined || isObj(m.options)) &&
    (m.pk === undefined || (isStr(m.pk, 64) && HEX64.test(m.pk))) && (m.ranked === undefined || typeof m.ranked === "boolean"),
  // Partite classificate (ELO): firme dello start e del risultato.
  "rank-start": (m) => isStr(m.sig, 128) && SIG.test(m.sig),
  "rank-result": (m) => isStr(m.hash, 64) && HEX64.test(m.hash) && isStr(m.sig, 128) && SIG.test(m.sig),
  reveal: (m) => isStr(m.rand, 64) && HEX64.test(m.rand),
  reject: (m) => isStr(m.reason, 2000),
  first: (m) => typeof m.hostFirst === "boolean",
  resp: (m) =>
    isInt(m.seq, 0) && (m.response == null || isObj(m.response)) &&
    (m.sum === undefined || m.sum === null || isStr(m.sum, 200) || Number.isFinite(m.sum)) &&
    (m.clock === undefined || (isObj(m.clock) && Number.isFinite(m.clock.left) && m.clock.left >= 0 && m.clock.left <= HOUR && (m.clock.bonus == null || (Number.isFinite(m.clock.bonus) && m.clock.bonus >= 0 && m.clock.bonus <= HOUR)))),
  chat: (m) => isStr(m.text, 300),
  timeout: (m) => m.player === 0 || m.player === 1,
  rematch: () => true,
  surrender: () => true,
  bye: () => true,
  concede: () => true,
};
// Dimensione massima di un messaggio (il "hello" porta sleeve e icone Pendulum, qualche decina di KB).
const MAX_SIZE = 400 * 1024;

/** true se il messaggio ricevuto si può usare; altrimenti lo si scarta (e lo si segnala nella console). */
export function validMessage(msg) {
  let ok = false;
  try {
    ok = isObj(msg) && (msg.g === undefined || isInt(msg.g, 0, 1e6)) && Object.hasOwn(SHAPES, msg.t) && SHAPES[msg.t](msg) && JSON.stringify(msg).length <= MAX_SIZE;
  } catch {
    ok = false;
  }
  if (!ok) console.warn("Ignored an invalid message from the opponent:", typeof msg?.t === "string" ? msg.t.slice(0, 20) : typeof msg);
  return ok;
}

/**
 * Opzioni del duello scelte dall'host, controllate dall'ospite prima di giocare: valori ammessi e flag del
 * motore uguali a quelli della modalità indicata (un host modificato non può imporre regole nascoste).
 * Restituisce le opzioni pulite o lancia un errore leggibile.
 */
export function cleanOptions(o) {
  const bad = (what) => {
    throw new Error(`The host sent invalid Duel options (${what})`);
  };
  if (!isObj(o)) bad("missing");
  const mode = DUEL_MODES[o.mode] ? o.mode : bad("rules");
  if (String(o.flags) !== String(DUEL_MODES[mode].flags)) bad("engine flags");
  if (!isInt(o.lp, 1, 999999)) bad("Life Points");
  if (!isInt(o.hand, 0, 20)) bad("starting hand");
  if (!isInt(o.draw, 0, 10)) bad("draws per turn");
  if (o.banlist != null && !(isStr(o.banlist, 200) && db.banlists.some((b) => b.name === o.banlist))) bad(`banlist "${String(o.banlist).slice(0, 60)}" not found: update the client`);
  if (!Object.hasOwn(TIMER_PRESETS, o.timer)) bad("timer");
  if (!(isInt(o.bestOf, 1, MAX_BEST_OF) && o.bestOf % 2 === 1)) bad("best of");
  return {
    mode,
    flags: String(DUEL_MODES[mode].flags),
    lp: o.lp,
    hand: o.hand,
    draw: o.draw,
    banlist: o.banlist ?? null,
    timer: o.timer,
    bestOf: o.bestOf,
    allowUnofficial: o.allowUnofficial === true,
    ranked: o.ranked === true,
  };
}

/** Limite di frequenza (es. chat): al massimo `n` eventi ogni `ms`. */
export function rateLimit(n, ms) {
  const times = [];
  return () => {
    const now = Date.now();
    while (times.length && now - times[0] > ms) times.shift();
    if (times.length >= n) return false;
    times.push(now);
    return true;
  };
}
