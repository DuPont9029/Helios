// Sleeve personalizzato: un'immagine scelta dall'utente come dorso delle proprie carte.
// Viene ridotta a una piccola JPEG (proporzioni della carta) così si salva nel browser e,
// nei duelli online, si manda all'avversario insieme al mazzo.

const W = 236;
const H = 344; // 59:86, come le carte
const MAX_CHARS = 60000; // ~45 KB di immagine: passa tranquillamente nel canale dati WebRTC
const SLEEVE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Restituisce lo sleeve se è un'immagine valida e non troppo grande, altrimenti null (anche per quelli ricevuti in rete). */
export function validSleeve(s) {
  return typeof s === "string" && s.length <= MAX_CHARS && SLEEVE_RE.test(s) ? s : null;
}

/** Ritaglia l'immagine nelle proporzioni della carta (riempiendo, come "cover") e la comprime in JPEG. */
export async function makeSleeve(file) {
  const img = await loadImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const hgt = img.naturalHeight * scale;
  ctx.drawImage(img, (W - w) / 2, (H - hgt) / 2, w, hgt);
  URL.revokeObjectURL(img.src);
  for (const q of [0.85, 0.75, 0.6, 0.45, 0.3]) {
    const url = canvas.toDataURL("image/jpeg", q);
    if (url.length <= MAX_CHARS) return url;
  }
  throw new Error("The image is too detailed: try a simpler one");
}

/** Carica il file come <img>: decodifica tutti i formati che il browser sa mostrare (anche HEIC su Safari). */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => (img.naturalWidth ? resolve(img) : reject(new Error("Unable to read the image")));
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error("Unsupported image format: use a JPG, PNG or WebP"));
    };
    img.src = URL.createObjectURL(file);
  });
}

/**
 * Applica gli sleeve dei due giocatori (indici del core) a tutta la pagina, comprese le finestre
 * fuori dal campo. Le carte coperte con data-owner="p" usano lo sleeve di p. Restituisce la funzione di pulizia.
 */
export function applySleeves(sleeves) {
  const root = document.documentElement;
  [0, 1].forEach((p) => {
    const s = validSleeve(sleeves?.[p]);
    root.classList.toggle(`has-sleeve-${p}`, !!s);
    if (s) root.style.setProperty(`--sleeve-${p}`, `url("${s}")`);
    else root.style.removeProperty(`--sleeve-${p}`);
  });
  return () => applySleeves([null, null]);
}
