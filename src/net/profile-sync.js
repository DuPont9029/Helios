// Mazzi, combo, spreadsheet, cube, draft giocati (pool, mazzo e risultati) e aspetto (sleeve, gemme Pendulum, Moai)
// salvati con il profilo, come le carte personalizzate (net/custom-cards-sync.js): ogni
// elemento è un evento NIP-78 (kind 30078) sostituibile sui relay della classifica, cifrato per sé stessi (NIP-44),
// con d = "helios-store-v1:tipo:id". Importando il profilo su un altro browser tornano; le cancellazioni lasciano un
// evento "cancellato" al posto dell'elemento. Il contenuto è compresso (gzip); se resta oltre il limite dei relay
// (64 KB) si spezza in parti, eventi a sé con d = "...:tipo:id:#n", che si riuniscono leggendo il backup.
//
// Le modifiche fatte qui arrivano da data/sync-store.js (evento helios-store-change); i Base decks non modificati
// non vanno nel backup (ogni browser ne ha già una copia).
import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { identity, fromHex } from "./identity.js";
import { eloRelays } from "./elo.js";
import { sharedPool } from "./social.js";
import { syncTimes, syncDeleted, setSyncTimes, setSyncDeleted, noteReplaced, SYNCED_SETTINGS } from "../data/sync-store.js";
import { loadDecks, writeDecksRaw, isDefaultDeck } from "../deck/deck.js";
import { loadComboStore, writeComboStoreRaw } from "../duel/trainer.js";
import { loadFormats, writeFormatsRaw, cleanFormat } from "../draft/format.js";
import { loadRuns, writeRunsRaw } from "../draft/runs.js";
import { settings, setSettingRaw } from "../data/settings.js";
import { validSleeve } from "../data/sleeve.js";
import { validPendulumIcons } from "../data/pendulum.js";
import { validMoai } from "../data/moai.js";

const KIND = 30078;
const TAG = "helios-store-v1";
const MAX_PLAIN = 44_000; // vedi custom-cards-sync.js
const PART = 40_000; // caratteri di una parte (il testo compresso è base64: un carattere = un byte)
const MAX_PARTS = 64; // ~2,5 MB: oltre non si salva
const now = () => Math.floor(Date.now() / 1000);

let ownPool = null;
const pool = () => sharedPool() ?? (ownPool ??= new SimplePool({ enablePing: true, enableReconnect: true }));
const selfKey = () => {
  const { sk, pk } = identity();
  return nip44.v2.utils.getConversationKey(fromHex(sk), pk);
};

// ---------------------------------------------------------------- compressione

