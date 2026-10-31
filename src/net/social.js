// Amici, presenza online e inviti senza server, sui relay Nostr della classifica (elo.js).
//
// - Lista amici: resta nel browser e si sincronizza sui relay in un evento NIP-78 cifrato per sé (NIP-44):
//   chi ha la stessa chiave (seed, nsec) la ritrova su un altro browser, nessun altro sa chi sono i tuoi amici.
// - Messaggi tra giocatori (richieste di amicizia, inviti): "gift wrap" NIP-59, cifrati per il destinatario e
//   firmati da una chiave usa e getta, così sui relay non si vede chi scrive a chi.
// - Presenza: ogni minuto un evento con lo stato ("online", "in duello"), firmato da una chiave di presenza
//   diversa da quella del giocatore e cifrato con essa. La chiave segreta di presenza la ricevono solo gli
//   amici (con l'amicizia): solo loro sanno di chi è e la leggono. Rimuovendo un amico la chiave cambia.
//   In duello la presenza porta anche le chiavi per guardarlo da spettatori (vedi spectate.js).
import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { wrapEvent, unwrapEvent } from "nostr-tools/nip59";
import * as nip44 from "nostr-tools/nip44";
import { settings } from "../data/settings.js";
import { identity, toHex, fromHex } from "./identity.js";
import { eloRelays } from "./elo.js";

const KEY = "ygoweb.social";
const KIND = 30078; // NIP-78: dati di un'applicazione
const PROFILE_D = "helios-social";
const PRESENCE_D = "helios-presence";
const MSG_TAG = "helios-social-v1";
const HEARTBEAT_MS = 60 * 1000;
const ONLINE_FOR_S = 150; // online se l'ultimo battito è più recente di così
const INVITE_TTL_S = 120;
const MAX_REQUESTS = 30;
const HEX64 = /^[0-9a-f]{64}$/;
const ROOM = /^[A-HJ-NP-Z2-9]{8}$/;
const TWO_DAYS = 2 * 24 * 3600;

const now = () => Math.floor(Date.now() / 1000);
const cleanName = (n) => String(n ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "Duelist";

// ---------------------------------------------------------------- stato nel browser

/**
 * { updated, name, presenceSk, friends: [{ pk, name, status: "friend"|"sent", presence, since }],
 *   requests: [{ pk, name, presence, at }], recent: [{ pk, name, at }], seen: [id] }
 * updated: ora dell'ultima modifica (ms) per la sincronizzazione; recent e seen restano solo qui.
 */
function load() {
  let v = null;
  try {
    v = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch { /* storage non leggibile */ }
  if (!v || v.owner !== identity().pk) v = { owner: identity().pk, updated: 0 };
  v.friends = Array.isArray(v.friends) ? v.friends.filter((f) => HEX64.test(f?.pk)) : [];
  v.requests = Array.isArray(v.requests) ? v.requests.filter((f) => HEX64.test(f?.pk)) : [];
  v.recent = Array.isArray(v.recent) ? v.recent.filter((f) => HEX64.test(f?.pk)) : [];
  v.seen = Array.isArray(v.seen) ? v.seen : [];
  if (!HEX64.test(v.presenceSk ?? "")) v.presenceSk = toHex(generateSecretKey());
  return v;
}

let state = load();
function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* storage pieno */ }
}

const listeners = new Set();
/** Avvisa la UI (lista amici, contatori) che qualcosa è cambiato. */
function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}
export function onSocialChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Modifica della parte sincronizzata (amici, richieste, chiave di presenza): si salva e si pubblica. */
function touch() {
  state.updated = Date.now();
  persist();
  schedulePublishProfile();
  notify();
}

// ---------------------------------------------------------------- relay

let pool = null;
const relays = () => eloRelays();
const sk = () => fromHex(identity().sk);

function publish(ev, extra = []) {
  if (!pool) return Promise.resolve(0);
  const urls = [...new Set([...relays(), ...extra])];
  return Promise.allSettled(pool.publish(urls, ev, { maxWait: 6000 })).then((r) => r.filter((x) => x.status === "fulfilled").length);
}

// ---------------------------------------------------------------- profilo sincronizzato

const selfKey = () => nip44.v2.utils.getConversationKey(sk(), identity().pk);
const synced = () => ({ v: 1, updated: state.updated, name: settings.name, presenceSk: state.presenceSk, friends: state.friends, requests: state.requests });

