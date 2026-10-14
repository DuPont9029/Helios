// Rendering di una carta: immagine ufficiale se disponibile, altrimenti una
// cornice disegnata in CSS con nome, tipo e statistiche.
import { h } from "./dom.js";
import { getCard, attributeName } from "../data/db.js";
import { imageUrl } from "../data/settings.js";
import { TYPE } from "../core/constants.js";

const failed = new Set();

export function frameClass(c) {
  if (!c) return "frame-back";
  const t = c.type;
  if (t & TYPE.SPELL) return "frame-spell";
  if (t & TYPE.TRAP) return "frame-trap";
  if (t & TYPE.TOKEN) return "frame-token";
  if (t & TYPE.LINK) return "frame-link";
  if (t & TYPE.XYZ) return "frame-xyz";
  if (t & TYPE.SYNCHRO) return "frame-synchro";
  if (t & TYPE.FUSION) return "frame-fusion";
  if (t & TYPE.RITUAL) return "frame-ritual";
  if (t & TYPE.NORMAL) return "frame-normal";
  return "frame-effect";
}

function fallbackFace(c) {
  const stars = c.type & TYPE.MONSTER && !(c.type & TYPE.LINK) ? "★".repeat(Math.min(c.level, 12)) : "";
  const v = (n) => (n < 0 ? "?" : n);
  return h(
    "div.card-fallback",
    h("div.cf-name", c.name),
    h("div.cf-attr", c.type & TYPE.MONSTER ? attributeName(c.attribute) : c.type & TYPE.SPELL ? "SPELL" : "TRAP"),
    stars && h("div.cf-stars", stars),
    h("div.cf-art"),
    h("div.cf-text", c.desc.slice(0, 160)),
    (c.type & TYPE.MONSTER) !== 0 && h("div.cf-stats", c.type & TYPE.LINK ? `ATK/${v(c.atk)} LINK-${c.level}` : `ATK/${v(c.atk)} DEF/${v(c.def)}`)
  );
}

/**
 * @param code     codice carta (0/null = dorso)
 * @param opts     { faceDown, small }
 */
export function cardFace(code, opts = {}) {
  const c = code ? getCard(code) : null;
  const el = h("div.card", { dataset: { code: code || 0 } });
  if (!c || opts.faceDown) {
    el.classList.add("back");
    el.append(h("div.card-back"));
    return el;
  }
  el.classList.add(frameClass(c));
  const src = imageUrl(c.code);
  if (failed.has(src)) {
    el.append(fallbackFace(c));
  } else {
    const img = h("img", { src, alt: c.name, loading: "lazy", draggable: false, decoding: "async" });
    img.onerror = () => {
      failed.add(src);
      img.replaceWith(fallbackFace(c));
    };
    el.append(img);
  }
  return el;
}
