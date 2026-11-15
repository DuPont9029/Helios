// API Lua di EDOPro per l'editor degli script delle carte personalizzate (ui/script-editor.js): autocompletamento e
// suggerimenti. Ricavata dagli script di ProjectIgnis già in public/data/script:
//  - costanti (constant.lua e gli altri file di costanti): nome, valore, commento;
//  - funzioni scritte in Lua (utility.lua, proc_*.lua...): "function Duel.Foo(a,b)" con i loro parametri;
//  - funzioni del motore (in C++, senza firma nei file): da come le usano gli script delle carte, con quante volte e
//    l'esempio di chiamata più comune (es. Duel.Draw(tp,1,REASON_EFFECT)).
// Uso: node scripts/build-lua-api.mjs (lo chiama anche build-data.mjs). Scrive public/data/lua-api.json.
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(import.meta.dirname, "..", "public", "data", "script");
const OUT = path.resolve(import.meta.dirname, "..", "public", "data", "lua-api.json");

// Variabili che negli script indicano di solito un effetto, una carta o un gruppo (per i metodi "x:Foo(").
const KIND = [
  [/^(e\d*|te|re|ce|ae|eff|effect|e_|ef)$/, "Effect"],
  [/^(g|sg|mg|tg|dg|og|rg|hg|cg|fg|ag|bg|eg|pg|gg|sg\d|g\d|mat|mats|group)$/, "Group"],
  [/^(c|tc|rc|hc|mc|sc|fc|bc|ac|dc|ec|oc|pc|xc|lc|cc|tc\d|c\d|card|handler)$/, "Card"],
];
const NAMESPACES = ["Duel", "Card", "Effect", "Group", "aux", "Auxiliary", "Fusion", "Synchro", "Xyz", "Link", "Ritual", "Pendulum", "Spirit", "Gemini", "Union", "Equip", "Maximum", "Debug"];

export function buildLuaApi() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".lua"));
  const lib = files.filter((f) => !/^c\d+\.lua$/.test(f));
  const cards = files.filter((f) => /^c\d+\.lua$/.test(f));

  // costanti
  const constants = {};
  for (const f of lib.filter((f) => /constant/.test(f))) {
    for (const line of fs.readFileSync(path.join(DIR, f), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z][A-Z0-9_]+)\s*=\s*([^-\n]+?)\s*(?:--\s*(.*))?$/);
      if (m) constants[m[1]] = [m[2].trim().slice(0, 40), (m[3] ?? "").trim().slice(0, 120)];
    }
  }

  // funzioni scritte in Lua: firma vera
  const fns = {}; // "Duel.Foo" → { params, n, ex }
  const add = (key) => (fns[key] ??= { params: null, n: 0, ex: null, exs: new Map() });
  for (const f of lib) {
    const text = fs.readFileSync(path.join(DIR, f), "utf8");
    for (const m of text.matchAll(/function\s+([A-Za-z_]+)([.:])([A-Za-z_]\w*)\s*\(([^)]*)\)/g)) {
      const ns = m[1] === "Auxiliary" ? "aux" : m[1];
      if (!NAMESPACES.includes(m[1])) continue;
      const key = m[2] === ":" ? `${ns}:${m[3]}` : `${ns}.${m[3]}`;
      add(key).params = m[4].replace(/\s+/g, "");
    }
  }

  // uso negli script delle carte (anche le funzioni del motore, che non hanno firma nei file)
  const call = /\b(Duel|aux|Fusion|Synchro|Xyz|Link|Ritual|Pendulum|Spirit|Gemini|Union|Equip|Maximum|Card|Effect|Group)\.([A-Za-z_]\w*)\s*\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
  const method = /\b([a-z_]\w*):([A-Z]\w*)\s*\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
  const seen = (key, args) => {
    const x = add(key);
    x.n++;
    const a = args.replace(/\s+/g, "");
    if (a.length <= 90) x.exs.set(a, (x.exs.get(a) ?? 0) + 1);
  };
  for (const f of cards) {
    const text = fs.readFileSync(path.join(DIR, f), "utf8");
    for (const m of text.matchAll(call)) seen(`${m[1]}.${m[2]}`, m[3]);
    for (const m of text.matchAll(method)) {
      const kind = KIND.find(([re]) => re.test(m[1]))?.[1];
      if (kind) seen(`${kind}:${m[2]}`, m[3]);
    }
  }
  // Card.Foo(c,...) e c:Foo(...) sono la stessa funzione: si tiene la forma con i due punti.
  for (const ns of ["Card", "Effect", "Group"]) {
    for (const key of Object.keys(fns).filter((k) => k.startsWith(`${ns}.`))) {
      const m = add(`${ns}:${key.slice(ns.length + 1)}`);
      const d = fns[key];
      m.n += d.n;
      m.params ??= d.params?.replace(/^[^,]*,?/, "") ?? null;
      for (const [a, k] of d.exs) m.exs.set(a.replace(/^[^,]*,?/, ""), (m.exs.get(a) ?? 0) + k);
      delete fns[key];
    }
  }
  const functions = {};
  for (const [key, d] of Object.entries(fns)) {
    if (!d.n && d.params == null) continue;
    const ex = [...d.exs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    functions[key] = [d.params, d.n, ex];
  }
  fs.writeFileSync(OUT, JSON.stringify({ v: 1, constants, functions }));
  return { constants: Object.keys(constants).length, functions: Object.keys(functions).length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = buildLuaApi();
  console.log(`lua-api.json: ${r.constants} costanti, ${r.functions} funzioni`);
}
