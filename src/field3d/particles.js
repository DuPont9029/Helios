// Simulatore semplificato dei ParticleSystem di Unity (Shuriken) per three.js.
// Moduli supportati: Initial, Emission (rate + burst), Shape, Color/Size/Rotation/Velocity over lifetime,
// Force, Limit Velocity, Noise (approssimato), Texture Sheet Animation. Render: billboard, stretched,
// horizontal, vertical, mesh.
import * as THREE from 'three';
import { evalMinMax, evalMinMaxGrad, srgbToLinear, decodeF32 } from './curves.js';
import { blendInfo, colorFromUnity, applyBlend } from './materials.js';

const MAX_CAP = 1500;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _m = new THREE.Matrix4(), _e = new THREE.Euler();
const _col = [0, 0, 0, 0], _col2 = [0, 0, 0, 0];

const VERT = /* glsl */`
attribute vec3 iPos; attribute vec3 iSize; attribute vec3 iRot; attribute vec4 iCol; attribute float iFrame; attribute vec3 iVel;
uniform vec2 tiles; uniform float lenScale; uniform float velScale;
varying vec2 vUv; varying vec4 vCol;
mat3 rotXYZ(vec3 r){
  float cx=cos(r.x), sx=sin(r.x), cy=cos(r.y), sy=sin(r.y), cz=cos(r.z), sz=sin(r.z);
  mat3 X=mat3(1.,0.,0., 0.,cx,sx, 0.,-sx,cx);
  mat3 Y=mat3(cy,0.,-sy, 0.,1.,0., sy,0.,cy);
  mat3 Z=mat3(cz,sz,0., -sz,cz,0., 0.,0.,1.);
  return Y*X*Z;
}
void main(){
  float fr = floor(iFrame + 0.001);
  float col = mod(fr, tiles.x), row = floor(fr / tiles.x);
  vUv = vec2((col + uv.x) / tiles.x, (row + uv.y) / tiles.y);
  vCol = iCol;
#if defined(MODE_MESH)
  vec3 wp = iPos + rotXYZ(iRot) * (position * iSize);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
#elif defined(MODE_HORIZONTAL)
  float c = cos(iRot.z), s = sin(iRot.z);
  vec2 p = position.xy * iSize.xy; p = vec2(c*p.x - s*p.y, s*p.x + c*p.y);
  vec3 wp = iPos + vec3(p.x, 0.0, p.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
#elif defined(MODE_VERTICAL)
  vec3 toCam = cameraPosition - iPos; toCam.y = 0.0;
  vec3 fwd = normalize(toCam + vec3(1e-5, 0.0, 0.0));
  vec3 right = normalize(cross(vec3(0.0,1.0,0.0), fwd));
  float c = cos(iRot.z), s = sin(iRot.z);
  vec2 p = position.xy * iSize.xy; p = vec2(c*p.x - s*p.y, s*p.x + c*p.y);
  vec3 wp = iPos + right * p.x + vec3(0.0, p.y, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
#elif defined(MODE_STRETCH)
  float sp = length(iVel);
  vec3 axis = sp > 1e-5 ? iVel / sp : vec3(0.0, 1.0, 0.0);
  vec3 toCam = normalize(cameraPosition - iPos);
  vec3 side = normalize(cross(axis, toCam) + vec3(1e-6));
  float L = iSize.y * lenScale + sp * velScale;
  vec3 wp = iPos + side * position.x * iSize.x - axis * (0.5 - position.y) * L;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
#else
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  float c = cos(iRot.z), s = sin(iRot.z);
  vec2 p = position.xy * iSize.xy; p = vec2(c*p.x - s*p.y, s*p.x + c*p.y);
  mv.xy += p;
  gl_Position = projectionMatrix * mv;
#endif
}`;

const FRAG = /* glsl */`
uniform sampler2D map; uniform float hasMap; uniform vec4 tint; uniform float alphaTest; uniform float additive; uniform float lumAlpha;
varying vec2 vUv; varying vec4 vCol;
void main(){
  vec4 t = hasMap > 0.5 ? texture2D(map, vUv) : vec4(1.0);
  vec4 c = t * vCol * tint;
  if (lumAlpha > 0.5) c = vec4(vCol.rgb * tint.rgb, t.r * vCol.a * tint.a);
  if (c.a <= alphaTest) discard;
  c.rgb = min(c.rgb, vec3(2.0)); // limite HDR: evita che il bloom saturi lo schermo
  gl_FragColor = c;
  #include <colorspace_fragment>
}`;

function quadGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

function meshGeometry(src) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', src.getAttribute('position'));
  if (src.getAttribute('uv')) g.setAttribute('uv', src.getAttribute('uv'));
  else g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(src.getAttribute('position').count * 2), 2));
  if (src.index) g.setIndex(src.index);
  return g;
}

export function particleMaterial(srcMat, P) {
  const ex = (srcMat && srcMat.userData) || {};
  const f = ex.f || {}, c = ex.c || {};
  const b = blendInfo(ex);
  let { additive, multiply } = b;
  if (!ex.st && !('_DstBlend' in f) && /add/i.test(ex.shader || '')) additive = true;
  let tint = [1, 1, 1, 1];
  if (c._BaseColor) tint = c._BaseColor.slice();
  else if (c._TintColor) tint = c._TintColor.map((x) => x * 2);
  else if (c._Color) tint = c._Color.slice();
  else if (c._Color01) tint = c._Color01.slice();
  const tc = colorFromUnity(tint);
  const uv = P.uv;
  const mode = P.r.mode;
  const defines = {};
  if (mode === 4) defines.MODE_MESH = 1;
  else if (mode === 2) defines.MODE_HORIZONTAL = 1;
  else if (mode === 3) defines.MODE_VERTICAL = 1;
  else if (mode === 1) defines.MODE_STRETCH = 1;
  const m = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, defines,
    uniforms: {
      map: { value: srcMat ? srcMat.map : null }, hasMap: { value: srcMat && srcMat.map ? 1 : 0 },
      tint: { value: new THREE.Vector4(tc.r, tc.g, tc.b, Math.min(1, tint[3])) },
      tiles: { value: new THREE.Vector2(uv ? uv.tx : 1, uv ? uv.ty : 1) },
      alphaTest: { value: f._AlphaClip === 1 ? (f._Cutoff ?? 0.5) : 0.001 },
      additive: { value: additive ? 1 : 0 },
      lumAlpha: { value: lumAlphaOf(ex, additive) },
      lenScale: { value: P.r.len || 1 }, velScale: { value: P.r.vel || 0 },
    },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: additive ? THREE.AdditiveBlending : (multiply ? THREE.MultiplyBlending : THREE.NormalBlending),
    premultipliedAlpha: multiply,
  });
  if (b.src !== undefined && !b.opaque) { applyBlend(m, { ...b, transparent: true, depthWrite: false, cull: 0 }); }
  if (m.uniforms.map.value) {
    const t = m.uniforms.map.value;
    if (uv && (uv.tx > 1 || uv.ty > 1)) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; }
  }
  return m;
}

function lumAlphaOf(ex, additive) {
  const t = ex.main && ex.tex && ex.tex[ex.main];
  if (!t || t.a || additive) return 0;
  return /^Shader Graphs|^VFX_Shader/.test(ex.shader || '') ? 1 : 0;
}

function randUnit(out) {
  const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(a), r * Math.sin(a), z);
}

// rotazione con euler Unity (gradi, ordine Z, X, Y) nello spazio Unity
function unityEulerQuat(e, out) {
  _e.set(e[0] * Math.PI / 180, e[1] * Math.PI / 180, e[2] * Math.PI / 180, 'YXZ');
  return out.setFromEuler(_e);
}

