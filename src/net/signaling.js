// Due modi per far incontrare i peer:
//  1. server WebSocket (server/signal.mjs) con codice stanza;
//  2. codice invito copia/incolla, senza alcun server oltre a STUN/TURN.
import { PeerLink, packSignal, unpackSignal } from "./peer.js";
import { localIceServers, settings, BUILD_ICE_URL, BUILD_SIGNAL_URL } from "../data/settings.js";

function signalBase() {
  const url = settings.signalUrl || BUILD_SIGNAL_URL;
  return url ? url.replace(/\/+$/, "") : location.origin;
}

function wsUrl() {
  const base = new URL(signalBase());
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = base.pathname.replace(/\/?$/, "/ws");
  return base.href;
}

/** Server TURN (con credenziali) da una risposta { iceServers } o da un array, senza la porta 53. */
function turnFrom(data) {
  const list = Array.isArray(data) ? data : data?.iceServers ?? [];
  const out = [];
  for (const s of list) {
    // Porta 53 bloccata dai browser: senza trickle ICE farebbe solo aspettare un timeout.
    const urls = [s?.urls ?? []].flat().filter((u) => typeof u === "string" && !/:53(\?|$)/.test(u));
    if (urls.length && s.username) out.push({ urls, username: s.username, credential: s.credential });
  }
  return out;
}

/** Toglie gli URL ripetuti: gli stessi TURN due volte raddoppiano i candidati e rallentano la raccolta. */
export function dedupeIce(servers) {
  const seen = new Set();
  const out = [];
  for (const sv of servers) {
    const urls = [sv.urls].flat().filter((u) => !seen.has(u));
    urls.forEach((u) => seen.add(u));
    if (urls.length) out.push({ ...sv, urls });
  }
  return out;
}

/** true se il server di segnalazione risponde (su un hosting statico come GitHub Pages di solito no). */
export async function signalingAvailable(timeoutMs = 2500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(signalBase() + "/api/health", { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

/** ICE: impostazioni locali + eventuali server (anche TURN temporanei) forniti dal server. */
export async function resolveIceServers() {
  const servers = localIceServers();
  const getJson = async (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      return res.ok ? await res.json() : null;
    } catch {
      return null; // non disponibile: bastano gli altri server
    } finally {
      clearTimeout(t);
    }
  };
  // I TURN del sito (Worker di Cloudflare o server di segnalazione) si usano solo con turnMode "cloudflare":
  // con "custom" vale solo il server dell'utente, con "off" nessun relay.
  if ((settings.turnMode ?? "cloudflare") !== "cloudflare") return servers;
  const iceUrl = BUILD_ICE_URL && BUILD_ICE_URL.replace(/\/+$/, "") !== signalBase() ? BUILD_ICE_URL : null;
  const [fromSignal, fromBuild] = await Promise.all([getJson(signalBase() + "/api/ice"), iceUrl ? getJson(iceUrl) : null]);
  return dedupeIce([...servers, ...turnFrom(fromSignal), ...turnFrom(fromBuild)]);
}

/**
 * Entra in una stanza sul server di segnalazione.
 * @returns {{ ready: Promise<{link: PeerLink, host: boolean}>, room: Promise<string>, cancel(): void }}
 */
export function connectViaServer({ room = null, onStatus = () => {} }) {
  let ws;
  let link;
  let cancelled = false;
  let resolveRoom;
  const roomPromise = new Promise((r) => (resolveRoom = r));

  const ready = new Promise((resolve, reject) => {
    onStatus("Connecting to signaling server...");
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      reject(e);
      return;
    }
    ws.onerror = () => reject(new Error("Signaling server unreachable. Choose \"Nostr relays\" for Online Rooms in Settings, or use an invite code."));
    ws.onclose = () => {
      if (!link?.channel || link.channel.readyState !== "open") reject(new Error("Connection to server closed"));
    };
    ws.onopen = () => ws.send(JSON.stringify(room ? { type: "join", room } : { type: "create" }));
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (cancelled) return;
      if (msg.type === "error") {
        reject(new Error(msg.message));
        ws.close();
        return;
      }
      if (msg.type === "joined") {
        resolveRoom(msg.room);
        // TURN offerto dal server solo con turnMode "cloudflare" (predefinito).
        const ice = dedupeIce([...localIceServers(), ...((settings.turnMode ?? "cloudflare") === "cloudflare" ? turnFrom(msg.iceServers) : [])]);
        link = new PeerLink(ice, {
          initiator: !msg.host,
          forceRelay: settings.forceRelay,
          onSignal: (data) => ws.send(JSON.stringify({ type: "signal", data })),
        });
        link.addEventListener("open", () => {
          onStatus("Connected!");
          // Il server non serve più: i dati viaggiano in P2P.
          setTimeout(() => ws.close(), 500);
          resolve({ link, host: msg.host });
        });
        link.addEventListener("state", (e) => onStatus(`WebRTC: ${e.detail}`));
        if (msg.host) onStatus(`Room ${msg.room} created. Waiting for opponent...`);
        else {
          onStatus("Negotiating WebRTC...");
          await link.createOffer();
        }
        return;
      }
      if (msg.type === "peer-joined") onStatus("Opponent found, negotiating WebRTC...");
      if (msg.type === "peer-left") onStatus("Your opponent left the Room");
      if (msg.type === "signal") await link?.handleSignal(msg.data);
    };
  });

  return {
    ready,
    room: roomPromise,
    cancel() {
      cancelled = true;
      ws?.close();
      link?.close();
    },
  };
}

// ------------------------------------------------------------- codice invito

/** Host: genera il codice invito da mandare all'altro giocatore. */
export async function createInvite() {
  const ice = await resolveIceServers();
  const link = new PeerLink(ice, { initiator: true, trickle: false, forceRelay: settings.forceRelay });
  const offer = await link.createOffer();
  return { link, code: await packSignal({ v: 1, sdp: offer, ice }) };
}

/** Ospite: incolla l'invito, ottiene il codice risposta da rimandare all'host. */
export async function acceptInvite(code) {
  const { sdp, ice } = await unpackSignal(code);
  // Usa anche i server TURN dell'host (le credenziali temporanee valgono per entrambi).
  const servers = dedupeIce([...(await resolveIceServers()), ...(ice ?? []).filter((x) => x.username)]);
  const link = new PeerLink(servers, { initiator: false, trickle: false, forceRelay: settings.forceRelay });
  const answer = await link.handleSignal({ sdp });
  return { link, code: await packSignal({ v: 1, sdp: answer }) };
}

/** Host: completa la connessione con il codice risposta. */
export async function completeInvite(link, code) {
  const { sdp } = await unpackSignal(code);
  await link.handleSignal({ sdp });
}

export function waitOpen(link, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (link.channel?.readyState === "open") return resolve(link);
    const t = setTimeout(() => reject(new Error("Timeout: connection failed. Try a TURN server.")), timeoutMs);
    link.addEventListener("open", () => {
      clearTimeout(t);
      resolve(link);
    });
    link.addEventListener("close", (e) => {
      clearTimeout(t);
      reject(new Error(e.detail || "Connection closed"));
    });
  });
}
