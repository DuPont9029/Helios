// Esporta un mazzo come immagine PNG (Main, Extra e Side Deck in griglia, con il nome del mazzo e i conteggi).
// Le immagini delle carte non hanno CORS: per disegnarle in un canvas esportabile passano dal proxy di immagini
// wsrv.nl (aggiunge Access-Control-Allow-Origin). Una carta che non si carica diventa un riquadro con il nome.
import { getCard } from "../data/db.js";
import { imageUrl } from "../data/settings.js";
import { TYPE } from "../core/constants.js";
import { frameClass } from "./card.js";

const CW = 140; // larghezza di una carta
const CH = Math.round(CW * 1.458);
const GAP = 6;
const COLS = 10;
const PAD = 28;
const FRAME = {
  "frame-spell": "#1d9e8c", "frame-trap": "#b0457c", "frame-link": "#2f78d0", "frame-xyz": "#3a3a3a", "frame-synchro": "#d8d8d8",
  "frame-fusion": "#8a5aa8", "frame-ritual": "#4f7fd0", "frame-normal": "#d8b45a", "frame-effect": "#c8743a",
};

const proxied = (code) => `https://wsrv.nl/?url=${encodeURIComponent(imageUrl(code))}&w=${CW * 2}&output=jpg`;

function loadImage(code) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = proxied(code);
  });
}

function wrapName(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

/** Disegna il mazzo e lo scarica come "<nome>.png". */
export async function exportDeckImage(deck) {
  const parts = [
    ["Main Deck", deck.main ?? []],
    ["Extra Deck", deck.extra ?? []],
    ["Side Deck", deck.side ?? []],
  ].filter(([, codes]) => codes.length);
  const rows = (n) => Math.ceil(n / COLS);
  const HEAD = 56;
  const SEC = 34;
  const width = PAD * 2 + COLS * CW + (COLS - 1) * GAP;
  const height = PAD * 2 + HEAD + parts.reduce((a, [, codes]) => a + SEC + rows(codes.length) * (CH + GAP), 0);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#0d1220");
  bg.addColorStop(1, "#06080e");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const codes = [...new Set(parts.flatMap(([, c]) => c))];
  const images = new Map(await Promise.all(codes.map(async (c) => [c, await loadImage(c)])));

  ctx.fillStyle = "#ffffff";
  ctx.font = "700 32px sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText(deck.name || "Deck", PAD, PAD);
  ctx.fillStyle = "#38c6ff";
  ctx.font = "600 14px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("Helios", width - PAD, PAD + 10);
  ctx.textAlign = "left";

  let y = PAD + HEAD;
  for (const [label, list] of parts) {
    const n = (t) => list.filter((c) => getCard(c)?.type & t).length;
    const counts = label === "Extra Deck"
      ? [["Fusion", n(TYPE.FUSION)], ["Synchro", n(TYPE.SYNCHRO)], ["Xyz", n(TYPE.XYZ)], ["Link", n(TYPE.LINK)]]
      : [["Monsters", n(TYPE.MONSTER)], ["Spells", n(TYPE.SPELL)], ["Traps", n(TYPE.TRAP)]];
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 20px sans-serif";
    ctx.fillText(`${label} (${list.length})`, PAD, y + 4);
    ctx.fillStyle = "#9aa3b2";
    ctx.font = "500 14px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(counts.filter(([, k]) => k).map(([t, k]) => `${t} ${k}`).join(" · "), width - PAD, y + 8);
    ctx.textAlign = "left";
    y += SEC;
    list.forEach((code, i) => {
      const x = PAD + (i % COLS) * (CW + GAP);
      const cy = y + Math.floor(i / COLS) * (CH + GAP);
      const img = images.get(code);
      if (img) ctx.drawImage(img, x, cy, CW, CH);
      else {
        const c = getCard(code);
        ctx.fillStyle = FRAME[frameClass(c)] ?? "#555";
        ctx.fillRect(x, cy, CW, CH);
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(x + 6, cy + 6, CW - 12, CH - 12);
        ctx.fillStyle = "#fff";
        ctx.font = "600 13px sans-serif";
        wrapName(ctx, c?.name ?? `#${code}`, CW - 20).forEach((line, k) => ctx.fillText(line, x + 10, cy + 12 + k * 16));
      }
    });
    y += rows(list.length) * (CH + GAP);
  }

  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(deck.name || "deck").replace(/[\\/:*?"<>|]+/g, "").trim() || "deck"}.png`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
