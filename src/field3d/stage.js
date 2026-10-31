// Campo di gioco 3D (three.js) sotto il campo del duello. I campi NON stanno nella repository: si caricano
// da un indirizzo esterno (Settings → 3D field) con la struttura generata da md-fields/tools/convert.py:
//   <url>/index.json, <url>/<id>/near.glb|json, <url>/<id>/far.glb|json
// La telecamera guarda il campo dall'alto ed è allineata alla griglia delle zone di Helios:
// tutti i campi hanno le zone nelle stesse coordinate (zone mostri a x = 0, ±8.55, ±17.1).
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Field } from "./field.js";

// Centro delle zone mostri extra (x) nel campo 3D: dà la scala tra unità del campo e pixel della griglia.
const EMZ_X = 8.55;
const FOV = 35;
// Eventi del campo (vedi EVENT_LABELS in field.js).
const HIT = 11;
const BREAK = [12, 13, 14, 15]; // fase 2, 3, 4, distruzione

export class FieldStage {
  /**
   * @param host elemento in cui disegnare (la tela riempie tutto l'elemento)
   * @param opts { fx: particelle + bagliore }
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.fx = opts.fx !== false;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "field3d-canvas";
    host.prepend(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07080c);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-20, 60, -30);
    this.scene.add(sun);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 4000);
    this.camera.up.set(0, 0, 1); // in alto sullo schermo il lato dell'avversario (+z)
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.4, 1.0));
    this.composer.addPass(new OutputPass());
    this.field = null;
    this.anchors = null;
    this.stage = [0, 0]; // fase di danneggiamento del campo per lato (0 = intatto)
    this.timers = [];
    this.clock = new THREE.Clock();
    this.alive = true;
    // Cambia la dimensione del campo, o solo lo zoom della pagina (main.js: fitScreen): si riallinea.
    this.onResize = () => this.align();
    this.resize = new ResizeObserver(this.onResize);
    this.resize.observe(host);
    window.addEventListener("resize", this.onResize);
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  async load(base, id, sides = ["near", "far"]) {
    const f = await Field.load(base, id, sides);
    if (!this.alive) return f.dispose();
    this.field = f;
    this.scene.add(f.group);
    this.align();
  }

  /**
   * Allinea la telecamera alla griglia: `center` è l'elemento al centro del campo, `left`/`right`
   * le due zone mostri extra (rettangoli a schermo, con lo zoom della pagina già applicato).
   */
  setAnchors(anchors) {
    this.anchors = anchors;
    this.align();
  }

  align() {
    const a = this.anchors;
    if (!a || !this.alive) return;
    const box = this.canvas.getBoundingClientRect();
    const mid = (el) => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
    const [cx, cy] = mid(a.center);
    const ppu = (mid(a.right)[0] - mid(a.left)[0]) / (2 * EMZ_X); // pixel a schermo per unità del campo
    if (!box.width || !box.height || !(ppu > 0)) return;
    // Risoluzione: dimensione CSS della tela × zoom della pagina × densità dello schermo.
    const w = this.canvas.clientWidth || box.width;
    const hgt = this.canvas.clientHeight || box.height;
    const zoom = box.width / w;
    this.renderer.setPixelRatio(Math.min(2, (window.devicePixelRatio || 1) * zoom));
    this.renderer.setSize(w, hgt, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, hgt);
    // Telecamera perpendicolare al pavimento (y = 0): il pavimento si proietta senza deformazioni,
    // le decorazioni in rilievo mantengono un po' di profondità.
    const height = box.height / ppu / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    // Il centro della griglia (x = z = 0) va dove sta il suo elemento; lo schermo ha +x a sinistra e +z in alto.
    const ox = (cx - (box.left + box.width / 2)) / ppu;
    const oz = (cy - (box.top + box.height / 2)) / ppu;
    this.camera.aspect = box.width / box.height;
    this.camera.position.set(ox, height, oz);
    this.camera.lookAt(ox, 0, oz);
    this.camera.far = height + 500;
    this.camera.updateProjectionMatrix();
    this.placeLogButton();
  }

  // ---------------------------------------------------------------- pulsante Log/Chat nel campo

