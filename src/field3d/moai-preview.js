// Anteprima del proprio Moai nelle impostazioni: com'è sul campo (stesso punto, stessa posa, stessa telecamera dall'alto
// sopra il centro del campo), inquadrato da vicino con setViewOffset. Cliccato spara.
// In modalità pittura la telecamera va davanti alla faccia: trascinando sulla testa si dipinge (onPaint riceve il punto
// della texture, in 0..1 con l'alto in alto), trascinando attorno la si gira, con la rotellina si fa zoom.
import * as THREE from "three";
import { Moai, PET } from "./moai.js";

// Altezza della telecamera del campo (circa quella di una finestra da laptop) e quanto l'anteprima ingrandisce.
const FIELD_HEIGHT = 100;
const CROP = 2.2;

export class MoaiPreview {
  constructor(host, cfg) {
    this.host = host;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "moai-preview-canvas";
    host.append(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0f17);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-20, 60, -30);
    this.scene.add(sun);
    // Pavimento di pietra scura, per vedere il colpo come sul campo.
    const floor = (this.floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 1 })));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 400);
    this.camera.up.set(0, 0, 1); // come sul campo: in alto +z, a sinistra +x
    this.camera.position.set(0, FIELD_HEIGHT, 0);
    this.camera.lookAt(0, 0, 0);
    this.moai = new Moai(cfg);
    this.moai.group.position.set(PET.x, PET.y, PET.z[0]);
    this.moai.group.scale.setScalar(PET.scale);
    this.moai.setTarget(new THREE.Vector3(0, 0, 0));
    this.scene.add(this.moai.group, this.moai.beam.mesh);
    this.canvas.addEventListener("click", () => !this.painting && this.moai.fire());
    this.painting = false;
    this.orbit = { yaw: 0, pitch: 0 };
    this.distance = 21; // distanza dalla faccia in modalità pittura (zoom)
    this.view = { pos: this.camera.position.clone(), up: new THREE.Vector3(0, 0, 1), look: new THREE.Vector3() };
    this.look = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    this.onPaint = null; // (u, v, newStroke) oppure (null) quando il pennello esce dalla testa
    this.onPaintEnd = null;
    this.onWheel = null; // (deltaY, ctrlKey) => true se la rotellina l'ha usata qualcun altro (niente zoom)
    this.bindPaint();
    this.aimCamera();
    this.camera.position.copy(this.view.pos);
    this.look.copy(this.view.look);
    this.camera.lookAt(this.look);
    this.clock = new THREE.Clock();
    this.alive = true;
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  setConfig(cfg) {
    this.moai.setConfig(cfg);
  }

  fire() {
    this.moai.fire();
  }

  /** Mostra subito un disegno ancora da salvare (la tela della faccia). */
  showDrawing(canvas) {
    this.moai.paint(canvas);
  }

  setPaintMode(on) {
    this.painting = on;
    this.orbit = { yaw: 0, pitch: 0 };
    this.distance = 21;
    this.canvas.style.cursor = on ? "grab" : "";
    this.floor.visible = !on; // girando attorno alla testa la telecamera può scendere sotto il pavimento
    this.aimCamera();
  }

  /** Dove deve andare la telecamera: dall'alto come sul campo, o davanti alla faccia (girata di `orbit`). */
  aimCamera() {
    const head = this.moai.head;
    head.updateWorldMatrix(true, false);
    const center = new THREE.Box3().setFromObject(head).getCenter(new THREE.Vector3());
    if (!this.painting) {
      // Come sul campo: dall'alto sopra il centro del campo (il Moai si vede di sbieco); frame() lo inquadra al centro.
      this.headCenter = center;
      this.view.pos.set(0, FIELD_HEIGHT, 0);
      this.view.up.set(0, 0, 1);
      this.view.look.set(0, 0, 0);
      return;
    }
    const up = new THREE.Vector3(0, 1, 0).transformDirection(head.matrixWorld);
    const face = new THREE.Vector3(0, 0, 1).transformDirection(head.matrixWorld);
    const right = new THREE.Vector3().crossVectors(up, face).normalize();
    face.applyAxisAngle(up, this.orbit.yaw).applyAxisAngle(right, -this.orbit.pitch);
    this.view.pos.copy(center).addScaledVector(face, this.distance);
    this.view.up.copy(up);
    this.view.look.copy(center);
  }

  /** Zoom sulla testa in modalità pittura: k < 1 avvicina, k > 1 allontana. */
  zoom(k) {
    if (!this.painting) return;
    this.distance = THREE.MathUtils.clamp(this.distance * k, 7, 32);
    this.aimCamera();
  }

  hitHead(e) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObject(this.moai.head, false)[0]?.uv ?? null;
  }

  bindPaint() {
    let mode = null; // "paint" | "turn"
    let from = null;
    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.painting || e.button !== 0) return;
      this.canvas.setPointerCapture(e.pointerId);
      const uv = this.hitHead(e);
      mode = uv ? "paint" : "turn";
      from = [e.clientX, e.clientY];
      if (uv) this.onPaint?.(uv.x, uv.y, true);
      else this.canvas.style.cursor = "grabbing";
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.painting) return;
      if (mode === "paint") {
        const uv = this.hitHead(e);
        this.onPaint?.(uv?.x ?? null, uv?.y ?? null, false);
      } else if (mode === "turn") {
        const clamp = THREE.MathUtils.clamp;
        this.orbit.yaw = clamp(this.orbit.yaw - (e.clientX - from[0]) * 0.01, -1.3, 1.3);
        this.orbit.pitch = clamp(this.orbit.pitch + (e.clientY - from[1]) * 0.01, -0.9, 0.9);
        from = [e.clientX, e.clientY];
        this.aimCamera();
      } else {
        this.canvas.style.cursor = this.hitHead(e) ? "crosshair" : "grab";
      }
    });
    const end = () => {
      if (mode === "paint") this.onPaintEnd?.();
      mode = null;
      if (this.painting) this.canvas.style.cursor = "grab";
    };
    // Rotellina (e pinch sul trackpad, che arriva come rotellina con ctrl) per avvicinarsi alla testa.
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.painting) return;
        e.preventDefault();
        if (this.onWheel?.(e.deltaY, e.ctrlKey)) return;
        this.zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      },
      { passive: false }
    );
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
  }

  frame() {
    if (!this.alive) return;
    // Impostazioni chiuse (la tela non è più nel documento): si libera il contesto WebGL.
    if (this.canvas.isConnected) this.mounted = true;
    else if (this.mounted) return this.dispose();
    requestAnimationFrame(this.frame);
    const w = this.canvas.clientWidth;
    const hgt = this.canvas.clientHeight;
    if (!w || !hgt) return;
    if (this.size !== `${w}x${hgt}`) {
      this.size = `${w}x${hgt}`;
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer.setSize(w, hgt, false);
      this.camera.aspect = w / hgt;
      this.camera.updateProjectionMatrix();
    }
    const dt = Math.min(this.clock.getDelta(), 1 / 15);
    // La telecamera scivola verso la vista scelta.
    const k = 1 - Math.exp(-dt * 10);
    this.camera.position.lerp(this.view.pos, k);
    this.camera.up.lerp(this.view.up, k).normalize();
    this.look.lerp(this.view.look, k);
    this.camera.lookAt(this.look);
    this.camera.updateMatrixWorld();
    // Fuori dalla pittura: si ritaglia dalla vista del campo un riquadro attorno al Moai (prospettiva identica al campo).
    this.camera.clearViewOffset();
    if (!this.painting && this.headCenter) {
      const c = this.headCenter.clone().project(this.camera);
      const fw = w * CROP;
      const fh = hgt * CROP;
      this.camera.setViewOffset(fw, fh, ((c.x + 1) / 2) * fw - w / 2, ((1 - c.y) / 2) * fh - hgt / 2, w, hgt);
    }
    this.moai.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.alive = false;
    this.moai.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
