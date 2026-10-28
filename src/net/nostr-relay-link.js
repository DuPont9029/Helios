// Ripiego quando il collegamento WebRTC non riesce (nessuna strada diretta né TURN): i messaggi del duello
// passano dai relay Nostr, cifrati con una chiave ricavata dal codice della stanza (come la password di Trystero).
// Eventi effimeri (kind 2xxxx: i relay li inoltrano senza salvarli), firmati da una chiave usa e getta.
// I relay possono perdere un evento: ogni pezzo ha un numero, chi riceve conferma (ack) e chi manda ripete quelli
// non confermati; i messaggi grandi (es. lo sleeve nel saluto) si dividono in pezzi. Più lento del P2P (centinaia
// di millisecondi per messaggio), ma resta decentralizzato. RelayLink si comporta come PeerLink.
import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { encode, decode } from "./peer.js";
import { sha256Hex, fromHex } from "./identity.js";
import { eloRelays } from "./elo.js";

const KIND = 25078;
const CHUNK = 12000; // caratteri per pezzo (gli eventi restano sotto i limiti dei relay)
const RESEND_MS = 3000;
const GAP_MS = 60; // tra un evento e l'altro: niente raffiche che i relay rifiuterebbero
const PING_MS = 10000;
const LOST_MS = 45000;
const now = () => Math.floor(Date.now() / 1000);
const rid = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");

class RelayLink extends EventTarget {
  constructor(channel) {
    super();
    this.ch = channel;
    this.closed = false;
    this.queue = [];
  }

  addEventListener(type, fn, opts) {
    super.addEventListener(type, fn, opts);
    if (type === "message" && !this.listening) {
      this.listening = true;
      for (const msg of this.queue.splice(0)) this.dispatchEvent(new CustomEvent("message", { detail: msg }));
    }
  }

  deliver(msg) {
    if (this.listening) this.dispatchEvent(new CustomEvent("message", { detail: msg }));
    else this.queue.push(msg);
  }

  send(obj) {
    if (!this.closed) this.ch.sendData(encode(obj));
  }

  async routeInfo() {
    return { local: "nostr", remote: "nostr", rtt: this.ch.rtt };
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.ch.close(true);
    this.dispatchEvent(new CustomEvent("close", { detail: reason }));
  }
}

/**
 * Canale sui relay per la stanza `code`. Si mette subito in ascolto (se l'altro passa ai relay, ci passa anche
 * questo client); request() lo attiva da qui. onPeer(): l'altro ha chiesto il ripiego. ready: Promise<RelayLink>.
 */
