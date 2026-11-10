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
import { HeliosField } from "./helios-field.js";
import { Moai, PET } from "./moai.js";

// Centro delle zone mostri extra (x) nel campo 3D: dà la scala tra unità del campo e pixel della griglia.
const EMZ_X = 8.55;
const FOV = 35;
// Eventi del campo (vedi EVENT_LABELS in field.js).
const HIT = 11;
const BREAK = [12, 13, 14, 15]; // fase 2, 3, 4, distruzione
const SUN = 24; // tocco: sul campo di Helios l'onda del sole
// Moai (i pet, come in MDPro3): il mio a sinistra appena sotto la linea centrale, quello dell'avversario a destra appena
// sopra, speculare al mio (girato di mezzo giro: l'avversario vede il suo come io vedo il mio). Posizioni scelte
// nell'anteprima di md-fields; a grandezza piena servono PET_ROOM unità tra il centro del campo e il bordo della vista.
const { x: PET_X, y: PET_Y, z: PET_Z, scale: PET_SCALE } = PET; // il mio a +x (sinistra dello schermo)
const PET_ROOM = 47; // sotto, i Moai si rimpiccioliscono
const PET_MIN_FIT = 0.45;
const PET_COOLDOWN = 1500; // ms tra un colpo e l'altro del proprio Moai
// Altezza dei supporti di Deck ed Extra Deck nei campi di Master Duel (misurata: piatti, a 1.46 in quasi tutti).
const PILE_HEIGHT = 1.46;
// Supporti di Deck ed Extra Deck negli angoli (centro a x = ±27.2, z = ±24.4, ruotati di 20°) e spessore di una carta
// nella pila (campo inclinato): 40 carte ≈ 2.4 unità, circa come un mazzo vero.
const PILE_AT = [27.2, 24.4, THREE.MathUtils.degToRad(20)];
const CARD_THICK = 0.06;
// Angolo di ogni pila: [sx, sz] (lo schermo ha la destra a -x e l'alto a +z). Il mio Deck in basso a destra, il mio
// Extra Deck in basso a sinistra; quelli dell'avversario negli angoli opposti in alto.
const PILE_CORNERS = { deck: [[-1, -1], [1, 1]], extra: [[1, -1], [-1, 1]] };

export class FieldStage {
  /**
   * @param host elemento in cui disegnare (la tela riempie tutto l'elemento)
   * @param opts { fx: particelle + bagliore, tilt: gradi di inclinazione del campo nel duello (0 = dall'alto) }
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.fx = opts.fx !== false;
    this.tilt = opts.tilt || 0;
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
    // Moai in una scena a parte, disegnata su una tela trasparente sopra la griglia delle zone (vedi setPets): né le
    // decorazioni del campo né zone e carte coprono il Moai e il suo colpo.
    this.petScene = new THREE.Scene();
    this.petScene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 2.2));
    const petSun = new THREE.DirectionalLight(0xffffff, 1.6);
    petSun.position.set(-20, 60, -30);
    this.petScene.add(petSun);
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

  /** Campo di Helios (nel codice, niente da scaricare) con il tema "helios" o "sole". */
  async loadHelios(theme) {
    this.field = new HeliosField({ theme });
    this.scene.add(this.field.group);
    this.align();
  }

