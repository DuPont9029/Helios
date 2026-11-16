// Immagine di una carta personalizzata (data/custom-cards.js), disegnata su canvas dai suoi dati con gli asset dello
// stile Yu-Gi-Oh! "Series 10" di Magic Set Editor (src/assets/mse, licenza Apache-2.0: vedi NOTICE.md): cornice del
// tipo, attributo, stelle, segno di Magia/Trappola, frecce Link, riquadro Pendulum. Le posizioni sono quelle dello stile
// (carta di 421×614 punti); si disegna al doppio (842×1228) per un'immagine nitida anche in grande.
// Ogni client la disegna da sé: all'avversario arrivano solo i dati e l'artwork.
import { TYPE, ATTRIBUTES, RACES } from "../core/constants.js";
import sixtyUrl from "../assets/fonts/sixty.ttf?url";

const W = 421;
const H = 614;
const S = 2; // scala del disegno

// Asset (URL; nel file singolo sono già dentro il bundle).
const ASSETS = import.meta.glob("../assets/mse/**/*.{jpg,png}", { eager: true, query: "?url", import: "default" });
const asset = (name) => ASSETS[`../assets/mse/${name}`] ?? null;

const images = new Map();
const loadImage = (src) =>
  new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
/** Immagine degli asset, caricata una volta sola. */
const assetImage = (name) => {
  if (!images.has(name)) images.set(name, loadImage(asset(name)));
  return images.get(name);
};

const FRAMES = [
  [TYPE.LINK, "link"], [TYPE.XYZ, "xyz"], [TYPE.SYNCHRO, "synchro"], [TYPE.FUSION, "fusion"], [TYPE.RITUAL, "ritual"],
  [TYPE.TOKEN, "token"], [TYPE.SPELL, "spell"], [TYPE.TRAP, "trap"],
];
const frameOf = (c) => {
  if (c.look === "token" && c.type & TYPE.MONSTER) return "token";
  const f = FRAMES.find(([bit]) => c.type & bit)?.[1];
  if (f) return f;
  // Mostro Normale solo se non ha effetti né abilità; altrimenti cornice degli effetti.
  return c.type & TYPE.NORMAL && !(c.type & (TYPE.EFFECT | TYPE.TUNER | TYPE.FLIP | TYPE.GEMINI | TYPE.SPIRIT | TYPE.UNION | TYPE.TOON)) ? "normal" : "effect";
};
const attrFile = (a) => ATTRIBUTES.find(([bit]) => a & bit)?.[1].toLowerCase() ?? null;
const raceName = (r) => RACES.find(([bit]) => r & bit)?.[1] ?? "";
const KINDS = [[TYPE.FUSION, "Fusion"], [TYPE.SYNCHRO, "Synchro"], [TYPE.XYZ, "Xyz"], [TYPE.LINK, "Link"], [TYPE.RITUAL, "Ritual"], [TYPE.PENDULUM, "Pendulum"], [TYPE.TUNER, "Tuner"], [TYPE.FLIP, "Flip"], [TYPE.GEMINI, "Gemini"], [TYPE.SPIRIT, "Spirit"], [TYPE.UNION, "Union"], [TYPE.TOON, "Toon"]];
const SPELL_MARKS = [[TYPE.QUICKPLAY, "quickspell"], [TYPE.CONTINUOUS, "continuousspell"], [TYPE.EQUIP, "equipspell"], [TYPE.FIELD, "fieldspell"], [TYPE.RITUAL, "ritualspell"]];
const TRAP_MARKS = [[TYPE.CONTINUOUS, "continuoustrap"], [TYPE.COUNTER, "countertrap"]];
const LINK_MARKERS = [
  [0x40, "ul", 34, 95, 38, 38], [0x100, "ur", 349, 95, 38, 38], [0x1, "dl", 34, 411, 38, 38], [0x4, "dr", 349, 411, 38, 38],
  [0x80, "u", 169, 88, 80, 24], [0x2, "d", 169, 433, 80, 24], [0x8, "l", 26.5, 232, 24, 80], [0x20, "r", 370, 232, 24, 80],
];



// src/ui/card-render.js
// Carattere del nome: Sixty (".ttf", 1998, freeware: si può ridistribuire con il suo readme e senza modificarlo,
// vedi src/assets/fonts/sixty-readme.txt). Si carica una volta, prima di disegnare la prima carta; se non si carica
// si usano i serif di sistema.
const nameFont = new FontFace("Sixty", `url(${sixtyUrl})`);
const fontReady = nameFont.load().then((f) => document.fonts.add(f)).catch(() => null);

// Caratteri di sistema per il resto, uguali per tutti. Quelli delle carte vere (Matrix Small Caps, ITC Stone Serif,
// usati anche da Magic Set Editor) sono commerciali: non si includono e non si cercano tra quelli installati.
const NAME = "Sixty, 'Palatino Linotype', 'Book Antiqua', Palatino, 'Times New Roman', serif";
const SERIF = "'Palatino Linotype', 'Book Antiqua', Palatino, 'Times New Roman', serif";
const TEXT = "Georgia, 'Times New Roman', serif";

