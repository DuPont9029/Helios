// Campo di default di Helios (sorgente e anteprima in md-fields/web/helios-field): tutto procedurale in three.js (nessun asset esterno), fatto da noi.
// Due temi (THEMES): i colori del sito o l'oro. Stessa interfaccia del Field di Helios (src/field3d/field.js), così lo stage lo usa come un campo convertito:
//   group, sides [{ name, trigger, resetPhases }], update(dt, opts), trigger(label, side), tapBoxes(), dispose()
// Coordinate di Helios: in alto sullo schermo +z (avversario), a sinistra +x; zone da 8 unità, colonne ogni 8.55,
// zone mostri a z = ∓9.35, Magie/Trappole a z = ∓17.9, Deck ed Extra Deck sui supporti a (±27.2, ±24.4) girati di 20°.
import * as THREE from "three";

// Eventi (come EVENT_LABELS in field.js di Helios).
const HIT = 11;
const PHASES = { 12: 1, 13: 2, 14: 3, 15: 4 };
const TAP = 24;

const COL = 8.55;
const ROW_MON = 9.35;
const ROW_ST = 17.9;
const ZONE = 3.75; // mezza zona disegnata (la zona di Helios è 8 unità, con un po' di margine)
const PILE = [27.2, 24.4, THREE.MathUtils.degToRad(20)];
const SLAB = [34, 31]; // mezza larghezza e mezza profondità del tabellone
// Basamenti dei Moai: dove lo stage di Helios mette i pet (PET in src/field3d/moai.js), il mio e quello dell'avversario.
const PETS = [[37.67, -5.48], [-37.67, 7.48]];
const PET_TOP = 1.9; // i Moai poggiano a y = 2

/** Zone disegnate sul tabellone: [x, z, mezza larghezza, mezza profondità, tipo] (tipo 0 mostri, 1 magie, 2 pile). */
function zoneRects() {
  const mine = [];
  for (let c = -2; c <= 2; c++) {
    mine.push([c * COL, -ROW_MON, ZONE, ZONE, 0]);
    mine.push([c * COL, -ROW_ST, ZONE, ZONE, 1]);
  }
  mine.push([3 * COL - 0.52, -ROW_MON - 0.8, 2.8, 3.4, 1]); // Terreno
  mine.push([-3 * COL, -ROW_MON, ZONE, ZONE, 2]); // Cimitero
  mine.push([-3 * COL, 0, ZONE, ZONE, 2]); // Banditi
  const all = [...mine, ...mine.map(([x, z, w, h, t]) => [-x, -z, w, h, t])];
  all.push([COL, 0, ZONE, ZONE, 0], [-COL, 0, ZONE, ZONE, 0]); // zone mostri extra
  return all;
}

