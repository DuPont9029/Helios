// Pannello laterale con i dettagli di una carta (immagine grande + testo).
import { h, clear } from "./dom.js";
import { cardFace, regionBadge } from "./card.js";
import { getCard, typeLine, statLine, setName } from "../data/db.js";

// Frecce su/giù (e Pagina su/giù): scorrono il testo della carta mostrata, senza dover portare il mouse sul pannello.
const SCROLL_KEYS = { ArrowDown: 1, ArrowUp: -1, PageDown: 4, PageUp: -4 };
document.addEventListener("keydown", (e) => {
  const dir = SCROLL_KEYS[e.key];
  if (!dir || e.ctrlKey || e.metaKey || e.altKey) return;
  // Nei campi di testo su una riga (es. la ricerca) le frecce su/giù non servono: scorrono la carta.
  if (e.target.closest?.("textarea, select, [contenteditable], input:not([type=search], [type=text], :not([type]))")) return;
  const box = [...document.querySelectorAll(".detail-panel .detail-scroll")].find((x) => x.offsetParent);
  if (!box || box.scrollHeight <= box.clientHeight) return;
  e.preventDefault();
  box.scrollTop += dir * 48;
});

/** @param opts { actions(code) → nodi da mostrare sotto l'immagine (es. pulsanti "+ Main") } */
export function createDetailPanel(opts = {}) {
  const el = h("aside.detail-panel", h("div.detail-empty", "Hover over a card to see its details"));
  let current = null;
  return {
    el,
    show(code, extra = {}) {
      if (!code || code === current) return;
      const c = getCard(code);
      if (!c) return;
      current = code;
      const archetypes = c.setcodes.map(setName).filter(Boolean);
      const only = (nodes) => nodes.filter((n) => n instanceof Node);
      // Immagine e pulsanti restano fermi: scorre solo il testo.
      clear(el).append(
        ...only([
          h("div.detail-card", cardFace(code)),
          opts.actions && h("div.detail-actions", opts.actions(code)),
          h(
            "div.detail-scroll",
            only([
              h("div.detail-name", c.name, regionBadge(code)),
              h("div.detail-type", typeLine(c)),
              statLine(c) && h("div.detail-stats", statLine(c)),
              extra.status && h("div.detail-status", extra.status),
              archetypes.length > 0 && h("div.detail-sets", archetypes.join(" · ")),
              h("div.detail-desc", c.desc),
              h("div.detail-code", `#${c.code}${c.source === 1 ? " · unofficial" : c.source === 2 ? " · pre-release" : ""}`),
            ])
          ),
        ])
      );
    },
    clear() {
      current = null;
    },
  };
}
