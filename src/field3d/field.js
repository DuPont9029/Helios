// Caricamento di un campo (lati near + far): GLB + JSON generati da tools/convert.py
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AnimatorPlayer, prepareClips, sampleTrack } from './animator.js';
import { buildMaterial, applyMaterialProp, updateScroll, needsUpdate } from './materials.js';
import { ParticleSystem, particleMaterial } from './particles.js';

const loader = new GLTFLoader();

// Etichette evento (BgEffectSetting.animationLabel) -> stato dell'animator principale
export const EVENT_LABELS = {
  11: { name: 'Colpo', state: /^DamagePhaseAll$/ },
  12: { name: 'Fase 2', state: /Phase1ToPhase2/ },
  13: { name: 'Fase 3', state: /Phase2ToPhase3/ },
  14: { name: 'Fase 4', state: /Phase3ToPhase4/ },
  15: { name: 'Distruzione', state: /Phase4ToEnd/ },
  24: { name: 'Tocca creatura', state: null },
};

const HIDE_NAMES = /^(GetLightDummy|Lightdummy|LightDummy)/;

class Side {
  constructor(field, name, gltf, meta) {
    this.field = field;
    this.name = name;
    this.gltf = gltf;
    this.meta = meta;
    this.root = gltf.scene;
    this.root.name = name;
    this.nodes = [];
    this.particles = [];
    this.animators = [];
    this.materials = [];
    this.scrollMats = new Set();
    this.timers = [];
    this._tmp = new Float32Array(4);
  }