  /** Onda del sole al centro del campo di Helios (sugli altri campi niente). */
  sunPulse() {
    if (this.field instanceof HeliosField) this.field.trigger(SUN);
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
    // Con il campo inclinato le misure si prendono con la griglia delle zone dritta (inclinata ha i rettangoli deformati).
    const grid = a.center.parentElement;
    const tilted = grid.style.transform;
    grid.style.transform = "none";
    const [cx, cy] = mid(a.center);
    const ppu = (mid(a.right)[0] - mid(a.left)[0]) / (2 * EMZ_X); // pixel a schermo per unità del campo
    const gridBox = grid.getBoundingClientRect();
    const boardBox = grid.parentElement.getBoundingClientRect();
    grid.style.transform = tilted;
    if (!box.width || !box.height || !(ppu > 0)) return;
    // Risoluzione: dimensione CSS della tela × zoom della pagina × densità dello schermo.
    const w = this.canvas.clientWidth || box.width;
    const hgt = this.canvas.clientHeight || box.height;
    const zoom = box.width / w;
    this.renderer.setPixelRatio(Math.min(2, (window.devicePixelRatio || 1) * zoom));
    this.renderer.setSize(w, hgt, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, hgt);
    this.sizePets();
    // Telecamera perpendicolare al pavimento (y = 0): il pavimento si proietta senza deformazioni,
    // le decorazioni in rilievo mantengono un po' di profondità.
    const height = box.height / ppu / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    // Il centro della griglia (x = z = 0) va dove sta il suo elemento; lo schermo ha +x a sinistra e +z in alto.
    const ox = (cx - (box.left + box.width / 2)) / ppu;
    const oz = (cy - (box.top + box.height / 2)) / ppu;
    this.camera.aspect = box.width / box.height;
    this.camera.position.set(ox, height, oz);
    this.camera.up.set(0, 0, 1);
    const target = new THREE.Vector3(ox, 0, oz);
    // Inquadratura dritta (prima dell'inclinazione): serve per mettere il pulsante di Log/Chat sullo schermo.
    this.camBase = { x: ox, z: oz, height };
    if (this.tilt) {
      // Campo inclinato (come in Master Duel): la griglia delle zone gira di `tilt` gradi attorno alla linea orizzontale
      // che passa per il centro del campo, vista da un occhio sopra il centro della tela alla stessa distanza della
      // telecamera (perspective); la telecamera gira al contrario attorno allo stesso asse, così 3D e zone combaciano.
      const axis = new THREE.Vector3(1, 0, 0);
      const k = -THREE.MathUtils.degToRad(this.tilt);
      this.camera.position.applyAxisAngle(axis, k);
      this.camera.up.applyAxisAngle(axis, k);
      target.applyAxisAngle(axis, k);
      const board = grid.parentElement;
      board.style.perspective = `${(height * ppu) / zoom}px`;
      board.style.perspectiveOrigin = `${(box.left + box.width / 2 - boardBox.left) / zoom}px ${(box.top + box.height / 2 - boardBox.top) / zoom}px`;
      grid.style.transformOrigin = `${(cx - gridBox.left) / zoom}px ${(cy - gridBox.top) / zoom}px`;
      grid.style.transform = `rotateX(${this.tilt}deg)`;
      // Deck ed Extra Deck sui supporti rialzati: le loro zone salgono all'altezza del supporto (dall'alto non serve,
      // le posizioni in field-3d.css sono misurate così).
      grid.style.transformStyle = "preserve-3d";
      // isolation: isolate (in duel.css) appiattirebbe il 3D: le zone non salirebbero sopra supporti e pile.
      grid.style.isolation = "auto";
      grid.style.setProperty("--pile-lift", `${((this.field?.pileHeight ?? PILE_HEIGHT) * ppu) / zoom}px`);
      this.pilePx = ppu / zoom;
      this.placePiles();
    }
    this.camera.lookAt(target);
    this.camera.far = height + 500;
    this.camera.updateProjectionMatrix();
    this.placeLogButton();
    this.placePets();
  }

  // ---------------------------------------------------------------- Moai

  /**
   * I due Moai: `mine` e `theirs` sono i loro aspetti (src/data/moai.js). Cliccando il mio spara e chiama onFire
   * (online lo si manda all'avversario, che lo vede con firePet(1)).
   */
  setPets({ mine, theirs, onFire }) {
    if (!this.petRenderer) {
      this.petCanvas = document.createElement("canvas");
      this.petCanvas.className = "field3d-pets";
      this.host.append(this.petCanvas);
      this.petRenderer = new THREE.WebGLRenderer({ canvas: this.petCanvas, alpha: true, antialias: true });
      this.petRenderer.outputColorSpace = THREE.SRGBColorSpace;
      this.petRenderer.setClearColor(0x000000, 0);
      this.sizePets();
    }
    const list = [new Moai(mine), new Moai(theirs)];
    for (const m of list) this.petScene.add(m.group, m.beam.mesh);
    this.pets = { list, onFire, last: 0, visible: false };

    this.placePets();
  }