let profileTimer = 0;
function schedulePublishProfile() {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(publishProfile, 1500);
}
async function publishProfile() {
  if (!pool) return;
  const ev = finalizeEvent({ kind: KIND, created_at: now(), tags: [["d", PROFILE_D]], content: nip44.v2.encrypt(JSON.stringify(synced()), selfKey()) }, sk());
  await publish(ev);
}

/** Scarica il profilo dai relay: se è più recente di quello qui lo si usa, altrimenti si pubblica il nostro. */
export async function syncProfile() {
  if (!pool) return;
  const { pk } = identity();
  const evs = await pool.querySync(relays(), { kinds: [KIND], authors: [pk], "#d": [PROFILE_D] }, { maxWait: 6000 }).catch(() => []);
  if (identity().pk !== pk) return;
  let best = null;
  for (const ev of evs) {
    if (ev.pubkey !== pk || ev.content.length > 200000) continue;
    try {
      const p = JSON.parse(nip44.v2.decrypt(ev.content, selfKey()));
      if (p?.v === 1 && Number.isFinite(p.updated) && (!best || p.updated > best.updated)) best = p;
    } catch { /* non è nostro o è rovinato */ }
  }
  if (best && best.updated > state.updated) {
    const ok = (f) => f && HEX64.test(f.pk) && f.pk !== pk;
    state.friends = (Array.isArray(best.friends) ? best.friends : []).filter(ok).map((f) => ({
      pk: f.pk, name: cleanName(f.name), status: f.status === "sent" ? "sent" : "friend", presence: HEX64.test(f.presence ?? "") ? f.presence : null, presenceAt: Number(f.presenceAt) || 0, since: Number(f.since) || 0,
    }));
    state.requests = (Array.isArray(best.requests) ? best.requests : []).filter(ok).slice(0, MAX_REQUESTS).map((f) => ({ pk: f.pk, name: cleanName(f.name), presence: HEX64.test(f.presence ?? "") ? f.presence : null, at: Number(f.at) || 0 }));
    if (HEX64.test(best.presenceSk ?? "")) state.presenceSk = best.presenceSk;
    state.updated = best.updated;
    if (typeof best.name === "string" && best.name.trim()) settings.name = cleanName(best.name).slice(0, 24);
    persist();
    subscribePresence();
    notify();
  } else if (state.updated && (!best || best.updated < state.updated)) await publishProfile();
}

// ---------------------------------------------------------------- messaggi tra giocatori (NIP-59)

/** Manda un messaggio cifrato a un giocatore; restituisce quanti relay l'hanno accettato. */
function sendTo(pk, msg, extra) {
  if (!pool) return Promise.resolve(0);
  const ev = wrapEvent({ kind: KIND, created_at: now(), tags: [["t", MSG_TAG]], content: JSON.stringify({ ...msg, name: cleanName(settings.name) }) }, sk(), pk);
  return publish(ev, extra);
}

const friend = (pk) => state.friends.find((f) => f.pk === pk);
const isFriend = (pk) => friend(pk)?.status === "friend";

/** Chiave di presenza di un amico: vale l'ultima mandata (i relay rimandano anche i messaggi vecchi). */
function setPresence(f, presence, at) {
  if (!presence || (f.presenceAt ?? 0) > at) return;
  f.presence = presence;
  f.presenceAt = at;
}

/** Messaggi già letti (id dei gift wrap): i relay li rimandano a ogni connessione. */
function seen(id) {
  if (state.seen.includes(id)) return true;
  state.seen.push(id);
  if (state.seen.length > 600) state.seen.splice(0, state.seen.length - 600);
  persist();
  return false;
}

const handlers = { invite: new Set(), reply: new Set(), cancel: new Set(), request: new Set(), direct: new Set(), watch: new Set() };
/** Inviti ricevuti da un amico: fn({ id, from, name, room, rules, expires }). */
export const onInvite = (fn) => (handlers.invite.add(fn), () => handlers.invite.delete(fn));
/** Risposte ai nostri inviti: fn({ id, from, accept, reason }). */
export const onInviteReply = (fn) => (handlers.reply.add(fn), () => handlers.reply.delete(fn));
/** Inviti ritirati da chi li aveva mandati: fn({ id, from }). */
export const onInviteCancel = (fn) => (handlers.cancel.add(fn), () => handlers.cancel.delete(fn));
/** Richiesta di amicizia nuova: fn({ pk, name }). */
export const onFriendRequest = (fn) => (handlers.request.add(fn), () => handlers.request.delete(fn));
const emit = (set, v) => set.forEach((fn) => fn(v));

