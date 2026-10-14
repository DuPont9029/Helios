// Cloudflare Worker per Helios: credenziali TURN temporanee + server di segnalazione.
//
//   GET /  oppure /api/ice  → { iceServers }: credenziali TURN di Cloudflare valide TTL secondi.
//                             Il token resta qui come secret: il sito riceve solo credenziali a scadenza.
//   GET /api/health         → { ok: true }: il client lo usa per capire che le stanze online sono disponibili.
//   GET /ws (WebSocket)     → stanze da 2 giocatori con codice di 6 caratteri, stesso protocollo di
//                             server/signal.mjs: create / join / signal. Le stanze vivono in un Durable Object.
//
// Secret (wrangler secret put ...):  TURN_KEY_ID, TURN_KEY_API_TOKEN
// Variabili (wrangler.toml):         ALLOWED_ORIGINS, TTL

const API = "https://rtc.live.cloudflare.com/v1/turn/keys";
const ROOM_RE = /^[A-Z0-9]{4,12}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // niente 0/O e 1/I: si dettano meglio

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  // I browser mandano l'host in minuscolo: il confronto ignora le maiuscole (es. "DuPont9029.github.io").
  const allowed = String(env.ALLOWED_ORIGINS || "").split(/[\s,]+/).filter(Boolean).map((o) => o.replace(/\/+$/, "").toLowerCase());
  return allowed.includes(origin.toLowerCase()) ? origin : null;
}

/** Credenziali TURN temporanee da Cloudflare, senza gli URL sulla porta 53 (bloccata dai browser). */
async function turnServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return [];
  const res = await fetch(`${API}/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl: Number(env.TTL) || 14400 }),
  });
  if (!res.ok) throw new Error("TURN credentials unavailable");
  const data = await res.json();
  return (data.iceServers ?? [])
    .map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);
    const cors = origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {};

    if (request.method === "OPTIONS") {
      return new Response(null, { status: origin ? 204 : 403, headers: { ...cors, "access-control-allow-methods": "GET", "access-control-max-age": "86400" } });
    }
    // Solo le pagine del sito possono usare il Worker (un client fuori dal browser può falsificare l'Origin,
    // ma ottiene comunque solo credenziali a scadenza: il token non esce mai da qui).
    if (!origin) return new Response("Forbidden", { status: 403 });

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      // Tutte le stanze in un solo Durable Object: per un progetto amatoriale è più che sufficiente.
      return env.ROOMS.get(env.ROOMS.idFromName("lobby")).fetch(request);
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });
    if (url.pathname === "/api/health") return Response.json({ ok: true }, { headers: { ...cors, "cache-control": "no-store" } });
    if (url.pathname === "/" || url.pathname === "/api/ice") {
      try {
        return Response.json({ iceServers: await turnServers(env) }, { headers: { ...cors, "cache-control": "no-store" } });
      } catch (e) {
        return new Response(e.message, { status: 502, headers: cors });
      }
    }
    return new Response("Not found", { status: 404, headers: cors });
  },
};

/**
 * Stanze di segnalazione. Usa le WebSocket "hibernation": l'oggetto si può sospendere tra un messaggio e
 * l'altro senza chiudere le connessioni; la stanza di ogni socket è salvata nel suo attachment.
 */
export class SignalRooms {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ room: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  peers(room) {
    return this.state.getWebSockets().filter((ws) => ws.deserializeAttachment()?.room === room);
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket già chiuso */
    }
  }

  newRoomCode() {
    for (;;) {
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      const code = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
      if (!this.peers(code).length) return code;
    }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 256 * 1024) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment() ?? { room: null };
    if (msg.type === "create" || msg.type === "join") {
      if (me.room) return;
      const code = msg.type === "create" ? this.newRoomCode() : String(msg.room || "").toUpperCase();
      if (!ROOM_RE.test(code)) return this.send(ws, { type: "error", message: "Invalid Room code" });
      const others = this.peers(code);
      if (msg.type === "join" && !others.length) return this.send(ws, { type: "error", message: "Room not found" });
      if (others.length >= 2) return this.send(ws, { type: "error", message: "Room is full" });
      ws.serializeAttachment({ room: code });
      let iceServers = [];
      try {
        iceServers = await turnServers(this.env);
      } catch {
        /* senza TURN si prova comunque con STUN */
      }
      this.send(ws, { type: "joined", room: code, host: others.length === 0, iceServers });
      for (const p of others) this.send(p, { type: "peer-joined" });
      return;
    }
    if (msg.type === "signal" && me.room) {
      for (const p of this.peers(me.room)) if (p !== ws) this.send(p, { type: "signal", data: msg.data });
    }
  }

  async webSocketClose(ws) {
    const { room } = ws.deserializeAttachment() ?? {};
    try {
      ws.serializeAttachment({ room: null });
    } catch {
      /* socket già chiuso */
    }
    if (room) for (const p of this.peers(room)) if (p !== ws) this.send(p, { type: "peer-left" });
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
