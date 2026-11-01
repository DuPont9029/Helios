// Moai: il "pet" ai lati del campo 3D (src/field3d/moai.js). Qui c'è il suo aspetto, salvato nelle impostazioni e
// mandato all'avversario nel "hello" dei duelli online (come lo sleeve): colori, forma del colpo e disegno sulla faccia.
import { settings } from "./settings.js";

export const MOAI_DEFAULT = { stone: "#c9c9cd", eyes: "#38c6ff", flame: "#ff6a1a", shape: "ray", drawing: "" };
// La CPU ha il suo: pietra scura e occhi rossi.
export const MOAI_CPU = { stone: "#9c97a3", eyes: "#ff3b4e", flame: "#ff3b4e", shape: "ray", drawing: "" };
// Forme del colpo dalla bocca (il colore è `flame`).
export const MOAI_SHAPES = { ray: "Beam", flame: "Flame", wave: "Wave", bolt: "Lightning" };

// Disegno sulla testa: PNG con trasparenza su tutta la texture, aperta come un cubo: al centro la faccia, sopra la cima,
// sotto il mento, ai lati i fianchi e a destra la nuca (unità della testa: larghezza 2, altezza 3.6, profondità 1.5).
export const DRAWING_W = 448;
export const DRAWING_H = 424;
const UW = 7; // unità in larghezza: fianco 1.5 + faccia 2 + fianco 1.5 + nuca 2
const UH = 6.6; // unità in altezza: cima 1.5 + faccia 3.6 + mento 1.5
const rect = (x, y, w, hgt) => ({ x: (x / UW) * DRAWING_W, y: (y / UH) * DRAWING_H, w: (w / UW) * DRAWING_W, h: (hgt / UH) * DRAWING_H });
/** Zone della texture in pixel (y dall'alto). */
export const DRAWING_RECTS = {
  left: rect(0, 1.5, 1.5, 3.6),
  face: rect(1.5, 1.5, 2, 3.6),
  right: rect(3.5, 1.5, 1.5, 3.6),
  back: rect(5, 1.5, 2, 3.6),
  top: rect(1.5, 0, 2, 1.5),
  bottom: rect(1.5, 5.1, 2, 1.5),
};
// Disegni fatti prima (solo la faccia, 160 × 288): vanno nella zona della faccia.
const OLD_W = 160;
const OLD_H = 288;
const MAX_CHARS = 90000;
const PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Aspetto valido (anche quello ricevuto dall'avversario): i campi mancanti o sbagliati tornano quelli predefiniti. */
export function validMoai(v) {
  if (!v || typeof v !== "object") return null;
  const color = (k) => (typeof v[k] === "string" && COLOR_RE.test(v[k]) ? v[k].toLowerCase() : MOAI_DEFAULT[k]);
  return {
    stone: color("stone"),
    eyes: color("eyes"),
    flame: color("flame"),
    shape: Object.hasOwn(MOAI_SHAPES, v.shape) ? v.shape : "ray",
    drawing: typeof v.drawing === "string" && v.drawing.length <= MAX_CHARS && PNG_RE.test(v.drawing) ? v.drawing : "",
  };
}

/** Il proprio Moai (Settings → Field). */
export function moaiConfig() {
  return validMoai(settings.moai) ?? { ...MOAI_DEFAULT };
}

/** Disegna `img` (immagine o tela) su una tela di w × h con la disposizione di DRAWING_RECTS (i disegni vecchi sulla faccia). */
export function drawDrawing(ctx, img, w, hgt) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (iw === OLD_W && ih === OLD_H) {
    const f = DRAWING_RECTS.face;
    const k = w / DRAWING_W;
    ctx.drawImage(img, f.x * k, f.y * (hgt / DRAWING_H), f.w * k, f.h * (hgt / DRAWING_H));
  } else ctx.drawImage(img, 0, 0, w, hgt);
}

/** Il disegno della tela (DRAWING_W × DRAWING_H) come PNG; "" se è vuoto. Lancia un errore se è troppo grande. */
export function drawingFrom(canvas) {
  const px = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let empty = true;
  for (let i = 3; i < px.length; i += 4) if (px[i]) { empty = false; break; }
  if (empty) return "";
  const url = canvas.toDataURL("image/png");
  if (url.length > MAX_CHARS) throw new Error("The drawing is too detailed: try a simpler one");
  return url;
}