  /**
   * Pulsante di Log e Chat dentro il campo: un esagono piccolo sul bordo sinistro, a metà altezza, che si accende
   * solo al passaggio del mouse (o appena di più con messaggi da leggere). onVisible(false): niente spazio ai lati
   * del tabellone (schermo stretto), la pagina mostra il suo pulsante.
   */
  setLogButton({ onClick, onVisible }) {
    const icon = document.createElement("canvas");
    icon.width = icon.height = 256;
    const x = icon.getContext("2d");
    const g = x.createRadialGradient(128, 128, 20, 128, 128, 128);
    g.addColorStop(0, "rgba(20,40,70,0.95)");
    g.addColorStop(1, "rgba(6,10,20,0.95)");
    x.fillStyle = g;
    x.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + (k * Math.PI) / 3;
      x[k ? "lineTo" : "moveTo"](128 + Math.cos(a) * 124, 128 + Math.sin(a) * 124);
    }
    x.closePath();
    x.fill();
    x.strokeStyle = x.fillStyle = "#9ae2ff";
    x.lineWidth = 10;
    x.lineJoin = "round";
    x.beginPath();
    x.roundRect(62, 66, 132, 92, 18);
    x.stroke();
    x.beginPath();
    x.moveTo(92, 156);
    x.lineTo(80, 192);
    x.lineTo(120, 156);
    x.fill();
    for (const y of [94, 114, 134]) x.fillRect(84, y - 4, y === 134 ? 56 : 88, 8);
    const tex = new THREE.CanvasTexture(icon);
    tex.colorSpace = THREE.SRGBColorSpace;
    const group = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CircleGeometry(2.6, 6), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.rotation.z = Math.PI; // la destra dello schermo è -x
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x38c6ff, toneMapped: false, transparent: true, opacity: 0.8 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.75, 2.9, 6), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    // Numero dei messaggi da leggere: un pallino rosso con la cifra.
    const badgeCanvas = document.createElement("canvas");
    badgeCanvas.width = badgeCanvas.height = 64;
    const badgeTex = new THREE.CanvasTexture(badgeCanvas);
    badgeTex.colorSpace = THREE.SRGBColorSpace;
    const badge = new THREE.Mesh(new THREE.CircleGeometry(1, 24), new THREE.MeshBasicMaterial({ map: badgeTex, transparent: true, toneMapped: false }));
    badge.rotation.x = -Math.PI / 2;
    badge.rotation.z = Math.PI;
    badge.position.set(-2, 0.1, 2);
    badge.visible = false;
    group.add(disc, ring, badge);
    this.scene.add(group);
    this.logButton = { group, disc, ringMat, badge, badgeCanvas, badgeTex, onClick, onVisible, unread: 0, hover: false, visible: null };
    this.placeLogButton();
  }

  setLogUnread(n) {
    const b = this.logButton;
    if (!b) return;
    b.unread = n;
    b.badge.visible = n > 0;
    const x = b.badgeCanvas.getContext("2d");
    x.clearRect(0, 0, 64, 64);
    x.fillStyle = "#ff3b4e";
    x.beginPath();
    x.arc(32, 32, 30, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = "#fff";
    x.font = "700 36px sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(n > 9 ? "9+" : String(n), 32, 34);
    b.badgeTex.needsUpdate = true;
  }

  /** Sul bordo sinistro della vista, a metà altezza, sollevato sopra le decorazioni del campo. */
  placeLogButton() {
    const b = this.logButton;
    if (!b || !this.anchors) return;
    const y = 20;
    const t = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const halfW = (this.camera.position.y - y) * t * this.camera.aspect;
    const x = this.camera.position.x + halfW - 4.5; // lo schermo ha la sinistra a +x
    // Serve spazio a sinistra del tabellone (la Zona Banditi dell'avversario è a x ≈ 25.6).
    const visible = x > 33;
    b.group.position.set(x, y, 0);
    b.group.visible = visible;
    if (visible !== b.visible) {
      b.visible = visible;
      b.onVisible?.(visible);
    }
  }

  /** Il pulsante di Log/Chat è sotto il puntatore? */
  overLogButton(clientX, clientY) {
    const b = this.logButton;
    if (!b?.group.visible) return false;
    b.hover = this.rayAt(clientX, clientY).intersectObject(b.disc).length > 0;
    return b.hover;
  }

  /** Raggio dalla telecamera attraverso un punto dello schermo. */
  rayAt(clientX, clientY) {
    const box = this.canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((clientX - box.left) / box.width) * 2 - 1, -((clientY - box.top) / box.height) * 2 + 1), this.camera);
    return ray;
  }

  /** Inquadratura libera (anteprima nelle impostazioni): il campo visto dal lato del giocatore. */
  showcase() {
    this.anchors = null;
    const fit = () => {
      const w = this.canvas.clientWidth;
      const hgt = this.canvas.clientHeight;
      if (!w || !hgt) return;
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer.setSize(w, hgt, false);
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, hgt);
      this.camera.aspect = w / hgt;
      this.camera.up.set(0, 1, 0);
      this.camera.position.set(0, 82, -62);
      this.camera.lookAt(0, 0, -3);
      this.camera.updateProjectionMatrix();
    };
    this.align = fit;
    fit();
  }

  /** Danno al lato `side` (0 = mio, in basso): colpo e, con pochi LP, il campo si rompe a fasi. */
  damage(side, lp, startLP) {
    if (!this.field) return;
    const name = side === 0 ? "near" : "far";
    this.field.trigger(HIT, name);
    this.syncLP(side, lp, startLP);
  }

  /** Porta il danneggiamento del lato alla fase dei suoi LP (dopo un ripristino del duello torna intatto). */
  syncLP(side, lp, startLP) {
    if (!this.field) return;
    const name = side === 0 ? "near" : "far";
    const k = lp / (startLP || 8000);
    const want = lp <= 0 ? 4 : k <= 0.25 ? 3 : k <= 0.5 ? 2 : k <= 0.75 ? 1 : 0;
    if (want < this.stage[side]) {
      for (const s of this.field.sides) if (s.name === name) s.resetPhases();
      this.stage[side] = 0;
    }
    // Una fase alla volta: ogni transizione ha la sua animazione.
    let delay = 0;
    while (this.stage[side] < want) {
      const label = BREAK[this.stage[side]++];
      this.later(delay, () => this.field?.trigger(label, name));
      delay += 1400;
    }
  }

  later(ms, fn) {
    const t = setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== t);
      if (this.alive) fn();
    }, ms);
    this.timers.push(t);
  }

  /** Clic sul pavimento (fuori da zone e carte): la creatura del campo fa la sua animazione. */
  tap(clientX, clientY) {
    if (this.overLogButton(clientX, clientY)) {
      this.logButton.onClick?.();
      return true;
    }
    if (!this.field) return false;
    const ray = this.rayAt(clientX, clientY);
    let best = null;
    for (const b of this.field.tapBoxes()) {
      const c = new THREE.Vector3(...b.off);
      const half = new THREE.Vector3(...b.size).multiplyScalar(0.5);
      const p = ray.ray.intersectBox(new THREE.Box3(c.clone().sub(half), c.clone().add(half)), new THREE.Vector3());
      if (p) {
        const d = p.distanceTo(this.camera.position);
        if (!best || d < best.d) best = { d, b };
      }
    }
    if (best) best.b.side.trigger(best.b.label);
    return !!best;
  }

  frame() {
    if (!this.alive) return;
    // Pagina chiusa (la tela non è più nel documento): si libera il contesto WebGL.
    if (this.canvas.isConnected) this.mounted = true;
    else if (this.mounted) return this.dispose();
    requestAnimationFrame(this.frame);
    const dt = Math.min(this.clock.getDelta(), 1 / 15);
    if (!this.field || document.hidden) return;
    const b = this.logButton;
    if (b) {
      b.ringMat.color.setRGB(0.22, 0.78, 1).multiplyScalar(b.hover ? 2.4 : b.unread ? 1 : 0.7);
      b.group.scale.setScalar(b.hover ? 1.08 : 1);
    }
    this.field.update(dt, { particles: this.fx, animations: true });
    if (this.fx) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.alive = false;
    this.timers.forEach(clearTimeout);
    this.resize.disconnect();
    window.removeEventListener("resize", this.onResize);
    this.field?.dispose();
    this.field = null;
    this.composer.dispose?.();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
