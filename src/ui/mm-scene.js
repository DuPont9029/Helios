// Schermata del matchmaking (Find a Duel): a tutto schermo, in three.js, mostra quello che succede davvero.
// - Ricerca: il client al centro collegato a stella ai relay Nostr (accesi se connessi); intorno i giocatori che
//   cercano con le stesse regole, collegati ai relay da cui arriva il loro annuncio. Ogni annuncio, offerta,
//   risposta e conferma è un impulso che viaggia sul percorso vero (tu → relay → giocatore).
// - Avversario trovato: il percorso della stretta di mano diventa un circuito che si illumina.
// - Connessione P2P: tra i due client si forma il collegamento diretto (o tramite TURN, o il ripiego sui relay
//   Nostr), colorato per tipo.
// Se WebGL non c'è restano la lista dei giocatori, lo stato e il pulsante per annullare.
import * as THREE from "three";
import { h, clear } from "./dom.js";

const C = {
  me: 0x38c6ff,
  relay: 0x9ae2ff,
  off: 0x3a4152,
  player: 0xffc52e,
  circuit: 0x38c6ff,
  direct: 0x3ddc84,
  stun: 0x38c6ff,
  turn: 0xb48cff,
  nostr: 0xffc52e,
  error: 0xff3b4e,
};
const R_RELAY = 3.2;
const R_PLAYER = 6.4;
const SPEED = 9; // unità al secondo degli impulsi

const host = (url) => url.replace(/^wss?:\/\//, "").replace(/\/+$/, "");
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Bagliore rotondo (texture disegnata una volta) per nodi e impulsi. */
let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.25, "rgba(255,255,255,0.7)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}
const glow = (color, size, opacity = 1) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.setScalar(size);
  return s;
};
const line = (color, opacity) => {
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  l.frustumCulled = false;
  return l;
};
const setLine = (l, a, b) => {
  const p = l.geometry.attributes.position;
  p.setXYZ(0, a.x, a.y, a.z);
  p.setXYZ(1, b.x, b.y, b.z);
  p.needsUpdate = true;
};
/** Tubo luminoso lungo una spezzata (circuito, collegamento P2P). */
function tube(points, color, radius = 0.045) {
  const path = new THREE.CurvePath();
  for (let i = 0; i < points.length - 1; i++) path.add(new THREE.LineCurve3(points[i], points[i + 1]));
  const m = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(8, points.length * 12), radius, 8, false), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  m.userData.path = path;
  return m;
}

/**
 * Apre la schermata. onCancel(): l'utente annulla (la ricerca o la connessione) e torna a Find a Duel.
 * Restituisce { event(e), relays(list), status(text, kind), matched(opponent, relay), connected(route), failed(text), close() }.
 */
