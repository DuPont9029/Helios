// Banlist di EDOPro (file .lflist.conf di ProjectIgnis/LFLists): usato sia da scripts/build-data.mjs
// sia dall'aggiornamento automatico nel client (src/data/banlist-update.js). Niente dipendenze.

/** Banlist di un file .lflist.conf: [{ name, file, whitelist, cards: { codice: limite } }]. */
export function parseLflist(text, file) {
  const lists = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      cur = { name: line.slice(1).trim(), file, whitelist: false, cards: {} };
      lists.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("$whitelist")) {
      cur.whitelist = true;
      continue;
    }
    const m = line.match(/^(\d+)\s+(-?\d+)/);
    if (m) cur.cards[m[1]] = parseInt(m[2], 10);
  }
  return lists;
}

/** Le banlist "correnti" (TCG/OCG) prima, poi le altre (ordine dei file mantenuto). */
export function sortBanlists(lists) {
  const rank = (l) => (/TCG/.test(l.file) ? 0 : /OCG/.test(l.file) ? 1 : 2);
  return [...lists].sort((a, b) => rank(a) - rank(b));
}
