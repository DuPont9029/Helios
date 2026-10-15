// Gemme delle zone Pendulum personalizzate: da un'immagine su sfondo bianco o trasparente
// si ricavano una versione rossa e una blu (PNG piccole con trasparenza), salvate nelle impostazioni.
import { settings } from "./settings.js";

const MAX = 128; // lato massimo delle immagini salvate
const MAX_CHARS = 80000;
const PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const valid = (s) => typeof s === "string" && s.length <= MAX_CHARS && PNG_RE.test(s);

// Tinte: [scura, chiara] di ogni colore (la sfumatura dell'immagine va dall'una all'altra).
const TINTS = {
  red: [[120, 6, 18], [255, 150, 150]],
  blue: [[8, 30, 125], [150, 205, 255]],
};

/** Le gemme salvate { red, blue } se valide, altrimenti null (si usano quelle disegnate in CSS). */
export function pendulumIcons() {
  const v = settings.pendulumIcon;
  return v && valid(v.red) && valid(v.blue) ? { red: v.red, blue: v.blue } : null;
}

/** Converte il file scelto nelle due gemme { red, blue }. */
export async function makePendulumIcons(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, hgt);
  URL.revokeObjectURL(img.src);
  const src = ctx.getImageData(0, 0, w, hgt);
  const px = src.data;
  // Luminosità e opacità di ogni pixel: i pixel quasi bianchi diventano trasparenti (bordo morbido).
  const lum = new Float32Array(w * hgt);
  const alpha = new Float32Array(w * hgt);
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < w * hgt; i++) {
    const [r, g, b, a] = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2], px[i * 4 + 3]];
    const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const white = Math.min(r, g, b) / 255; // quanto il pixel è vicino al bianco
    const k = Math.max(0, Math.min(1, (0.94 - white) / 0.12));
    lum[i] = l;
    alpha[i] = (a / 255) * (white > 0.94 ? 0 : k < 1 ? k : 1);
    if (alpha[i] > 0.1) {
      lo = Math.min(lo, l);
      hi = Math.max(hi, l);
    }
  }
  if (hi < lo) throw new Error("The image looks empty: use a figure on a white or transparent background");
  // Figura di un solo colore (es. sagoma nera): tinta media uniforme.
  const flat = hi - lo <= 0.05;
  const tint = ([dark, light]) => {
    const out = ctx.createImageData(w, hgt);
    for (let i = 0; i < w * hgt; i++) {
      // Le ombre dell'originale restano ombre: dal colore scuro a quello chiaro.
      const t = flat ? 0.55 : Math.max(0, Math.min(1, (lum[i] - lo) / (hi - lo)));
      for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.round(dark[c] + (light[c] - dark[c]) * (0.25 + 0.75 * t));
      out.data[i * 4 + 3] = Math.round(alpha[i] * 255);
    }
    ctx.putImageData(out, 0, 0);
    return canvas.toDataURL("image/png");
  };
  const red = tint(TINTS.red);
  const blue = tint(TINTS.blue);
  if (!valid(red) || !valid(blue)) throw new Error("The image is too detailed: try a simpler one");
  return { red, blue };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => (img.naturalWidth ? resolve(img) : reject(new Error("Unable to read the image")));
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error("Unsupported image format: use a PNG, JPG or WebP"));
    };
    img.src = URL.createObjectURL(file);
  });
}
