// Replay dei duelli: il duello è deterministico, quindi basta salvare la configurazione data al core (mazzi, seed,
// regole) e le risposte date, in ordine. Si salvano a fine duello (online, con gli amici, contro la CPU, Test Duel;
// non il Combo Trainer) in localStorage e si condividono come codice "HELIOS-REPLAY:" (JSON compresso in base64).
// Un replay: { v, id, at, mode, names, me, duel, history, winner, result, game, custom }.

const KEY = "helios.replays";
const MAX = 60;
export const REPLAY_PREFIX = "HELIOS-REPLAY:";
// Codice o replay troppo grande: probabilmente non è un replay (o è stato manomesso).
const MAX_RESPONSES = 20000;
const MAX_JSON = 2_000_000;

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter(valid) : [];
  } catch {
    return [];
  }
}

// Letti al primo uso: load() usa i controlli definiti più sotto.
let cache = null;
const all = () => (cache ??= load());
const listeners = new Set();

function save(list) {
  // Storage pieno: si tolgono i replay più vecchi finché ci sta.
  for (;;) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      break;
    } catch {
      if (list.length <= 1) break;
      list = list.slice(0, -1);
    }
  }
  cache = list;
  for (const fn of listeners) fn(list);
}

/** fn(list) a ogni cambio. Restituisce la funzione per smettere. */
export function onReplaysChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Replay salvati, dal più recente. */
export const listReplays = () => all().slice();

export const getReplay = (id) => all().find((r) => r.id === id) ?? null;

/** Salva un replay (nuovo o importato) e lo restituisce. */
export function saveReplay(r) {
  const rp = { v: 1, id: r.id ?? crypto.randomUUID().slice(0, 12), at: r.at ?? Date.now(), ...clean(r) };
  save([rp, ...all().filter((x) => x.id !== rp.id)].slice(0, MAX));
  return rp;
}

export function deleteReplay(id) {
  save(all().filter((r) => r.id !== id));
}

export function renameReplay(id, title) {
  const list = all();
  const r = list.find((x) => x.id === id);
  if (!r) return;
  r.title = String(title).trim().slice(0, 80) || undefined;
  save(list);
}

// ---------------------------------------------------------------- controllo dei dati

const isInt = (x) => Number.isInteger(x);
const codes = (a) => Array.isArray(a) && a.length <= 200 && a.every((c) => isInt(c) && c > 0);
const plain = (x) => x && typeof x === "object" && !Array.isArray(x);

/** Configurazione del duello accettabile per il core (anche da un codice importato). */
function validDuel(d) {
  return (
    plain(d) &&
    Array.isArray(d.decks) && d.decks.length === 2 && d.decks.every((x) => plain(x) && codes(x.main) && codes(x.extra ?? [])) &&
    Array.isArray(d.seed) && d.seed.length === 4 && d.seed.every((s) => /^\d{1,20}$/.test(String(s))) &&
    /^\d{1,20}$/.test(String(d.flags ?? 0)) &&
    isInt(d.lp) && d.lp > 0 && isInt(d.hand ?? 5) && isInt(d.draw ?? 1) &&
    // campi facoltativi (es. pescate nell'ordine del mazzo, carte già sul campo)
    (d.top == null || (Array.isArray(d.top) && d.top.length === 2 && d.top.every((x) => x == null || codes(x)))) &&
    (d.place == null || (Array.isArray(d.place) && d.place.length <= 100 && d.place.every((c) => plain(c) && isInt(c.code) && c.code > 0)))
  );
}

function valid(r) {
  return plain(r) && typeof r.id === "string" && validDuel(r.duel) && Array.isArray(r.history) && r.history.length <= MAX_RESPONSES && r.history.every(plain) && (r.me === 0 || r.me === 1);
}

/** Solo i campi del replay, con i tipi giusti. */
function clean(r) {
  const names = Array.isArray(r.names) ? r.names.slice(0, 2).map((n) => String(n ?? "").slice(0, 40)) : ["Player 1", "Player 2"];
  return {
    mode: String(r.mode ?? "Duel").slice(0, 30),
    title: r.title ? String(r.title).slice(0, 80) : undefined,
    names,
    me: r.me === 1 ? 1 : 0,
    duel: r.duel,
    history: r.history,
    winner: r.winner === 0 || r.winner === 1 ? r.winner : null,
    result: String(r.result ?? "").slice(0, 160),
    game: isInt(r.game) ? r.game : undefined,
    // carte personalizzate dei mazzi (data/custom-cards.js), controllate una per una quando si usano
    custom: Array.isArray(r.custom) && r.custom.length ? r.custom.slice(0, 120).filter(plain) : undefined,
  };
}

// ---------------------------------------------------------------- codice da condividere

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

const toB64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** Codice del replay (senza id e data: chi lo importa ne fa uno suo). */
export async function replayToCode(r) {
  const { mode, title, names, me, duel, history, winner, result, game, custom } = r;
  const json = new TextEncoder().encode(JSON.stringify({ v: 1, mode, title, names, me, duel, history, winner, result, game, custom }));
  return REPLAY_PREFIX + toB64(await pipe(json, new CompressionStream("gzip")));
}

/** Replay da un codice (lancia un errore leggibile se non è valido). Non lo salva. */
export async function replayFromCode(text) {
  const s = String(text ?? "").trim().replace(/\s+/g, "");
  if (!s.startsWith(REPLAY_PREFIX)) throw new Error("This is not a Helios replay code (it starts with HELIOS-REPLAY:)");
  let r;
  try {
    const bytes = await pipe(fromB64(s.slice(REPLAY_PREFIX.length)), new DecompressionStream("gzip"));
    if (bytes.length > MAX_JSON) throw new Error("too big");
    r = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("The replay code is damaged: copy it again, all of it");
  }
  const rp = { id: "import", ...clean(r ?? {}) };
  if (!valid(rp)) throw new Error("The replay code is not valid");
  delete rp.id;
  return rp;
}