// Temi: "sole" (oro caldo) e "helios" (i colori del sito: ciano, blu per me, rosso per l'avversario, giallo stella).
// Colori in sRGB; i valori > 1 (moltiplicatori) fanno brillare con il bagliore dello stage.
const C = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
export const THEMES = {
  sole: {
    line: C("#ffdc9a"), lineMine: C("#ffd492"), lineTheirs: C("#c2e5ff"), tintMine: C("#ffcf7f"), tintTheirs: C("#95cfff"),
    sun: C("#ffd89d", 1.25), center: C("#ffdc9a", 1.2), edge: C("#ffdc9a"), edgeTheirs: C("#d9dee8"), stoneLo: C("#1a1b22"), stoneHi: C("#2c2c33"), veins: C("#3c3528"),
    hit: C("#ffa776", 1.4), danger: C("#ff8a3a", 1.3), floorLine: C("#cbb48a"), floorRays: C("#ffe0a0"), floorGlow: C("#2a2216"), bg: C("#0d0f18"),
    frame: C("#ffd596", 1.05), crystalMine: C("#ffbc7c", 1.5), crystalTheirs: C("#97c9ff", 1.6), motes: C("#ffd59b", 1.2), sparks: C("#ff9b51", 1.8),
    sideMix: 0.45, rim: 0x8a6a34, rimGlow: 0x2a1a06,
  },
  helios: {
    line: C("#38c6ff"), lineMine: C("#38c6ff"), lineTheirs: C("#ff6b7a"), tintMine: C("#1f6bff"), tintTheirs: C("#d92338"),
    sun: C("#ffc52e", 1.25), center: C("#9ae2ff", 1.1), edge: C("#38c6ff"), edgeTheirs: C("#ff3b4e"), stoneLo: C("#0d0e13"), stoneHi: C("#1c1e27"), veins: C("#1d2a3c"),
    hit: C("#9ae2ff", 1.4), danger: C("#ff3b4e", 1.3), floorLine: C("#1b6a8a"), floorRays: C("#9ae2ff"), floorGlow: C("#0b1a2a"), bg: C("#07070a"),
    frame: C("#38c6ff", 1.05), crystalMine: C("#38c6ff", 1.6), crystalTheirs: C("#ff3b4e", 1.6), motes: C("#9ae2ff", 1.2), sparks: C("#9ae2ff", 1.8),
    sideMix: 0.8, rim: 0x2a5a78, rimGlow: 0x061a2a,
  },
};