const toB64 = (buf) => {
  let s = "";
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const pipe = (data, stream) => new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer();

async function pack(obj) {
  const json = JSON.stringify(obj);
  if (typeof CompressionStream === "undefined") return json;
  return JSON.stringify({ z: toB64(await pipe(json, new CompressionStream("gzip"))) });
}
async function unpack(text) {
  const v = JSON.parse(text);
  if (typeof v?.z !== "string") return v;
  return JSON.parse(new TextDecoder().decode(await pipe(fromB64(v.z), new DecompressionStream("gzip"))));
}

// ---------------------------------------------------------------- elenchi locali

const VALID_SETTING = { sleeve: validSleeve, pendulumIcon: validPendulumIcons, moai: validMoai };

/**
 * Un adattatore per tipo: list() l'elenco salvato (elementi con id), write(arr) lo riscrive senza registrare
 * modifiche, skip(item) se non va nel backup, clean(item) controlla quelli che arrivano (null = scartato),
 * slim(item) una versione più leggera se è troppo grande anche a parti.
 */
const ADAPTERS = {
  deck: { list: loadDecks, write: writeDecksRaw, skip: isDefaultDeck },
  combo: { list: () => loadComboStore().combos, write: (combos) => writeComboStoreRaw({ ...loadComboStore(), combos }) },
  sheet: { list: () => loadComboStore().sheets, write: (sheets) => writeComboStoreRaw({ ...loadComboStore(), sheets }) },
  cube: { list: loadFormats, write: writeFormatsRaw, clean: cleanFormat },
  // i draft online hanno già il loro backup (net/tournament-store.js)
  run: {
    list: loadRuns,
    write: writeRunsRaw,
    skip: (r) => !!r.online,
    slim: (r) => ({ ...r, results: (r.results ?? []).map((x) => ({ ...x, replay: null })), botMatches: r.botMatches?.map((x) => ({ ...x, replay: null })) ?? null }),
  },
  setting: {
    list: () => SYNCED_SETTINGS.filter((k) => settings[k] != null).map((k) => ({ id: k, value: settings[k] })),
    write: (arr) => {
      for (const k of SYNCED_SETTINGS) {
        const v = arr.find((x) => x.id === k)?.value ?? null;
        if (JSON.stringify(v) !== JSON.stringify(settings[k] ?? null)) setSettingRaw(k, v);
      }
    },
    clean: (x) => (VALID_SETTING[x.id]?.(x.value) ? { id: x.id, value: x.value } : null),
  },
};
const TYPES = Object.keys(ADAPTERS);
const lists = () => Object.fromEntries(TYPES.map((t) => [t, ADAPTERS[t].list()]));
const localItem = (type, id) => ADAPTERS[type].list().find((x) => x.id === id) ?? null;
const uploadable = (type, item) => !ADAPTERS[type].skip?.(item);

/** Mette (o toglie, item = null) un elemento arrivato dal backup, senza registrarlo come modifica fatta qui. */
function applyRemote(type, id, item, at) {
  const key = `${type}:${id}`;
  const arr = ADAPTERS[type].list();
  const i = arr.findIndex((x) => x.id === id);
  if (i >= 0) noteReplaced(key, arr[i]);
  if (!item) {
    if (i >= 0) arr.splice(i, 1);
  } else if (i >= 0) arr[i] = item;
  else arr.push(item);
  ADAPTERS[type].write(arr);
  const times = syncTimes();
  const dead = syncDeleted();
  if (item) {
    times[key] = at;
    delete dead[key];
  } else {
    delete times[key];
    dead[key] = { at, sent: true };
  }
  setSyncTimes(times);
  setSyncDeleted(dead);
}

// ---------------------------------------------------------------- relay

async function send(d, text) {
  const { sk } = identity();
  const ev = finalizeEvent({ kind: KIND, created_at: now(), tags: [["d", d], ["t", TAG]], content: nip44.v2.encrypt(text, selfKey()) }, fromHex(sk));
  const res = await Promise.allSettled(pool().publish(eloRelays(), ev));
  return res.some((r) => r.status === "fulfilled");
}

async function publish(type, id, data) {
  const d = `${TAG}:${type}:${id}`;
  const text = await pack({ v: 1, type, id, ...data });
  const size = new TextEncoder().encode(text).length;
  if (size <= MAX_PLAIN) return send(d, text);
  // troppo grande per un evento solo: prima le parti, poi l'evento principale che dice quante sono (stesso at:
  // parti rimaste da una versione precedente non si mescolano)
  const step = size === text.length ? PART : Math.floor(PART / 4); // senza compressione può esserci testo non ASCII
  const parts = [];
  for (let i = 0; i < text.length; i += step) parts.push(text.slice(i, i + step));
  if (parts.length > MAX_PARTS) return null; // troppo grande
  const sent = await Promise.all(parts.map((part, i) => send(`${d}:#${i}`, JSON.stringify({ v: 1, type, id, at: data.at, part: i, data: part }))));
  if (sent.includes(false)) return false;
  return send(d, JSON.stringify({ v: 1, type, id, at: data.at, parts: parts.length }));
}

async function uploadItem(type, id) {
  const item = localItem(type, id);
  const at = syncTimes()[`${type}:${id}`];
  if (!item || !at || !uploadable(type, item)) return false;
  let ok = await publish(type, id, { at, item });
  const slim = ADAPTERS[type].slim;
  if (ok === null && slim) ok = await publish(type, id, { at, item: slim(item) });
  if (ok === null) console.warn(`profile backup: ${type} ${id} is too large`);
  return !!ok;
}

async function uploadDeletion(type, id) {
  const key = `${type}:${id}`;
  const d = syncDeleted()[key];
  if (!d) return false;
  const ok = await publish(type, id, { at: d.at, deleted: true });
  const dead = syncDeleted();
  if (ok && dead[key]?.at === d.at) {
    dead[key].sent = true;
    setSyncDeleted(dead);
  }
  return ok;
}

/** Il backup di questo profilo: "tipo:id" → { type, id, at, item } o { type, id, at, deleted } (l'ultimo di ognuno). */
async function fetchBackup() {
  const { pk } = identity();
  const evs = await pool().querySync(eloRelays(), { kinds: [KIND], authors: [pk], "#t": [TAG], limit: 5000 }, { maxWait: 7000 });
  const by = new Map();
  const mains = [];
  const parts = new Map(); // "tipo:id:at" → [testo delle parti]
  for (const ev of evs) {
    if (!verifyEvent(ev)) continue;
    try {
      const data = await unpack(nip44.v2.decrypt(ev.content, selfKey()));
      if (!TYPES.includes(data?.type) || typeof data.id !== "string" || !data.id) continue;
      if (Number.isInteger(data.part) && typeof data.data === "string") {
        const k = `${data.type}:${data.id}:${Number(data.at) || 0}`;
        if (!parts.has(k)) parts.set(k, []);
        parts.get(k)[data.part] = data.data;
      } else mains.push(data);
    } catch {
      /* non è un nostro backup leggibile */
    }
  }
  for (let data of mains) {
    try {
      const at = Number(data.at) || 0;
      if (Number.isInteger(data.parts) && data.parts > 0) {
        // elemento spezzato: si riunisce solo se ci sono tutte le parti di questa versione
        const got = parts.get(`${data.type}:${data.id}:${at}`) ?? [];
        if (got.filter((x) => typeof x === "string").length < data.parts) continue;
        const whole = await unpack(got.slice(0, data.parts).join(""));
        if (whole?.type !== data.type || whole?.id !== data.id) continue;
        data = whole;
      }
      if (!data.deleted) {
        const clean = ADAPTERS[data.type].clean;
        if (clean) data.item = data.item && typeof data.item === "object" ? clean(data.item) : null;
        if (data.item?.id !== data.id) continue;
      }
      const key = `${data.type}:${data.id}`;
      if (!by.has(key) || by.get(key).at < at) by.set(key, { type: data.type, id: data.id, at, item: data.deleted ? null : data.item });
    } catch {
      /* non è un nostro backup leggibile */
    }
  }
  return by;
}

// ---------------------------------------------------------------- modifiche fatte qui → relay

const timers = new Map();
window.addEventListener("helios-store-change", (e) => {
  const { type, id, deleted } = e.detail ?? {};
  if (!TYPES.includes(type) || !id) return;
  const key = `${type}:${id}`;
  clearTimeout(timers.get(key));
  if (deleted) {
    timers.delete(key);
    uploadDeletion(type, id).catch(() => {});
    return;
  }
  // il mazzo si salva a ogni modifica: si pubblica solo quando ci si ferma
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    uploadItem(type, id).catch(() => {});
  }, 4000));
});

