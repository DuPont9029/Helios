// Formato compatto prodotto da scripts/build-data.mjs (una riga per carta).
// Condiviso tra thread principale, worker del motore e script Node.
import { TYPE } from "./constants.js";

export function parseCard(row) {
  const [code, ot, alias, setcodes, type, atk, def, rawLevel, race, attribute, category, name, desc, strings, src] = row;
  const isLink = (type & TYPE.LINK) !== 0;
  return {
    code,
    ot,
    alias,
    setcodes,
    type,
    atk,
    def: isLink ? 0 : def,
    level: rawLevel & 0xff,
    lscale: (rawLevel >>> 24) & 0xff,
    rscale: (rawLevel >>> 16) & 0xff,
    linkMarker: isLink ? def : 0,
    race,
    attribute,
    category,
    name,
    desc,
    strings,
    // 0 = ufficiale, 1 = non ufficiale (anime/custom), 2 = pre-release
    source: src,
  };
}

// Converte una carta nel formato OcgCardData atteso da ocgcore-wasm.
export function toCoreCard(c) {
  return {
    code: c.code,
    alias: c.alias,
    setcodes: c.setcodes,
    type: c.type,
    level: c.level,
    attribute: c.attribute,
    race: BigInt(c.race),
    attack: c.atk,
    defense: c.def,
    lscale: c.lscale,
    rscale: c.rscale,
    link_marker: c.linkMarker,
  };
}
