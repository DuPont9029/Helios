// Un solo file con HeliosNames, HeliosCardRenderer e le librerie (OpenZeppelin, Solady) alle versioni del progetto,
// per compilarlo e deployarlo da Remix o verificarlo su Etherscan. Uso: node scripts/flatten-contracts.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const resolve = (from, spec) => {
  if (spec.startsWith(".")) return path.resolve(path.dirname(from), spec);
  return require.resolve(spec, { paths: [ROOT] });
};
const done = new Set();
const out = [];
function visit(file) {
  if (done.has(file)) return;
  done.add(file);
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/^import\s+(?:\{[^}]*\}\s+from\s+)?"([^"]+)";/gm)) visit(resolve(file, m[1]));
  const body = src
    .replace(/^\/\/ SPDX-License-Identifier:.*$/gm, "")
    .replace(/^pragma solidity [^;]+;$/gm, "")
    .replace(/^import\s+(?:\{[^}]*\}\s+from\s+)?"[^"]+";$/gm, "");
  out.push(`// ---------------------------------------------------------------- ${path.relative(ROOT, file).replace(/^node_modules\//, "")}\n${body.trim()}\n`);
}
visit(path.join(ROOT, "contracts/HeliosNames.sol"));
const file = path.join(ROOT, "contracts/flat/HeliosNames.flat.sol");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `// SPDX-License-Identifier: MIT\npragma solidity 0.8.28;\n\n// Generato da scripts/flatten-contracts.mjs: non modificare a mano.\n// Compilatore 0.8.28, ottimizzatore 200 runs, viaIR, EVM paris. Contratto da deployare: HeliosNames.\n\n${out.join("\n")}`);
console.log(`${path.relative(ROOT, file)}: ${done.size} files, ${fs.statSync(file).size} bytes`);
