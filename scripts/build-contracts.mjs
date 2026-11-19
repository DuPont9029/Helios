// Compila contracts/HeliosNames.sol (OpenZeppelin Contracts dalle dipendenze di sviluppo) e scrive ABI e bytecode in
// src/data/names-contract.json, usati da Helios (src/net/names.js) e dalla pagina di deploy. EVM "paris" (niente
// PUSH0), ottimizzatore attivo. Uso: npm run contracts
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");
const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = "contracts/HeliosNames.sol";

const input = {
  language: "Solidity",
  sources: { [SRC]: { content: fs.readFileSync(path.join(ROOT, SRC), "utf8") } },
  settings: {
    evmVersion: "paris",
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};
const findImports = (p) => {
  try {
    return { contents: fs.readFileSync(require.resolve(p), "utf8") };
  } catch {
    return { error: `not found: ${p}` };
  }
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const problems = out.errors ?? [];
for (const e of problems) console[e.severity === "error" ? "error" : "warn"](e.formattedMessage);
if (problems.some((e) => e.severity === "error")) process.exit(1);
const c = out.contracts[SRC].HeliosNames;
const runtime = c.evm.deployedBytecode.object.length / 2;
if (runtime > 24576) throw new Error(`Runtime bytecode is ${runtime} bytes: over the 24,576-byte limit (EIP-170)`);
const file = path.join(ROOT, "src/data/names-contract.json");
fs.writeFileSync(file, JSON.stringify({ compiler: solc.version(), evmVersion: "paris", abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 1));
console.log(`HeliosNames: ${runtime} bytes of runtime code (limit 24,576) → ${path.relative(ROOT, file)}`);
