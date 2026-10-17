// Valutazione di AnimationCurve / MinMaxCurve / Gradient di Unity (formato compatto di convert.py)

export function evalCurve(keys, t) {
  const n = keys ? keys.length : 0;
  if (!n) return 0;
  if (n === 1 || t <= keys[0][0]) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  let i = 0;
  while (i < n - 2 && t > keys[i + 1][0]) i++;
  const k0 = keys[i], k1 = keys[i + 1];
  const dt = k1[0] - k0[0];
  if (dt <= 1e-9) return k1[1];
  const s = (t - k0[0]) / dt, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * k0[1] + (s3 - 2 * s2 + s) * dt * k0[3] +
    (-2 * s3 + 3 * s2) * k1[1] + (s3 - s2) * dt * k1[2];
}

// mm: {m, s, ms, c, c2}; t normalizzato 0..1; r casuale 0..1 per particella
export function evalMinMax(mm, t, r) {
  if (!mm) return 0;
  switch (mm.m) {
    case 0: return mm.s;
    case 1: return evalCurve(mm.c, t) * mm.s;
    case 2: {
      const a = evalCurve(mm.c2, t), b = evalCurve(mm.c, t);
      return (a + (b - a) * r) * mm.s;
    }
    case 3: return mm.ms + (mm.s - mm.ms) * r;
  }
  return mm.s;
}

export function evalGradient(g, t, out) {
  const c = g.c, a = g.a, fixed = g.mode === 1;
  sample(c, t, fixed, 3, out, 0);
  const tmp = [0];
  sample(a, t, fixed, 1, tmp, 0);
  out[3] = tmp[0];
  return out;
}

function sample(keys, t, fixed, nc, out, off) {
  const n = keys.length;
  if (!n) { for (let i = 0; i < nc; i++) out[off + i] = 1; return; }
  if (t <= keys[0][0] || n === 1) { for (let i = 0; i < nc; i++) out[off + i] = keys[0][1 + i]; return; }
  if (t >= keys[n - 1][0]) { for (let i = 0; i < nc; i++) out[off + i] = keys[n - 1][1 + i]; return; }
  let j = 0;
  while (j < n - 2 && t > keys[j + 1][0]) j++;
  const k0 = keys[j], k1 = keys[j + 1];
  if (fixed) { for (let i = 0; i < nc; i++) out[off + i] = k1[1 + i]; return; }
  const w = (t - k0[0]) / Math.max(1e-6, k1[0] - k0[0]);
  for (let i = 0; i < nc; i++) out[off + i] = k0[1 + i] + (k1[1 + i] - k0[1 + i]) * w;
}

const _t1 = [0, 0, 0, 0], _t2 = [0, 0, 0, 0];
export function evalMinMaxGrad(mg, t, r, out) {
  if (!mg) { out[0] = out[1] = out[2] = out[3] = 1; return out; }
  switch (mg.m) {
    case 0: for (let i = 0; i < 4; i++) out[i] = mg.c0[i]; break;
    case 1: evalGradient(mg.g0, t, out); break;
    case 2: for (let i = 0; i < 4; i++) out[i] = mg.c1[i] + (mg.c0[i] - mg.c1[i]) * r; break;
    case 3:
      evalGradient(mg.g1, t, _t1); evalGradient(mg.g0, t, _t2);
      for (let i = 0; i < 4; i++) out[i] = _t1[i] + (_t2[i] - _t1[i]) * r;
      break;
    case 4: evalGradient(mg.g0, r, out); break;
    default: out[0] = out[1] = out[2] = out[3] = 1;
  }
  return out;
}

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function decodeF32(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Float32Array(buf.buffer);
}
