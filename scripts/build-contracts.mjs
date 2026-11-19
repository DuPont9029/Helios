// Compila contracts/HeliosNames.sol (OpenZeppelin Contracts dalle dipendenze di sviluppo) e scrive ABI e bytecode in
// src/data/names-contract.json, usati da Helios (src/net/names.js) e dalla pagina di deploy. EVM "paris" (niente
// PUSH0), ottimizzatore attivo, pipeline via IR. Uso: npm run contracts
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
    // pipeline via IR: niente "stack too deep" con le card (molti campi) e codice più piccolo
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};
const findImports = (p) => {
  try {
    // i contratti del progetto (./HeliosCard.sol) e le librerie (OpenZeppelin, Solady) dalle dipendenze
    if (fs.existsSync(path.join(ROOT, p))) return { contents: fs.readFileSync(path.join(ROOT, p), "utf8") };
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
// tutti e due i contratti (registro e renderer creato dal suo constructor) devono stare nei limiti
for (const [file, list] of Object.entries(out.contracts)) for (const [name, x] of Object.entries(list)) {
  const size = (x.evm.deployedBytecode?.object?.length ?? 0) / 2;
  if (size > 24576) throw new Error(`${name}: runtime bytecode is ${size} bytes, over the 24,576-byte limit (EIP-170)`);
  if (size && file.startsWith("contracts/")) console.log(`${name}: ${size} bytes of runtime code`);
}
const init = c.evm.bytecode.object.length / 2;
if (init > 49152) throw new Error(`Init code is ${init} bytes: over the 49,152-byte limit (EIP-3860)`);
const runtime = c.evm.deployedBytecode.object.length / 2;
const file = path.join(ROOT, "src/data/names-contract.json");
// rendererAbi: per chiedere l'anteprima di una card al renderer on-chain (svg) prima di firmare
const rendererAbi = out.contracts["contracts/HeliosCard.sol"].HeliosCardRenderer.abi;
fs.writeFileSync(file, JSON.stringify({ compiler: solc.version(), evmVersion: "paris", viaIR: true, abi: c.abi, rendererAbi, bytecode: "0x" + c.evm.bytecode.object }, null, 1));
console.log(`HeliosNames init code: ${init} bytes (limit 49,152) → ${path.relative(ROOT, file)}`);
