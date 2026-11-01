// Moai (il "pet" di Helios): testa di pietra chiara modellata a mano (un blocco suddiviso deformato con il profilo del
// viso), poggiata sul terreno ai lati del campo come i pet di MDPro3 (vedi FieldStage.setPets). Cliccato, gli occhi si
// accendono e dalla bocca esce il colpo. L'aspetto (pietra, occhi, colore e forma del colpo, disegno sulla faccia) è in
// src/data/moai.js.
import * as THREE from "three";
import { MOAI_DEFAULT, DRAWING_W, DRAWING_H, DRAWING_RECTS, drawDrawing } from "../data/moai.js";

// Dove sta il mio Moai sul campo (unità del campo; l'avversario a -x e z[1], speculare) e quanto è grande: lo usano
// FieldStage.placePets e l'anteprima nelle impostazioni, che così lo vede come sul campo.
export const PET = { x: 37.67, y: 2, z: [-5.48, 7.48], scale: 2.5 };

const SHAPE_ID = { ray: 0, flame: 1, wave: 2, bolt: 3 };
const SHAPE_WIDTH = { ray: 1.4, flame: 2.4, wave: 1.8, bolt: 1.6 };

// Dimensioni della testa (unità locali): larghezza, altezza, profondità.
const W = 2;
const H = 3.6;
const D = 1.5;
const g = (a, s) => Math.exp(-(a * a) / (2 * s * s));
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Rilievo della faccia (quanto sporge, in unità) nel punto nx, ny ∈ [-1, 1] (ny = 1 in cima). */
function relief(nx, ny) {
  const ax = Math.abs(nx);
  const brow = 0.24 * g(ny - 0.36, 0.06) * g(nx, 0.75);
  const sockets = -0.3 * g(ax - 0.42, 0.17) * g(ny - 0.2, 0.11);
  const noseMask = smooth(0.34, 0.24, ny) * smooth(-0.44, -0.28, ny);
  const down = clamp01((0.3 - ny) / 0.7);
  const nose = 0.5 * g(nx, 0.09 + 0.1 * down) * noseMask * (0.6 + 0.4 * down);
  const tip = 0.12 * g(nx, 0.16) * g(ny + 0.34, 0.06);
  const wings = 0.1 * g(ax - 0.2, 0.07) * g(ny + 0.36, 0.05);
  const lips = 0.2 * g(nx, 0.3) * g(ny + 0.56, 0.07);
  const mouth = -0.12 * g(nx, 0.28) * g(ny + 0.565, 0.014);
  const chin = 0.16 * g(nx, 0.42) * g(ny + 0.84, 0.09);
  const cheeks = -0.07 * g(ax - 0.62, 0.16) * g(ny + 0.1, 0.25);
  return brow + sockets + nose + tip + wings + lips + mouth + chin + cheeks;
}

// Zona della texture (DRAWING_RECTS) di ogni lato del blocco, nell'ordine dei vertici di BoxGeometry (+x, -x, +y, -y,
// +z, -z) e come trasformare la posizione (non ancora deformata) in coordinate 0..1 dentro la zona, vista da fuori.
const SIDES = [
  ["right", (v) => [(D / 2 - v.z) / D, (v.y + H / 2) / H]],
  ["left", (v) => [(v.z + D / 2) / D, (v.y + H / 2) / H]],
  ["top", (v) => [(v.x + W / 2) / W, (D / 2 - v.z) / D]], // il bordo davanti tocca la fronte
  ["bottom", (v) => [(v.x + W / 2) / W, (v.z + D / 2) / D]], // il bordo davanti tocca il mento
  ["face", (v) => [(v.x + W / 2) / W, (v.y + H / 2) / H]],
  ["back", (v) => [(W / 2 - v.x) / W, (v.y + H / 2) / H]],
];

