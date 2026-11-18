// Generatore di numeri veramente casuali dal rumore fisico (stessa logica di "Noise TRNG"), per le parole del profilo.
//
// Sorgenti: rumore del sensore della webcam (differenza tra due frame), rumore del microfono (bit bassi dei campioni),
// tempi e coordinate di mouse/touch/tastiera (1 bit per evento, per i tasti solo il tempo); accelerometro e jitter
// della CPU si mescolano ma non contano. Ogni blocco di campioni passa i test di salute NIST SP 800-90B (Repetition
// Count e Adaptive Proportion); la min-entropia si stima con il Most Common Value (limite superiore al 99%) e si
// riduce ancora (×0,1 webcam, ×0,25 microfono) per correlazioni e compressione; un blocco vale al massimo 256 bit.
// Ogni blocco va nel pool con SHA-512; con almeno 512 bit stimati il pool si condensa con SHA-256 in 256 bit di
// output (2:1, entropia piena) e si azzera. Nessun PRNG: ogni byte di output si usa una volta sola.

const CFG = {
  poolThreshold: 512,
  chunkCreditCap: 256,
  camChunk: 16384, camFactor: 0.1, camAssumedH: 0.5,
  micChunk: 4096, micFactor: 0.25, micAssumedH: 0.5,
  inputEventsPerChunk: 32,
  maxPending: 64,
  maxPoolParts: 64,
};
const TAG = { camera: 1, mic: 2, input: 3, motion: 4, jitter: 5 };

const sha512 = async (buf) => new Uint8Array(await crypto.subtle.digest("SHA-512", buf));
const sha256 = async (buf) => new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const gcd = (a, b) => {
  while (b) [a, b] = [b, a % b];
  return a;
};

// ---------------------------------------------------------------- test di salute (SP 800-90B §4.4)

const aptCache = new Map();
// più piccolo c tale che P(Binom(W, 2^-H) >= c) <= 2^-20
function aptCutoff(H, W = 512) {
  const key = `${H}:${W}`;
  if (aptCache.has(key)) return aptCache.get(key);
  const p = 2 ** -H;
  const alpha = 2 ** -20;
  const lp = new Float64Array(W + 1);
  let logC = 0;
  for (let k = 0; k <= W; k++) {
    if (k > 0) logC += Math.log((W - k + 1) / k);
    lp[k] = logC + k * Math.log(p) + (W - k) * Math.log1p(-p);
  }
  let tail = 0;
  let c = W;
  for (let k = W; k >= 0; k--) {
    tail += Math.exp(lp[k]);
    if (tail > alpha) {
      c = Math.min(W, k + 1);
      break;
    }
  }
  aptCache.set(key, c);
  return c;
}

/** Fallimenti dei test (Repetition Count + Adaptive Proportion) sul blocco di simboli. */
export function healthTests(sym, H) {
  const rctC = 1 + Math.ceil(20 / H);
  const W = 512;
  const aptC = aptCutoff(H, W);
  let fails = 0;
  let run = 1;
  for (let i = 1; i < sym.length; i++) {
    if (sym[i] === sym[i - 1]) {
      if (++run >= rctC) {
        fails++;
        run = 1;
      }
    } else run = 1;
  }
  for (let s = 0; s + W <= sym.length; s += W) {
    const a = sym[s];
    let c = 0;
    for (let i = s; i < s + W; i++) if (sym[i] === a) c++;
    if (c >= aptC) fails++;
  }
  return fails;
}

/** Min-entropia per simbolo con il Most Common Value (SP 800-90B §6.3.1). */
export function mcvMinEntropy(sym) {
  const n = sym.length;
  if (n < 2) return 0;
  const cnt = new Uint32Array(256);
  for (let i = 0; i < n; i++) cnt[sym[i]]++;
  let m = 0;
  for (let i = 0; i < 256; i++) if (cnt[i] > m) m = cnt[i];
  const p = m / n;
  const pu = Math.min(1, p + 2.576 * Math.sqrt((p * (1 - p)) / (n - 1)));
  return -Math.log2(pu);
}

// ---------------------------------------------------------------- generatore

