// Server di segnalazione per Helios.
//
// - WebSocket su /ws: stanze da 2 giocatori, inoltra offerte/risposte SDP e
//   candidati ICE. Dopo la connessione WebRTC i dati della partita viaggiano
//   direttamente tra i browser: il server non vede il duello.
// - GET /api/ice: server STUN/TURN da usare. Se TURN_SECRET è impostato genera
//   credenziali temporanee nel formato "TURN REST API" supportato da coturn
//   (use-auth-secret / static-auth-secret).
// - In produzione serve anche i file statici di dist/.
//
// Variabili d'ambiente:
//   PORT=8787
//   STUN_URLS="stun:stun.l.google.com:19302 stun:stun.cloudflare.com:3478"
//   TURN_URLS="turn:turn.example.com:3478?transport=udp turns:turn.example.com:5349"
//   TURN_SECRET=...            (credenziali temporanee, consigliato)
//   TURN_USERNAME / TURN_CREDENTIAL (credenziali statiche, alternativa)
//   TURN_TTL=86400
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8787);
const DIST = path.resolve(import.meta.dirname, "..", "dist");
const STUN_URLS = (process.env.STUN_URLS || "stun:stun.l.google.com:19302 stun:stun.cloudflare.com:3478").split(/\s+/).filter(Boolean);
const TURN_URLS = (process.env.TURN_URLS || "").split(/\s+/).filter(Boolean);
const TURN_TTL = Number(process.env.TURN_TTL || 86400);

function iceServers() {
  const servers = [{ urls: STUN_URLS }];
  if (TURN_URLS.length && process.env.TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:helios`;
    const credential = crypto.createHmac("sha1", process.env.TURN_SECRET).update(username).digest("base64");
    servers.push({ urls: TURN_URLS, username, credential });
  } else if (TURN_URLS.length && process.env.TURN_USERNAME) {
    servers.push({ urls: TURN_URLS, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL || "" });
  }
  return servers;
}

// ------------------------------------------------------------------ HTTP

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".wasm": "application/wasm", ".lua": "text/plain; charset=utf-8",
  ".woff2": "font/woff2", ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/ice") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ iceServers: iceServers() }));
    return;
  }
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  if (!fs.existsSync(DIST)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("dist/ not found: run `npm run build` or use `npm run dev`.");
    return;
  }
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  const ext = path.extname(file);
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
});

// ------------------------------------------------------------------ WebSocket

/** @type {Map<string, Set<import("ws").WebSocket>>} */
const rooms = new Map();
const ROOM_RE = /^[A-Z0-9-]{4,32}$/;

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function newRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let code = "";
    for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(code)) return code;
  }
}

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 256 * 1024 });

wss.on("connection", (ws) => {
  ws.room = null;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "create" || msg.type === "join") {
      if (ws.room) return;
      const code = msg.type === "create" ? newRoomCode() : String(msg.room || "").toUpperCase();
      if (!ROOM_RE.test(code)) return send(ws, { type: "error", message: "Invalid Room code" });
      const peers = rooms.get(code) ?? new Set();
      if (msg.type === "join" && !rooms.has(code)) return send(ws, { type: "error", message: "Room not found" });
      if (peers.size >= 2) return send(ws, { type: "error", message: "Room is full" });
      peers.add(ws);
      rooms.set(code, peers);
      ws.room = code;
      send(ws, { type: "joined", room: code, host: peers.size === 1, iceServers: iceServers() });
      for (const p of peers) if (p !== ws) send(p, { type: "peer-joined" });
      return;
    }
    if (msg.type === "signal" && ws.room) {
      for (const p of rooms.get(ws.room) ?? []) if (p !== ws) send(p, { type: "signal", data: msg.data });
    }
  });

  ws.on("close", () => {
    const peers = rooms.get(ws.room);
    if (!peers) return;
    peers.delete(ws);
    for (const p of peers) send(p, { type: "peer-left" });
    if (!peers.size) rooms.delete(ws.room);
  });
});

// Chiude le connessioni morte.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

server.listen(PORT, () => {
  console.log(`Helios signaling su http://localhost:${PORT}  (ws: /ws, ice: /api/ice)`);
  console.log(TURN_URLS.length ? `TURN: ${TURN_URLS.join(", ")}` : "TURN non configurato (solo STUN)");
});
