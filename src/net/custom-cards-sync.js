// Carte personalizzate salvate con il profilo: ogni carta è un evento NIP-78 (kind 30078) sostituibile sui relay
// della classifica, cifrato per sé stessi (NIP-44 tra la propria chiave segreta e la propria pubblica), quindi le
// legge solo chi ha la chiave del giocatore. Importando il profilo su un altro browser (parole, nsec, backup con
// password) le carte tornano. Una carta cancellata lascia al suo posto un evento "cancellata" (gli eventi
// sostituibili tengono solo l'ultimo), così non ricompare dagli altri browser.
//
// Nel backup l'artwork è ridotto: NIP-44 cifra al massimo 64 KB e i relay rifiutano gli eventi troppo grandi.
// La versione piena resta nel browser dove la carta è stata modificata l'ultima volta.
import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { identity, fromHex } from "./identity.js";
import { eloRelays } from "./elo.js";
import { sharedPool } from "./social.js";
import { customCards, storeCustomCard, deleteCustomCard, cleanCard, isCustomCode } from "../data/custom-cards.js";
import { compactArt } from "../ui/card-render.js";

const KIND = 30078;
const TAG = "helios-cards-v1";
const DELETED = "ygoweb.customCardsDeleted"; // cancellazioni non ancora arrivate ai relay: { codice: ms }
// byte del JSON cifrato: base64 + firma fanno un evento ~1,4 volte più grande e molti relay (strfry) rifiutano
// quelli oltre 64 KB
const MAX_PLAIN = 44_000;
const now = () => Math.floor(Date.now() / 1000);

let ownPool = null;
const pool = () => sharedPool() ?? (ownPool ??= new SimplePool({ enablePing: true, enableReconnect: true }));
const selfKey = () => {
  const { sk, pk } = identity();
  return nip44.v2.utils.getConversationKey(fromHex(sk), pk);
};
const bytes = (text) => new TextEncoder().encode(text).length;

const pendingDeletes = () => {
  try {
    const v = JSON.parse(localStorage.getItem(DELETED) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
const setPendingDeletes = (v) => {
  try {
    localStorage.setItem(DELETED, JSON.stringify(v));
  } catch {
    /* storage non disponibile */
  }
};

async function publish(data, code) {
  const { sk } = identity();
  const ev = finalizeEvent({ kind: KIND, created_at: now(), tags: [["d", `${TAG}:${code}`], ["t", TAG]], content: nip44.v2.encrypt(JSON.stringify(data), selfKey()) }, fromHex(sk));
  const res = await Promise.allSettled(pool().publish(eloRelays(), ev));
  return res.some((r) => r.status === "fulfilled");
}

/** Il contenuto del backup di una carta: artwork ridotto finché sta nel limite (se non basta, senza). */
async function payload(c) {
  const fits = (card) => bytes(JSON.stringify({ v: 1, card })) <= MAX_PLAIN;
  if (!c.art && fits(c)) return { v: 1, card: c };
  if (c.art) {
    for (const [size, q] of [[480, 0.82], [360, 0.76], [260, 0.7], [180, 0.62]]) {
      const art = await compactArt(c.art, size, q).catch(() => null);
      if (art && fits({ ...c, art })) return { v: 1, card: { ...c, art } };
    }
  }
  const bare = { ...c, art: null };
  return fits(bare) ? { v: 1, card: bare } : null;
}

async function upload(c) {
  const data = await payload(c);
  return data ? publish(data, c.code) : false;
}

async function uploadDeletion(code, at) {
  const ok = await publish({ v: 1, deleted: code, at }, code);
  const pend = pendingDeletes();
  if (ok && pend[code] === at) {
    delete pend[code];
    setPendingDeletes(pend);
  }
  return ok;
}

// ---------------------------------------------------------------- modifiche fatte qui → relay

const timers = new Map();
window.addEventListener("helios-custom-card", (e) => {
  const { code, deleted } = e.detail ?? {};
  if (!isCustomCode(code)) return;
  clearTimeout(timers.get(code));
  if (deleted) {
    timers.delete(code);
    const at = Date.now();
    setPendingDeletes({ ...pendingDeletes(), [code]: at });
    uploadDeletion(code, at).catch(() => {});
    return;
  }
  // il salvataggio automatico scatta mentre si scrive: si pubblica solo quando ci si ferma
  timers.set(code, setTimeout(() => {
    timers.delete(code);
    const c = customCards().find((x) => x.code === code);
    if (c) upload(c).catch(() => {});
  }, 4000));
});

// ---------------------------------------------------------------- relay ↔ browser

/** Le carte nel backup di questo profilo: codice → { card } o { deleted, at } (l'ultima versione di ognuna). */
async function fetchBackup() {
  const { pk } = identity();
  const evs = await pool().querySync(eloRelays(), { kinds: [KIND], authors: [pk], "#t": [TAG], limit: 1000 }, { maxWait: 7000 });
  const by = new Map();
  const when = (x) => (x.card ? x.card.updated : x.at);
  for (const ev of evs) {
    if (!verifyEvent(ev)) continue;
    try {
      const data = JSON.parse(nip44.v2.decrypt(ev.content, selfKey()));
      let item = null;
      if (isCustomCode(data?.deleted)) item = { code: data.deleted, deleted: true, at: Number(data.at) || 0 };
      else {
        const card = cleanCard(data?.card);
        if (card) item = { code: card.code, card };
      }
      if (item && (!by.has(item.code) || when(by.get(item.code)) < when(item))) by.set(item.code, item);
    } catch {
      /* non è un nostro backup leggibile */
    }
  }
  return by;
}

let running = null;
/**
 * Allinea le carte del browser con quelle salvate nel profilo: arrivano quelle nuove o più recenti (e spariscono quelle
 * cancellate altrove), partono quelle che il backup non ha o ha più vecchie. Restituisce { restored, removed, uploaded }.
 */
export function syncCustomCards() {
  running ??= (async () => {
    const backup = await fetchBackup();
    const pend = pendingDeletes();
    let restored = 0;
    let removed = 0;
    let uploaded = 0;
    for (const [code, item] of backup) {
      if (pend[code]) continue; // cancellata qui, la cancellazione deve ancora arrivare ai relay
      const mine = customCards().find((x) => x.code === code);
      if (item.deleted) {
        if (mine && mine.updated <= item.at) {
          await deleteCustomCard(code, { sync: true });
          removed++;
        }
      } else if (!mine || mine.updated < item.card.updated) {
        await storeCustomCard(item.card);
        restored++;
      }
    }
    for (const [code, at] of Object.entries(pend)) await uploadDeletion(+code, at).catch(() => {});
    for (const c of customCards()) {
      const item = backup.get(c.code);
      const theirs = item ? (item.card ? item.card.updated : item.at) : -1;
      if (c.updated > theirs && (await upload(c).catch(() => false))) uploaded++;
    }
    if (restored || removed) window.dispatchEvent(new CustomEvent("helios-custom-cards-synced", { detail: { restored, removed } }));
    return { restored, removed, uploaded };
  })().finally(() => (running = null));
  return running;
}

// Profilo importato (o nuovo): le sue carte arrivano, quelle di questo browser si aggiungono al suo backup.
window.addEventListener("helios-identity", () => {
  syncCustomCards().catch(() => {});
});
