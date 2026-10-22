// Banlist sempre aggiornate, anche nel file singolo: all'avvio (al massimo ogni CHECK_EVERY) si guarda
// l'ultimo commit di ProjectIgnis/LFLists; se è diverso da quello dei dati del client si scaricano i file
// .lflist.conf e le banlist nuove sostituiscono quelle incluse, salvate nel browser per gli avvii seguenti.
// Senza rete (o con GitHub che non risponde) restano quelle che ci sono.
import { db } from "./db.js";
import { parseLflist, sortBanlists } from "./lflist.js";

const KEY = "ygoweb.banlists";
const REPO = "ProjectIgnis/LFLists";
const CHECK_EVERY = 6 * 60 * 60 * 1000;

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "null");
    return c && Array.isArray(c.lists) ? c : null;
  } catch {
    return null;
  }
}
function writeCache(c) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* storage pieno o non disponibile: si riscaricano al prossimo avvio */
  }
}

/**
 * Da chiamare dopo loadDatabase: usa subito le banlist già scaricate, poi (senza bloccare) controlla se ce
 * ne sono di nuove. Restituisce una Promise con true se le banlist sono cambiate.
 */
/** Le banlist che non vengono da LFLists (es. Master Duel, aggiunta da build-data) restano quelle dei dati. */
function withExtra(lists, bundled) {
  const extra = bundled.filter((l) => !String(l.file).endsWith(".lflist.conf"));
  const out = lists.filter((l) => String(l.file).endsWith(".lflist.conf"));
  out.splice(out.filter((l) => /TCG|OCG/.test(l.file)).length, 0, ...extra);
  return out;
}

export async function updateBanlists({ force = false } = {}) {
  const shipped = db.banlists ?? [];
  const bundled = db.manifest?.repos?.LFLists ?? null;
  // Banlist scaricate prima: valgono solo con gli stessi dati del client (base). Dati nuovi (sito aggiornato,
  // un altro file singolo) possono avere banlist più recenti: si ricontrolla da capo.
  let cache = readCache();
  if (cache && cache.base !== bundled) cache = null;
  if (cache?.lists.length && cache.sha !== bundled) db.banlists = withExtra(cache.lists, shipped);
  if (!force && cache && Date.now() - (cache.checked ?? 0) < CHECK_EVERY) return false;
  try {
    const head = await fetch(`https://api.github.com/repos/${REPO}/commits/HEAD`, { cache: "no-store" });
    if (!head.ok) throw new Error(`GitHub ${head.status}`);
    const sha = (await head.json()).sha;
    if (sha === (cache?.sha ?? bundled)) {
      writeCache({ ...(cache ?? { sha, lists: [] }), base: bundled, checked: Date.now() });
      return false;
    }
    const dir = await fetch(`https://api.github.com/repos/${REPO}/contents/?ref=${sha}`);
    if (!dir.ok) throw new Error(`GitHub ${dir.status}`);
    const files = (await dir.json()).map((f) => f.name).filter((n) => n.endsWith(".lflist.conf")).sort();
    const texts = await Promise.all(
      files.map((f) => fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${encodeURIComponent(f)}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${f}: ${r.status}`)))))
    );
    const lists = sortBanlists(files.flatMap((f, i) => parseLflist(texts[i], f)));
    if (!lists.length) throw new Error("no banlists in the repository");
    writeCache({ sha, base: bundled, checked: Date.now(), lists: sha === bundled ? [] : lists });
    db.banlists = withExtra(lists, shipped);
    return true;
  } catch (e) {
    console.warn("Banlist update:", e.message);
    if (cache) writeCache({ ...cache, checked: Date.now() });
    return false;
  }
}