  /** La tela dei Moai è grande come quella del campo, con la stessa risoluzione. */
  sizePets() {
    if (!this.petRenderer) return;
    this.petRenderer.setPixelRatio(this.renderer.getPixelRatio());
    this.petRenderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight, false);
  }

  /** Fa sparare il Moai del lato `side` (0 = mio, 1 = dell'avversario). */
  firePet(side) {
    this.pets?.list[side].fire();
  }

  placePets() {
    const p = this.pets;
    if (!p || !this.anchors) return;
    const t = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const halfW = (this.camera.position.y - PET_Y) * t * this.camera.aspect;
    const cx = this.camera.position.x;
    // Spazio dal centro del campo al bordo più vicino della vista (lo schermo ha la sinistra a +x).
    const room = Math.min(cx + halfW, halfW - cx);
    // Con poco spazio ai lati (finestra stretta) i Moai si rimpiccioliscono e si stringono verso il bordo; spariscono
    // solo se non c'è proprio posto.
    const fit = Math.min(1, room / PET_ROOM);
    p.visible = fit >= PET_MIN_FIT;
    const [me, opp] = p.list;
    for (const m of p.list) m.group.visible = p.visible;
    if (!p.visible) return;
    // Sempre allo stesso punto rispetto al tabellone (a tutto schermo non scivola verso il bordo); più vicino al centro
    // solo se la vista non arriva fin lì.
    const x = Math.min(PET_X, room - 7.1 * fit);
    me.group.position.set(x, PET_Y, PET_Z[0]);
    opp.group.position.set(-x, PET_Y, PET_Z[1]);
    for (const m of p.list) {
      m.group.scale.setScalar(PET_SCALE * fit);
      m.setTarget(new THREE.Vector3(0, 0, 0));
    }
    opp.body.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI).multiply(me.body.quaternion);
    // Il campo di Helios ha i basamenti dei Moai: seguono i Moai.
    this.field?.placePets?.([
      [x, PET_Z[0], fit],
      [-x, PET_Z[1], fit],
    ]);
  }

  /** Il mio Moai è sotto il puntatore? */
  overPet(clientX, clientY) {
    const p = this.pets;
    return !!p?.visible && p.list[0].hit(this.rayAt(clientX, clientY));
  }

  // ---------------------------------------------------------------- pulsante Log/Chat nel campo

  /**
   * Pulsante di Log e Chat dentro il campo: un esagono piccolo sul bordo sinistro, in alto, che si accende
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

  /**
   * In alto a sinistra della vista, sopra il dettaglio della carta (che sta a metà altezza), sollevato sopra le
   * decorazioni del campo. Con il campo inclinato il pulsante gira insieme alla telecamera: resta dritto verso lo
   * schermo, nello stesso punto della vista dall'alto.
   */
  placeLogButton() {
    const b = this.logButton;
    const base = this.camBase;
    if (!b || !this.anchors || !base) return;
    const y = 20;
    const t = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const halfH = (base.height - y) * t;
    const halfW = halfH * this.camera.aspect;
    const x = base.x + halfW - 4.5; // lo schermo ha la sinistra a +x
    const z = base.z + halfH - 4; // e l'alto a +z
    // Serve spazio a sinistra del tabellone (la Zona Banditi dell'avversario è a x ≈ 25.6).
    const visible = x > 33;
    b.group.position.set(x, y, z);
    b.group.rotation.set(0, 0, 0);
    if (this.tilt) {
      const k = -THREE.MathUtils.degToRad(this.tilt);
      b.group.position.applyAxisAngle(new THREE.Vector3(1, 0, 0), k);
      b.group.rotation.x = k;
    }
    b.group.visible = visible;
    if (visible !== b.visible) {
      b.visible = visible;
      b.onVisible?.(visible);
    }
  }

  /**
   * Spessore di Deck ed Extra Deck con il campo inclinato: una pila di carte sul supporto, alta in proporzione al
   * numero di carte; la carta in cima (nella griglia delle zone) sale sopra la pila.
   * @param counts { deck: [mio, avversario], extra: [mio, avversario] } (lati dello schermo: 0 in basso)
   */
  setPiles(counts) {
    if (!this.tilt) return;
    this.pileCounts = counts;
    if (!this.piles) {
      const edge = document.createElement("canvas");
      edge.width = 8;
      edge.height = 64;
      const x = edge.getContext("2d");
      for (let i = 0; i < 64; i++) {
        x.fillStyle = i % 2 ? "#3b3324" : "#c9b98f";
        x.fillRect(0, i, 8, 1);
      }
      const tex = new THREE.CanvasTexture(edge);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapT = THREE.RepeatWrapping;
      this.pileEdgeTex = tex;
      const side = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
      const top = new THREE.MeshStandardMaterial({ color: 0x2a1a0e, roughness: 0.7 });
      const geo = new THREE.BoxGeometry(6.9, 1, 10.1);
      this.piles = {};
      for (const [kind, corners] of Object.entries(PILE_CORNERS)) {
        this.piles[kind] = corners.map(([sx, sz]) => {
          const m = new THREE.Mesh(geo, [side, side, top, top, side, side]);
          m.position.set(sx * PILE_AT[0], 0, sz * PILE_AT[1]);
          m.rotation.y = sx * sz * PILE_AT[2];
          m.visible = false;
          this.scene.add(m);
          return m;
        });
      }
    }
    this.placePiles();
  }

  placePiles() {
    if (!this.piles || !this.pileCounts) return;
    const base = this.field?.pileHeight ?? PILE_HEIGHT;
    const grid = this.anchors?.center.parentElement;
    for (const [kind, meshes] of Object.entries(this.piles)) {
      meshes.forEach((m, side) => {
        const n = this.pileCounts[kind]?.[side] ?? 0;
        // Fino a una carta la pila non si vede: c'è solo la carta in cima.
        const hgt = Math.max(0, n - 1) * CARD_THICK;
        m.visible = hgt > 0;
        m.scale.y = Math.max(hgt, 0.001);
        m.position.y = base + hgt / 2;
        const zone = grid?.querySelector(`.zone.${kind}.side-${side}`);
        zone?.style.setProperty("--stack-lift", `${hgt * (this.pilePx ?? 0)}px`);
      });
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

  /** Clic sul pavimento (fuori da zone e carte): il mio Moai spara, o la creatura del campo fa la sua animazione. */
  tap(clientX, clientY) {
    if (this.overLogButton(clientX, clientY)) {
      this.logButton.onClick?.();
      return true;
    }
    if (this.overPet(clientX, clientY)) {
      const p = this.pets;
      if (performance.now() - p.last >= PET_COOLDOWN) {
        p.last = performance.now();
        p.list[0].fire();
        p.onFire?.();
      }
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
    for (const m of this.pets?.list ?? []) m.update(dt);
    if (this.fx) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.petRenderer?.render(this.petScene, this.camera);
  }

  dispose() {
    this.alive = false;
    // La griglia delle zone torna dritta (per esempio se il campo 3D non si carica e resta quello 2D).
    const grid = this.anchors?.center.parentElement;
    if (grid) {
      grid.style.transform = grid.style.transformOrigin = grid.style.transformStyle = grid.style.isolation = "";
      grid.parentElement.style.perspective = grid.parentElement.style.perspectiveOrigin = "";
      grid.style.removeProperty("--pile-lift");
      grid.querySelectorAll(".zone.deck, .zone.extra").forEach((z) => z.style.removeProperty("--stack-lift"));
    }
    this.timers.forEach(clearTimeout);
    this.resize.disconnect();
    window.removeEventListener("resize", this.onResize);
    this.field?.dispose();
    this.field = null;
    for (const m of this.pets?.list ?? []) m.dispose();
    this.pets = null;
    this.composer.dispose?.();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.petRenderer?.dispose();
    this.petRenderer?.forceContextLoss();
    this.petCanvas?.remove();
  }
}
