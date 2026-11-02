// Pacchetti del draft: 15 oggetti pescati a caso (uniforme) dal pool del round, rispettando le regole del formato.
// La rarità non conta nella composizione. Regole:
//   apart   (a, b)   i due oggetti mai nello stesso pacchetto
//   atLeast (tag, n) almeno n oggetti con il tag in ogni pacchetto
//   atMost  (tag, n) al massimo n oggetti con il tag in ogni pacchetto
// Sicurezze (dalla guida): con meno di 15 oggetti nel pool si ammettono i doppioni; se una regola non si riesce a
// rispettare in un pacchetto (pool cambiato dopo il controllo) la si toglie per quel pacchetto e lo si annota.
import { PACK_SIZE, roundItems, RULE_KINDS } from "./format.js";

/** Generatore pseudo-casuale con seme (mulberry32): stessi pacchetti da uno stesso seme. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pickOne = (list, rnd) => list[Math.floor(rnd() * list.length)];

/** Un tentativo di pacchetto con tutte le regole date; null se in questo tentativo non si riesce. */
function attempt(pool, rules, rnd) {
  const dupes = pool.length < PACK_SIZE;
  const pack = [];
  const count = (tag) => pack.filter((x) => x.tags.includes(tag)).length;
  const fits = (x) => {
    if (!dupes && pack.includes(x)) return false;
    for (const r of rules) {
      if (r.kind === "apart" && ((x.id === r.a && pack.some((y) => y.id === r.b)) || (x.id === r.b && pack.some((y) => y.id === r.a)))) return false;
      if (r.kind === "atMost" && x.tags.includes(r.tag) && count(r.tag) + 1 > r.n) return false;
    }
    return true;
  };
  // Prima i minimi (in ordine casuale), poi il resto del pacchetto.
  const mins = rules.filter((r) => r.kind === "atLeast").sort(() => rnd() - 0.5);
  for (const r of mins) {
    while (count(r.tag) < r.n && pack.length < PACK_SIZE) {
      const ok = pool.filter((x) => x.tags.includes(r.tag) && fits(x));
      if (!ok.length) return null;
      pack.push(pickOne(ok, rnd));
    }
    if (count(r.tag) < r.n) return null;
  }
  while (pack.length < PACK_SIZE) {
    const ok = pool.filter(fits);
    if (!ok.length) return null;
    pack.push(pickOne(ok, rnd));
  }
  // Mescolato: l'ordine non deve tradire quali oggetti sono arrivati per una regola.
  return pack.sort(() => rnd() - 0.5);
}

function tryRules(pool, rules, rnd, tries) {
  for (let i = 0; i < tries; i++) {
    const p = attempt(pool, rules, rnd);
    if (p) return p;
  }
  return null;
}

/**
 * Pacchetto del round (1 = bundle, 2 = singole). Restituisce { items, dropped } dove dropped sono le regole tolte per
 * riuscire a fare questo pacchetto (vuoto di solito), oppure null se il pool del round è vuoto.
 */
export function makePack(format, round, rnd = Math.random) {
  const pool = roundItems(format, round);
  if (!pool.length) return null;
  const rules = format.rules.filter((r) => r.round === round);
  let active = [...rules];
  const dropped = [];
  for (;;) {
    const items = tryRules(pool, active, rnd, 80);
    if (items) {
      if (dropped.length) console.warn(`Draft: rules dropped for one pack of round ${round}:`, dropped.map(ruleText));
      return { items, dropped };
    }
    // Una regola alla volta, dalla più vincolante (i minimi) finché il pacchetto si fa.
    const next = active.find((r) => r.kind === "atLeast") ?? active.find((r) => r.kind === "atMost") ?? active[0];
    if (!next) return null; // senza regole riesce sempre: qui non si arriva
    active = active.filter((r) => r !== next);
    dropped.push(next);
  }
}

export function ruleText(r, nameOf = (id) => id) {
  if (r.kind === "apart") return `${nameOf(r.a)} and ${nameOf(r.b)} never in the same pack`;
  return `${r.kind === "atLeast" ? "At least" : "At most"} ${r.n} "${r.tag}" per pack`;
}

/**
 * Problemi del formato che ne impediscono il salvataggio: bundle senza abbastanza carte del Main Deck e regole
 * che non si possono rispettare. Restituisce una lista di messaggi (vuota = tutto a posto).
 */
export function formatErrors(f, { bundleMinMain = 2 } = {}) {
  const errs = [];
  for (const b of f.bundles) {
    if (b.main.length < bundleMinMain) errs.push(`Bundle "${b.name}": it needs at least ${bundleMinMain} Main Deck cards (it has ${b.main.length}).`);
  }
  for (const round of [1, 2]) {
    const rules = f.rules.filter((r) => r.round === round);
    if (!rules.length) continue;
    const pool = roundItems(f, round);
    const where = round === 1 ? "Round 1 (bundles)" : "Round 2 (singles)";
    const ids = new Set(pool.map((x) => x.id));
    let broken = false;
    for (const r of rules) {
      if (!RULE_KINDS[r.kind]) continue;
      if (r.kind === "apart" && (!ids.has(r.a) || !ids.has(r.b) || r.a === r.b)) {
        errs.push(`${where}: a "never in the same pack" rule needs two different items of this round.`);
        broken = true;
      }
      if (r.kind !== "apart" && !r.tag) {
        errs.push(`${where}: a rule has no tag.`);
        broken = true;
      }
      if (r.kind === "atLeast" && r.tag && !pool.some((x) => x.tags.includes(r.tag))) {
        errs.push(`${where}: no item has the tag "${r.tag}", so "${ruleText(r)}" can never be met.`);
        broken = true;
      }
    }
    const mins = rules.filter((r) => r.kind === "atLeast").reduce((s, r) => s + r.n, 0);
    if (mins > 15) {
      errs.push(`${where}: the "at least" rules ask for ${mins} items, more than a pack holds (15).`);
      broken = true;
    }
    // Controllo vero: si prova a fare dei pacchetti con tutte le regole.
    if (!broken && pool.length && !tryRules(pool, rules, seededRandom(12345), 300)) {
      errs.push(`${where}: the pack rules cannot all be met with this pool.`);
    }
  }
  return errs;
}

/** Il formato si può usare per un draft? (Pool dei due round non vuoti.) Messaggi per l'host. */
export function readiness(f) {
  const out = [];
  if (f.mode === "bundle") {
    if (!f.bundles.length) out.push("Round 1 has no bundles.");
    if (!f.singles.length) out.push("Round 2 has no single cards.");
  }
  return out;
}
