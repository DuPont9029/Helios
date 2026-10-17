// Ricostruzione dei materiali Unity (URP + Shader Graph custom di Master Duel) come materiali three.js.
// Il codice degli shader non è disponibile: si usano lo stato reale del pass (blend, zwrite, cull),
// le descrizioni delle proprietà salvate nello shader e qualche shader dedicato per le famiglie più comuni.
import * as THREE from 'three';

const ALPHA_PROPS = ['_Alpha', '_alpha', '_AllAlpha', '_Opacity', '_opacity', 'Alpha', '_BaseAlpha', '_baseAlpha', '_Animation_Alpha'];
const COLOR_PROPS = ['_BaseColor', '_TintColor', '_Color', '_Color01', '_MainColor', '_Color_01', '_Color1', '_basecolor'];
const COLOR_DESC = /^(base |main |tint |)colou?r( ?0?1)?$/i;
const ALPHA_DESC = /^(alpha|opacity|all ?alpha|base ?alpha)$/i;
const ADD_NAME = /add|glow|flash|spark|fire|aura|beam|plasma|thunder|shout|slash|kira|lightning|ring|fresnel/i;

const FACTOR = [
  THREE.ZeroFactor, THREE.OneFactor, THREE.DstColorFactor, THREE.SrcColorFactor, THREE.OneMinusDstColorFactor,
  THREE.SrcAlphaFactor, THREE.OneMinusSrcColorFactor, THREE.DstAlphaFactor, THREE.OneMinusDstAlphaFactor,
  THREE.SrcAlphaSaturateFactor, THREE.OneMinusSrcAlphaFactor,
];

export function colorFromUnity(arr, target = new THREE.Color()) {
  // i colori dei materiali Unity sono salvati in gamma (sRGB); HDR limitato per non saturare il bloom
  const k = (x) => Math.min(Math.max(x, 0), 1.6);
  return target.setRGB(k(arr[0]), k(arr[1]), k(arr[2]), THREE.SRGBColorSpace);
}

function byDesc(ex, re, kind) {
  const d = ex.desc || {}, src = kind === 'c' ? ex.c : kind === 'f' ? ex.f : ex.tex;
  if (!src) return null;
  for (const [k, v] of Object.entries(d)) if (re.test(v) && k in src) return k;
  return null;
}

// Stato di blend: dallo shader se disponibile, altrimenti euristica
export function blendInfo(ex) {
  const f = ex.f || {}, shader = ex.shader || '', st = ex.st;
  if (st && st.src !== undefined) {
    const src = st.src | 0, dst = st.dst | 0;
    const opaque = src === 1 && dst === 0;
    return {
      transparent: !opaque || (ex.tags && ex.tags.RenderType === 'Transparent' && st.zw === 0),
      additive: dst === 1,
      multiply: src === 2 || dst === 3,
      src, dst, opaque,
      depthWrite: st.zw === 1,
      cull: st.cull ?? 2,
    };
  }
  let transparent = f._Surface === 1 || ex.queue >= 2450 || /_alpha|Transparent/i.test(shader);
  let additive = false;
  if (transparent && '_DstBlend' in f) additive = f._DstBlend === 1;
  else if (transparent && ADD_NAME.test(shader)) additive = true;
  return { transparent, additive, multiply: false, depthWrite: !transparent, cull: f._Cull ?? 2 };
}

export function applyBlend(mat, b) {
  mat.transparent = b.transparent;
  mat.depthWrite = b.depthWrite;
  mat.side = b.cull === 0 ? THREE.DoubleSide : b.cull === 1 ? THREE.BackSide : THREE.FrontSide;
  if (b.src !== undefined && !b.opaque) {
    if (b.src === 5 && b.dst === 10) mat.blending = THREE.NormalBlending;
    else if (b.src === 5 && b.dst === 1) mat.blending = THREE.AdditiveBlending;
    else {
      mat.blending = THREE.CustomBlending;
      mat.blendSrc = FACTOR[b.src] ?? THREE.OneFactor;
      mat.blendDst = FACTOR[b.dst] ?? THREE.ZeroFactor;
      mat.blendSrcAlpha = mat.blendSrc; mat.blendDstAlpha = mat.blendDst;
    }
  } else if (b.additive) mat.blending = THREE.AdditiveBlending;
}

