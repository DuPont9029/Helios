// Helios in un solo file HTML: app, motore (worker e WASM) e dati (carte, stringhe, banlist, script Lua)
// in standalone/Helios.html, da aprire con doppio clic o da mandare a un amico. I duelli online passano
// dai relay Nostr (Trystero); servono internet solo per quelli e per le immagini delle carte.
// Uso: npm run data (se public/data manca), poi npm run standalone.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "dist-standalone");
const data = join(root, "public/data");
if (!existsSync(join(data, "cards.json"))) throw new Error("public/data is missing: run npm run data first");

rmSync(out, { recursive: true, force: true });
execFileSync("npx", ["vite", "build", "--mode", "standalone"], { cwd: root, stdio: "inherit" });

// Archivio dei dati (formato in src/data/bundle.js): [uint32 LE lunghezza indice][indice JSON][file].
const names = ["cards.json", "strings.json", "banlists.json", "starter-decks.json", "manifest.json"]
  .filter((n) => existsSync(join(data, n)))
  .concat(readdirSync(join(data, "script")).filter((n) => n.endsWith(".lua")).sort().map((n) => `script/${n}`));
const files = {};
const chunks = [];
let at = 0;
for (const name of names) {
  const buf = readFileSync(join(data, name));
  files[name] = [at, buf.length];
  chunks.push(buf);
  at += buf.length;
}
const index = Buffer.from(JSON.stringify(files));
const size = Buffer.alloc(4);
size.writeUInt32LE(index.length);
const archive = gzipSync(Buffer.concat([size, index, ...chunks]), { level: 9 }).toString("base64");

// Il CSS e il JS del build dentro la pagina; via i riferimenti ai file della PWA (manifest, icone).
let html = readFileSync(join(out, "index.html"), "utf8");
const asset = (p) => readFileSync(join(out, p.replace(/^\.\//, "")), "utf8");
html = html
  .replace(/\s*<link rel="(manifest|apple-touch-icon)"[^>]*>/g, "")
  .replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, p) => `<style>${asset(p)}</style>`)
  .replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, p) => "")
  .replace("</body>", () => {
    const js = readdirSync(join(out, "assets")).find((n) => n.startsWith("index-") && n.endsWith(".js"));
    // Il JS va dopo i dati (la pagina li legge all'avvio); "</script" nel codice spezzerebbe il tag.
    const code = asset(`assets/${js}`).replace(/<\/(script)/gi, "<\\/$1");
    return `<script id="helios-data" type="application/octet-stream">${archive}</script>\n<script type="module">${code}</script>\n</body>`;
  });

mkdirSync(join(root, "standalone"), { recursive: true });
writeFileSync(join(root, "standalone/Helios.html"), html);
rmSync(out, { recursive: true, force: true });
console.log(`standalone/Helios.html: ${(html.length / 1048576).toFixed(1)} MB (${names.length} data files)`);