const WORKLET_SRC = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.size = ${CFG.micChunk}; this.buf = new Float32Array(this.size); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(this.size); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('tap', Tap);`;

export const TRNG_SOURCES = {
  camera: "Webcam",
  mic: "Microphone",
  input: "Mouse, touch and keys",
  motion: "Motion sensors",
  jitter: "CPU timing jitter",
};

/**
 * Un generatore. onUpdate() a ogni cambiamento; onNoise(imageData) il rumore della webcam da disegnare; onWave(samples)
 * quello del microfono. state: { sources: { chiave: { state, note, credited } }, pool: bit nel pool, ready: byte pronti }.
 */
export function createTrng({ onUpdate = () => {}, onNoise = null, onWave = null } = {}) {
  const sources = Object.fromEntries(Object.keys(TRNG_SOURCES).map((k) => [k, { state: "off", note: "off", credited: 0 }]));
  const set = (k, state, note) => {
    sources[k].state = state;
    sources[k].note = note;
    onUpdate();
  };
  let running = false;
  let poolParts = [];
  let poolCredit = 0;
  let counter = 0;
  let pending = 0;
  let chain = Promise.resolve();
  let out = new Uint8Array(0);
  let waiters = [];

  const canIngest = () => running && pending < CFG.maxPending && out.length < 4096;

  function ingest(key, data, credit) {
    pending++;
    chain = chain
      .then(async () => {
        const hdr = new Float64Array([performance.now(), Date.now(), ++counter]);
        const buf = new Uint8Array(1 + hdr.byteLength + data.length);
        buf[0] = TAG[key];
        buf.set(new Uint8Array(hdr.buffer), 1);
        buf.set(data, 1 + hdr.byteLength);
        poolParts.push(await sha512(buf));
        poolCredit += credit;
        sources[key].credited += credit;
        if (poolCredit >= CFG.poolThreshold) {
          const block = await sha256(concat(poolParts));
          poolParts = [];
          poolCredit = 0;
          out = concat([out, block]);
          const w = waiters;
          waiters = [];
          w.forEach((f) => f());
        } else if (poolParts.length > CFG.maxPoolParts) {
          poolParts = [await sha512(concat(poolParts))]; // SHA-512 conserva fino a 512 bit, più del credito attuale
        }
        onUpdate();
      })
      .catch((e) => console.error(e))
      .finally(() => pending--);
  }

  // ---- webcam
  let camStream = null;
  let cam = null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;

  function initCam(w, hgt) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = hgt;
    const N = w * hgt;
    let step = 7919 % N || 1;
    while (gcd(step, N) !== 1) step++;
    const noise = new ImageData(w, hgt);
    for (let i = 3; i < noise.data.length; i += 4) noise.data[i] = 255;
    cam = { w, h: hgt, N, step, ctx: canvas.getContext("2d", { willReadFrequently: true }), prev: null, noise };
  }

  function frame() {
    if (!cam || video.readyState < 2) return;
    if (video.videoWidth !== cam.w || video.videoHeight !== cam.h) initCam(video.videoWidth, video.videoHeight);
    const { w, h: hgt, N, step, ctx, noise } = cam;
    ctx.drawImage(video, 0, 0, w, hgt); // risoluzione nativa: niente ridimensionamento che medi il rumore
    const d = ctx.getImageData(0, 0, w, hgt).data;
    if (!cam.prev) {
      cam.prev = new Uint8Array(N);
      for (let i = 0; i < N; i++) cam.prev[i] = d[i * 4 + 1];
      return;
    }
    // pixel in ordine sparso (passo coprimo con N) per rompere la correlazione spaziale
    const prev = cam.prev;
    const nd = noise.data;
    const sym = new Uint8Array(N);
    let idx = 0;
    let changed = 0;
    for (let k = 0; k < N; k++) {
      const g = d[idx * 4 + 1];
      const diff = g - prev[idx];
      sym[k] = diff & 0xff;
      changed |= diff;
      prev[idx] = g;
      const v = Math.min(255, Math.abs(diff) * 24);
      const o = idx * 4;
      nd[o] = v;
      nd[o + 1] = v;
      nd[o + 2] = v;
      idx += step;
      if (idx >= N) idx -= N;
    }
    onNoise?.(noise);
    if (changed === 0) return set("camera", "warn", "duplicate frames");
    if (!canIngest()) return;
    let anyFail = false;
    for (let s = 0; s < N; s += CFG.camChunk) {
      const chunk = sym.subarray(s, Math.min(N, s + CFG.camChunk));
      const fails = healthTests(chunk, CFG.camAssumedH);
      const credit = fails ? 0 : Math.min(CFG.chunkCreditCap, Math.floor(mcvMinEntropy(chunk) * chunk.length * CFG.camFactor));
      if (fails) anyFail = true;
      ingest("camera", chunk.slice(), credit);
    }
    set("camera", anyFail ? "warn" : "on", anyFail ? "health tests failed" : `${w}×${hgt}`);
  }

  function camLoop() {
    if (!camStream) return;
    frame();
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(camLoop);
    else requestAnimationFrame(camLoop);
  }

  async function startCamera() {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false });
      video.srcObject = camStream;
      await video.play();
      initCam(video.videoWidth, video.videoHeight);
      set("camera", "on", "on");
      camLoop();
    } catch (e) {
      camStream = null;
      set("camera", "err", e.name === "NotAllowedError" ? "permission denied" : "not available");
    }
  }

  function stopCamera() {
    camStream?.getTracks().forEach((t) => t.stop());
    camStream = null;
    cam = null;
    video.srcObject = null;
    if (sources.camera.state !== "err") set("camera", "off", "off");
  }

  // ---- microfono
  let micStream = null;
  let audioCtx = null;
  let micNodes = [];

  function audio(samples) {
    onWave?.(samples);
    if (!canIngest()) return;
    const n = samples.length;
    const sym = new Uint8Array(n);
    for (let i = 0; i < n; i++) sym[i] = Math.round(samples[i] * 32768) & 0xff; // 8 bit bassi a 16 bit
    const fails = healthTests(sym, CFG.micAssumedH);
    const credit = fails ? 0 : Math.min(CFG.chunkCreditCap, Math.floor(mcvMinEntropy(sym) * n * CFG.micFactor));
    set("mic", fails ? "warn" : "on", fails ? "health tests failed" : "on");
    ingest("mic", new Uint8Array(samples.buffer.slice(0)), credit); // nel pool i campioni interi, non solo i bit bassi
  }

  async function startMic() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }, video: false });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume();
      const src = audioCtx.createMediaStreamSource(micStream);
      const mute = audioCtx.createGain();
      mute.gain.value = 0;
      mute.connect(audioCtx.destination);
      if (audioCtx.audioWorklet) {
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
        await audioCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const tap = new AudioWorkletNode(audioCtx, "tap");
        tap.port.onmessage = (e) => audio(e.data);
        src.connect(tap);
        tap.connect(mute);
        micNodes = [src, tap, mute];
      } else {
        const sp = audioCtx.createScriptProcessor(CFG.micChunk, 1, 1);
        sp.onaudioprocess = (e) => audio(new Float32Array(e.inputBuffer.getChannelData(0)));
        src.connect(sp);
        sp.connect(mute);
        micNodes = [src, sp, mute];
      }
      set("mic", "on", "on");
    } catch (e) {
      stopMic();
      set("mic", "err", e.name === "NotAllowedError" ? "permission denied" : "not available");
    }
  }

  function stopMic() {
    micNodes.forEach((n) => {
      try {
        n.disconnect();
      } catch {
        /* già scollegato */
      }
    });
    micNodes = [];
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    audioCtx?.close();
    audioCtx = null;
    if (sources.mic.state !== "err") set("mic", "off", "off");
  }

  // ---- mouse, touch, tastiera, sensori, jitter
  const IN_FIELDS = 4;
  const inBuf = new Float64Array(CFG.inputEventsPerChunk * IN_FIELDS);
  let inN = 0;
  let inCredit = 0;
  let lastX = NaN;
  let lastY = NaN;
  let lastKeyT = 0;

  function onInput(e) {
    if (!running) return;
    const t = performance.now();
    let fresh = 0;
    let x = 0;
    let y = 0;
    let type;
    if (e.type === "keydown") {
      type = 1; // solo il tempo, mai il tasto premuto
      fresh = t - lastKeyT >= 1 ? 1 : 0;
      lastKeyT = t;
    } else {
      type = e.type === "wheel" ? 3 : 2;
      x = e.clientX ?? 0;
      y = e.clientY ?? 0;
      if (e.type === "wheel") {
        x += e.deltaX;
        y += e.deltaY;
      }
      fresh = x !== lastX || y !== lastY ? 1 : 0;
      lastX = x;
      lastY = y;
    }
    const o = inN * IN_FIELDS;
    inBuf[o] = t;
    inBuf[o + 1] = x;
    inBuf[o + 2] = y;
    inBuf[o + 3] = type + (e.timeStamp % 1);
    inN++;
    inCredit += fresh;
    if (inN === CFG.inputEventsPerChunk) {
      if (canIngest()) ingest("input", new Uint8Array(inBuf.buffer.slice(0)), inCredit);
      inN = 0;
      inCredit = 0;
    }
    if (sources.input.state !== "on") set("input", "on", "on");
  }

  let motionBuf = [];
  function onMotion(e) {
    if (!running) return;
    const a = e.accelerationIncludingGravity || {};
    const r = e.rotationRate || {};
    motionBuf.push(performance.now(), a.x ?? 0, a.y ?? 0, a.z ?? 0, r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0);
    if (motionBuf.length >= 7 * 64) {
      if (canIngest()) ingest("motion", new Uint8Array(new Float64Array(motionBuf).buffer), 0);
      motionBuf = [];
    }
    if (sources.motion.state !== "on") set("motion", "on", "mixed in, not counted");
  }

  let jitterTimer = null;
  function jitterTick() {
    if (!canIngest()) return;
    const arr = new Float64Array(64);
    for (let i = 0; i < 64; i++) {
      const t0 = performance.now();
      let c = 0;
      let t1 = t0;
      while ((t1 = performance.now()) === t0 && c < 1e6) c++;
      arr[i] = c + (t1 - t0);
    }
    ingest("jitter", new Uint8Array(arr.buffer), 0);
  }

  const INPUT_EVENTS = ["pointermove", "pointerdown", "wheel", "keydown"];

  return {
    sources,
    get pool() {
      return poolCredit;
    },
    get ready() {
      return out.length;
    },
    get running() {
      return running;
    },
    threshold: CFG.poolThreshold,

    /** Avvia le sorgenti scelte (webcam e microfono chiedono il permesso). */
    async start({ camera = true, mic = true } = {}) {
      if (!window.isSecureContext || !crypto.subtle) throw new Error("A secure page (HTTPS) is needed");
      running = true;
      INPUT_EVENTS.forEach((t) => window.addEventListener(t, onInput, { passive: true }));
      set("input", "warn", "move the mouse");
      window.addEventListener("devicemotion", onMotion);
      set("motion", "off", "no sensor");
      jitterTimer = setInterval(jitterTick, 100);
      set("jitter", "on", "mixed in, not counted");
      const media = !!navigator.mediaDevices?.getUserMedia;
      await Promise.all([
        camera && media ? startCamera() : set("camera", media ? "off" : "err", media ? "off" : "not available"),
        mic && media ? startMic() : set("mic", media ? "off" : "err", media ? "off" : "not available"),
      ]);
    },

    stop() {
      running = false;
      stopCamera();
      stopMic();
      INPUT_EVENTS.forEach((t) => window.removeEventListener(t, onInput));
      window.removeEventListener("devicemotion", onMotion);
      clearInterval(jitterTimer);
      ["input", "motion", "jitter"].forEach((k) => set(k, "off", "off"));
      waiters.forEach((f) => f());
      waiters = [];
    },

    /** n byte veri (aspetta se non ce ne sono abbastanza); i byte presi si cancellano dal buffer. */
    async take(n) {
      while (out.length < n) {
        if (!running) throw new Error("The generator is stopped");
        await new Promise((r) => waiters.push(r));
      }
      const r = out.slice(0, n);
      out.fill(0, 0, n);
      out = out.slice(n);
      return r;
    },
  };
}