function receive(wrap) {
  if (wrap.content.length > 60000 || seen(wrap.id)) return;
  let rumor;
  try {
    rumor = unwrapEvent(wrap, sk());
  } catch {
    return; // non per noi o rovinato
  }
  if (rumor.kind !== KIND || !rumor.tags?.some((t) => t[0] === "t" && t[1] === MSG_TAG) || !HEX64.test(rumor.pubkey) || rumor.pubkey === identity().pk) return;
  let m;
  try {
    m = JSON.parse(rumor.content);
  } catch {
    return;
  }
  if (!m || typeof m !== "object") return;
  const from = rumor.pubkey;
  const at = Number(rumor.created_at) || 0;
  const name = cleanName(m.name);
  const presence = HEX64.test(m.presence ?? "") ? m.presence : null;
  const f = friend(from);
  switch (m.t) {
    case "friend-request": {
      if (f && f.since > at * 1000) return; // richiesta vecchia, l'amicizia è stata rifatta dopo
      if (f?.status === "sent") {
        // Ci eravamo già aggiunti a vicenda: siamo amici.
        Object.assign(f, { status: "friend", name });
        setPresence(f, presence, at);
        touch();
        subscribePresence();
      } else if (f) {
        // Già amici (l'altro ha cambiato browser o ci ha riaggiunto): gli serve di nuovo la nostra chiave.
        f.name = name;
        setPresence(f, presence, at);
        touch();
        subscribePresence();
        if (at > now() - 600) sendTo(from, { t: "friend-accept", presence: state.presenceSk });
      } else {
        const old = state.requests.find((r) => r.pk === from);
        if (old) Object.assign(old, { name, presence, at });
        else {
          if (state.requests.length >= MAX_REQUESTS) return;
          state.requests.push({ pk: from, name, presence, at });
          emit(handlers.request, { pk: from, name });
        }
        touch();
      }
      return;
    }
    case "friend-accept":
      if (!f) return; // non l'avevamo chiesto
      Object.assign(f, { status: "friend", name });
      setPresence(f, presence, at);
      touch();
      subscribePresence();
      return;
    case "friend-remove":
      if (f && f.since < at * 1000) {
        state.friends = state.friends.filter((x) => x.pk !== from);
        rotatePresence();
      }
      state.requests = state.requests.filter((r) => r.pk !== from);
      touch();
      return;
    case "presence-key":
      if (f?.status === "friend" && presence) {
        setPresence(f, presence, at);
        touch();
        subscribePresence();
      }
      return;
    case "invite": {
      const expires = Math.min(Number(m.expires) || 0, at + INVITE_TTL_S);
      if (!isFriend(from) || expires < now() || typeof m.id !== "string" || m.id.length > 40 || !ROOM.test(m.room ?? "")) return;
      friend(from).name = name;
      emit(handlers.invite, { id: m.id, from, name, room: m.room, rules: cleanRules(m.rules), expires });
      return;
    }
    case "invite-reply":
      if (isFriend(from) && typeof m.id === "string") emit(handlers.reply, { id: m.id, from, accept: m.accept === true, reason: String(m.reason ?? "").slice(0, 80) });
      return;
    case "invite-cancel":
      if (isFriend(from) && typeof m.id === "string") emit(handlers.cancel, { id: m.id, from });
      return;
    // Spettatori (spectate.js, duel/coaching.js): un amico guarda il nostro duello, smette o segnala un errore.
    case "watch-hello":
    case "watch-bye":
    case "watch-note":
      if (isFriend(from) && typeof m.id === "string" && m.id.length <= 40) emit(handlers.watch, { ...m, from, name, at });
      return;
    default:
      // Matchmaking con sconosciuti (matchmaking.js): solo messaggi recenti, il resto lo controlla lui.
      if (typeof m.t === "string" && m.t.startsWith("mm-") && at > now() - 120) emit(handlers.direct, { ...m, from, name, at, relay: seenOn(wrap.id)[0] ?? null });
  }
}