// ---------------------------------------------------------------- allineamento

// stesso nome e stesse carte: un Base deck (o un mazzo) che questo browser ha già con un altro id
const sameDeck = (a, b) => a.name === b.name && ["main", "extra", "side"].every((p) => (a[p] ?? []).join() === (b[p] ?? []).join());

let running = null;
/**
 * Allinea mazzi, combo, spreadsheet, cube, draft e aspetto del browser con il backup del profilo: arrivano quelli nuovi o più recenti (e
 * spariscono quelli cancellati altrove), partono quelli che il backup non ha o ha più vecchi.
 * Restituisce { restored: { tipo: quanti }, removed, uploaded }.
 */
export function syncProfileStore() {
  running ??= (async () => {
    const backup = await fetchBackup();
    const restored = Object.fromEntries(TYPES.map((t) => [t, 0]));
    let removed = 0;
    let uploaded = 0;
    for (const [key, r] of backup) {
      const times = syncTimes();
      const dead = syncDeleted();
      const mine = localItem(r.type, r.id);
      if (!r.item) {
        if (mine && (times[key] ?? 0) <= r.at) {
          applyRemote(r.type, r.id, null, r.at);
          removed++;
        }
        continue;
      }
      if (dead[key] && dead[key].at >= r.at) continue; // cancellato qui dopo
      if (mine && (times[key] ?? 0) >= r.at) continue;
      if (!mine && r.type === "deck" && lists().deck.some((d) => sameDeck(d, r.item))) continue;
      applyRemote(r.type, r.id, r.item, r.at);
      restored[r.type]++;
    }
    for (const [key, d] of Object.entries(syncDeleted())) {
      const [type, ...rest] = key.split(":");
      const id = rest.join(":");
      const r = backup.get(key);
      if (!d.sent || (r && r.item && r.at < d.at)) await uploadDeletion(type, id).catch(() => {});
    }
    const times = syncTimes();
    for (const [type, arr] of Object.entries(lists())) {
      for (const item of arr) {
        if (!item?.id || !uploadable(type, item)) continue;
        const key = `${type}:${item.id}`;
        // mai modificato qui (es. salvato prima del backup sul profilo): conta come appena modificato
        if (!times[key]) {
          times[key] = Date.now();
          setSyncTimes(times);
        }
        const theirs = backup.get(key)?.at ?? -1;
        if (times[key] > theirs && (await uploadItem(type, item.id).catch(() => false))) uploaded++;
      }
    }
    const any = Object.values(restored).reduce((a, b) => a + b, removed);
    if (any) window.dispatchEvent(new CustomEvent("helios-store-synced", { detail: { restored, removed } }));
    return { restored, removed, uploaded };
  })().finally(() => (running = null));
  return running;
}

// Profilo importato (o nuovo): i suoi mazzi, combo, cube... arrivano, quelli di questo browser si aggiungono al suo backup.
window.addEventListener("helios-identity", () => {
  syncProfileStore().catch(() => {});
});
