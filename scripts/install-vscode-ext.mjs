// Installa l'estensione tools/vscode-features in VS Code (e in Cursor / VS Code Insiders se presenti) con un
// collegamento alla cartella del progetto: le modifiche all'estensione valgono dopo "Developer: Reload Window".
//   npm run vscode-ext
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../tools/vscode-features", import.meta.url));
const { publisher, name, version } = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
const dirs = [".vscode", ".vscode-insiders", ".cursor"].map((d) => join(homedir(), d, "extensions"));
let done = 0;
for (const dir of dirs) {
  if (!existsSync(join(dir, ".."))) continue; // editor non installato
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${publisher}.${name}-${version}`);
  try {
    if (lstatSync(dest)) rmSync(dest, { recursive: true, force: true });
  } catch {}
  symlinkSync(src, dest, "dir");
  console.log(`Installata: ${dest} → ${src}`);
  done++;
}
if (!done) console.log("Nessun VS Code trovato. In VS Code: comando \"Developer: Install Extension from Location...\" e scegli " + src);
else console.log('Riavvia VS Code (o "Developer: Reload Window"), poi apri la preview di features-and-improvements.md.');