/** Testo su una riga dentro il riquadro: si stringe in orizzontale se è troppo lungo. */
function fitLine(g, text, x, y, w, h, font, color, align = "left") {
  g.font = font;
  g.fillStyle = color;
  g.textBaseline = "middle";
  const tw = g.measureText(text).width;
  const k = tw > w ? w / tw : 1;
  g.save();
  g.translate(align === "right" ? x + w - tw * k : align === "center" ? x + (w - tw * k) / 2 : x, y + h / 2);
  g.scale(k, 1);
  g.fillText(text, 0, 0);
  g.restore();
}

/** Nome della carta nella sua barra (31–346 in orizzontale), stretto in orizzontale se non ci sta. */
function nameLine(g, text, color) {
  const x = 33;
  const w = 312;
  g.font = `small-caps 36px ${NAME}`;
  g.textBaseline = "alphabetic";
  const tw = g.measureText(text).width;
  const k = tw > w ? w / tw : 1;
  g.save();
  g.translate(x, 58.5);
  g.scale(k, 1);
  g.fillStyle = color;
  g.strokeStyle = color;
  g.lineWidth = 0.6;
  g.lineJoin = "round";
  g.strokeText(text, 0, 0);
  g.fillText(text, 0, 0);
  g.restore();
}

/** Testo su più righe nel riquadro: il carattere si rimpicciolisce finché ci sta. */
function wrapText(g, text, x, y, w, h, { max, min, family = TEXT, style = "", color = "#000" }) {
  const paras = String(text ?? "").split(/\n/);
  for (let size = max; size >= min; size -= 0.25) {
    g.font = `${style} ${size}px ${family}`;
    const lines = [];
    for (const p of paras) {
      let line = "";
      for (const word of p.split(/\s+/)) {
        const t = line ? `${line} ${word}` : word;
        if (g.measureText(t).width > w && line) {
          lines.push(line);
          line = word;
        } else line = t;
      }
      lines.push(line);
    }
    const lh = size * 1.1;
    if (lines.length * lh <= h || size - 0.25 < min) {
      g.fillStyle = color;
      g.textBaseline = "top";
      lines.slice(0, Math.max(1, Math.floor(h / lh))).forEach((l, i) => g.fillText(l, x, y + i * lh));
      return;
    }
  }
}