/** Messaggi degli amici che guardano i nostri duelli: fn({ t: "watch-hello"|"watch-bye"|"watch-note", id, from, name, ... }). */
export const onWatchMessage = (fn) => (handlers.watch.add(fn), () => handlers.watch.delete(fn));
/** Messaggio a un amico che stiamo guardando (solo amici). */
export const sendWatch = (pk, msg) => (isFriend(pk) ? sendTo(pk, msg) : Promise.resolve(0));
/** Evento già firmato (es. dalla chiave usa e getta di un duello trasmesso agli spettatori). */
export const publishEvent = (ev) => publish(ev);

/** Messaggi "mm-*" da qualunque giocatore (matchmaking): fn({ t, from, name, at, ... }). */
export const onDirect = (fn) => (handlers.direct.add(fn), () => handlers.direct.delete(fn));
/** Messaggio cifrato a un giocatore qualunque (matchmaking). */
/** extra: altri relay su cui pubblicarlo (es. quelli da cui arriva l'annuncio dell'altro, se usa relay diversi). */
export const sendDirect = (pk, msg, extra) => sendTo(pk, msg, extra);
/** Evento firmato con la chiave del giocatore, pubblicato sui relay. */
export const publishSigned = (tmpl) => publish(finalizeEvent(tmpl, sk()));
/** Relay da cui è arrivato un evento (per la schermata del matchmaking). */
export const seenOn = (id) => [...(pool?.seenOn.get(id) ?? [])].map((r) => r.url);
/** Relay in uso con il loro stato: [{ url, connected }]. */
export function relayStatus() {
  const st = pool?.listConnectionStatus() ?? new Map();
  const norm = (u) => u.replace(/\/+$/, "");
  return relays().map((url) => ({ url, connected: [...st].some(([u, ok]) => ok && norm(u) === norm(url)) }));
}
/** Connessioni ai relay di amici e matchmaking (null se non avviate): le riusa il ripiego dei duelli sui relay. */
export const sharedPool = () => pool;
/** Iscrizione ai relay (null se non collegati): restituisce { close() }. */
export const subscribeRelays = (filter, onevent) => (pool ? pool.subscribeMany(relays(), filter, { onevent }) : null);

/** Riassunto delle regole di un invito (solo da mostrare: quelle vere arrivano con il duello). */
function cleanRules(r) {
  const s = (v) => (typeof v === "string" ? v.slice(0, 60) : "");
  return { banlist: s(r?.banlist), timer: s(r?.timer), mode: s(r?.mode), bestOf: [1, 3, 5].includes(r?.bestOf) ? r.bestOf : 1, ranked: r?.ranked === true };
}

// ---------------------------------------------------------------- amici

/** Aggiunge un amico (chiave pubblica esadecimale): gli arriva la richiesta, è amico quando accetta. */
export async function addFriend(pk, name = "") {
  if (!HEX64.test(pk)) throw new Error("Not a valid player key");
  if (pk === identity().pk) throw new Error("That is your own friend code");
  const req = state.requests.find((r) => r.pk === pk);
  if (req) return acceptRequest(pk);
  if (friend(pk)) throw new Error("Already in your friends list");
  state.friends.push({ pk, name: cleanName(name || state.recent.find((r) => r.pk === pk)?.name), status: "sent", presence: null, since: Date.now() });
  touch();
  const n = await sendTo(pk, { t: "friend-request", presence: state.presenceSk });
  if (!n) throw new Error("The Nostr relays did not answer: the request will not arrive. Try again later.");
}

export async function acceptRequest(pk) {
  const r = state.requests.find((x) => x.pk === pk);
  if (!r) return;
  state.requests = state.requests.filter((x) => x.pk !== pk);
  state.friends = state.friends.filter((x) => x.pk !== pk);
  state.friends.push({ pk, name: r.name, status: "friend", presence: r.presence, presenceAt: r.at, since: Date.now() });
  touch();
  subscribePresence();
  await sendTo(pk, { t: "friend-accept", presence: state.presenceSk });
}

export function declineRequest(pk) {
  state.requests = state.requests.filter((x) => x.pk !== pk);
  touch();
}

/** Toglie un amico: gli si dice e la chiave di presenza cambia (non vede più quando sei online). */
export async function removeFriend(pk) {
  if (!friend(pk)) return;
  state.friends = state.friends.filter((x) => x.pk !== pk);
  sendTo(pk, { t: "friend-remove" });
  rotatePresence();
  touch();
}

