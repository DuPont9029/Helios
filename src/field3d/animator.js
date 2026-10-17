// Player di AnimationClip/AnimatorController di Unity (curve già campionate da convert.py)
import { decodeF32 } from './curves.js';

const COMP = { p: 3, r: 4, s: 3, a: 1, e: 1, m: 1 };

export function prepareClips(meta) {
  for (const c of meta.clips) {
    for (const t of c.tracks) {
      t.data = decodeF32(t.v);
      t.cs = COMP[t.k];
      delete t.v;
    }
  }
}

export class AnimatorPlayer {
  // side: oggetto con apply(track, values, offset/interp)
  constructor(side, meta, clips) {
    this.side = side;
    this.meta = meta;
    this.clips = clips;
    this.name = meta.name;
    this.node = meta.n;
    this.paused = false;
    this.layers = meta.layers.map((L) => ({ L, cur: L.default, time: 0, done: false }));
  }

  stateNames() {
    return this.layers.flatMap((l, li) => l.L.states.map((s, si) => ({ layer: li, index: si, name: s.name })));
  }

  findState(re) {
    for (let li = 0; li < this.layers.length; li++) {
      const st = this.layers[li].L.states;
      for (let si = 0; si < st.length; si++) if (re.test(st[si].name)) return { layer: li, index: si };
    }
    return null;
  }

  play(layer, index) {
    const l = this.layers[layer];
    l.cur = index; l.time = 0; l.done = false;
    this.paused = false;
  }

  reset() {
    for (const l of this.layers) { l.cur = l.L.default; l.time = 0; l.done = false; }
  }

  stateDuration(st) {
    let d = 0;
    for (const ci of st.clips) d = Math.max(d, this.clips[ci].dur);
    return d;
  }

  update(dt) {
    for (const l of this.layers) {
      const st = l.L.states[l.cur];
      if (!st) continue;
      if (!this.paused) l.time += dt * (st.speed || 1);
      const dur = this.stateDuration(st);
      const loop = st.clips.length && st.clips.every((ci) => this.clips[ci].loop);
      let t = l.time;
      if (dur > 0) {
        if (loop) t = l.time % dur;
        else t = Math.min(l.time, dur);
      }
      for (const ci of st.clips) this.applyClip(this.clips[ci], t);
      // transizioni automatiche (senza condizioni)
      const norm = dur > 0 ? l.time / dur : 1;
      for (const tr of st.trans) {
        if (tr.cond) continue;
        if (!tr.hasExit) continue;
        const exit = tr.exit <= 0 ? 1 : tr.exit;
        if (norm >= exit) {
          l.cur = tr.to; l.time = 0;
          break;
        }
      }
    }
  }

  applyClip(clip, t) {
    const f = Math.min(clip.frames - 1, Math.max(0, t * clip.rate));
    for (const tr of clip.tracks) this.side.applyTrack(tr, f);
  }
}

// Valori interpolati di una traccia al frame (float) f -> out
export function sampleTrack(tr, f, out) {
  const cs = tr.cs, d = tr.data;
  if (tr.nf === 1) {
    for (let i = 0; i < cs; i++) out[i] = d[i];
    return out;
  }
  const f0 = Math.floor(f), f1 = Math.min(tr.nf - 1, f0 + 1), w = f - f0;
  if (tr.k === 'a' || tr.k === 'e') {
    out[0] = d[f0];
    return out;
  }
  const o0 = f0 * cs, o1 = f1 * cs;
  if (tr.k === 'r') {
    // lerp normalizzato lungo l'emisfero più corto
    let dot = 0;
    for (let i = 0; i < 4; i++) dot += d[o0 + i] * d[o1 + i];
    const sgn = dot < 0 ? -1 : 1;
    let len = 0;
    for (let i = 0; i < 4; i++) { out[i] = d[o0 + i] * (1 - w) + sgn * d[o1 + i] * w; len += out[i] * out[i]; }
    len = Math.sqrt(len) || 1;
    for (let i = 0; i < 4; i++) out[i] /= len;
    return out;
  }
  for (let i = 0; i < cs; i++) out[i] = d[o0 + i] * (1 - w) + d[o1 + i] * w;
  return out;
}