  async init() {
    const parser = this.gltf.parser;
    // indice nodo glTF -> Object3D
    for (const [obj, a] of parser.associations) {
      if (a && a.nodes !== undefined && obj.isObject3D) this.nodes[a.nodes] = obj;
    }
    // stato iniziale (GameObject attivi / renderer abilitati)
    this.root.traverse((o) => {
      const u = o.userData || {};
      if (u.off) o.visible = false;
      if (u.roff) o.visible = false;
      if (HIDE_NAMES.test(o.name)) o.visible = false;
    });
    // renderer per nodo
    this.renderOf = new Map();
    this.root.traverse((o) => {
      if (o.userData && o.userData.rn !== undefined) this.renderOf.set(o, this.nodes[o.userData.rn]);
    });
    // nodi con materiali animati: materiali unici per quel renderer
    const animMatNodes = new Set();
    for (const c of this.meta.clips) for (const t of c.tracks) if (t.k === 'm') animMatNodes.add(t.n);
    // materiali
    const cache = new Map();
    const conv = (m, mesh, unique) => {
      const vc = !!mesh.geometry.getAttribute('_color_0') && /vc|vertex|Particle|Ygom/i.test((m.userData && m.userData.shader) || '');
      const key = m.uuid + (vc ? ':vc' : '') + (mesh.isSkinnedMesh ? ':sk' : '');
      if (!unique && cache.has(key)) return cache.get(key);
      const nm = buildMaterial(m, { vertexColors: vc, skinned: !!mesh.isSkinnedMesh });
      if (!unique) cache.set(key, nm);
      this.materials.push(nm);
      if (needsUpdate(nm)) this.scrollMats.add(nm);
      return nm;
    };
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      if (o.geometry.getAttribute('_color_0') && !o.geometry.getAttribute('color')) {
        o.geometry.setAttribute('color', o.geometry.getAttribute('_color_0'));
      }
      let owner = o;
      while (owner && !(owner.userData && owner.userData.i !== undefined && this.renderOf.get(owner) !== undefined)) owner = owner.parent;
      const unique = owner && animMatNodes.has(owner.userData.i);
      o.material = Array.isArray(o.material) ? o.material.map((m) => conv(m, o, unique)) : conv(o.material, o, unique);
      const q = o.material.userData && o.material.userData.queue;
      if (o.material.transparent) o.renderOrder = q > 0 ? q - 2000 : 1000;
      o.frustumCulled = !o.isSkinnedMesh;
    });
    // animazioni
    prepareClips(this.meta);
    this.propHash = this.meta.propHash || {};
    const driven = new Set();
    for (const e of this.meta.effects || []) if (e.anim !== null && e.anim !== undefined && !e.root) driven.add(e.anim);
    for (const a of this.meta.animators) {
      const p = new AnimatorPlayer(this, a, this.meta.clips);
      p.driven = driven.has(a.n);
      if (p.driven) p.paused = true;
      if (!a.enabled) p.paused = true;
      this.animators.push(p);
    }
    // particelle
    for (const P of this.meta.particles) {
      const node = this.nodes[P.n];
      if (!node) continue;
      let src = null, geom = null;
      if (P.r.mat !== null && P.r.mat !== undefined) src = await parser.getDependency('material', P.r.mat);
      if (P.r.mode === 4) {
        if (P.r.mesh === null || P.r.mesh === undefined) continue;
        const m = await parser.getDependency('mesh', P.r.mesh);
        m.traverse((x) => { if (x.isMesh && !geom) geom = x.geometry; });
        if (!geom) continue;
      }
      const ps = new ParticleSystem(P, node, particleMaterial(src, P), geom, this.field.fxRoot);
      this.particles.push(ps);
    }
    this.byNode = new Map();
    for (const ps of this.particles) {
      if (!this.byNode.has(ps.P.n)) this.byNode.set(ps.P.n, []);
      this.byNode.get(ps.P.n).push(ps);
    }
    // stato iniziale animator: valuta il frame 0
    for (const a of this.animators) a.update(0);
  }

  applyTrack(tr, f) {
    const o = this.nodes[tr.n];
    if (!o) return;
    const v = sampleTrack(tr, f, this._tmp);
    switch (tr.k) {
      case 'p': o.position.set(v[0], v[1], v[2]); break;
      case 'r': o.quaternion.set(v[0], v[1], v[2], v[3]); break;
      case 's': o.scale.set(v[0], v[1], v[2]); break;
      case 'a': o.visible = v[0] > 0.5; break;
      case 'e': {
        if (tr.typ === 199 || tr.typ === 198) {
          const ps = this.byNode.get(tr.n);
          if (ps) for (const p of ps) p.renderVisible = v[0] > 0.5;
        } else {
          const r = this.renderOf.get(o);
          if (r) r.visible = v[0] > 0.5;
        }
        break;
      }
      case 'm': {
        const name = this.propHash[tr.h];
        if (!name) break;
        if (tr.typ === 199) {
          const ps = this.byNode.get(tr.n);
          if (ps) for (const p of ps) {
            const u = p.mesh.material.uniforms;
            if (/alpha|opacity/i.test(name) && tr.comp === 8) u.tint.value.w = Math.min(1, v[0]);
            else if (/color/i.test(name) && tr.comp === 7) u.tint.value.w = Math.min(1, v[0] * (name === '_TintColor' ? 2 : 1));
          }
          break;
        }
        const r = this.renderOf.get(o);
        if (r) r.traverse((x) => { if (x.isMesh) applyMaterialProp(x.material, name, tr.comp, v[0]); });
        break;
      }
    }
  }

  update(dt, time, opts) {
    for (const a of this.animators) {
      if (opts.animations || a.driven) a.update(a.paused ? 0 : dt);
    }
    for (const m of this.scrollMats) updateScroll(m, time);
    for (const ps of this.particles) ps.update(dt, opts.particles);
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const t = this.timers[i];
      t.left -= dt;
      if (t.left <= 0) { t.fn(); this.timers.splice(i, 1); }
    }
  }

  // Riproduce un evento di gioco (etichetta numerica)
  trigger(label) {
    const def = EVENT_LABELS[label];
    if (def && def.state) {
      for (const a of this.animators) {
        if (a.driven) continue;
        const s = a.findState(def.state);
        if (s) a.play(s.layer, s.index);
      }
    }
    for (const e of this.meta.effects || []) {
      if (e.animLabel !== label || e.root) continue;
      if (e.anim !== null && e.anim !== undefined) {
        const a = this.animators.find((x) => x.node === e.anim);
        if (a) { a.reset(); a.play(0, a.layers[0].L.default); }
      }
      if (e.node !== null && e.node !== undefined && e.anim === null) {
        const n = this.nodes[e.node];
        if (!n) continue;
        n.visible = true;
        // riavvia le particelle sotto il nodo
        n.traverse((x) => {
          const idx = x.userData && x.userData.i;
          const list = idx !== undefined && this.byNode.get(idx);
          if (list) for (const p of list) { p.wasActive = false; }
        });
        if (e.active > 0) this.timers.push({ left: e.active + 2, fn: () => { n.visible = !(n.userData && n.userData.off); } });
      }
    }
  }

  resetPhases() {
    for (const a of this.animators) if (!a.driven) a.reset();
    for (const a of this.animators) a.update(0);
  }

  labels() {
    const s = new Set();
    for (const e of this.meta.effects || []) if (!e.root && e.animLabel) s.add(e.animLabel);
    for (const a of this.animators) {
      if (a.driven) continue;
      for (const [k, d] of Object.entries(EVENT_LABELS)) if (d.state && a.findState(d.state)) s.add(+k);
    }
    return s;
  }

  tapBoxes() {
    return (this.meta.effects || []).filter((e) => e.tap).map((e) => ({ side: this, label: e.animLabel, ...e.tap }));
  }

  dispose() {
    for (const p of this.particles) p.dispose();
    this.root.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    for (const m of this.materials) { if (m.map) m.map.dispose(); m.dispose(); }
    this.root.removeFromParent();
  }
}