/** Immagine dentro un riquadro, tagliata al centro per riempirlo (come "cover"). */
function drawCover(g, img, x, y, w, h) {
  const k = Math.max(w / img.width, h / img.height);
  const sw = w / k;
  const sh = h / k;
  g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

/**
 * Immagine della carta (data URL JPEG, 842×1228) dai dati: { name, desc, pendText, type, attribute, race, level, atk,
 * def, lscale, rscale, linkMarker, art }.
 */
export async function renderCardImage(c, { scale = S, type = "image/jpeg", quality = 0.92 } = {}) {
  await fontReady;
  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const g = canvas.getContext("2d");
  g.scale(scale, scale);
  g.imageSmoothingQuality = "high";
  const monster = !!(c.type & TYPE.MONSTER);
  const link = monster && !!(c.type & TYPE.LINK);
  const xyz = monster && !!(c.type & TYPE.XYZ);
  const pendulum = monster && !link && !!(c.type & TYPE.PENDULUM);
  const frame = frameOf(c);
  const [frameImg, pendImg, artImg] = await Promise.all([assetImage(`frames/${frame}.jpg`), pendulum ? assetImage("pendulum.png") : null, loadImage(c.art)]);

  // cornice
  if (frameImg) g.drawImage(frameImg, 0, 0, W, H);
  else {
    g.fillStyle = "#333";
    g.fillRect(0, 0, W, H);
  }

  // artwork (o un motivo al suo posto)
  const art = pendulum ? [27, 109, 368, 344.5] : [49, 111.5, 323, 323];
  if (artImg) drawCover(g, artImg, ...art);
  else {
    const [ax, ay, aw, ah] = art;
    const grad = g.createRadialGradient(ax + aw / 2, ay + ah / 2, 10, ax + aw / 2, ay + ah / 2, aw * 0.7);
    grad.addColorStop(0, "#3a4a6a");
    grad.addColorStop(1, "#0b0d14");
    g.fillStyle = grad;
    g.fillRect(ax, ay, aw, ah);
    fitLine(g, "◆", ax, ay, aw, ah, `64px ${SERIF}`, "rgba(255,255,255,0.3)", "center");
  }
  // Pendulum: il riquadro (scale e testo) sta sopra la parte bassa dell'artwork, come in Magic Set Editor
  if (pendImg) g.drawImage(pendImg, 0, 0, W, H);

  // nome: appoggiato su una linea di base che mette le maiuscole al centro della barra (y 23–70 della cornice), non
  // centrato sul riquadro (con le maiuscoletto il testo sembrerebbe in alto); peso normale con un contorno sottile,
  // più vicino al Matrix Small Caps delle carte vere (non incluso: carattere commerciale)
  const light = xyz || link || frame === "spell" || frame === "trap";
  nameLine(g, c.name || "Custom card", light ? "#fff" : "#000");

  // attributo (o SPELL / TRAP)
  const attr = monster ? attrFile(c.attribute) : frame;
  const attrImg = attr ? await assetImage(`attribute/${attr}.png`) : null;
  // centrato in altezza sulla barra del nome e grande quasi quanto lei
  if (attrImg) g.drawImage(attrImg, 350.5, 25, 43, 43);

  // stelle (Rank a sinistra per gli Xyz) o segno di Magia/Trappola
  if (monster && !link && c.level > 0) {
    const star = await assetImage(xyz ? "xyzstar.png" : "star.png");
    const n = Math.min(c.level, 13);
    // Fino a 12 nello spazio dello stile (48–379.5); 13 come sulle carte vere: la fila si allarga a quasi tutta la
    // larghezza della carta (16–377), stelle un po' più piccole.
    const [left, width, size, top] = n === 13 ? [16, 361, 24.5, 77.5] : [48, 331.5, 26, 76.5];
    const step = n === 13 ? (width - size) / 12 : Math.min(size + 1.5, width / n);
    for (let i = 0; i < n; i++) {
      const x = xyz ? left + i * step : left + width - size - i * step;
      if (star) g.drawImage(star, x, top, size, size);
    }
  } else if (!monster) {
    const list = frame === "spell" ? SPELL_MARKS : TRAP_MARKS;
    const name = list.find(([bit]) => c.type & bit)?.[1] ?? (frame === "spell" ? "normalspell" : "normaltrap");
    const mark = await assetImage(`marks/${name}.png`);
    if (mark) {
      const h = 26;
      const w = (mark.width / mark.height) * h;
      g.drawImage(mark, 48 + 331.5 - w, 76.5, w, h);
    }
  }

  // frecce Link
  if (link) {
    for (const [bit, file, x, y, w, h] of LINK_MARKERS) {
      const img = await assetImage(`link/${file}${c.linkMarker & bit ? "" : "_off"}.png`);
      if (img) g.drawImage(img, x, y, w, h);
    }
  }

  // Pendulum: scale e testo del riquadro
  if (pendulum) {
    fitLine(g, String(c.lscale ?? 0), 31.5, 421.5, 25, 19, `small-caps bold 19px ${SERIF}`, "#000", "center");
    fitLine(g, String(c.rscale ?? 0), 364.5, 421.5, 25, 19, `small-caps bold 19px ${SERIF}`, "#000", "center");
    if (c.pendText) wrapText(g, c.pendText, 66, 389, 288, 60, { max: 10.5, min: 5 });
  }

  // tipo del mostro e testo
  if (monster) {
    const kinds = KINDS.filter(([bit]) => c.type & bit).map(([, n]) => n);
    if (frame === "token") kinds.push("Token");
    else if (frame !== "normal") kinds.push("Effect");
    else kinds.push("Normal");
    fitLine(g, `[${[raceName(c.race) || "Monster", ...new Set(kinds)].join(" / ")}]`, 33, 464.5, 353, 14, `small-caps bold 13px ${SERIF}`, "#000");
    wrapText(g, c.desc, 33, 483, 353, 73, { max: 10.5, min: 5, style: frame === "normal" ? "italic" : "" });
    const v = (n) => (n < 0 ? "?" : String(n ?? 0));
    fitLine(g, v(c.atk), 265, 563, 37, 13, `bold 14px ${SERIF}`, "#000", "right");
    if (link) fitLine(g, String(c.level || 1), 374, 563, 13, 13, `bold 13px ${SERIF}`, "#000", "center");
    else fitLine(g, v(c.def), 349, 563, 37, 13, `bold 14px ${SERIF}`, "#000", "right");
  } else {
    wrapText(g, c.desc, 33, 464, 353, 107.5, { max: 10.5, min: 5 });
  }

  // numero della carta: è una carta personalizzata
  fitLine(g, "HELIOS-CUSTOM", pendulum ? 35 : link ? 269.5 : 302, pendulum ? 563 : 442, 74, 10, `10px ${TEXT}`, light && !pendulum ? "#fff" : "#000", pendulum ? "left" : "right");
  return canvas.toDataURL(type, quality);
}

const webp = (() => {
  try {
    return document.createElement("canvas").toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    return false;
  }
})();

/** Immagine ridotta (al massimo size×size, proporzioni mantenute) in WebP o JPEG: data URL. */
async function shrink(src, size, quality) {
  const img = await loadImage(src);
  if (!img) throw new Error("This file is not an image");
  const k = Math.min(1, size / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * k));
  canvas.height = Math.max(1, Math.round(img.height * k));
  const g = canvas.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(webp ? "image/webp" : "image/jpeg", quality);
}

/**
 * Artwork caricato dall'utente, alla qualità più alta che conviene tenere: fino a 1200 px di lato (il riquadro della
 * carta disegnata è di circa 740 px), proporzioni originali (la carta lo taglia al centro), WebP o JPEG al 95%.
 */
export async function artFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    return await shrink(url, 1200, 0.95);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Artwork più leggero per mandarlo all'avversario o metterlo in un replay (size px, qualità). */
export const compactArt = (art, size = 420, quality = 0.85) => shrink(art, size, quality);