function mainColor(ex) {
  const c = ex.c || {};
  const k = byDesc(ex, COLOR_DESC, 'c') || COLOR_PROPS.find((p) => c[p]);
  if (!k) return null;
  const v = c[k].slice();
  if (k === '_TintColor') { v[0] *= 2; v[1] *= 2; v[2] *= 2; v[3] *= 2; }
  return { key: k, v };
}

function mainAlpha(ex) {
  const f = ex.f || {};
  const k = byDesc(ex, ALPHA_DESC, 'f') || ALPHA_PROPS.find((p) => p in f);
  return k ? { key: k, v: Math.max(0, Math.min(1, f[k])) } : null;
}

function scrollSpeed(ex) {
  const f = ex.f || {}, c = ex.c || {}, d = ex.desc || {};
  let sx = null, sy = null;
  for (const [k, v] of Object.entries(d)) {
    if (/^(main[ _]?)?(texture )?scroll( speed)?$|^(uv )?scroll$|^speed$|^main speed$/i.test(v) && c[k]) return [c[k][0], c[k][1]];
    if (/^(main[ _]?)?scroll[ _]?x$|^speed[ _]?x$|^u ?speed$/i.test(v) && k in f) sx = f[k];
    if (/^(main[ _]?)?scroll[ _]?y$|^speed[ _]?y$|^v ?speed$/i.test(v) && k in f) sy = f[k];
  }
  if (sx !== null || sy !== null) return [sx || 0, sy || 0];
  for (const [a, b] of [['_Scroll_X', '_Scroll_Y'], ['_ScrollX', '_ScrollY'], ['_Speed_X', '_Speed_Y']]) if (a in f || b in f) return [f[a] || 0, f[b] || 0];
  return null;
}

function tiling(ex) {
  const c = ex.c || {}, d = ex.desc || {};
  for (const [k, v] of Object.entries(d)) if (/^(main )?til(l)?ing$/i.test(v) && c[k]) return [c[k][0] || 1, c[k][1] || 1];
  return null;
}

function texOf(ex, src) {
  return ex.main && ex.tex && ex.tex[ex.main];
}