export class Field {
  constructor(id) {
    this.id = id;
    this.group = new THREE.Group();
    this.group.name = id;
    this.fxRoot = new THREE.Group();
    this.fxRoot.name = 'particles';
    this.group.add(this.fxRoot);
    this.sides = [];
    this.time = 0;
  }

  // base: indirizzo della cartella dei campi, oppure una funzione (percorso) -> Promise<URL> (campi da uno zip)
  static async load(base, id, sides, onProgress) {
    const f = new Field(id);
    let done = 0;
    const url = typeof base === 'function' ? base : async (path) => `${base}/${path}`;
    await Promise.all(sides.map(async (s) => {
      const [gltf, meta] = await Promise.all([
        url(`${id}/${s}.glb`).then((u) => loader.loadAsync(u)),
        url(`${id}/${s}.json`).then((u) => fetch(u)).then((r) => r.json()),
      ]);
      const side = new Side(f, s, gltf, meta);
      await side.init();
      f.sides.push(side);
      f.group.add(side.root);
      onProgress && onProgress(++done / sides.length);
    }));
    f.sides.sort((a, b) => (a.name === 'near' ? -1 : 1));
    return f;
  }

  update(dt, opts) {
    this.time += dt;
    for (const s of this.sides) s.update(dt, this.time, opts);
  }

  trigger(label, sideName) {
    for (const s of this.sides) if (!sideName || s.name === sideName) s.trigger(label);
  }

  resetPhases() { for (const s of this.sides) s.resetPhases(); }

  labels() {
    const s = new Set();
    for (const x of this.sides) for (const l of x.labels()) s.add(l);
    return [...s].sort((a, b) => a - b);
  }

  tapBoxes() { return this.sides.flatMap((s) => s.tapBoxes()); }

  setSideVisible(name, v) {
    for (const s of this.sides) if (s.name === name) {
      s.root.visible = v;
      for (const p of s.particles) p.mesh.visible = v && p.mesh.visible;
      s.hidden = !v;
    }
  }

  dispose() {
    for (const s of this.sides) s.dispose();
    this.group.removeFromParent();
  }
}