export class ParticleSystem {
  constructor(P, node, material, meshGeom, root) {
    this.P = P;
    this.node = node;
    this.root = root;
    this.cap = Math.min(MAX_CAP, Math.max(1, P.init.max | 0));
    const g = meshGeom ? meshGeometry(meshGeom) : quadGeometry();
    const N = this.cap;
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this.aFrame = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    for (const a of [this.aPos, this.aSize, this.aRot, this.aCol, this.aFrame, this.aVel]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iSize', this.aSize); g.setAttribute('iRot', this.aRot);
    g.setAttribute('iCol', this.aCol); g.setAttribute('iFrame', this.aFrame); g.setAttribute('iVel', this.aVel);
    g.instanceCount = 0;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3000 + (P.r.order || 0);
    this.mesh.name = 'ps:' + node.name;
    root.add(this.mesh);
    // stato particelle
    this.pos = new Float32Array(N * 3); this.vel = new Float32Array(N * 3);
    this.age = new Float32Array(N); this.life = new Float32Array(N);
    this.size0 = new Float32Array(N * 3); this.rot = new Float32Array(N * 3); this.rotV = new Float32Array(N * 3);
    this.col0 = new Float32Array(N * 4); this.rnd = new Float32Array(N * 4); this.frame0 = new Float32Array(N);
    this.n = 0;
    this.world = P.space === 1;
    this.shapePts = P.shape && P.shape.pts ? decodeF32(P.shape.pts) : null;
    this.wasActive = false;
    this.enabled = P.r.enabled !== false && P.r.mode !== 5;
    this.renderVisible = true;
    this.stop();
  }

  stop() {
    this.playing = false;
    this.n = 0;
    this.t = 0;
  }

  play() {
    const P = this.P;
    this.playing = true;
    this.n = 0;
    this.t = -evalMinMax(P.delay, 0, Math.random());
    this.emitAcc = 0;
    this.burstDone = (P.emit ? P.emit.bursts : []).map(() => 0);
    this.loopIdx = 0;
    if (P.prewarm && P.loop) {
      for (let i = 0; i < Math.min(P.dur, 10) * 20; i++) this.simulate(1 / 20);
    }
  }

  isActiveInHierarchy() {
    let o = this.node;
    while (o) {
      if (!o.visible) return false;
      if (o === this.root) break;
      o = o.parent;
    }
    return true;
  }

  update(dt, enabled) {
    const active = enabled && this.isActiveInHierarchy();
    if (!active) {
      if (this.wasActive) this.stop();
      this.wasActive = false;
      this.mesh.visible = false;
      return;
    }
    if (!this.wasActive && this.P.awake) this.play();
    this.wasActive = true;
    this.simulate(dt * (this.P.speedMul || 1));
    this.mesh.visible = this.enabled && this.renderVisible && this.n > 0;
    if (this.mesh.visible) this.writeBuffers();
  }

  simulate(dt) {
    const P = this.P;
    if (dt <= 0) return;
    // emissione
    if (this.playing) {
      const prevT = this.t;
      this.t += dt;
      if (this.t >= 0 && P.emit) {
        const tn = Math.min(1, Math.max(0, this.t / P.dur));
        const rate = evalMinMax(P.emit.rate, tn, Math.random());
        this.emitAcc += rate * Math.min(dt, Math.max(0, this.t));
        let k = Math.floor(this.emitAcc);
        this.emitAcc -= k;
        while (k-- > 0) this.spawn(tn);
        P.emit.bursts.forEach((b, i) => {
          const cycles = b.cycles || 1;
          while (this.burstDone[i] < cycles) {
            const bt = b.t + this.burstDone[i] * (b.interval || 0.01);
            if (this.t >= bt && bt <= P.dur) {
              this.burstDone[i]++;
              if (Math.random() <= (b.p ?? 1)) {
                let cnt = Math.round(evalMinMax(b.n, tn, Math.random()));
                while (cnt-- > 0) this.spawn(tn);
              }
            } else break;
          }
        });
      }
      if (this.t >= P.dur) {
        if (P.loop) {
          this.t -= P.dur;
          this.burstDone = this.burstDone.map(() => 0);
        } else {
          this.playing = false;
        }
      }
      void prevT;
    }
    // integrazione
    this.integrate(dt);
  }

  gravityVec(out) {
    // gravità (Unity world -Y) nello spazio di simulazione
    out.set(0, -9.81, 0);
    if (!this.world) {
      this.node.getWorldQuaternion(_q);
      out.applyQuaternion(_q.invert());
      this.node.getWorldScale(_s);
      out.divide(_s);
    }
    return out;
  }

  spawn(tn) {
    if (this.n >= this.cap) return;
    const P = this.P, I = P.init, i = this.n++;
    const r0 = Math.random(), r1 = Math.random(), r2 = Math.random(), r3 = Math.random();
    this.rnd[i * 4] = r0; this.rnd[i * 4 + 1] = r1; this.rnd[i * 4 + 2] = r2; this.rnd[i * 4 + 3] = r3;
    this.age[i] = 0;
    this.life[i] = Math.max(0.01, evalMinMax(I.life, tn, Math.random()));
    const speed = evalMinMax(I.speed, tn, Math.random());
    // forma (spazio Unity locale)
    const p = _v.set(0, 0, 0), d = _v2.set(0, 0, 1);
    this.sampleShape(p, d);
    d.multiplyScalar(speed);
    // Unity -> glTF: X negato
    p.x = -p.x; d.x = -d.x;
    if (this.world) {
      this.node.updateWorldMatrix(true, false);
      p.applyMatrix4(this.node.matrixWorld);
      this.node.getWorldQuaternion(_q);
      d.applyQuaternion(_q);
    }
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = d.x; this.vel[i * 3 + 1] = d.y; this.vel[i * 3 + 2] = d.z;
    const rs = Math.random();
    const s = evalMinMax(I.size, tn, rs);
    if (I.size3D) {
      this.size0[i * 3] = s; this.size0[i * 3 + 1] = evalMinMax(I.sizeY, tn, rs); this.size0[i * 3 + 2] = evalMinMax(I.sizeZ, tn, rs);
    } else {
      this.size0[i * 3] = this.size0[i * 3 + 1] = this.size0[i * 3 + 2] = s;
    }
    const rr = Math.random();
    const flip = (I.randRotDir && Math.random() < I.randRotDir) ? -1 : 1;
    this.rot[i * 3 + 2] = -evalMinMax(I.rot, tn, rr) * flip;
    this.rot[i * 3] = I.rot3D ? evalMinMax(I.rotX, tn, rr) : 0;
    this.rot[i * 3 + 1] = I.rot3D ? -evalMinMax(I.rotY, tn, rr) : 0;
    evalMinMaxGrad(I.color, tn, Math.random(), _col);
    this.col0[i * 4] = _col[0]; this.col0[i * 4 + 1] = _col[1]; this.col0[i * 4 + 2] = _col[2]; this.col0[i * 4 + 3] = _col[3];
    const uv = P.uv;
    this.frame0[i] = uv ? evalMinMax(uv.start, tn, Math.random()) : 0;
    if (uv && uv.anim === 1) {
      const row = uv.rowMode === 1 || uv.rowMode === undefined ? Math.floor(Math.random() * uv.ty) : uv.row;
      this.frame0[i] += row * uv.tx;
    }
  }

  sampleShape(p, d) {
    const S = this.P.shape;
    if (!S) { randUnit(d); return; }
    const R = S.radius || 0, rt = S.rt ?? 1, arc = (S.arc ?? 360) * Math.PI / 180;
    const phi = Math.random() * arc;
    switch (S.type) {
      case 0: case 1: case 2: case 3: {
        randUnit(d);
        if (S.type >= 2) d.z = Math.abs(d.z);
        const rr = R * (1 - rt + rt * Math.cbrt(Math.random()));
        p.copy(d).multiplyScalar(rr);
        break;
      }
      case 4: case 7: case 8: case 9: {
        const k = (1 - rt + rt * Math.sqrt(Math.random()));
        const rr = R * k;
        const ta = Math.tan(Math.min(89.9, S.angle) * Math.PI / 180);
        p.set(Math.cos(phi) * rr, Math.sin(phi) * rr, 0);
        d.set(Math.cos(phi) * k * ta, Math.sin(phi) * k * ta, 1).normalize();
        if (S.type >= 8) {
          const l = Math.random() * (S.length || 0);
          p.x += d.x / d.z * l; p.y += d.y / d.z * l; p.z += l;
        }
        break;
      }
      case 5: case 15: case 16:
        p.set((Math.random() - 0.5) * S.scl[0], (Math.random() - 0.5) * S.scl[1], (Math.random() - 0.5) * S.scl[2]);
        d.set(0, 0, 1);
        break;
      case 10: case 11: {
        const rr = S.type === 11 ? R : R * (1 - rt + rt * Math.sqrt(Math.random()));
        p.set(Math.cos(phi) * rr, Math.sin(phi) * rr, 0);
        d.set(Math.cos(phi), Math.sin(phi), 0);
        break;
      }
      case 12:
        p.set((Math.random() * 2 - 1) * R, 0, 0);
        d.set(0, 1, 0);
        break;
      case 17: {
        const th = Math.random() * Math.PI * 2, dr = (S.donut || 0) * Math.sqrt(Math.random());
        const ring = R + dr * Math.cos(th);
        p.set(Math.cos(phi) * ring, Math.sin(phi) * ring, dr * Math.sin(th));
        d.set(Math.cos(phi), Math.sin(phi), 0);
        break;
      }
      case 18:
        p.set((Math.random() - 0.5), (Math.random() - 0.5), 0);
        d.set(0, 0, 1);
        break;
      case 6: case 13: case 14: {
        const pts = this.shapePts;
        if (pts && pts.length >= 3) {
          const k = Math.floor(Math.random() * (pts.length / 3)) * 3;
          p.set(-pts[k], pts[k + 1], pts[k + 2]);
        }
        randUnit(d);
        break;
      }
      default:
        randUnit(d);
    }
    if (S.type !== 5 && S.type !== 15 && S.type !== 16) p.multiply(_s.set(S.scl[0], S.scl[1], S.scl[2]));
    else if (S.type === 18) p.multiply(_s.set(S.scl[0], S.scl[1], 1));
    if (S.rot[0] || S.rot[1] || S.rot[2]) {
      unityEulerQuat(S.rot, _q);
      p.applyQuaternion(_q); d.applyQuaternion(_q);
    }
    p.x += S.pos[0]; p.y += S.pos[1]; p.z += S.pos[2];
    if (S.randDir) { const r = randUnit(new THREE.Vector3()); d.lerp(r, S.randDir).normalize(); }
    if (S.sphDir && p.lengthSq() > 0) { d.lerp(p.clone().normalize(), S.sphDir).normalize(); }
    if (S.randPos) { p.x += (Math.random() * 2 - 1) * S.randPos; p.y += (Math.random() * 2 - 1) * S.randPos; p.z += (Math.random() * 2 - 1) * S.randPos; }
  }

  integrate(dt) {
    const P = this.P;
    let gm = 0;
    const g = new THREE.Vector3();
    if (P.init.gravity && (P.init.gravity.s || P.init.gravity.ms)) {
      gm = 1;
      this.gravityVec(g);
    }
    const tn = Math.min(1, Math.max(0, this.t / P.dur));
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.kill(i);
        i--;
        continue;
      }
      const nt = this.age[i] / this.life[i];
      const r = this.rnd[i * 4];
      const o = i * 3;
      if (gm) {
        const gg = evalMinMax(P.init.gravity, tn, r);
        this.vel[o] += g.x * gg * dt; this.vel[o + 1] += g.y * gg * dt; this.vel[o + 2] += g.z * gg * dt;
      }
      if (P.fol) {
        this.vel[o] += -evalMinMax(P.fol.x, nt, r) * dt;
        this.vel[o + 1] += evalMinMax(P.fol.y, nt, r) * dt;
        this.vel[o + 2] += evalMinMax(P.fol.z, nt, r) * dt;
      }
      if (P.limit) {
        const sp = Math.hypot(this.vel[o], this.vel[o + 1], this.vel[o + 2]);
        const mx = evalMinMax(P.limit.mag, nt, r);
        if (sp > mx && sp > 0) {
          const k = 1 - (1 - mx / sp) * Math.min(1, P.limit.damp);
          this.vel[o] *= k; this.vel[o + 1] *= k; this.vel[o + 2] *= k;
        }
        if (P.limit.drag) {
          const dk = Math.max(0, 1 - evalMinMax(P.limit.drag, nt, r) * dt);
          this.vel[o] *= dk; this.vel[o + 1] *= dk; this.vel[o + 2] *= dk;
        }
      }
      let vx = this.vel[o], vy = this.vel[o + 1], vz = this.vel[o + 2];
      if (P.vol) {
        vx += -evalMinMax(P.vol.x, nt, r); vy += evalMinMax(P.vol.y, nt, r); vz += evalMinMax(P.vol.z, nt, r);
        if (P.vol.speedMod) { const k = evalMinMax(P.vol.speedMod, nt, r); vx *= k; vy *= k; vz *= k; }
      }
      if (P.noise) {
        const st = evalMinMax(P.noise.str, nt, r), fq = P.noise.freq || 0.5, ph = this.rnd[i * 4 + 1] * 100;
        const tt = this.age[i];
        vx += Math.sin((this.pos[o + 1] + tt) * fq * 2.1 + ph) * st;
        vy += Math.sin((this.pos[o + 2] + tt) * fq * 1.7 + ph * 1.3) * st;
        vz += Math.sin((this.pos[o] + tt) * fq * 1.9 + ph * 0.7) * st;
      }
      this.pos[o] += vx * dt; this.pos[o + 1] += vy * dt; this.pos[o + 2] += vz * dt;
      this.aVel.array[o] = vx; this.aVel.array[o + 1] = vy; this.aVel.array[o + 2] = vz;
      if (P.rol) {
        const rz = evalMinMax(P.rol.z, nt, r);
        this.rotV[o + 2] = -rz;
        if (P.rol.sep) { this.rotV[o] = evalMinMax(P.rol.x, nt, r); this.rotV[o + 1] = -evalMinMax(P.rol.y, nt, r); }
        this.rot[o] += this.rotV[o] * dt; this.rot[o + 1] += this.rotV[o + 1] * dt; this.rot[o + 2] += this.rotV[o + 2] * dt;
      }
    }
  }

  kill(i) {
    const j = --this.n;
    if (i === j) return;
    const c3 = (a) => { a[i * 3] = a[j * 3]; a[i * 3 + 1] = a[j * 3 + 1]; a[i * 3 + 2] = a[j * 3 + 2]; };
    const c4 = (a) => { for (let k = 0; k < 4; k++) a[i * 4 + k] = a[j * 4 + k]; };
    c3(this.pos); c3(this.vel); c3(this.size0); c3(this.rot); c3(this.rotV); c3(this.aVel.array);
    c4(this.col0); c4(this.rnd);
    this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.frame0[i] = this.frame0[j];
  }

  writeBuffers() {
    const P = this.P;
    const N = this.n;
    const pos = this.aPos.array, size = this.aSize.array, rot = this.aRot.array, col = this.aCol.array, fr = this.aFrame.array;
    let mw = null;
    this.node.updateWorldMatrix(true, false);
    this.node.matrixWorld.decompose(_v, _q, _s);
    const ws = (P.scaling === 1 || this.world) ? 1 : (Math.abs(_s.x) + Math.abs(_s.y) + Math.abs(_s.z)) / 3;
    if (!this.world) mw = this.node.matrixWorld;
    const uv = P.uv;
    const frames = uv ? (uv.anim === 1 ? uv.tx : uv.tx * uv.ty) : 1;
    const nq = new THREE.Quaternion();
    if (!this.world) nq.copy(_q);
    for (let i = 0; i < N; i++) {
      const o = i * 3, nt = this.age[i] / this.life[i], r = this.rnd[i * 4 + 2];
      _v.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
      if (mw) _v.applyMatrix4(mw);
      pos[o] = _v.x; pos[o + 1] = _v.y; pos[o + 2] = _v.z;
      if (mw) {
        _v2.set(this.aVel.array[o], this.aVel.array[o + 1], this.aVel.array[o + 2]).applyQuaternion(nq);
        this.aVel.array[o] = _v2.x; this.aVel.array[o + 1] = _v2.y; this.aVel.array[o + 2] = _v2.z;
      }
      let sx = this.size0[o], sy = this.size0[o + 1], sz = this.size0[o + 2];
      if (P.sol) {
        const kx = evalMinMax(P.sol.x, nt, r);
        if (P.sol.sep) { sx *= kx; sy *= evalMinMax(P.sol.y, nt, r); sz *= evalMinMax(P.sol.z, nt, r); }
        else { sx *= kx; sy *= kx; sz *= kx; }
      }
      size[o] = sx * ws; size[o + 1] = sy * ws; size[o + 2] = sz * ws;
      rot[o] = this.rot[o]; rot[o + 1] = this.rot[o + 1]; rot[o + 2] = this.rot[o + 2];
      const c0 = this.col0, q = i * 4;
      let cr = c0[q], cg = c0[q + 1], cb = c0[q + 2], ca = c0[q + 3];
      if (P.col) {
        evalMinMaxGrad(P.col, nt, this.rnd[q + 3], _col2);
        cr *= _col2[0]; cg *= _col2[1]; cb *= _col2[2]; ca *= _col2[3];
      }
      col[q] = srgbToLinear(Math.min(cr, 8)); col[q + 1] = srgbToLinear(Math.min(cg, 8)); col[q + 2] = srgbToLinear(Math.min(cb, 8)); col[q + 3] = ca;
      if (uv) {
        let f = evalMinMax(uv.fot, nt, r) * (uv.cycles || 1);
        f = (f - Math.floor(f)) * frames;
        if (uv.anim === 1) fr[i] = Math.min(frames - 1, Math.floor(f)) + this.frame0[i];
        else fr[i] = (Math.floor(f) + Math.floor(this.frame0[i])) % frames;
      } else fr[i] = 0;
    }
    this.mesh.geometry.instanceCount = N;
    for (const a of [this.aPos, this.aSize, this.aRot, this.aCol, this.aFrame, this.aVel]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, N * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}
