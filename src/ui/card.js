// Rendering di una carta: immagine ufficiale se disponibile, altrimenti una
// cornice disegnata in CSS con nome, tipo e statistiche.
import { h } from "./dom.js";
import { getCard, attributeName } from "../data/db.js";
import { imageUrl } from "../data/settings.js";
import { TYPE } from "../core/constants.js";
import { cardRegion } from "../deck/deck.js";

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
  // Immagini da provare: il codice della carta e, per le stampe con codice alternativo (es. Dark Magician
  // Girl 38033120), il codice base, che è quello con cui le pubblica ygoprodeck.
  const sources = [...new Set([c.code, c.alias].filter(Boolean).map(imageUrl))].filter((u) => !failed.has(u));
  if (!sources.length) {
    el.append(fallbackFace(c));
  } else {
    const img = h("img", { src: sources[0], alt: c.name, loading: "lazy", draggable: false, decoding: "async" });
    let i = 0;
    let retried = false;
    img.onerror = () => {
      // Un secondo tentativo dopo poco (il server delle immagini a volte rifiuta le richieste a raffica),
      // poi l'immagine alternativa e infine la cornice disegnata in CSS.
      if (!retried) {
        retried = true;
        setTimeout(() => img.isConnected && (img.src = `${sources[i]}${sources[i].includes("?") ? "&" : "?"}r=1`), 1200);
        return;
      }
      failed.add(sources[i]);
      if (++i < sources.length) {
        retried = false;
        img.src = sources[i];
        return;
      }
      img.replaceWith(fallbackFace(c));
    };
    el.append(img);
  }
  return el;
}

/** Etichetta "OCG"/"TCG" per le carte uscite in una sola regione (null se esiste in entrambe). */
export function regionBadge(code) {
  const r = cardRegion(getCard(code));
  return r ? h(`span.region-badge.${r.toLowerCase()}`, { title: `${r}-only card` }, r) : null;
}
