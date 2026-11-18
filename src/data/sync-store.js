// Registro locale delle modifiche a mazzi, combo e spreadsheet, per il backup sul profilo Nostr
// (net/profile-sync.js). Ogni elemento ha una chiave "tipo:id" (deck, combo, sheet) e l'ora dell'ultima modifica
// fatta in questo browser; le cancellazioni restano come "lapidi" così non ricompaiono dagli altri browser.
//
// I salvataggi passano da mergeForSave: le pagine tengono in memoria la loro copia dell'elenco, e il backup può
// ripristinare elementi mentre sono aperte. Per non perderli, chi salva non cancella mai per omissione (si cancella
// solo con forgetItems) e una copia vecchia di un elemento appena ripristinato non sovrascrive quella nuova.

const TIMES = "ygoweb.syncTimes"; // { "tipo:id": ms }
const DELETED = "ygoweb.syncDeleted"; // { "tipo:id": { at, sent } }

const read = (k) => {
  try {
    const v = JSON.parse(localStorage.getItem(k) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage non disponibile */
  }
};

export const syncTimes = () => read(TIMES);
export const syncDeleted = () => read(DELETED);
export const setSyncTimes = (v) => write(TIMES, v);
export const setSyncDeleted = (v) => write(DELETED, v);

// versione locale sostituita da un ripristino (JSON): se una pagina aperta la risalva, vince quella ripristinata
const replaced = new Map();
export const noteReplaced = (key, item) => replaced.set(key, JSON.stringify(item));

const changed = (detail) => window.dispatchEvent(new CustomEvent("helios-store-change", { detail }));

/**
 * L'elenco da salvare per il tipo indicato: quello nuovo, più gli elementi già salvati che mancano (non cancellati
 * esplicitamente). Segna l'ora degli elementi nuovi o modificati e avvisa il backup.
 */
export function mergeForSave(type, prev, next) {
  const times = syncTimes();
  const dead = syncDeleted();
  const before = new Map((prev ?? []).filter((x) => x?.id).map((x) => [x.id, x]));
  const out = [];
  const ids = new Set();
  let touched = false;
  for (const item of next) {
    if (!item?.id) {
      out.push(item);
      continue;
    }
    const key = `${type}:${item.id}`;
    ids.add(item.id);
    const json = JSON.stringify(item);
    const old = before.get(item.id);
    if (old && replaced.get(key) === json) {
      out.push(old); // copia vecchia di una pagina aperta prima del ripristino
      continue;
    }
    out.push(item);
    if (!old || JSON.stringify(old) !== json) {
      times[key] = Date.now();
      delete dead[key];
      touched = true;
      changed({ type, id: item.id });
    }
  }
  for (const [id, old] of before) if (!ids.has(id) && !dead[`${type}:${id}`]) out.push(old);
  if (touched) {
    setSyncTimes(times);
    setSyncDeleted(dead);
  }
  return out;
}

/** Cancellazione esplicita: da fare prima di salvare l'elenco senza quegli elementi. */
export function forgetItems(type, ids) {
  const times = syncTimes();
  const dead = syncDeleted();
  const at = Date.now();
  for (const id of ids) {
    const key = `${type}:${id}`;
    delete times[key];
    dead[key] = { at, sent: false };
  }
  setSyncTimes(times);
  setSyncDeleted(dead);
  for (const id of ids) changed({ type, id, deleted: true });
}
