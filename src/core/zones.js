import { LOC } from "./constants.js";

/**
 * Zone selezionabili da SELECT_PLACE / SELECT_DISFIELD.
 * field_mask ha un bit a 1 per ogni zona NON disponibile: bit 0-6 zone mostri,
 * 8-15 zone magie/trappole del giocatore che sceglie, +16 per l'avversario.
 */
export function availableZones(msg) {
  const out = [];
  const mask = msg.field_mask >>> 0;
  for (const [rel, shift] of [[0, 0], [1, 16]]) {
    const player = rel === 0 ? msg.player : 1 - msg.player;
    for (let s = 0; s < 7; s++) {
      if (!(mask & (1 << (shift + s)))) out.push({ player, location: LOC.MZONE, sequence: s });
    }
    for (let s = 0; s < 8; s++) {
      if (!(mask & (1 << (shift + 8 + s)))) out.push({ player, location: LOC.SZONE, sequence: s });
    }
  }
  return out;
}