// ------------------------------------------------------------ shader dedicati
const FX_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec4 vCol;
#ifdef USE_VCOL
attribute vec4 _color_0;
#endif
#include <common>
#include <skinning_pars_vertex>
void main(){
  vUv = uv;
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vN = normalize(mat3(modelMatrix) * objectNormal);
  vV = normalize(cameraPosition - wp.xyz);
#ifdef USE_VCOL
  vCol = _color_0;
#else
  vCol = vec4(1.0);
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// Famiglia "R Color / G Color" (lava, bolle): canali della texture colorati e scorrevoli
const RG_FRAG = /* glsl */`
uniform sampler2D map; uniform float time;
uniform vec3 rColor, gColor, fColor; uniform vec2 rScroll, gScroll, rScale, gScale, rRemap, gRemap; uniform float fPower;
varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec4 vCol;
void main(){
  float r = texture2D(map, vUv * rScale + rScroll * time).r;
  float g = texture2D(map, vUv * gScale + gScroll * time).g;
  r = clamp((r - rRemap.x) / max(1e-4, rRemap.y - rRemap.x), 0.0, 1.0);
  g = clamp((g - gRemap.x) / max(1e-4, gRemap.y - gRemap.x), 0.0, 1.0);
  float fr = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), max(fPower, 0.01));
  vec3 c = r * rColor + g * gColor * r * 0.5 + fr * fColor * 0.2;
  c = 1.0 - exp(-c * 1.2); // compressione HDR (in Unity c'è il tonemapping)
  gl_FragColor = vec4(c * 1.15, 1.0);
  #include <colorspace_fragment>
}`;

// Famiglia "Color A / Color B" (+ Alpha, Scroll Speed, Tiling)
const AB_FRAG = /* glsl */`
uniform sampler2D map; uniform float time, alpha;
uniform vec3 colA, colB; uniform vec2 scroll, tiling;
varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec4 vCol;
void main(){
  vec4 t = texture2D(map, vUv * tiling + scroll * time);
  vec3 c = mix(colB, colA, t.r);
  gl_FragColor = vec4(c, t.a * alpha * vCol.a);
  #include <colorspace_fragment>
}`;

function lin(c) { return colorFromUnity(c || [1, 1, 1, 1]); }
function vec2(c, def) { return new THREE.Vector2(c ? c[0] : def[0], c ? c[1] : def[1]); }

function propByDesc(ex, desc, kind) {
  const d = ex.desc || {}, src = kind === 'c' ? ex.c : ex.f;
  for (const [k, v] of Object.entries(d)) if (v === desc && src && k in src) return src[k];
  return undefined;
}

function special(src, ex, b, opts) {
  const descs = Object.values(ex.desc || {});
  const map = src.map;
  if (!map) return null;
  const common = { vertexShader: FX_VERT, defines: {} };
  if (opts.skinned) common.defines.USE_SKINNING = 1;
  if (opts.vertexColors) common.defines.USE_VCOL = 1;
  let m = null;
  if (descs.includes('R Color') && descs.includes('G Color')) {
    map.wrapS = map.wrapT = THREE.RepeatWrapping; map.needsUpdate = true;
    m = new THREE.ShaderMaterial({
      ...common, fragmentShader: RG_FRAG,
      uniforms: {
        map: { value: map }, time: { value: 0 },
        rColor: { value: lin(propByDesc(ex, 'R Color', 'c')) }, gColor: { value: lin(propByDesc(ex, 'G Color', 'c')) },
        fColor: { value: lin(propByDesc(ex, 'Fresnel Color', 'c') || [0, 0, 0, 0]) },
        rScroll: { value: vec2(propByDesc(ex, 'R Scroll', 'c'), [0, 0]).multiply(new THREE.Vector2(-1, 1)) },
        gScroll: { value: vec2(propByDesc(ex, 'G Scroll', 'c'), [0, 0]).multiply(new THREE.Vector2(-1, 1)) },
        rScale: { value: vec2(propByDesc(ex, 'R Scale', 'c'), [1, 1]) }, gScale: { value: vec2(propByDesc(ex, 'G Scale', 'c'), [1, 1]) },
        rRemap: { value: vec2(propByDesc(ex, 'R Remap', 'c'), [0, 1]) }, gRemap: { value: vec2(propByDesc(ex, 'G Remap', 'c'), [0, 1]) },
        fPower: { value: propByDesc(ex, 'Fresnel Power', 'f') ?? 1 },
      },
    });
  } else if (descs.includes('Color A') && descs.includes('Color B')) {
    map.wrapS = map.wrapT = THREE.RepeatWrapping; map.needsUpdate = true;
    const sc = propByDesc(ex, 'Scroll Speed', 'c');
    m = new THREE.ShaderMaterial({
      ...common, fragmentShader: AB_FRAG,
      uniforms: {
        map: { value: map }, time: { value: 0 }, alpha: { value: propByDesc(ex, 'Alpha', 'f') ?? 1 },
        colA: { value: lin(propByDesc(ex, 'Color A', 'c')) }, colB: { value: lin(propByDesc(ex, 'Color B', 'c')) },
        scroll: { value: vec2(sc, [0, 0]).multiply(new THREE.Vector2(1, -1)) }, tiling: { value: vec2(propByDesc(ex, 'Tiling', 'c'), [1, 1]) },
      },
    });
  }
  if (m) {
    applyBlend(m, b);
    m.name = src.name;
    m.userData = { ex, timeUniform: true, queue: ex.queue, transparentFx: b.transparent };
  }
  return m;
}

// Costruisce il materiale three.js a partire dal materiale GLTF (userData = extras di convert.py)
export function buildMaterial(src, opts = {}) {
  const ex = src.userData || {};
  const shader = ex.shader || '';
  const f = ex.f || {};
  const b = blendInfo(ex);
  const sp = special(src, ex, b, opts);
  if (sp) return sp;
  const lit = shader === 'Universal Render Pipeline/Lit';
  const params = { name: src.name, map: src.map || null };
  if (f._AlphaClip === 1 || /alphaClip|Cutout|_clip/i.test(shader)) params.alphaTest = f._Cutoff ?? 0.5;
  const mat = lit ? new THREE.MeshLambertMaterial(params) : new THREE.MeshBasicMaterial(params);
  applyBlend(mat, b);
  // maschere di profondità: scrivono solo lo z-buffer
  if (/^Masked\/|depthmask/i.test(shader + ' ' + src.name)) mat.colorWrite = false;
  // FX procedurali (rumore generato nello shader, nessuna texture): non riproducibili, si nascondono
  const hasTex = ex.tex && Object.keys(ex.tex).length > 0;
  if (!hasTex && b.transparent && !/^Universal Render Pipeline\/(Lit|Unlit)$/.test(shader)) mat.visible = false;
  // gli Shader Graph opachi con texture non usano il "Color" come tinta (spesso serve ad altro)
  const isGraph = !/^(Universal Render Pipeline|Ygom|Legacy|Particles)/.test(shader);
  const mc = (isGraph && !b.transparent && src.map) ? null : mainColor(ex);
  const ma = mainAlpha(ex);
  const mt0 = texOf(ex);
  if (isGraph && !b.transparent && mt0 && mt0.a && /alpha|clip|cutout|leaf|grass|plant/i.test(shader + ' ' + src.name)) mat.alphaTest = 0.5;
  if (mc) {
    colorFromUnity(mc.v, mat.color);
    if (b.transparent && /^(Universal|Ygom|Legacy|Particles)/.test(shader)) mat.opacity = Math.max(0, Math.min(1, mc.v[3]));
    else mat.userData_ignoreColorAlpha = true;
  }
  if (ma && b.transparent) mat.opacity *= ma.v;
  mat.userData = {
    ex, colorKey: mc && mc.key, alphaKey: ma && ma.key,
    baseColor: mc ? mc.v.slice() : [1, 1, 1, 1], baseAlpha: ma ? ma.v : 1,
    queue: ex.queue, transparentFx: b.transparent, ignoreColorAlpha: !!mat.userData_ignoreColorAlpha,
  };
  delete mat.userData_ignoreColorAlpha;
  // tiling / offset / scroll della texture principale
  const mt = texOf(ex);
  const sc = scrollSpeed(ex);
  const tl = tiling(ex);
  if (mat.map && mt && (mt.s[0] !== 1 || mt.s[1] !== 1 || mt.o[0] !== 0 || mt.o[1] !== 0 || sc || tl)) {
    mat.map = mat.map.clone();
    mat.map.wrapS = mat.map.wrapT = THREE.RepeatWrapping;
    const rx = mt.s[0] * (tl ? tl[0] : 1), ry = mt.s[1] * (tl ? tl[1] : 1);
    mat.map.repeat.set(rx, ry);
    mat.map.offset.set(mt.o[0], 1 - mt.o[1] - ry);
    mat.map.needsUpdate = true;
    mat.userData.baseOffset = [mt.o[0], 1 - mt.o[1] - ry];
  }
  if (sc && mat.map && (sc[0] || sc[1]) && Math.abs(sc[0]) < 5 && Math.abs(sc[1]) < 5) mat.userData.scroll = sc;
  // Shader Graph FX con texture senza alpha: la texture in scala di grigi fa da maschera
  if (b.transparent && !b.additive && mat.map && mt && !mt.a && !/^Universal Render Pipeline/.test(shader) && !/basecolor|albedo/i.test(mt.n)) {
    mat.alphaMap = mat.map;
  }
  if (opts.vertexColors) mat.vertexColors = true;
  return mat;
}

// Applica una proprietà animata (da AnimationClip) a un materiale
export function applyMaterialProp(mat, name, comp, value) {
  const u = mat.userData;
  if (!u || !mat.color) return;
  if (name === u.alphaKey && comp === 8) {
    u.baseAlpha = Math.max(0, Math.min(1, value));
  } else if (name === u.colorKey && comp >= 4 && comp <= 7) {
    u.baseColor[comp - 4] = name === '_TintColor' ? value * 2 : value;
  } else if (ALPHA_PROPS.includes(name) && comp === 8 && !u.alphaKey) {
    u.alphaKey = name; u.baseAlpha = Math.max(0, Math.min(1, value));
  } else {
    return;
  }
  colorFromUnity(u.baseColor, mat.color);
  const ca = u.ignoreColorAlpha ? 1 : Math.max(0, Math.min(1, u.baseColor[3]));
  if (u.transparentFx) mat.opacity = ca * u.baseAlpha;
}

export function needsUpdate(mat) {
  return !!(mat.userData && (mat.userData.scroll || mat.userData.timeUniform));
}

export function updateScroll(mat, time) {
  const u = mat.userData;
  if (u.timeUniform) { mat.uniforms.time.value = time; return; }
  const s = u.scroll;
  if (!s || !mat.map) return;
  const o = u.baseOffset || [0, 0];
  mat.map.offset.set(o[0] + s[0] * time, o[1] - s[1] * time);
}
