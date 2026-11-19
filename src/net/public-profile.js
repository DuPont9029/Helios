// Profilo pubblico del giocatore (la sua "scheda"): un evento NIP-78 (kind 30078) sostituibile, firmato con la chiave
// del giocatore e NON cifrato, sui relay della classifica. Chiunque conosca la chiave pubblica (amici, avversari,
// classifica) lo legge: nome, immagine, una frase, i mazzi giocati online e, solo se il giocatore lo sceglie, gli
// indirizzi ETH e XMR per ricevere crypto. Non è il profilo Nostr (kind 0): chi usa la stessa chiave altrove non se lo
// vede sovrascrivere.
import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { settings } from "../data/settings.js";
import { identity, fromHex, sha256Hex, canonical } from "./identity.js";
import { eloRelays } from "./elo.js";
import { sharedPool } from "./social.js";

const KIND = 30078;
const D = "helios-public-profile";
const TAG = "helios-profile-v1";
// Codice breve della scheda (link https://…/#p/<codice>): i primi 10 caratteri della chiave, anche come tag
// dell'evento ("helios-p-<codice>"), così i relay la trovano senza la chiave intera.
const CODE_TAG = "helios-p-";
export const profileCode = (pk) => String(pk).slice(0, 10);
const PLAYED = "ygoweb.playedDecks"; // mazzi giocati online: [{ key, name, main, extra, side, cover, games, at }]
const PUBLISHED = "ygoweb.publicProfileHash"; // impronta dell'ultimo profilo pubblicato (per non ripubblicarlo uguale)
export const MAX_AVATAR = 60000; // caratteri del data URL (l'evento resta sotto i 64 KB dei relay)
const MAX_DECKS = 5;
const HEX64 = /^[0-9a-f]{64}$/;
const AVATAR_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/;
const ETH_RE = /^0x[0-9a-fA-F]{40}$/;
const XMR_RE = /^[48][1-9A-HJ-NP-Za-km-z]{94}$/;

let ownPool = null;
const pool = () => sharedPool() ?? (ownPool ??= new SimplePool({ enablePing: true, enableReconnect: true }));
const now = () => Math.floor(Date.now() / 1000);

const codes = (v, max) => (Array.isArray(v) ? v.filter((c) => Number.isInteger(c) && c > 0 && c < 2 ** 31).slice(0, max) : []);
const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** Profilo pulito (anche quello che arriva dai relay, scritto da chiunque). */
export function cleanProfile(v) {
  if (!v || typeof v !== "object") return null;
  const wallets = {};
  if (ETH_RE.test(v.wallets?.eth ?? "")) wallets.eth = v.wallets.eth;
  if (XMR_RE.test(v.wallets?.xmr ?? "")) wallets.xmr = v.wallets.xmr;
  return {
    name: str(v.name, 24) || "Duelist",
    avatar: typeof v.avatar === "string" && v.avatar.length <= MAX_AVATAR && AVATAR_RE.test(v.avatar) ? v.avatar : "",
    bio: str(v.bio, 160),
    wallets,
    decks: (Array.isArray(v.decks) ? v.decks : []).slice(0, MAX_DECKS).map((d) => ({
      name: str(d?.name, 40) || "Deck",
      main: codes(d?.main, 60), extra: codes(d?.extra, 15), side: codes(d?.side, 15),
      cover: Number.isInteger(d?.cover) ? d.cover : null,
      games: Number.isInteger(d?.games) && d.games > 0 ? Math.min(d.games, 1e6) : 1,
      at: Number.isFinite(d?.at) ? d.at : 0,
    })).filter((d) => d.main.length || d.extra.length),
    updated: Number.isFinite(v.updated) ? v.updated : 0,
  };
}

// ---------------------------------------------------------------- mazzi giocati