/** Testa: blocco suddiviso deformato. Ogni lato ha la sua zona della texture (il disegno resta dove lo si fa). */
function headGeometry() {
  const seg = [44, 80, 14];
  const geo = new THREE.BoxGeometry(W, H, D, ...seg);
  const p = geo.attributes.position;
  const uv = geo.attributes.uv;
  const v = new THREE.Vector3();
  // Vertici per lato: (segmenti + 1) × (segmenti + 1) delle due direzioni del lato.
  const grid = [
    [seg[2], seg[1]],
    [seg[2], seg[1]],
    [seg[0], seg[2]],
    [seg[0], seg[2]],
    [seg[0], seg[1]],
    [seg[0], seg[1]],
  ];
  const sideOf = [];
  grid.forEach(([a, b], k) => {
    for (let i = 0; i < (a + 1) * (b + 1); i++) sideOf.push(k);
  });
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const [name, map] = SIDES[sideOf[i]];
    const r = DRAWING_RECTS[name];
    const [su, sv] = map(v);
    // La texture si legge dal basso (flipY): v = 1 è la riga in alto della tela.
    uv.setXY(i, (r.x + clamp01(su) * r.w) / DRAWING_W, 1 - (r.y + (1 - clamp01(sv)) * r.h) / DRAWING_H);
    const nx = v.x / (W / 2);
    const ny = v.y / (H / 2);
    const nz = v.z / (D / 2);
    const front = smooth(-0.2, 1, nz);
    const width = 1 + 0.06 * g(ny - 0.05, 0.35) - 0.16 * smooth(-0.55, -1, ny) - 0.05 * smooth(0.7, 1, ny);
    let x = v.x * width;
    let z = v.z;
    z -= (0.55 * Math.abs(nx) ** 3 + 0.3 * smooth(0.85, 1, ny) + 0.25 * smooth(-0.88, -1, ny)) * front;
    z += relief(nx, ny) * front * front;
    // Orecchie lunghe: escono dai lati, dalla tempia fino sotto la bocca.
    const ear = smooth(-0.45, -0.25, ny) * smooth(0.62, 0.42, ny) * smooth(0.86, 1, Math.abs(nx)) * (1 - 0.6 * Math.abs(nz));
    x += Math.sign(v.x) * 0.24 * ear;
    p.setXYZ(i, x, v.y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Pietra lavica porosa (deterministica: lo stesso Moai è uguale per entrambi), poi il disegno sopra. */
function stoneCanvas(color) {
  const c = document.createElement("canvas");
  c.width = DRAWING_W * 2;
  c.height = DRAWING_H * 2;
  const x = c.getContext("2d");
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 5400; i++) {
    x.fillStyle = rnd() < 0.55 ? `rgba(0,0,0,${0.05 + rnd() * 0.16})` : `rgba(255,255,255,${0.03 + rnd() * 0.08})`;
    x.beginPath();
    x.arc(rnd() * c.width, rnd() * c.height, 0.6 + rnd() * 2.2, 0, Math.PI * 2);
    x.fill();
  }
  x.strokeStyle = "rgba(0,0,0,0.22)";
  for (let i = 0; i < 28; i++) {
    x.lineWidth = 0.6 + rnd() * 1.4;
    x.beginPath();
    let px = rnd() * c.width;
    let py = rnd() * c.height;
    x.moveTo(px, py);
    for (let k = 0; k < 6; k++) x.lineTo((px += (rnd() - 0.5) * 60), (py += rnd() * 50));
    x.stroke();
  }
  return c;
}

// ---------------------------------------------------------------- raggio

// Raggio dalla bocca: una striscia piatta distesa sul campo (la telecamera la vede dall'alto), con il nucleo
// bianco, i bordi del colore scelto e un flusso che scorre verso la punta. Si allunga, resta e si spegne.
const beamVert = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const beamFrag = `
uniform vec3 uColor;
uniform float uTime;
uniform float uReach;   // 0..1: quanto del colpo è già uscito
uniform float uFade;    // 1 acceso, 0 spento
uniform int uShape;     // 0 raggio, 1 fiamma, 2 onda, 3 fulmine
varying vec2 vUv;
float hash(float n) { return fract(sin(n) * 43758.5453); }
float noise(float x) { float i = floor(x); float f = fract(x); return mix(hash(i), hash(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main() {
  float along = vUv.y;             // 0 alla bocca, 1 alla punta
  if (along > uReach) discard;
  float side = (vUv.x - 0.5) * 2.0;
  float width, coreW, glowW, flow;
  vec3 hot = vec3(1.0, 0.97, 0.9);
  if (uShape == 1) {
    // Fiamma: si allarga uscendo, lingue che tremano, la punta si sfrangia e si scurisce.
    side += (noise(along * 9.0 - uTime * 18.0) - 0.5) * 0.35 * along;
    width = mix(0.3, 1.0, sqrt(along)) * (0.75 + 0.35 * noise(along * 12.0 - uTime * 30.0));
    coreW = 0.28; glowW = 0.8;
    flow = (0.6 + 0.4 * noise(along * 25.0 - uTime * 40.0)) * (1.0 - 0.55 * along);
    hot = mix(vec3(1.0, 0.95, 0.6), uColor, along);
  } else if (uShape == 2) {
    // Onda: anelli che corrono verso la punta.
    width = mix(0.7, 1.0, along) * (0.75 + 0.25 * sin(along * 38.0 - uTime * 26.0));
    coreW = 0.12; glowW = 0.6;
    flow = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(along * 38.0 - uTime * 26.0), 3.0);
  } else if (uShape == 3) {
    // Fulmine: una linea sottile che salta a zig-zag, ridisegnata di continuo.
    float k = floor(uTime * 16.0);
    side -= (noise(along * 7.0 + k * 3.1) - 0.5) * 1.1 + (noise(along * 23.0 + k) - 0.5) * 0.3;
    width = 1.0;
    coreW = 0.07; glowW = 0.3;
    flow = 0.8 + 0.2 * hash(k);
  } else {
    width = mix(1.0, 0.55, along) * (0.85 + 0.15 * noise(along * 14.0 - uTime * 22.0));
    coreW = 0.16; glowW = 0.62;
    flow = 0.75 + 0.25 * noise(along * 40.0 - uTime * 60.0);
  }
  float across = abs(side);
  float core = exp(-pow(across / (coreW * width), 2.0));
  float glow = exp(-pow(across / (glowW * width), 2.0));
  float tip = smoothstep(uReach, uReach - 0.12, along);
  float base = smoothstep(0.0, 0.04, along);
  vec3 col = uColor * glow * 1.8 * flow + hot * core * 2.6 * flow;
  float a = max(glow, core) * tip * base * uFade;
  gl_FragColor = vec4(col * a, a);
}`;

class Beam {
  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uReach: { value: 0 }, uFade: { value: 0 }, uShape: { value: 0 } },
      vertexShader: beamVert,
      fragmentShader: beamFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    // Piano 1×1 con l'origine alla base: x = larghezza, y = lunghezza (poi disteso sul campo).
    const geo = new THREE.PlaneGeometry(1, 1, 1, 24);
    geo.translate(0, 0.5, 0);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.t = -1;
  }

  /** Dalla bocca (origin) verso il punto `to`, largo `width`. */
  aim(origin, to, width) {
    const d = to.clone().sub(origin);
    const len = d.length();
    this.mesh.position.copy(origin);
    // Asse y del piano lungo il raggio, asse z verso l'alto (il piano resta orizzontale, visto dalla telecamera).
    const y = d.normalize();
    const zUp = new THREE.Vector3(0, 1, 0);
    const x = new THREE.Vector3().crossVectors(y, zUp).normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    this.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    this.mesh.scale.set(width, len, 1);
  }

  fire() {
    this.t = 0;
    this.mesh.visible = true;
  }

  get active() {
    return this.t >= 0;
  }

  /** 0,25 s per uscire, ~1,3 s acceso, 0,45 s per spegnersi. */
  update(dt, time) {
    this.mat.uniforms.uTime.value = time;
    if (this.t < 0) return;
    this.t += dt;
    const u = this.mat.uniforms;
    u.uReach.value = Math.min(1, this.t / 0.25);
    u.uFade.value = this.t < 1.55 ? 1 : Math.max(0, 1 - (this.t - 1.55) / 0.45);
    if (this.t > 2) {
      this.t = -1;
      this.mesh.visible = false;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------- Moai

let headGeo = null;
let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d");
  const r = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.3, "rgba(255,255,255,0.55)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = r;
  x.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

export class Moai {
  constructor(cfg) {
    this.group = new THREE.Group(); // posizione e scala ai lati del campo
    // Statua: la testa poggia sul terreno, l'orientamento lo decide setTarget (la faccia è +z locale).
    this.body = new THREE.Group();
    this.body.position.y = H * 0.32;
    this.group.add(this.body);
    this.texture = new THREE.CanvasTexture(document.createElement("canvas"));
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.stoneMat = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.92, metalness: 0.02 });
    this.head = new THREE.Mesh((headGeo ??= headGeometry()), this.stoneMat);
    this.body.add(this.head);
    // Occhi: ellissi luminose in fondo alle orbite, con il bagliore.
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const eyeGeo = new THREE.SphereGeometry(0.17, 20, 12);
    this.eyeGlow = [-1, 1].map((s) => {
      const e = new THREE.Mesh(eyeGeo, this.eyeMat);
      e.scale.set(1.25, 0.55, 0.35);
      e.position.set(s * 0.42 * (W / 2) * 1.04, 0.2 * (H / 2), D / 2 - 0.2);
      this.head.add(e);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      sp.position.set(s * 0.42 * (W / 2) * 1.04, 0.2 * (H / 2), D / 2 + 0.05);
      sp.scale.setScalar(0.9);
      this.head.add(sp);
      return sp;
    });
    // Bocca: bagliore che si accende quando sputa fuoco.
    this.mouthLocal = new THREE.Vector3(0, -0.565 * (H / 2), D / 2 + 0.12);
    this.mouthGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0 }));
    this.mouthGlow.position.copy(this.mouthLocal);
    this.mouthGlow.scale.setScalar(1.6);
    this.head.add(this.mouthGlow);
    this.beam = new Beam();
    this.target = new THREE.Vector3();
    this.firing = 0;
    this.recoil = 0;
    this.glow = 0;
    this.reach = 4; // lunghezza del colpo, in teste (× scala)
    this.beamTurn = 29; // direzione del colpo rispetto all'asse della testa, in gradi
    // Posa scelta nell'anteprima: quanto la testa pende verso l'alto dello schermo, giro e rollio (gradi).
    this.pose = { stand: 22, yaw: 69, roll: 10 };
    this.aim = new THREE.Vector3(1, 0, 0);
    this.time = Math.random() * 10;
    this.setConfig(cfg);
  }

  setConfig(cfg) {
    const c = { ...MOAI_DEFAULT, ...(cfg ?? {}) };
    this.cfg = c;
    this.eyeColor = new THREE.Color(c.eyes);
    this.beam.mat.uniforms.uColor.value.set(c.flame);
    this.beam.mat.uniforms.uShape.value = SHAPE_ID[c.shape] ?? 0;
    this.mouthGlow.material.color.set(c.flame);
    for (const s of this.eyeGlow) s.material.color.set(c.eyes);
    if (this.stoneColor !== c.stone) {
      this.stoneColor = c.stone;
      this.stone = stoneCanvas(c.stone);
    }
    // Il disegno salvato è un PNG: finché non è caricato resta quello di prima (niente lampi mentre si dipinge).
    const token = (this.drawToken = (this.drawToken ?? 0) + 1);
    if (!c.drawing || !this.face) this.paint(null);
    if (!c.drawing) return;
    const img = new Image();
    img.onload = () => token === this.drawToken && this.paint(img);
    img.src = c.drawing;
  }

  /** La pietra con sopra `drawing` (immagine o tela, nelle proporzioni della faccia; null = pietra nuda). */
  paint(drawing) {
    if (!this.face) {
      this.face = document.createElement("canvas");
      this.face.width = this.stone.width;
      this.face.height = this.stone.height;
    }
    const x = this.face.getContext("2d");
    x.globalAlpha = 1;
    x.drawImage(this.stone, 0, 0);
    if (drawing) {
      x.globalAlpha = 0.95;
      drawDrawing(x, drawing, this.face.width, this.face.height);
    }
    this.texture.image = this.face;
    this.texture.needsUpdate = true;
  }

  /**
   * Il raggio punta a `target` (di solito il centro del campo). La statua sta in piedi, vista quasi dall'alto come i pet di
   * Master Duel: la cima della testa verso la telecamera e un po' verso l'alto dello schermo, la faccia di lato verso il
   * campo e un po' verso chi guarda.
   */
  setTarget(target) {
    this.target.copy(target);
    const dir = target.clone().sub(this.group.position).setY(0).normalize();
    this.aim.copy(dir);
    const p = this.pose;
    const stand = THREE.MathUtils.degToRad(p.stand);
    const top = new THREE.Vector3(0, Math.cos(stand), Math.sin(stand));
    const face = dir.clone().add(new THREE.Vector3(0, 0, -0.55));
    face.addScaledVector(top, -face.dot(top)).normalize();
    const right = new THREE.Vector3().crossVectors(top, face);
    this.group.rotation.set(0, 0, 0);
    // Poi le correzioni a mano: giro attorno alla verticale e rollio attorno al naso.
    const base = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, top, face));
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(p.yaw));
    const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(p.roll));
    this.body.quaternion.copy(yaw).multiply(base).multiply(roll);
  }

  fire(seconds = 1.55) {
    this.firing = seconds;
    this.recoil = 1;
    this.beam.fire();
  }

  hit(ray) {
    this.head.updateWorldMatrix(true, false);
    const box = new THREE.Box3().setFromObject(this.head).expandByScalar(0.3);
    return !!ray.ray.intersectBox(box, new THREE.Vector3());
  }

  mouthWorld() {
    this.head.updateWorldMatrix(true, false);
    return this.mouthLocal.clone().applyMatrix4(this.head.matrixWorld);
  }

  update(dt) {
    this.time += dt;
    const breathe = 0.75 + 0.25 * Math.sin(this.time * 1.7);
    const blaze = this.firing > 0 ? 1 : 0;
    // Occhi spenti (appena tinti) a riposo, accesi mentre spara.
    this.glow += ((blaze ? 1 : 0) - this.glow) * Math.min(1, dt * 8);
    this.eyeMat.color.copy(this.eyeColor).multiplyScalar(0.1 + 0.04 * breathe + 4 * this.glow);
    for (const s of this.eyeGlow) s.material.opacity = 0.9 * this.glow;
    this.recoil = Math.max(0, this.recoil - dt * 2.5);
    this.head.scale.setScalar(1 + 0.06 * Math.sin(this.recoil * Math.PI) * this.recoil);
    this.mouthGlow.material.opacity += ((blaze ? 1 : 0) - this.mouthGlow.material.opacity) * Math.min(1, dt * 10);
    this.mouthGlow.scale.setScalar(1.6 + 1.2 * this.mouthGlow.material.opacity * (0.8 + 0.2 * Math.sin(this.time * 40)));
    if (this.firing > 0) this.firing -= dt;
    if (this.beam.active) {
      // Esce dritto dalla bocca, lungo `reach`. Visto dall'alto la testa "punta" dalla cima verso il mento: il colpo
      // segue quell'asse (un po' verso dove guarda la faccia), ruotato di `beamTurn` gradi.
      const from = this.mouthWorld();
      const m = this.head.matrixWorld;
      const chin = new THREE.Vector3(0, -1, 0).transformDirection(m).setY(0);
      const face = new THREE.Vector3(0, 0, 1).transformDirection(m).setY(0);
      const look = chin.normalize().addScaledVector(face.normalize(), 0.35).normalize();
      look.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(this.beamTurn));
      const k = this.group.scale.x;
      const to = from.clone().addScaledVector(look, this.reach * k); // in piano, all'altezza della bocca: dritto anche in prospettiva
      this.beam.aim(from, to, (SHAPE_WIDTH[this.cfg.shape] ?? 1.4) * k);
    }
    this.beam.update(dt, this.time);
  }

  dispose() {
    this.beam.dispose();
    this.texture.dispose();
    this.stoneMat.dispose();
    this.eyeMat.dispose();
    for (const s of [...this.eyeGlow, this.mouthGlow]) s.material.dispose();
  }
}
