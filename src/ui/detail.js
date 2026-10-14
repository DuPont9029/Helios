// Pannello laterale con i dettagli di una carta (immagine grande + testo).
import { h, clear } from "./dom.js";
import { cardFace } from "./card.js";
import { getCard, typeLine, statLine, setName } from "../data/db.js";

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
      clear(el).append(
        ...[
        h("div.detail-card", cardFace(code)),
        opts.actions && h("div.detail-actions", opts.actions(code)),
        h("div.detail-name", c.name),
        h("div.detail-type", typeLine(c)),
        statLine(c) && h("div.detail-stats", statLine(c)),
        extra.status && h("div.detail-status", extra.status),
        archetypes.length > 0 && h("div.detail-sets", archetypes.join(" · ")),
        h("div.detail-desc", c.desc),
        h("div.detail-code", `#${c.code}${c.source === 1 ? " · unofficial" : c.source === 2 ? " · pre-release" : ""}`),
        ].filter((n) => n instanceof Node)
      );
    },
    clear() {
      current = null;
    },
  };
}