export async function relayChannel(code, { onPeer } = {}) {
  const key = fromHex(await sha256Hex(`helios-relay-v1|key|${code}`));
  const topic = (await sha256Hex(`helios-relay-v1|topic|${code}`)).slice(0, 32);
  const sk = generateSecretKey();
  const sid = rid();
  const relays = eloRelays();
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  let peer = null; // sid dell'altro
  let established = false;
  let active = false;
  let closed = false;
  let link = null;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  // ---- invio (in coda, distanziato)
  const outbox = [];
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    while (outbox.length && !closed) {
      const body = outbox.shift();
      const ev = finalizeEvent({ kind: KIND, created_at: now(), tags: [["h", topic]], content: nip44.v2.encrypt(JSON.stringify({ from: sid, to: peer, ...body }), key) }, sk);
      pool.publish(relays, ev).forEach((p) => p.catch(() => {}));
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
    pumping = false;
  };
  const post = (body) => {
    outbox.push(body);
    pump();
  };

  let seq = 0; // prossimo numero da mandare
  const unacked = new Map(); // n → { body, at }
  const sendData = (text) => {
    const k = Math.max(1, Math.ceil(text.length / CHUNK));
    for (let i = 0; i < k; i++) {
      const body = { n: seq++, i, k, d: text.slice(i * CHUNK, (i + 1) * CHUNK) };
      unacked.set(body.n, { body, at: Date.now() });
      post(body);
    }
  };

  // ---- ricezione (in ordine)
  let next = 0; // prossimo numero atteso
  const parts = new Map();
  let partial = "";
  let ackTimer = 0;
  let lastHeard = Date.now();
  const deliverInOrder = () => {
    while (parts.has(next)) {
      const p = parts.get(next);
      parts.delete(next);
      next++;
      partial += p.d;
      if (p.i === p.k - 1) {
        let msg;
        try {
          msg = decode(partial);
        } catch {
          msg = null;
        }
        partial = "";
        if (msg) link?.deliver(msg);
      }
    }
    clearTimeout(ackTimer);
    ackTimer = setTimeout(() => post({ ack: next - 1 }), 250);
  };

  // Saluti: seen = l'altro che abbiamo visto, est = noi siamo già collegati. Si risponde a chi non lo è ancora.
  const hello = () => post({ hello: true, seen: peer, est: established });
  const establish = () => {
    if (established) return;
    established = true;
    link = new RelayLink(api);
    resolveReady(link);
  };

  const sub = pool.subscribeMany(relays, { kinds: [KIND], "#h": [topic], since: now() - 30 }, {
    onevent(ev) {
      if (closed) return;
      let m;
      try {
        m = JSON.parse(nip44.v2.decrypt(ev.content, key));
      } catch {
        return;
      }
      if (!m || m.from === sid || (peer && m.from !== peer) || (m.to && m.to !== sid)) return;
      lastHeard = Date.now();
      if (m.hello) {
        if (!peer) {
          peer = m.from;
          if (!active) {
            active = true;
            onPeer?.();
          }
        }
        if (m.seen === sid) establish();
        if (!m.est) hello();
        return;
      }
      if (!established) return;
      if (m.bye) return link?.close("Your opponent left the Duel");
      if (m.ping) return post({ pong: m.ping });
      if (m.pong) return void (api.rtt = Date.now() - m.pong);
      if (Number.isInteger(m.ack)) {
        for (const n of unacked.keys()) if (n <= m.ack) unacked.delete(n);
        return;
      }
      if (Number.isInteger(m.n) && Number.isInteger(m.i) && Number.isInteger(m.k) && typeof m.d === "string") {
        if (m.n >= next && m.n < next + 2000) parts.set(m.n, m);
        deliverInOrder();
      }
    },
  });

  // ---- tempi: saluti finché non ci si trova, ripetizioni, ping e connessione persa
  const timer = setInterval(() => {
    if (closed) return;
    if (active && !established) hello();
    if (!established) return;
    const t = Date.now();
    for (const u of unacked.values()) if (t - u.at > RESEND_MS) (u.at = t), post(u.body);
    if (t - lastHeard > LOST_MS) link?.close("Lost the connection through the Nostr relays");
  }, 1500);
  const pinger = setInterval(() => established && !closed && post({ ping: Date.now() }), PING_MS);

  const api = {
    rtt: null,
    ready,
    sendData,
    /** Questo client chiede il ripiego (il suo WebRTC non è riuscito). */
    request() {
      if (closed) return;
      active = true;
      hello();
    },
    get active() {
      return active;
    },
    close(bye = false) {
      if (closed) return;
      if (bye && established) {
        const ev = finalizeEvent({ kind: KIND, created_at: now(), tags: [["h", topic]], content: nip44.v2.encrypt(JSON.stringify({ from: sid, to: peer, bye: true }), key) }, sk);
        pool.publish(relays, ev).forEach((p) => p.catch(() => {}));
      }
      closed = true;
      clearInterval(timer);
      clearInterval(pinger);
      clearTimeout(ackTimer);
      setTimeout(() => {
        sub.close();
        pool.destroy();
      }, bye ? 1500 : 0);
    },
  };
  return api;
}