/** Chiave di presenza nuova, mandata agli amici rimasti. */
function rotatePresence() {
  state.presenceSk = toHex(generateSecretKey());
  persist();
  for (const f of state.friends) if (f.status === "friend") sendTo(f.pk, { t: "presence-key", presence: state.presenceSk });
  heartbeat();
}

export function renameFriend(pk, name) {
  const f = friend(pk);
  if (!f) return;
  f.name = cleanName(name);
  touch();
}

/** Avversari recenti (dal duello online): si possono aggiungere agli amici. */
export function rememberOpponent(pk, name) {
  if (!HEX64.test(pk ?? "") || pk === identity().pk) return;
  state.recent = [{ pk, name: cleanName(name), at: Date.now() }, ...state.recent.filter((r) => r.pk !== pk)].slice(0, 10);
  persist();
  notify();
}

// ---------------------------------------------------------------- presenza

/** Stato degli amici: pk → { status, at, name } dall'ultimo battito ricevuto. */
const live = new Map();
let presenceSub = null;
let heartbeatTimer = 0;
let statusOf = () => "online";
let watchOf = () => null;

const presencePk = (skHex) => getPublicKey(fromHex(skHex));
const presenceKey = (skHex) => nip44.v2.utils.getConversationKey(fromHex(skHex), presencePk(skHex));

async function heartbeat(status = statusOf()) {
  clearTimeout(heartbeatTimer);
  if (!pool) return;
  heartbeatTimer = setTimeout(() => heartbeat(), HEARTBEAT_MS);
  // Invisibile: si manda un solo "offline", poi niente.
  if (settings.showOnline === false) {
    if (state.lastStatus === "offline") return;
    status = "offline";
  }
  state.lastStatus = status;
  const p = state.presenceSk;
  // In duello: chiavi per guardarlo (solo gli amici leggono la presenza).
  const watch = status === "duel" ? watchOf() : null;
  const content = nip44.v2.encrypt(JSON.stringify({ status, name: cleanName(settings.name), at: now(), ...(watch ? { watch } : {}) }), presenceKey(p));
  const ev = finalizeEvent({ kind: KIND, created_at: now(), tags: [["d", PRESENCE_D], ["expiration", String(now() + 3 * 3600)]], content }, fromHex(p));
  await publish(ev);
}

function subscribePresence() {
  presenceSub?.close();
  presenceSub = null;
  if (!pool) return;
  // Chiave di presenza → amico.
  const byKey = new Map();
  for (const f of state.friends) if (f.status === "friend" && f.presence) byKey.set(presencePk(f.presence), f);
  if (!byKey.size) return;
  presenceSub = pool.subscribeMany(relays(), { kinds: [KIND], authors: [...byKey.keys()], "#d": [PRESENCE_D] }, {
    onevent(ev) {
      const f = byKey.get(ev.pubkey);
      if (!f || ev.content.length > 4000) return;
      try {
        const p = JSON.parse(nip44.v2.decrypt(ev.content, presenceKey(f.presence)));
        const at = Math.min(Number(p.at) || 0, ev.created_at, now() + 60);
        if ((live.get(f.pk)?.at ?? 0) > at) return;
        const status = ["online", "duel", "offline"].includes(p.status) ? p.status : "online";
        live.set(f.pk, { status, at, watch: status === "duel" ? cleanWatch(p.watch) : null });
        if (p.name && cleanName(p.name) !== f.name) {
          f.name = cleanName(p.name);
          persist();
        }
        notify();
      } catch { /* non decifrabile */ }
    },
  });
}

/** Chiavi di un duello da guardare (spectate.js): { id, pk, key } o null. */
function cleanWatch(w) {
  return w && /^[0-9a-f]{16}$/.test(w.id ?? "") && HEX64.test(w.pk ?? "") && HEX64.test(w.key ?? "") ? { id: w.id, pk: w.pk, key: w.key } : null;
}

/**
 * Stato di un amico: "online", "duel", "offline" (con lastSeen in secondi) o "pending" (richiesta mandata).
 * In duello, watch = chiavi per guardarlo (null se non si può: spettatori non ammessi o client vecchio).
 */
export function presenceOf(f) {
  if (f.status !== "friend") return { status: "pending" };
  const p = live.get(f.pk);
  if (!p) return { status: "offline", lastSeen: null };
  if (p.status === "offline" || now() - p.at > ONLINE_FOR_S) return { status: "offline", lastSeen: p.at };
  return { status: p.status, watch: p.watch ?? null };
}

