// Moai: il "pet" ai lati del campo 3D (src/field3d/moai.js). Qui c'è il suo aspetto, salvato nelle impostazioni e
// mandato all'avversario nel "hello" dei duelli online (come lo sleeve): colori, forma del colpo e disegno sulla faccia.
import { settings } from "./settings.js";

export const MOAI_DEFAULT = { stone: "#c9c9cd", eyes: "#38c6ff", flame: "#ff6a1a", shape: "ray", drawing: "" };
// La CPU ha il suo: pietra scura e occhi rossi.
export const MOAI_CPU = { stone: "#9c97a3", eyes: "#ff3b4e", flame: "#ff3b4e", shape: "ray", drawing: "" };
// Forme del colpo dalla bocca (il colore è `flame`).
export const MOAI_SHAPES = { ray: "Beam", flame: "Flame", wave: "Wave", bolt: "Lightning" };

// Disegno sulla faccia: PNG con trasparenza, nelle proporzioni della texture della testa.
export const DRAWING_W = 160;
export const DRAWING_H = 288;
const MAX_CHARS = 60000;
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
