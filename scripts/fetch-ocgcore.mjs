// Scarica ocgcore-wasm (core di EDOPro compilato in WebAssembly, licenza MIT)
// da JSR, verifica l'integrità e corregge i bug noti della build minificata.
//
// Usiamo la 0.1.4 da JSR perché su npm c'è solo la 0.1.2, con un core troppo
// vecchio per gli script attuali di ProjectIgnis (es. CHAININFO_TRIGGERING_LINK).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VERSION = "0.1.4";
const TARBALL = `https://npm.jsr.io/~/11/@jsr/n1xx1__ocgcore-wasm/${VERSION}.tgz`;
const INTEGRITY = "sha512-zwBpgVtjEAJPH1VoMt6/alEpB92c3eoCUbsU0CnVEnf2kovMTtTJ8ViQRW7eifrk+/4u6Hep8xrdA0TqWk0JFQ==";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEST = path.join(ROOT, "vendor", "ocgcore-wasm");
const STAMP = path.join(DEST, ".version");

// 1. La risposta a SORT_CARD/SORT_CHAIN antepone la lunghezza, mentre il core
//    legge direttamente un byte per carta (playerop.cpp, SortCard).
// 2. readQuery non gestisce QUERY_TYPE e non salta i campi sconosciuti, quindi
//    il resto della query viene letto disallineato ("eof").
// 3. ATK/DEF nelle query sono interi con segno (-2 = "?").
// 4. SHUFFLE_SET_CARD: il numero di carte è un byte e il core scrive prima tutte le posizioni di partenza e poi
//    tutte quelle d'arrivo (libduel.cpp, ShuffleSetCard), non coppie da/a con un numero a 4 byte: si leggeva oltre
//    la fine del messaggio ("eof" in duelGetMessage).
const PATCHES = [
  {
    name: "risposta SORT_CARD",
    bad: "t.i8(e.order.length);for(let r of e.order)t.i8(r);",
    good: "for(let r of e.order)t.i8(r);",
  },
  {
    name: "parsing di QUERY_TYPE",
    bad: "t.link={rating:r,marker:O}}}return t}",
    good: "t.link={rating:r,marker:O}}else if(s===u.TYPE&&o===4)t.type=e.u32();else e.sub(o)}return t}",
  },
  ...["attack", "defense", "baseAttack", "baseDefense"].map((f) => ({
    name: `segno di ${f}`,
    bad: `t.${f}=e.u32()`,
    good: `t.${f}=e.i32()`,
  })),
  {
    name: "SHUFFLE_SET_CARD",
    bad: "location:e.u8(),cards:Array.from({length:e.u32()},()=>({from:p(e),to:p(e)}))",
    good: "location:e.u8(),cards:(()=>{let n=e.u8(),f=Array.from({length:n},()=>p(e)),o=Array.from({length:n},()=>p(e));return f.map((r,i)=>({from:r,to:o[i]}))})()",
  },
];
// Cambiando le patch si riscarica il pacchetto (le vecchie si applicano sul codice originale).
const STAMP_TEXT = `${VERSION}+${crypto.createHash("sha256").update(JSON.stringify(PATCHES)).digest("hex").slice(0, 12)}`;

if (fs.existsSync(STAMP) && fs.readFileSync(STAMP, "utf8") === STAMP_TEXT) {
  console.log(`ocgcore-wasm ${VERSION} già presente`);
  process.exit(0);
}

console.log(`scarico ocgcore-wasm ${VERSION}...`);
const res = await fetch(TARBALL);
if (!res.ok) throw new Error(`download fallito: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const digest = "sha512-" + crypto.createHash("sha512").update(buf).digest("base64");
if (digest !== INTEGRITY) throw new Error(`integrità non valida: ${digest}`);

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
const tgz = path.join(DEST, "package.tgz");
fs.writeFileSync(tgz, buf);
execFileSync("tar", ["xzf", tgz, "-C", DEST, "--strip-components", "1"]);
fs.rmSync(tgz);

const index = path.join(DEST, "dist", "index.js");
let src = fs.readFileSync(index, "utf8");
for (const p of PATCHES) {
  if (src.includes(p.bad)) {
    src = src.replace(p.bad, p.good);
    console.log(`  patch: ${p.name}`);
  } else if (!src.includes(p.good)) {
    throw new Error(`patch "${p.name}" non applicabile: codice cambiato`);
  }
}
fs.writeFileSync(index, src);
fs.writeFileSync(STAMP, STAMP_TEXT);
console.log("ocgcore-wasm pronto in vendor/ocgcore-wasm");