const readPlayed = () => {
  try {
    const v = JSON.parse(localStorage.getItem(PLAYED) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** Un mazzo usato in una partita online: va nella scheda (i più giocati di recente). */
export async function recordPlayedDeck(deck) {
  if (!deck?.main?.length) return;
  const key = await sha256Hex(canonical({ main: [...deck.main].sort(), extra: [...(deck.extra ?? [])].sort() }));
  const list = readPlayed();
  const old = list.find((d) => d.key === key);
  const entry = { key, name: str(deck.name, 40) || "Deck", main: [...deck.main], extra: [...(deck.extra ?? [])], side: [...(deck.side ?? [])], cover: deck.cover ?? null, games: (old?.games ?? 0) + 1, at: Date.now() };
  const next = [entry, ...list.filter((d) => d.key !== key)].slice(0, 20);
  try {
    localStorage.setItem(PLAYED, JSON.stringify(next));
  } catch {
    /* storage pieno */
  }
  schedulePublish();
}

/** I mazzi della scheda: i più recenti, poi i più giocati. */
export function playedDecks() {
  return readPlayed().sort((a, b) => b.at - a.at).slice(0, MAX_DECKS);
}

export function forgetPlayedDecks() {
  try {
    localStorage.removeItem(PLAYED);
  } catch {
    /* niente */
  }
  schedulePublish();
}

// ---------------------------------------------------------------- pubblicazione

/** Il proprio profilo come lo vedono gli altri. */
export async function myProfile() {
  const p = { name: settings.name, avatar: settings.avatar || "", bio: settings.bio || "", wallets: {}, decks: [], updated: Date.now() };
  if (settings.profileShowDecks !== false) p.decks = playedDecks();
  if (settings.profileShowWallets && identity().seed) {
    const { bip39Seed, ethAddresses, moneroWallet } = await import("./wallets.js");
    const seed = bip39Seed(identity().seed);
    p.wallets = { eth: ethAddresses(seed, 1)[0].address, xmr: moneroWallet(seed).address };
  }
  return cleanProfile(p);
}

let timer = 0;
/** Ripubblica il profilo fra poco (le modifiche ravvicinate vanno in un evento solo). */
export function schedulePublish(ms = 1500) {
  clearTimeout(timer);
  timer = setTimeout(() => publishProfile().catch(() => {}), ms);
}

/** Pubblica il profilo se è cambiato dall'ultima volta (force: comunque). Restituisce i relay che l'hanno preso. */
export async function publishProfile({ force = false } = {}) {
  const p = await myProfile();
  const { updated, ...content } = p;
  // "tags: 2": i profili pubblicati prima del codice breve si ripubblicano una volta con il tag nuovo
  const hash = await sha256Hex(canonical({ ...content, pk: identity().pk, tags: 2 }));
  try {
    if (!force && localStorage.getItem(PUBLISHED) === hash) return -1;
  } catch {
    /* si pubblica */
  }
  const ev = finalizeEvent({ kind: KIND, created_at: now(), tags: [["d", D], ["t", TAG], ["t", CODE_TAG + profileCode(identity().pk)]], content: JSON.stringify({ v: 1, ...p }) }, fromHex(identity().sk));
  const res = await Promise.allSettled(pool().publish(eloRelays(), ev));
  const n = res.filter((r) => r.status === "fulfilled").length;
  if (n) {
    try {
      localStorage.setItem(PUBLISHED, hash);
    } catch {
      /* la prossima volta si ripubblica */
    }
  }
  cache.set(identity().pk, { at: Date.now(), profile: p });
  return n;
}

// ---------------------------------------------------------------- lettura

const cache = new Map(); // pk → { at, profile }
const pending = new Map();
const TTL = 5 * 60 * 1000;

/** Profilo pubblico di un giocatore (null se non ne ha uno). */
export function fetchProfile(pk, { fresh = false } = {}) {
  if (!HEX64.test(pk ?? "")) return Promise.resolve(null);
  const c = cache.get(pk);
  if (!fresh && c && Date.now() - c.at < TTL) return Promise.resolve(c.profile);
  if (pending.has(pk)) return pending.get(pk);
  const job = (async () => {
    const evs = await pool().querySync(eloRelays(), { kinds: [KIND], authors: [pk], "#d": [D] }, { maxWait: 5000 }).catch(() => []);
    let best = null;
    for (const ev of evs) if (ev.pubkey === pk && verifyEvent(ev) && (!best || ev.created_at > best.created_at)) best = ev;
    let profile = null;
    try {
      profile = best ? cleanProfile(JSON.parse(best.content)) : null;
    } catch {
      profile = null;
    }
    cache.set(pk, { at: Date.now(), profile });
    return profile;
  })().finally(() => pending.delete(pk));
  pending.set(pk, job);
  return job;
}

/** Giocatore dal codice breve del link: { pk, profile } o null (se più giocatori hanno lo stesso codice, il più recente). */
export async function findProfileByCode(code) {
  if (!/^[0-9a-f]{10}$/.test(code)) return null;
  const evs = await pool().querySync(eloRelays(), { kinds: [KIND], "#t": [CODE_TAG + code], "#d": [D] }, { maxWait: 6000 }).catch(() => []);
  let best = null;
  for (const ev of evs) if (ev.pubkey.startsWith(code) && verifyEvent(ev) && (!best || ev.created_at > best.created_at)) best = ev;
  if (!best) return null;
  let profile = null;
  try {
    profile = cleanProfile(JSON.parse(best.content));
  } catch {
    profile = null;
  }
  cache.set(best.pubkey, { at: Date.now(), profile });
  return { pk: best.pubkey, profile };
}

/** Profili di più giocatori insieme (una richiesta sola ai relay), per gli elenchi: pk → profilo. */
export async function fetchProfiles(pks) {
  const want = [...new Set(pks.filter((pk) => HEX64.test(pk ?? "")))].filter((pk) => { const c = cache.get(pk); return !c || Date.now() - c.at >= TTL; });
  if (want.length) {
    const evs = await pool().querySync(eloRelays(), { kinds: [KIND], authors: want, "#d": [D] }, { maxWait: 5000 }).catch(() => []);
    const best = new Map();
    for (const ev of evs) if (want.includes(ev.pubkey) && verifyEvent(ev) && (!best.has(ev.pubkey) || ev.created_at > best.get(ev.pubkey).created_at)) best.set(ev.pubkey, ev);
    for (const pk of want) {
      let profile = null;
      try {
        profile = best.has(pk) ? cleanProfile(JSON.parse(best.get(pk).content)) : null;
      } catch {
        profile = null;
      }
      cache.set(pk, { at: Date.now(), profile });
    }
  }
  return new Map(pks.map((pk) => [pk, cache.get(pk)?.profile ?? null]));
}

/** Profilo già scaricato (senza rete), per disegnare subito gli elenchi. */
export const cachedProfile = (pk) => cache.get(pk)?.profile ?? null;

// Cambio di profilo (KeyTag, import): il nuovo si pubblica con i suoi dati.
window.addEventListener("helios-identity", () => schedulePublish(3000));