export function openMatchScene({ name = "You", rules = "", onCancel }) {
  const canvasHost = h("div.mm-scene-canvas");
  const labels = h("div.mm-scene-labels");
  const statusEl = h("p.mm-scene-status", "Joining the queue…");
  const countEl = h("b.mm-scene-count", "0");
  const listEl = h("ul.mm-scene-list");
  let countText;
  const cancelBtn = h("button.btn.mm-scene-cancel", { onclick: () => onCancel?.() }, "✕ Cancel");
  const root = h(
    "div.mm-scene",
    canvasHost,
    labels,
    h("div.mm-scene-head", h("h2", "Find a Duel"), h("span.muted.small", rules)),
    h("div.mm-scene-side", h("div.mm-scene-side-head", countEl, (countText = h("span", " players searching with your rules"))), listEl),
    h("div.mm-scene-foot", statusEl, cancelBtn)
  );
  document.body.append(root);
  const onKey = (e) => e.key === "Escape" && onCancel?.();
  addEventListener("keydown", onKey);

  // ---- stato (anche senza WebGL)
  let relayList = [];
  let players = new Map(); // pk → { pk, name, relays, node, label, edges: Map(url → line), pos, target }
  let phase = "search"; // search | matched | p2p | done | error
  let opponent = null;
  const drawList = () => {
    countEl.textContent = String(players.size);
    countText.textContent = ` player${players.size === 1 ? "" : "s"} searching with your rules`;
    clear(listEl).append(...[...players.values()].map((p) => h(`li${opponent?.pk === p.pk ? ".on" : ""}`, p.name)));
    if (!players.size) listEl.append(h("li.muted", "Nobody yet: you are visible to whoever starts searching"));
  };
  drawList();

  // ---- scena three.js
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    renderer = null;
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(0, -5.5, 15);
  camera.lookAt(0, 0, 0);
  const world = new THREE.Group();
  scene.add(world);
  const ME = new THREE.Vector3(0, 0, 0);

  // Punti di sfondo (rete lontana, solo decorativa).
  {
    const g = new THREE.BufferGeometry();
    const pts = [];
    for (let i = 0; i < 260; i++) pts.push((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 26, -4 - Math.random() * 10);
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x38c6ff, size: 0.05, transparent: true, opacity: 0.35 })));
    const ring = new THREE.Mesh(new THREE.RingGeometry(R_PLAYER - 0.01, R_PLAYER + 0.01, 128), new THREE.MeshBasicMaterial({ color: 0x38c6ff, transparent: true, opacity: 0.08, side: THREE.DoubleSide }));
    const ring2 = new THREE.Mesh(new THREE.RingGeometry(R_RELAY - 0.01, R_RELAY + 0.01, 96), new THREE.MeshBasicMaterial({ color: 0x38c6ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
    world.add(ring, ring2);
  }

  const label = (text, cls) => {
    const el = h(`div.mm-label${cls ? "." + cls : ""}`, text);
    labels.append(el);
    return el;
  };

  // Il client al centro.
  const meNode = new THREE.Group();
  meNode.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), new THREE.MeshBasicMaterial({ color: C.me, wireframe: true })));
  meNode.add(glow(C.me, 2.2, 0.9));
  world.add(meNode);
  const meLabel = label(name, "me");

  // Relay: diamanti sull'anello interno, collegati a stella al centro.
  const relayNodes = new Map(); // url → { node, mat, glow, line, label, pos }
  function setRelays(list) {
    relayList = list;
    list.forEach((r, i) => {
      let n = relayNodes.get(r.url);
      if (!n) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / list.length;
        const pos = new THREE.Vector3(Math.cos(a) * R_RELAY, Math.sin(a) * R_RELAY, 0);
        const mat = new THREE.MeshBasicMaterial({ color: C.relay, wireframe: true });
        const node = new THREE.Group();
        node.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.2), mat));
        const g = glow(C.relay, 1.1, 0.6);
        node.add(g);
        node.position.copy(pos);
        const l = line(C.relay, 0.5);
        setLine(l, ME, pos);
        world.add(node, l);
        n = { node, mat, glow: g, line: l, pos, label: label(host(r.url), "relay") };
        relayNodes.set(r.url, n);
      }
      const color = r.connected ? C.relay : C.off;
      n.mat.color.setHex(color);
      n.glow.material.color.setHex(color);
      n.glow.material.opacity = r.connected ? 0.6 : 0.15;
      n.line.material.color.setHex(color);
      n.line.material.opacity = r.connected ? 0.45 : 0.12;
      n.label.classList.toggle("off", !r.connected);
    });
  }
  const relayPos = (url) => relayNodes.get(url)?.pos ?? [...relayNodes.values()][0]?.pos ?? ME;
  const liveRelays = () => relayList.filter((r) => r.connected).map((r) => r.url);

  // Giocatori sull'anello esterno, ognuno collegato ai relay da cui è arrivato il suo annuncio.
  function setPlayers(list) {
    const keep = new Set(list.map((s) => s.pk));
    for (const [pk, p] of players) {
      if (keep.has(pk) || opponent?.pk === pk) continue;
      world.remove(p.node);
      for (const l of p.edges.values()) world.remove(l);
      p.label.remove();
      players.delete(pk);
    }
    for (const s of list) {
      let p = players.get(s.pk);
      if (!p) {
        const node = new THREE.Group();
        node.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 0), new THREE.MeshBasicMaterial({ color: C.player, wireframe: true })));
        node.add(glow(C.player, 1.3, 0.7));
        world.add(node);
        p = { pk: s.pk, name: s.name, relays: [], node, label: label(s.name, "player"), edges: new Map(), pos: null, target: new THREE.Vector3() };
        players.set(s.pk, p);
      }
      p.name = s.name;
      p.label.textContent = s.name;
      p.relays = s.relays?.length ? s.relays : liveRelays().slice(0, 1);
      for (const url of p.relays) if (!p.edges.has(url)) {
        const l = line(C.player, 0.28);
        world.add(l);
        p.edges.set(url, l);
      }
    }
    // Posizioni: distribuiti in ordine di chiave (stabili da un aggiornamento all'altro).
    const sorted = [...players.values()].sort((a, b) => (a.pk < b.pk ? -1 : 1));
    sorted.forEach((p, i) => {
      const a = Math.PI / 2 + (i + 0.5) * ((2 * Math.PI) / sorted.length);
      p.target.set(Math.cos(a) * R_PLAYER, Math.sin(a) * R_PLAYER * 0.82, 0);
      if (!p.pos) p.pos = p.target.clone().multiplyScalar(1.4);
    });
    drawList();
  }

  // Impulsi: una luce che percorre una spezzata; at(): cosa fare all'arrivo.
  const pulses = [];
  function pulse(points, color, { size = 0.55, at } = {}) {
    if (points.length < 2) return;
    const s = glow(color, size);
    world.add(s);
    const segs = [];
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const len = points[i].distanceTo(points[i + 1]);
      segs.push({ a: points[i], b: points[i + 1], len });
      total += len;
    }
    pulses.push({ s, segs, total, d: 0, at });
  }
  const playerPoint = (pk) => players.get(pk)?.pos ?? players.get(pk)?.target ?? new THREE.Vector3(R_PLAYER, 0, 0);
  const relayFor = (pk, relay) => (relay && relayNodes.has(relay) ? relay : players.get(pk)?.relays.find((u) => relayNodes.has(u)) ?? liveRelays()[0]);
  const flash = (node, color) => {
    const g = glow(color, 2.6, 0.9);
    node.add(g);
    g.userData.fade = true;
  };

  // ---- circuito e collegamento P2P
  let circuit = null;
  let p2pLink = null;
  let p2pDash = 0;
  let p2pColor = C.direct;
  const fadeIn = []; // mesh → opacità obiettivo
  function setMatched(opp, relay) {
    opponent = opp;
    phase = "matched";
    if (!players.has(opp.pk)) setPlayers([...players.values()].map((p) => ({ pk: p.pk, name: p.name, relays: p.relays })).concat([{ pk: opp.pk, name: opp.name }]));
    const p = players.get(opp.pk);
    p.target.multiplyScalar(0.78); // l'avversario si avvicina
    const via = relayFor(opp.pk, relay);
    const back = liveRelays().find((u) => u !== via) ?? via;
    const pts = [ME, relayPos(via), p.target.clone(), relayPos(back), ME];
    circuit = tube(pts, C.circuit, 0.05);
    circuit.userData.points = pts;
    world.add(circuit);
    fadeIn.push([circuit.material, 0.85]);
    for (const q of players.values()) if (q !== p) q.dim = true;
    flash(p.node, C.circuit);
    drawList();
  }
  function setConnected(route) {
    if (!opponent) return;
    phase = "p2p";
    const kind = route?.local === "nostr" ? "nostr" : route?.local === "relay" || route?.remote === "relay" ? "turn" : "direct";
    const color = kind === "nostr" ? C.nostr : kind === "turn" ? C.turn : route?.local === "host" && route?.remote === "host" ? C.direct : C.stun;
    const p = players.get(opponent.pk);
    // Via Nostr: niente collegamento diretto, il duello resta sul circuito dei relay (che si accende d'oro).
    const via = relayFor(opponent.pk);
    const pts = kind === "nostr" ? [ME, relayPos(via), p.target.clone()] : kind === "turn" ? [ME, new THREE.Vector3(p.target.x / 2, p.target.y / 2, 1.6), p.target.clone()] : [ME, p.target.clone()];
    p2pLink = tube(pts, color, 0.07);
    p2pLink.userData.points = pts;
    world.add(p2pLink);
    fadeIn.push([p2pLink.material, 1]);
    if (circuit) fadeIn.push([circuit.material, kind === "nostr" ? 0.35 : 0.12]);
    p2pColor = color;
    if (kind === "turn") {
      const t = glow(C.turn, 1.2, 0.8);
      t.position.copy(pts[1]);
      world.add(t);
      label("TURN relay", "relay").dataset.at = JSON.stringify(pts[1].toArray());
    }
    flash(meNode, color);
    flash(p.node, color);
  }

  // ---- disegno
  let raf = 0;
  let last = performance.now();
  const v = new THREE.Vector3();
  const place = (el, pos) => {
    v.copy(pos).applyMatrix4(world.matrixWorld).project(camera);
    const w = canvasHost.clientWidth;
    const hh = canvasHost.clientHeight;
    el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * hh}px)`;
  };
  function resize() {
    const w = canvasHost.clientWidth || innerWidth;
    const hh = canvasHost.clientHeight || innerHeight;
    renderer?.setSize(w, hh, false);
    camera.aspect = w / hh;
    // Su schermi stretti si allontana la telecamera, così l'anello dei giocatori resta visibile.
    camera.position.set(0, -5.5, 15 * Math.max(1, 1.25 / camera.aspect));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!reduced()) world.rotation.z += dt * (phase === "search" ? 0.03 : 0.008);
    meNode.rotation.z += dt * 0.6;
    meNode.rotation.x += dt * 0.25;
    for (const n of relayNodes.values()) n.node.rotation.y += dt * 0.8;
    for (const p of players.values()) {
      p.pos.lerp(p.target, Math.min(1, dt * 3));
      p.node.position.copy(p.pos);
      p.node.rotation.y += dt;
      const op = p.dim ? 0.08 : 0.28;
      for (const [url, l] of p.edges) {
        setLine(l, p.pos, relayPos(url));
        l.material.opacity += (op - l.material.opacity) * Math.min(1, dt * 4);
      }
      p.node.children[1].material.opacity = p.dim ? 0.2 : 0.7;
      p.label.classList.toggle("dim", !!p.dim);
      p.label.classList.toggle("opp", opponent?.pk === p.pk);
    }
    for (const [mat, to] of fadeIn) mat.opacity += (to - mat.opacity) * Math.min(1, dt * 3);
    // Impulsi in viaggio.
    for (let i = pulses.length - 1; i >= 0; i--) {
      const q = pulses[i];
      q.d += dt * SPEED;
      let d = q.d;
      const seg = q.segs.find((s) => (d <= s.len ? true : ((d -= s.len), false)));
      if (!seg) {
        world.remove(q.s);
        pulses.splice(i, 1);
        q.at?.();
        continue;
      }
      q.s.position.lerpVectors(seg.a, seg.b, d / seg.len);
    }
    // Bagliori dei lampi che svaniscono.
    const gone = [];
    world.traverse((o) => {
      if (o.userData.fade) {
        o.material.opacity -= dt * 1.2;
        o.scale.multiplyScalar(1 + dt * 1.5);
        if (o.material.opacity <= 0) gone.push(o);
      }
    });
    for (const o of gone) o.removeFromParent(), o.material.dispose();
    // Impulsi continui sul circuito e sul collegamento P2P.
    p2pDash += dt;
    if (p2pDash > 0.45) {
      p2pDash = 0;
      if (phase === "matched" && circuit) pulse(circuit.userData.points, C.circuit, { size: 0.45 });
      if (phase === "p2p" && p2pLink) {
        pulse(p2pLink.userData.points, p2pColor, { size: 0.4 });
        pulse([...p2pLink.userData.points].reverse(), p2pColor, { size: 0.4 });
      }
    }
    world.updateMatrixWorld();
    place(meLabel, ME);
    for (const n of relayNodes.values()) place(n.label, n.pos);
    for (const p of players.values()) place(p.label, p.pos);
    for (const el of labels.querySelectorAll("[data-at]")) place(el, new THREE.Vector3().fromArray(JSON.parse(el.dataset.at)));
    renderer?.render(scene, camera);
  }
  if (renderer) {
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    canvasHost.append(renderer.domElement);
    resize();
    addEventListener("resize", resize);
    raf = requestAnimationFrame(frame);
  } else root.classList.add("no-gl");

  // ---- API per play.js
  const api = {
    relays: setRelays,
    status(text, kind = "") {
      statusEl.textContent = text;
      statusEl.className = `mm-scene-status ${kind}`;
    },
    /** Eventi di findMatch (vedi matchmaking.js). */
    event(e) {
      if (e.t === "others") return setPlayers(e.list);
      if (!renderer) return;
      if (e.t === "seek") for (const url of liveRelays()) pulse([ME, relayPos(url)], C.me, { size: 0.45 });
      if (e.t === "back") {
        phase = "search";
        opponent = null;
        for (const p of players.values()) p.dim = false;
        drawList();
      }
      if (e.t === "send" && players.has(e.to)) {
        const via = relayFor(e.to);
        pulse([ME, relayPos(via), playerPoint(e.to)], e.type === "mm-decline" ? C.off : C.me, { at: () => flash(players.get(e.to)?.node ?? meNode, C.me) });
      }
      if (e.t === "recv" && players.has(e.from)) {
        const via = relayFor(e.from, e.relay);
        pulse([playerPoint(e.from), relayPos(via), ME], e.type === "mm-decline" ? C.off : C.player, { at: () => flash(meNode, C.player) });
        if (relayNodes.has(via)) flash(relayNodes.get(via).node, C.player);
      }
    },
    matched(opp, relay) {
      setMatched(opp, relay);
      cancelBtn.textContent = "✕ Cancel";
    },
    connected(route) {
      setConnected(route);
    },
    failed(text) {
      phase = "error";
      api.status(text, "error");
      cancelBtn.textContent = "← Back";
      if (circuit) fadeIn.push([circuit.material, 0.1]);
      if (opponent && players.get(opponent.pk)) flash(players.get(opponent.pk).node, C.error);
    },
    close() {
      cancelAnimationFrame(raf);
      removeEventListener("resize", resize);
      removeEventListener("keydown", onKey);
      root.classList.add("closing");
      setTimeout(() => {
        root.remove();
        renderer?.dispose();
        scene.traverse((o) => {
          o.geometry?.dispose();
          o.material?.dispose();
        });
      }, 250);
    },
  };
  return api;
}
