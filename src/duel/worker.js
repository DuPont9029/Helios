// Web Worker che esegue ocgcore (WASM). Il core chiede gli script Lua in modo
// sincrono: li precarichiamo in parallelo e, per quelli imprevisti, usiamo
// XMLHttpRequest sincrono (consentito nei worker).
import createCore from "../core/ocgcore.js";
import { DuelEngine } from "../core/engine.js";
import { parseCard } from "../core/carddata.js";

let lib = null;
let dataUrl = "";
let cards = null;
let engine = null;
const scripts = new Map();
const logs = [];

async function init(url) {
  dataUrl = url;
  const [core, rows] = await Promise.all([
    createCore({ sync: true }),
    fetch(dataUrl + "cards.json").then((r) => r.json()),
  ]);
  lib = core;
  cards = new Map(rows.map((r) => [r[0], parseCard(r)]));
}

function scriptUrl(name) {
  return dataUrl + "script/" + name.replace(/^.*[\\/]/, "");
}

// Alcuni server (es. Vite in sviluppo) rispondono con index.html ai file mancanti.
const isLua = (status, text) => status === 200 && !/^\s*</.test(text);

function readScript(name) {
  if (scripts.has(name)) return scripts.get(name);
  const xhr = new XMLHttpRequest();
  xhr.open("GET", scriptUrl(name), false);
  try {
    xhr.send();
  } catch {
    scripts.set(name, null);
    return null;
  }
  const text = isLua(xhr.status, xhr.responseText) ? xhr.responseText : null;
  scripts.set(name, text);
  return text;
}

const BASE_SCRIPTS = [
  "constant.lua", "utility.lua", "archetype_setcode_constants.lua", "card_counter_constants.lua",
  "cards_specific_functions.lua", "chain.lua", "deprecated_functions.lua", "proc_equip.lua",
  "proc_fusion.lua", "proc_fusion_spell.lua", "proc_gemini.lua", "proc_link.lua", "proc_maximum.lua",
  "proc_normal.lua", "proc_pendulum.lua", "proc_persistent.lua", "proc_ritual.lua", "proc_spirit.lua",
  "proc_synchro.lua", "proc_union.lua", "proc_workaround.lua", "proc_xyz.lua",
];

async function prefetch(names) {
  const todo = [...new Set(names)].filter((n) => !scripts.has(n));
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const name = todo[i++];
      try {
        const res = await fetch(scriptUrl(name));
        const text = await res.text();
        scripts.set(name, isLua(res.status, text) ? text : null);
      } catch {
        /* verrà ritentato in modo sincrono */
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
}

function step() {
  const { messages, prompt, ended } = engine.run();
  const snapshot = engine.snapshot();
  const out = { messages, prompt, ended, snapshot, checksum: engine.checksum(), logs: logs.splice(0) };
  return out;
}

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  try {
    let result;
    switch (cmd) {
      case "init":
        await init(args.dataUrl);
        result = { version: lib.getVersion() };
        break;
      case "start": {
        engine?.destroy();
        const codes = [...args.decks[0].main, ...args.decks[0].extra, ...args.decks[1].main, ...args.decks[1].extra];
        await prefetch([...BASE_SCRIPTS, ...codes.map((c) => `c${c}.lua`)]);
        engine = new DuelEngine(lib, {
          getCard: (code) => cards.get(code) ?? null,
          readScript,
          log: (type, text) => logs.push({ type, text }),
        });
        engine.start(args);
        result = step();
        break;
      }
      case "respond":
        engine.respond(args.response);
        result = step();
        break;
      case "destroy":
        engine?.destroy();
        engine = null;
        result = true;
        break;
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack || err) });
  }
};
