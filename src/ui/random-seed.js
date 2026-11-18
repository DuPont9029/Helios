// Profilo nuovo con parole veramente casuali: 128 bit dal rumore fisico di webcam, microfono e movimenti
// (net/trng.js), mostrati mentre si raccolgono. Restituisce true se il profilo è stato creato.
import { h, icon } from "./dom.js";
import { openModal, toast } from "./modal.js";
import { createTrng, TRNG_SOURCES } from "../net/trng.js";
import { newIdentity } from "../net/identity.js";

const NOISE_W = 160;
const NOISE_H = 120;

export function newRandomProfile() {
  const camOpt = h("input", { type: "checkbox", checked: true });
  const micOpt = h("input", { type: "checkbox", checked: true });
  const setup = h("div.trng-setup",
    h("p.muted.small", "Your 12 seed words are made from physical noise: the sensor noise of your webcam, the hiss of your microphone and the way you move the mouse or your finger. Nothing is recorded or sent: the noise is hashed and thrown away."),
    h("label.check", camOpt, "Webcam noise (cover the lens if you like: the sensor noise is still there)"),
    h("label.check", micOpt, "Microphone noise"),
    h("p.muted.small", "Without them it still works: move the mouse until the pool is full."),
    h("p.status-box.error", "This replaces the profile of this browser: your rating and your friends stay with the old key, which is lost if you have not backed it up."));

  // ---- vista dal vivo
  const noiseCv = h("canvas.trng-noise", { width: NOISE_W, height: NOISE_H });
  const waveCv = h("canvas.trng-wave", { width: 320, height: NOISE_H });
  const rows = Object.fromEntries(Object.keys(TRNG_SOURCES).map((k) => [k, { dot: h("span.trng-dot"), note: h("span.muted.small"), bits: h("span.trng-bits.mono") }]));
  const fill = h("div.trng-meter-fill");
  const poolTxt = h("span.mono");
  const hint = h("p.trng-hint", icon("swipe"), " Move the mouse or your finger around the window");
  const live = h("div.trng-live", { hidden: true },
    h("div.trng-scopes", h("figure", noiseCv, h("figcaption", "Webcam noise")), h("figure", waveCv, h("figcaption", "Microphone"))),
    h("div.trng-sources", Object.entries(TRNG_SOURCES).map(([k, name]) => h("div.trng-source", rows[k].dot, h("span", name), rows[k].note, rows[k].bits))),
    h("div.trng-meter-label", h("span", "Entropy in the pool"), poolTxt),
    h("div.trng-meter", fill),
    hint);

  // il rumore della webcam si disegna ridotto (a parte: il generatore usa la risoluzione piena)
  const scratch = document.createElement("canvas");
  const nctx = noiseCv.getContext("2d");
  const onNoise = (img) => {
    scratch.width = img.width;
    scratch.height = img.height;
    scratch.getContext("2d").putImageData(img, 0, 0);
    nctx.drawImage(scratch, 0, 0, NOISE_W, NOISE_H);
  };
  const wctx = waveCv.getContext("2d");
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#38c6ff";
  const onWave = (samples) => {
    const { width: w, height: hh } = waveCv;
    wctx.clearRect(0, 0, w, hh);
    let peak = 1e-6;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    const g = (hh / 2 - 6) / peak; // scala automatica: il rumore si vede anche nel silenzio
    wctx.strokeStyle = accent;
    wctx.lineWidth = 1;
    wctx.beginPath();
    const step = samples.length / w;
    for (let x = 0; x < w; x++) {
      const y = hh / 2 - samples[Math.floor(x * step)] * g;
      if (x) wctx.lineTo(x, y);
      else wctx.moveTo(x, y);
    }
    wctx.stroke();
  };

  let created = false;
  let full = false;
  const paint = () => {
    for (const [k, r] of Object.entries(rows)) {
      const s = trng.sources[k];
      r.dot.className = `trng-dot ${s.state}`;
      r.note.textContent = s.note;
      r.bits.textContent = s.credited ? `${Math.round(s.credited)} bits` : "";
    }
    full = trng.ready >= 16;
    const bits = full ? trng.threshold : trng.pool;
    fill.style.width = `${Math.min(100, (bits / trng.threshold) * 100)}%`;
    fill.classList.toggle("full", full);
    poolTxt.textContent = full ? "ready: 256 bits of true randomness" : `${Math.floor(bits)} / ${trng.threshold} bits`;
    hint.hidden = full;
    if (m) {
      m.buttons[2].disabled = !full;
      m.buttons[2].hidden = !trng.running;
      m.buttons[1].hidden = trng.running;
    }
  };
  let m = null;
  const trng = createTrng({ onUpdate: () => paint(), onNoise, onWave });

  m = openModal({
    title: "New profile",
    className: "trng-modal",
    body: [setup, live],
    onClose: () => trng.stop(),
    actions: [
      { label: "Cancel", value: false },
      {
        label: "Start",
        primary: true,
        onClick: async () => {
          setup.hidden = true;
          live.hidden = false;
          try {
            await trng.start({ camera: camOpt.checked, mic: micOpt.checked });
          } catch (e) {
            toast(e.message, { kind: "error" });
            m.close(false);
          }
          paint();
        },
      },
      {
        label: "Create profile",
        primary: true,
        onClick: async (close) => {
          if (!full) return;
          const bytes = await trng.take(16);
          trng.stop();
          newIdentity(bytes);
          bytes.fill(0);
          created = true;
          close(true);
        },
      },
    ],
  });
  paint();
  return m.result.then(() => created);
}