// ---------------------------------------------------------------- inviti

/** Invita un amico nella stanza Nostr `room`; restituisce l'id dell'invito. */
export async function sendInvite(pk, room, rules) {
  if (!isFriend(pk)) throw new Error("You can only invite your friends");
  const id = toHex(crypto.getRandomValues(new Uint8Array(8)));
  const n = await sendTo(pk, { t: "invite", id, room, rules, expires: now() + INVITE_TTL_S });
  if (!n) throw new Error("The Nostr relays did not answer: the invite was not sent");
  return id;
}
export const replyInvite = (inv, accept, reason = "") => sendTo(inv.from, { t: "invite-reply", id: inv.id, accept, reason });
export const cancelInvite = (pk, id) => sendTo(pk, { t: "invite-cancel", id });
export const INVITE_SECONDS = INVITE_TTL_S;

// ---------------------------------------------------------------- avvio

let inbox = null;
let tick = 0;
let inboxGuard = 0;

/**
 * Messaggi in arrivo (gift wrap per la nostra chiave). Quando un relay si riconnette nostr-tools riprende le
 * iscrizioni chiedendo solo gli eventi più nuovi dell'ultimo ricevuto (since = lastEmitted + 1), ma i gift wrap
 * hanno di proposito una data casuale fino a 2 giorni prima (NIP-59): dopo una riconnessione il relay scartava quasi
 * tutti i messaggi nuovi (offerte del matchmaking, inviti, richieste di amicizia). Per questa iscrizione l'ultimo
 * evento ricevuto non si ricorda, così riparte sempre dai 2 giorni prima; i doppioni li toglie seen().
 */
function guardInbox() {
  for (const relay of pool?.relays?.values() ?? []) {
    for (const sub of relay.openSubs?.values() ?? []) {
      if (sub.heliosInbox || !sub.filters?.some((f) => f.kinds?.includes(1059))) continue;
      sub.heliosInbox = true;
      Object.defineProperty(sub, "lastEmitted", { get: () => undefined, set: () => {}, configurable: true });
    }
  }
}
function openInbox() {
  const old = inbox;
  inbox = pool.subscribeMany(relays(), { kinds: [1059], "#p": [identity().pk], since: now() - TWO_DAYS - 600 }, { onevent: receive });
  old?.close();
  guardInbox();
}

/** Lista per la UI. */
export const socialState = () => ({ friends: state.friends, requests: state.requests, recent: state.recent.filter((r) => !friend(r.pk)) });
export const onlineCount = () => state.friends.filter((f) => ["online", "duel"].includes(presenceOf(f).status)).length;

/**
 * Collega amici e presenza ai relay (all'avvio e a ogni cambio di identità).
 * status(): "online" o "duel", letto a ogni battito; watch(): chiavi del duello da guardare o null.
 */
export function startSocial({ status, watch } = {}) {
  if (status) statusOf = status;
  if (watch) watchOf = watch;
  stopSocial();
  state = load();
  persist();
  pool = new SimplePool({ enablePing: true, enableReconnect: true });
  pool.trackRelays = true; // da quale relay arriva un evento (seenOn)
  openInbox();
  // Le iscrizioni ai relay nascono quando ognuno si collega: si proteggono appena ci sono.
  inboxGuard = setInterval(guardInbox, 1000);
  subscribePresence();
  heartbeat();
  syncProfile().catch((e) => console.warn("Friends sync:", e));
  // Gli amici diventano "offline" da soli quando i battiti smettono di arrivare.
  tick = setInterval(notify, 30000);
}

export function stopSocial() {
  clearTimeout(heartbeatTimer);
  clearTimeout(profileTimer);
  clearInterval(tick);
  clearInterval(inboxGuard);
  inbox?.close();
  presenceSub?.close();
  inbox = presenceSub = null;
  live.clear();
  if (pool) {
    const p = pool;
    pool = null;
    try {
      p.destroy?.();
    } catch { /* già chiuso */ }
  }
}

/** Cambio di stato (inizio/fine duello): il battito parte subito. */
export const statusChanged = () => heartbeat();

/** Chiusura della pagina: "offline" subito, senza aspettare i battiti. */
export function goingOffline() {
  if (pool && settings.showOnline !== false) heartbeat("offline");
}

window.addEventListener("helios-identity", () => {
  if (pool) startSocial();
});