const BOARD_VERT = /* glsl */ `
  varying vec2 vXZ;
  varying vec2 vUv;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vXZ = w.xz;
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const BOARD_FRAG = /* glsl */ `
  #define N ${zoneRects().length}
  uniform vec4 uZones[N];
  uniform float uKinds[N];
  uniform float uTime;
  uniform vec2 uSlab;
  uniform vec2 uDamage;   // fase di danneggiamento animata, lato mio (z < 0) e avversario
  uniform vec2 uHit;      // tempo dall'ultimo colpo per lato
  uniform float uTap;     // tempo dall'ultimo tocco del sole
  uniform float uSideMix;
  uniform vec2 uPetZ;     // z dei basamenti dei Moai: lì il bordo passa dal colore del mio lato a quello dell'avversario
  uniform vec3 uEdgeTheirs, uLine, uLineMine, uLineTheirs, uTintMine, uTintTheirs, uSun, uCenter, uEdge, uStoneLo, uStoneHi, uVeins, uHit3, uDanger;
  varying vec2 vXZ;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
  float roundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }

  void main() {
    vec2 p = vXZ;
    float side = p.y < 0.0 ? 0.0 : 1.0;
    float dmg = side < 0.5 ? uDamage.x : uDamage.y;
    float hit = side < 0.5 ? uHit.x : uHit.y;

    // Pietra scura venata.
    float n = fbm(p * 0.18);
    float veins = smoothstep(0.02, 0.0, abs(fbm(p * 0.09 + 3.0) - 0.5)) * 0.35;
    vec3 col = mix(uStoneLo, uStoneHi, n) + veins * uVeins;
    // Due metà appena tinte con il colore del lato.
    vec3 tint = side < 0.5 ? uTintMine : uTintTheirs;
    col += tint * 0.012 * (1.0 - smoothstep(0.0, 30.0, abs(p.y)));

    // Zone: contorno inciso che brilla, interno appena più chiaro.
    float glow = 0.0;
    float inside = 0.0;
    for (int i = 0; i < N; i++) {
      vec4 z = uZones[i];
      float d = roundBox(p - z.xy, z.zw, 0.55);
      float k = uKinds[i];
      float line = smoothstep(0.16, 0.0, abs(d));
      // Danneggiato, il contorno si spezza a tratti (sempre di più a ogni fase) che tremolano.
      float cut = noise(vec2(atan(p.y - z.y, p.x - z.x) * 3.0 + float(i) * 7.3, floor(uTime * (1.0 + dmg * 2.0)) * step(2.5, dmg)));
      line *= smoothstep(dmg * 0.17 - 0.05, dmg * 0.17 + 0.05, cut);
      float halo = exp(-max(d, 0.0) * 2.2) * 0.08 * step(0.0, d);
      // Angoli più accesi: piccole staffe sui quattro spigoli.
      vec2 q = abs(p - z.xy) - z.zw + 1.3;
      float corner = step(0.0, q.x) * step(0.0, q.y) * line;
      glow += line * (k > 1.5 ? 0.45 : 0.6) + corner * 0.9 + halo;
      inside = max(inside, smoothstep(0.1, -0.4, d) * (k > 0.5 ? 0.6 : 1.0));
    }
    col += inside * vec3(0.010, 0.011, 0.015) * (0.8 + 0.4 * n);

    // Linea centrale e sole di Helios al centro.
    float r = length(p);
    float ang = atan(p.y, p.x);
    float center = smoothstep(0.12, 0.0, abs(p.y)) * smoothstep(33.0, 4.6, abs(p.x)) * step(4.6, abs(p.x));
    float ring = smoothstep(0.14, 0.0, abs(r - 3.6)) + smoothstep(0.1, 0.0, abs(r - 2.4)) * 0.7;
    float rays = smoothstep(0.5, 1.0, cos(ang * 12.0 + uTime * 0.25)) * smoothstep(2.4, 2.9, r) * smoothstep(3.6, 3.1, r);
    float core = smoothstep(1.6, 0.0, r);
    float pulse = 0.75 + 0.25 * sin(uTime * 1.3);
    float tap = exp(-uTap * 2.5);
    float sun = (ring + rays * 0.8) * pulse + core * (0.6 + tap * 2.0);
    // Onda del tocco sul sole.
    sun += smoothstep(0.6, 0.0, abs(r - uTap * 30.0)) * tap * 1.5;

    vec3 lineCol = mix(uLine, side < 0.5 ? uLineMine : uLineTheirs, uSideMix);
    // A ogni fase le linee del lato virano verso il colore del pericolo.
    lineCol = mix(lineCol, uDanger, smoothstep(0.0, 3.0, dmg) * 0.85);
    // Con il campo danneggiato le linee tremano e si spengono.
    float flicker = 1.0 - smoothstep(1.5, 4.0, dmg) * (0.55 + 0.45 * step(0.6, noise(vec2(uTime * 9.0, side * 7.0))));
    col += lineCol * glow * 0.9 * flicker;
    col += uCenter * center;
    col += uSun * sun;

    // Danno: un bagliore del colore del pericolo che sale dal bordo del lato e pulsa, più alto a ogni fase.
    float fromEdge = uSlab.y - abs(p.y);
    float reach = dmg * 4.0;
    float beat = 0.75 + 0.25 * sin(uTime * (2.0 + dmg));
    float smoke = fbm(p * 0.22 + vec2(0.0, uTime * 0.15));
    col += uDanger * pow(smoothstep(reach, 0.0, fromEdge), 1.6) * step(0.01, dmg) * 0.12 * beat * (0.4 + smoke);

    // Colpo: un'onda che parte dal centro del lato colpito e un lampo.
    vec2 hc = vec2(0.0, side < 0.5 ? -13.0 : 13.0);
    float wave = smoothstep(1.2, 0.0, abs(length(p - hc) - hit * 42.0)) * exp(-hit * 2.2);
    col += uHit3 * wave + uHit3 * 0.35 * exp(-hit * 6.0) * (1.0 - smoothstep(0.0, 30.0, abs(p.y - hc.y)));

    // Bordo del tabellone.
    float edge = roundBox(p, uSlab - 0.6, 2.0);
    // Il mio colore fino al basamento del Moai sul fianco (il mio a +x, quello dell'avversario a -x), poi il suo.
    float split = p.x > 0.0 ? uPetZ.x : uPetZ.y;
    vec3 edgeCol = mix(uEdge, uEdgeTheirs, smoothstep(split - 0.6, split + 0.6, p.y));
    col += edgeCol * smoothstep(0.18, 0.0, abs(edge)) * 0.5;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const FLOOR_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uFloorLine, uFloorRays, uFloorGlow, uBg;
  varying vec2 vXZ;
  void main() {
    vec2 p = vXZ;
    float r = length(p);
    // Pavimento attorno al tabellone: esagoni appena incisi che svaniscono lontano, raggi del sole.
    vec2 h = p / 7.0;
    vec2 a = mod(h, vec2(1.0, 1.732)) - vec2(0.5, 0.866);
    vec2 b = mod(h - vec2(0.5, 0.866), vec2(1.0, 1.732)) - vec2(0.5, 0.866);
    vec2 g = dot(a, a) < dot(b, b) ? a : b;
    vec2 ag = abs(g);
    float hex = max(dot(ag, normalize(vec2(1.0, 1.732))), ag.x);
    float line = smoothstep(0.03, 0.0, abs(hex - 0.47));
    float fade = smoothstep(220.0, 40.0, r);
    float ang = atan(p.y, p.x);
    float rays = pow(max(0.0, cos(ang * 8.0 + uTime * 0.05)), 18.0) * smoothstep(200.0, 40.0, r) * 0.05;
    vec3 col = uBg + uFloorLine * line * 0.025 * fade + uFloorRays * rays * 0.4;
    col += uFloorGlow * smoothstep(90.0, 30.0, r);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Lato del campo (near = mio, far = avversario): stato del danneggiamento e del colpo. */
class Side {
  constructor(field, name) {
    this.field = field;
    this.name = name;
    this.index = name === "near" ? 0 : 1;
    this.damage = 0; // fase voluta (0-4)
    this.shown = 0; // fase disegnata, che la insegue
    this.hit = 99;
  }

  trigger(label) {
    if (label === HIT) this.hit = 0;
    else if (PHASES[label]) {
      this.damage = Math.max(this.damage, PHASES[label]);
      this.hit = 0;
      this.field.burst(this.index, PHASES[label]);
    } else if (label === TAP) this.field.tap = 0;
  }

  resetPhases() {
    this.damage = this.shown = 0;
  }
}

export class HeliosField {
  /** @param theme "helios" (colori del sito, default) o "sole" (oro) */
  constructor({ theme = "helios" } = {}) {
    const T = (this.theme = THEMES[theme] || THEMES.helios);
    this.id = "helios";
    this.group = new THREE.Group();
    this.group.name = "helios-field";
    this.sides = [new Side(this, "near"), new Side(this, "far")];
    this.time = 0;
    this.tap = 99;
    this.pileHeight = 0.6; // altezza delle piastre di Deck ed Extra Deck (per lo stage di Helios con il campo inclinato)
    this.disposables = [];

    const rects = zoneRects();
    this.board = new THREE.ShaderMaterial({
      vertexShader: BOARD_VERT,
      fragmentShader: BOARD_FRAG,
      uniforms: {
        uZones: { value: rects.map(([x, z, w, h]) => new THREE.Vector4(x, z, w, h)) },
        uKinds: { value: rects.map((r) => r[4]) },
        uTime: { value: 0 },
        uSlab: { value: new THREE.Vector2(...SLAB) },
        uDamage: { value: new THREE.Vector2() },
        uHit: { value: new THREE.Vector2(99, 99) },
        uTap: { value: 99 },
        uLine: { value: T.line }, uLineMine: { value: T.lineMine }, uLineTheirs: { value: T.lineTheirs },
        uTintMine: { value: T.tintMine }, uTintTheirs: { value: T.tintTheirs }, uSun: { value: T.sun }, uCenter: { value: T.center },
        uEdge: { value: T.edge }, uEdgeTheirs: { value: T.edgeTheirs }, uPetZ: { value: new THREE.Vector2(PETS[0][1], PETS[1][1]) }, uStoneLo: { value: T.stoneLo }, uStoneHi: { value: T.stoneHi }, uVeins: { value: T.veins },
        uHit3: { value: T.hit }, uDanger: { value: T.danger }, uSideMix: { value: T.sideMix },
      },
    });
    // Tabellone: una lastra con il piano disegnato dallo shader e i fianchi di pietra.
    const top = new THREE.Mesh(new THREE.PlaneGeometry(SLAB[0] * 2, SLAB[1] * 2), this.board);
    top.rotation.x = -Math.PI / 2;
    top.position.y = 0;
    const stone = new THREE.MeshStandardMaterial({ color: 0x1b1a1f, roughness: 0.85, metalness: 0.2 });
    const trim = new THREE.MeshStandardMaterial({ color: T.rim, roughness: 0.35, metalness: 0.9, emissive: T.rimGlow });
    const body = new THREE.Mesh(new THREE.BoxGeometry(SLAB[0] * 2, 2.4, SLAB[1] * 2), stone);
    body.position.y = -1.21;
    const rim = new THREE.Mesh(new THREE.BoxGeometry(SLAB[0] * 2 + 1.2, 0.5, SLAB[1] * 2 + 1.2), trim);
    rim.position.y = -2.3;
    this.group.add(top, body, rim);

    // Pavimento sotto e attorno, lontano fino ai bordi di uno schermo largo.
    this.floor = new THREE.ShaderMaterial({
      vertexShader: BOARD_VERT,
      fragmentShader: FLOOR_FRAG,
      uniforms: { uTime: { value: 0 }, uFloorLine: { value: T.floorLine }, uFloorRays: { value: T.floorRays }, uFloorGlow: { value: T.floorGlow }, uBg: { value: T.bg } },
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), this.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.6;
    this.group.add(floor);

    // Supporti di Deck ed Extra Deck negli angoli: piastre inclinate con il bordo d'oro.
    const plateGeo = new THREE.BoxGeometry(7.9, 0.7, 10.9);
    const plateTop = new THREE.MeshStandardMaterial({ color: 0x0b0b10, roughness: 0.5, metalness: 0.6 });
    // Bordo luminoso del colore del lato, come il bordo del tabellone: il mio in basso, quello dell'avversario in alto.
    const glowMats = [new THREE.MeshBasicMaterial({ color: T.frame }), new THREE.MeshBasicMaterial({ color: T.edgeTheirs.clone().multiplyScalar(1.05) })];
    // La cornice arriva quasi in cima alla piastra: dal campo inclinato si vede tutto il contorno, anche il lato
    // lontano (prima era più bassa della piastra e quel lato restava nascosto, ad esempio con un supporto vuoto).
    const frameGeo = new THREE.BoxGeometry(8.5, 0.84, 11.5);
    for (const [sx, sz, rot] of [[-1, -1, 1], [1, -1, -1], [1, 1, 1], [-1, 1, -1]]) {
      const g = new THREE.Group();
      g.position.set(sx * PILE[0], 0.15, sz * PILE[1]);
      g.rotation.y = rot * PILE[2];
      const frame = new THREE.Mesh(frameGeo, glowMats[sz < 0 ? 0 : 1]);
      frame.position.y = 0.02;
      const plate = new THREE.Mesh(plateGeo, plateTop);
      plate.position.y = 0.1;
      g.add(frame, plate);
      this.group.add(g);
    }

    // Basamenti dei Moai: un gradino largo sul pavimento, un disco di pietra e un anello luminoso del colore del lato.
    this.petRings = [];
    this.petSpots = [];
    const stepGeo = new THREE.CylinderGeometry(7.4, 7.9, 1.6, 48);
    const discGeo = new THREE.CylinderGeometry(5.9, 6.3, PET_TOP + 1.0, 48);
    const ringGeo = new THREE.RingGeometry(5.25, 5.6, 64);
    const innerGeo = new THREE.RingGeometry(3.6, 3.75, 64);
    const tickGeo = new THREE.PlaneGeometry(0.3, 0.9);
    PETS.forEach(([x, z], i) => {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      const step = new THREE.Mesh(stepGeo, stone);
      step.position.y = -2.6 + 0.8;
      const disc = new THREE.Mesh(discGeo, stone);
      disc.position.y = PET_TOP - (PET_TOP + 1.0) / 2;
      const mat = new THREE.MeshBasicMaterial({ color: i ? T.crystalTheirs : T.crystalMine, transparent: true, side: THREE.DoubleSide });
      const ring = new THREE.Mesh(ringGeo, mat);
      const inner = new THREE.Mesh(innerGeo, mat);
      for (const m of [ring, inner]) {
        m.rotation.x = -Math.PI / 2;
        m.position.y = PET_TOP + 0.02;
      }
      // Tacche attorno all'anello interno, che girano piano.
      const ticks = new THREE.Group();
      ticks.position.y = PET_TOP + 0.03;
      for (let k = 0; k < 12; k++) {
        const t = new THREE.Mesh(tickGeo, mat);
        t.rotation.x = -Math.PI / 2;
        const a = (k / 12) * Math.PI * 2;
        t.position.set(Math.cos(a) * 4.4, 0, Math.sin(a) * 4.4);
        t.rotation.z = -a + Math.PI / 2;
        ticks.add(t);
      }
      const rim = new THREE.Mesh(new THREE.TorusGeometry(6.1, 0.14, 8, 64), trim);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = PET_TOP;
      g.add(step, disc, ring, inner, ticks, rim);
      this.petRings.push({ mat, ticks, phase: i * 1.7 });
      this.petSpots.push(g);
      this.group.add(g);
    });

    // Obelischi ai quattro angoli del tabellone, con un cristallo che fluttua.
    this.crystals = [];
    const obeliskGeo = new THREE.CylinderGeometry(1.2, 2.0, 9, 6);
    const crystalGeo = new THREE.OctahedronGeometry(1.4);
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const o = new THREE.Mesh(obeliskGeo, stone);
      o.position.set(sx * (SLAB[0] + 6), 2, sz * (SLAB[1] - 4));
      const c = new THREE.Mesh(crystalGeo, new THREE.MeshBasicMaterial({ color: sz < 0 ? T.crystalMine : T.crystalTheirs }));
      c.position.set(o.position.x, 9.5, o.position.z);
      c.userData.phase = Math.random() * 6;
      this.crystals.push(c);
      this.group.add(o, c);
    }

    // Pulviscolo luminoso che sale piano sopra il campo.
    const M = 420;
    const pos = new Float32Array(M * 3);
    this.motes = { speed: new Float32Array(M) };
    for (let i = 0; i < M; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 160;
      pos[i * 3 + 1] = Math.random() * 30;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 100;
      this.motes.speed[i] = 0.4 + Math.random() * 1.2;
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.motes.points = new THREE.Points(mg, new THREE.PointsMaterial({
      color: T.motes, size: 0.35, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.group.add(this.motes.points);

    // Scintille dei colpi e delle fasi (un'esplosione per volta per lato).
    this.sparks = [0, 1].map(() => {
      const K = 160;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(K * 3), 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({
        color: T.sparks, size: 0.6, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.group.add(pts);
      return { pts, vel: new Float32Array(K * 3), age: 99 };
    });
  }

  /** Esplosione di scintille sul lato (0 mio, 1 avversario), più forte con la fase. */
  burst(index, power) {
    const s = this.sparks[index];
    const p = s.pts.geometry.attributes.position.array;
    const zc = index === 0 ? -13 : 13;
    for (let i = 0; i < p.length; i += 3) {
      p[i] = (Math.random() - 0.5) * 40;
      p[i + 1] = 0.3;
      p[i + 2] = zc + (Math.random() - 0.5) * 16;
      const a = Math.random() * Math.PI * 2;
      const v = (2 + Math.random() * 6) * (0.6 + power * 0.25);
      s.vel[i] = Math.cos(a) * v * 0.4;
      s.vel[i + 1] = 6 + Math.random() * 10 * (0.5 + power * 0.25);
      s.vel[i + 2] = Math.sin(a) * v * 0.4;
    }
    s.pts.geometry.attributes.position.needsUpdate = true;
    s.age = 0;
  }

  update(dt, opts = {}) {
    this.time += dt;
    this.tap += dt;
    const u = this.board.uniforms;
    u.uTime.value = this.time;
    this.floor.uniforms.uTime.value = this.time;
    u.uTap.value = this.tap;
    for (const s of this.sides) {
      s.hit += dt;
      s.shown += (s.damage - s.shown) * (1 - Math.exp(-dt * 1.6));
      if (s.damage === 0) s.shown = Math.min(s.shown, 0);
    }
    u.uDamage.value.set(this.sides[0].shown, this.sides[1].shown);
    u.uHit.value.set(this.sides[0].hit, this.sides[1].hit);

    for (const r of this.petRings) {
      r.ticks.rotation.y += dt * 0.25;
      r.mat.opacity = 0.7 + 0.3 * Math.sin(this.time * 1.4 + r.phase);
    }
    for (const c of this.crystals) {
      c.rotation.y += dt * 0.8;
      c.position.y = 9.5 + Math.sin(this.time * 1.2 + c.userData.phase) * 0.6;
    }
    const particles = opts.particles !== false;
    this.motes.points.visible = particles;
    if (particles) {
      const p = this.motes.points.geometry.attributes.position.array;
      for (let i = 0, k = 0; i < p.length; i += 3, k++) {
        p[i + 1] += this.motes.speed[k] * dt;
        p[i] += Math.sin(this.time * 0.5 + k) * dt * 0.3;
        if (p[i + 1] > 30) p[i + 1] = 0;
      }
      this.motes.points.geometry.attributes.position.needsUpdate = true;
    }
    for (const s of this.sparks) {
      s.age += dt;
      s.pts.visible = particles && s.age < 2.5;
      if (!s.pts.visible) continue;
      const p = s.pts.geometry.attributes.position.array;
      for (let i = 0; i < p.length; i += 3) {
        s.vel[i + 1] -= 22 * dt;
        p[i] += s.vel[i] * dt;
        p[i + 1] = Math.max(0.2, p[i + 1] + s.vel[i + 1] * dt);
        p[i + 2] += s.vel[i + 2] * dt;
      }
      s.pts.geometry.attributes.position.needsUpdate = true;
      s.pts.material.opacity = Math.max(0, 1 - s.age / 2.5);
    }
  }

  /**
   * Basamenti dove sono davvero i Moai: [[x, z, k], …] (il mio e quello dell'avversario), k = grandezza rispetto a quella
   * piena. Lo stage li avvicina e li rimpicciolisce quando ai lati del tabellone c'è poco spazio.
   */
  placePets(spots) {
    spots.forEach(([x, z, k], i) => {
      const g = this.petSpots[i];
      if (!g) return;
      g.position.set(x, 0, z);
      g.scale.set(k, 1, k);
    });
    this.board.uniforms.uPetZ.value.set(spots[0][1], spots[1][1]);
  }

  trigger(label, sideName) {
    for (const s of this.sides) if (!sideName || s.name === sideName) s.trigger(label);
  }

  resetPhases() {
    for (const s of this.sides) s.resetPhases();
  }

  labels() {
    return [HIT, 12, 13, 14, 15, TAP];
  }

  /** Il sole al centro si tocca (come la creatura dei campi di Master Duel). */
  tapBoxes() {
    return [{ side: this.sides[0], label: TAP, off: [0, 0.5, 0], size: [7, 1.5, 7] }];
  }

  setSideVisible() {}

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.group.removeFromParent();
  }
}
