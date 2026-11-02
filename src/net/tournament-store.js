// Torneo Limited sui relay Nostr: risultati, voti e bot tolti restano lì per tutta la durata del torneo (anche più
// giorni), cifrati con una chiave che conoscono solo i partecipanti (ricavata dal codice della stanza e dal seme del
// draft). Ogni record è firmato con l'identità del giocatore (identity.js): chi legge tiene solo quelli dei
// partecipanti. Eventi NIP-78 (kind 30078) sostituibili: un giocatore ha un solo record per cosa (es. un risultato
// per coppia di posti, un voto per giocatore), l'ultimo vale. Restano anche nel browser per ripubblicarli.
import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { identity, sha256Hex, fromHex } from "./identity.js";
import { eloRelays } from "./elo.js";
import { sharedPool } from "./social.js";

const KIND = 30078;
const OUTBOX = "ygoweb.tourOutbox";
const now = () => Math.floor(Date.now() / 1000);

let ownPool = null;
const pool = () => sharedPool() ?? (ownPool ??= new SimplePool({ enablePing: true, enableReconnect: true }));

/** Chiavi del torneo di un run online: { key, topic, room } (room = codice della stanza dal vivo). */
export async function tournamentKeys(run) {
  const base = `helios-tour-v1|${run.online.code}|${run.seed}`;
  const key = fromHex(await sha256Hex(`${base}|key`));
  const topic = (await sha256Hex(`${base}|topic`)).slice(0, 32);
  const roomHash = await sha256Hex(`${base}|room`);
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const room = [...fromHex(roomHash).slice(0, 8)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return { key, topic, room };
}

const outbox = () => {
  try {
    const v = JSON.parse(localStorage.getItem(OUTBOX) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/**
 * Pubblica un record del torneo: { type, id, ... }. type + id fanno da chiave (lo stesso record ripubblicato sostituisce
 * il precedente).
 */
export async function publishRecord(keys, rec) {
  const { sk } = identity();
  const content = nip44.v2.encrypt(JSON.stringify({ ...rec, at: Date.now() }), keys.key);
  const ev = finalizeEvent({ kind: KIND, created_at: now(), tags: [["d", `helios-tour:${keys.topic}:${rec.type}:${rec.id}`], ["t", `helios-tour-${keys.topic}`]], content }, fromHex(sk));
  try {
    const d = ev.tags[0][1];
    localStorage.setItem(OUTBOX, JSON.stringify([...outbox().filter((e) => e.tags[0]?.[1] !== d), ev].slice(-400)));
  } catch {
    /* storage pieno */
  }
  await Promise.allSettled(pool().publish(eloRelays(), ev));
  return ev;
}

/** Ripubblica i record del torneo rimasti nel browser (es. i relay non rispondevano). */
export async function republish(keys) {
  const mine = outbox().filter((e) => e.tags.some((t) => t[0] === "t" && t[1] === `helios-tour-${keys.topic}`));
  for (const ev of mine) await Promise.allSettled(pool().publish(eloRelays(), ev));
}

function open(keys, ev, members) {
  if (!ev || ev.kind !== KIND || !members.has(ev.pubkey) || !verifyEvent(ev)) return null;
  try {
    const rec = JSON.parse(nip44.v2.decrypt(ev.content, keys.key));
    if (!rec || typeof rec.type !== "string") return null;
    return { ...rec, pk: ev.pubkey, created: ev.created_at };
  } catch {
    return null;
  }
}

/** Tutti i record del torneo (dai relay e quelli ancora nel browser). members: chiavi dei partecipanti. */
export async function fetchRecords(keys, members) {
  const evs = await pool().querySync(eloRelays(), { kinds: [KIND], "#t": [`helios-tour-${keys.topic}`], limit: 2000 }, { maxWait: 7000 }).catch(() => []);
  const local = outbox().filter((e) => e.tags.some((t) => t[0] === "t" && t[1] === `helios-tour-${keys.topic}`));
  return latest([...evs, ...local].map((e) => open(keys, e, members)).filter(Boolean));
}

/** Nuovi record mentre la pagina del torneo è aperta. Restituisce { close() }. */
export function watchRecords(keys, members, onRecord) {
  return pool().subscribeMany(eloRelays(), { kinds: [KIND], "#t": [`helios-tour-${keys.topic}`], since: now() - 60 }, {
    onevent: (ev) => {
      const rec = open(keys, ev, members);
      if (rec) onRecord(rec);
    },
  });
}

/** Per ogni (autore, tipo, id) l'ultimo record. */
export function latest(recs) {
  const by = new Map();
  for (const r of recs) {
    const k = `${r.pk}|${r.type}|${r.id}`;
    const old = by.get(k);
    if (!old || (r.at ?? 0) > (old.at ?? 0)) by.set(k, r);
  }
  return [...by.values()];
}

// ---------------------------------------------------------------- backup privato

// Pool, mazzo e partite del giocatore: cifrati per sé stesso (chiave comune tra la propria chiave segreta e la propria
// pubblica, NIP-44), quindi li legge solo chi li ha draftati, anche dagli altri partecipanti del torneo. Un evento
// sostituibile per draft: l'ultimo vale. Con il backup un torneo si riprende su un altro browser (o dopo aver
// cancellato i dati del sito).
const BACKUP_TAG = "helios-tourbak-v1";
const selfKey = () => {
  const { sk, pk } = identity();
  return nip44.v2.utils.getConversationKey(fromHex(sk), pk);
};

/** Salva il run (senza i record del torneo, che stanno già sui relay) nel backup privato. */
export async function backupRun(run) {
  const { sk } = identity();
  const { tourRecords, botMatches, ...rest } = run;
  const content = nip44.v2.encrypt(JSON.stringify({ v: 1, run: rest, at: Date.now() }), selfKey());
  const ev = finalizeEvent({ kind: KIND, created_at: now(), tags: [["d", `${BACKUP_TAG}:${run.id}`], ["t", BACKUP_TAG]], content }, fromHex(sk));
  await Promise.allSettled(pool().publish(eloRelays(), ev));
}

/** I run salvati nel backup privato di questa identità (l'ultimo di ogni draft). */
export async function fetchBackups() {
  const { pk } = identity();
  const evs = await pool().querySync(eloRelays(), { kinds: [KIND], authors: [pk], "#t": [BACKUP_TAG], limit: 500 }, { maxWait: 7000 }).catch(() => []);
  const by = new Map();
  for (const ev of evs) {
    if (!verifyEvent(ev)) continue;
    try {
      const data = JSON.parse(nip44.v2.decrypt(ev.content, selfKey()));
      // Backup cancellato: vale come ultimo, il draft non si ripristina più.
      if (data?.deleted) {
        if (!by.has(data.deleted) || by.get(data.deleted).at < data.at) by.set(data.deleted, { run: null, at: data.at ?? 0 });
        continue;
      }
      const run = data?.run;
      if (!run?.id || !Array.isArray(run.seats)) continue;
      if (!by.has(run.id) || by.get(run.id).at < data.at) by.set(run.id, { run, at: data.at ?? 0 });
    } catch {
      /* non è un nostro backup leggibile */
    }
  }
  return [...by.values()].map((x) => x.run).filter(Boolean);
}

/**
 * Cancella dai relay il backup privato di un draft: lo sostituisce con un evento vuoto (gli eventi sostituibili
 * tengono solo l'ultimo) e chiede ai relay di cancellarlo (NIP-09). I record del torneo (risultati, voti) restano:
 * sono anche degli altri giocatori.
 */
export async function deleteBackup(runId) {
  const { sk, pk } = identity();
  const d = `${BACKUP_TAG}:${runId}`;
  const empty = finalizeEvent({ kind: KIND, created_at: now(), tags: [["d", d], ["t", BACKUP_TAG]], content: nip44.v2.encrypt(JSON.stringify({ v: 1, deleted: runId, at: Date.now() }), selfKey()) }, fromHex(sk));
  const del = finalizeEvent({ kind: 5, created_at: now(), tags: [["a", `${KIND}:${pk}:${d}`], ["k", String(KIND)]], content: "Helios: draft deleted" }, fromHex(sk));
  const res = await Promise.allSettled([...pool().publish(eloRelays(), empty), ...pool().publish(eloRelays(), del)]);
  return res.some((r) => r.status === "fulfilled");
}

