// Editor Lua degli script delle carte personalizzate, come lua-web-editor (github.com/sansmoraxz/lua-web-editor):
// Monaco (l'editor di VS Code) con l'evidenziazione Lua e wasmoon (Lua in WebAssembly) per gli errori di sintassi
// mentre si scrive. In più, per l'API di EDOPro (public/data/lua-api.json, da scripts/build-lua-api.mjs):
// autocompletamento di Duel., aux., Fusion.…, dei metodi di carte, effetti e gruppi (c:, e1:, g:…) e delle costanti,
// e i suggerimenti passando sopra un nome (firma o esempio d'uso dagli script ufficiali, quante carte la usano).
// Si carica solo quando si apre la pagina dello script (Monaco è grande).
import { DATA_URL } from "../data/db.js";
import { STANDALONE, loadArchive, archiveText } from "../data/bundle.js";

let ready = null;

/** Monaco pronto (una volta sola), con Lua, tema, autocompletamento e suggerimenti. */
export function loadMonaco() {
  return (ready ??= (async () => {
    const [monaco, , workerMod, api] = await Promise.all([
      import("monaco-editor/esm/vs/editor/edcore.main.js"),
      import("monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js"),
      // Nel file singolo il worker dell'editor è incorporato (come quello del motore).
      STANDALONE ? import("monaco-editor/esm/vs/editor/editor.worker.js?worker&inline") : import("monaco-editor/esm/vs/editor/editor.worker.js?worker"),
      loadApi(),
    ]);
    self.MonacoEnvironment = { getWorker: () => new workerMod.default() };
    monaco.editor.defineTheme("helios", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "keyword", foreground: "ff7ab8" },
        { token: "string", foreground: "a8e6a1" },
        { token: "number", foreground: "f5c26b" },
        { token: "comment", foreground: "6b7894", fontStyle: "italic" },
      ],
      colors: { "editor.background": "#07090e", "editor.lineHighlightBackground": "#101624", "editorLineNumber.foreground": "#3c4760" },
    });
    registerApi(monaco, api);
    return monaco;
  })());
}

async function loadApi() {
  try {
    if (STANDALONE) return JSON.parse(archiveText(await loadArchive(), "lua-api.json") ?? "null") ?? { constants: {}, functions: {} };
    const r = await fetch(DATA_URL + "lua-api.json");
    return r.ok ? await r.json() : { constants: {}, functions: {} };
  } catch {
    return { constants: {}, functions: {} };
  }
}

// Variabili che indicano un effetto, un gruppo o una carta (come in scripts/build-lua-api.mjs).
const KIND = [
  [/^(e\d*|te|re|ce|ae|eff|effect|ef)$/, "Effect"],
  [/^(g|sg|mg|tg|dg|og|rg|hg|cg|fg|ag|bg|eg|pg|gg|sg\d|g\d|mat|mats|group)$/, "Group"],
  [/^(c|tc|rc|hc|mc|sc|fc|bc|ac|dc|ec|oc|pc|xc|lc|cc|tc\d|c\d|card|handler)$/, "Card"],
];
const NAMESPACES = ["Duel", "aux", "Fusion", "Synchro", "Xyz", "Link", "Ritual", "Pendulum", "Spirit", "Gemini", "Union", "Equip", "Maximum", "Card", "Effect", "Group"];

/** Argomenti di un esempio separati alle virgole di primo livello (non quelle dentro le parentesi). */
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s ?? "") {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const snippetArgs = (args) => splitArgs(args).map((a, i) => `\${${i + 1}:${a.replace(/[$}\\]/g, "\\$&")}}`).join(",");

function registerApi(monaco, api) {
  const { CompletionItemKind: K, CompletionItemInsertTextRule: R } = monaco.languages;
  const fns = Object.entries(api.functions ?? {}).map(([key, [params, n, ex]]) => {
    const [, ns, sep, name] = key.match(/^(\w+)([.:])(\w+)$/) ?? [];
    return { key, ns, sep, name, params, n, ex };
  });
  const consts = Object.entries(api.constants ?? {});
  const doc = (f) => {
    const sig = f.params != null ? `${f.key}(${f.params})` : f.ex != null ? `${f.key}(${f.ex})` : `${f.key}()`;
    const lines = ["```lua", sig, "```"];
    if (f.params == null && f.ex != null) lines.push("Example from the official scripts.");
    if (f.n) lines.push(`Used ${f.n.toLocaleString("en-US")} times in the official card scripts.`);
    return { value: lines.join("\n") };
  };
  const fnItem = (f, range) => ({
    label: f.name,
    kind: f.sep === ":" ? K.Method : K.Function,
    detail: f.key,
    documentation: doc(f),
    insertText: `${f.name}(${snippetArgs(f.params ?? f.ex ?? "")})`,
    insertTextRules: R.InsertAsSnippet,
    range,
    // le più usate per prime
    sortText: String(1e7 - Math.min(f.n, 9999999)).padStart(8, "0") + f.name,
  });

  monaco.languages.registerCompletionItemProvider("lua", {
    triggerCharacters: [".", ":"],
    provideCompletionItems(model, pos) {
      const before = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
      const word = model.getWordUntilPosition(pos);
      const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const m = before.match(/([A-Za-z_]\w*)([.:])(\w*)$/);
      if (m) {
        const [, recv, sep] = m;
        if (sep === ".") {
          const ns = recv === "Auxiliary" ? "aux" : recv;
          if (ns === "s") return { suggestions: [] }; // funzioni della carta: le conosce l'editor (parole del file)
          return { suggestions: fns.filter((f) => f.ns === ns && f.sep === ".").map((f) => fnItem(f, range)) };
        }
        // metodo: carta, effetto o gruppo secondo il nome della variabile (altrimenti tutti)
        const kind = KIND.find(([re]) => re.test(recv))?.[1];
        return { suggestions: fns.filter((f) => f.sep === ":" && (!kind || f.ns === kind)).map((f) => fnItem(f, range)) };
      }
      const suggestions = [
        ...NAMESPACES.map((ns) => ({ label: ns, kind: K.Module, insertText: ns, range, sortText: "0" + ns })),
        ...consts.map(([name, [value, comment]]) => ({ label: name, kind: K.Constant, detail: `= ${value}`, documentation: comment || undefined, insertText: name, range, sortText: "2" + name })),
        ...SNIPPETS.map((s) => ({ label: s.label, kind: K.Snippet, detail: s.detail, insertText: s.body, insertTextRules: R.InsertAsSnippet, range, sortText: "1" + s.label })),
      ];
      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider("lua", {
    provideHover(model, pos) {
      const line = model.getLineContent(pos.lineNumber);
      const w = model.getWordAtPosition(pos);
      if (!w) return null;
      const before = line.slice(0, w.startColumn - 1);
      const m = before.match(/([A-Za-z_]\w*)([.:])$/);
      let f = null;
      if (m) {
        const ns = m[1] === "Auxiliary" ? "aux" : m[1];
        if (m[2] === ".") f = fns.find((x) => x.ns === ns && x.sep === "." && x.name === w.word);
        else {
          const kind = KIND.find(([re]) => re.test(m[1]))?.[1];
          f = fns.find((x) => x.sep === ":" && x.name === w.word && (!kind || x.ns === kind)) ?? fns.find((x) => x.sep === ":" && x.name === w.word);
        }
      }
      if (f) return { contents: [doc(f)] };
      const c = api.constants?.[w.word];
      if (c) return { contents: [{ value: `\`${w.word} = ${c[0]}\`${c[1] ? `\n\n${c[1]}` : ""}` }] };
      return null;
    },
  });
}

// Modelli che si inseriscono scrivendo il loro nome (autocompletamento).
const SNIPPETS = [
  { label: "card script", detail: "Script skeleton", body: "local s,id=GetID()\nfunction s.initial_effect(c)\n\t$0\nend\n" },
  {
    label: "effect: trigger",
    detail: "When this card is Summoned…",
    body: "local e${1:1}=Effect.CreateEffect(c)\ne$1:SetDescription(aux.Stringid(id,${2:0}))\ne$1:SetCategory(${3:CATEGORY_DRAW})\ne$1:SetType(EFFECT_TYPE_SINGLE+EFFECT_TYPE_TRIGGER_O)\ne$1:SetCode(${4:EVENT_SUMMON_SUCCESS})\ne$1:SetProperty(EFFECT_FLAG_DELAY)\ne$1:SetCountLimit(1,id)\ne$1:SetTarget(s.${5:target})\ne$1:SetOperation(s.${6:operation})\nc:RegisterEffect(e$1)",
  },
  {
    label: "effect: ignition",
    detail: "Activated effect on the field (Main Phase)",
    body: "local e${1:1}=Effect.CreateEffect(c)\ne$1:SetDescription(aux.Stringid(id,${2:0}))\ne$1:SetType(EFFECT_TYPE_IGNITION)\ne$1:SetRange(LOCATION_MZONE)\ne$1:SetCountLimit(1,id)\ne$1:SetTarget(s.${3:target})\ne$1:SetOperation(s.${4:operation})\nc:RegisterEffect(e$1)",
  },
  {
    label: "effect: quick",
    detail: "Quick Effect on the field",
    body: "local e${1:1}=Effect.CreateEffect(c)\ne$1:SetDescription(aux.Stringid(id,${2:0}))\ne$1:SetType(EFFECT_TYPE_QUICK_O)\ne$1:SetCode(EVENT_FREE_CHAIN)\ne$1:SetRange(LOCATION_MZONE)\ne$1:SetCountLimit(1,id)\ne$1:SetTarget(s.${3:target})\ne$1:SetOperation(s.${4:operation})\nc:RegisterEffect(e$1)",
  },
  {
    label: "effect: activate (Spell/Trap)",
    detail: "Activation of a Spell or Trap",
    body: "local e${1:1}=Effect.CreateEffect(c)\ne$1:SetCategory(${2:CATEGORY_DESTROY})\ne$1:SetType(EFFECT_TYPE_ACTIVATE)\ne$1:SetCode(EVENT_FREE_CHAIN)\ne$1:SetTarget(s.${3:target})\ne$1:SetOperation(s.${4:activate})\nc:RegisterEffect(e$1)",
  },
  {
    label: "target / operation",
    detail: "Target and operation functions",
    body: "function s.${1:target}(e,tp,eg,ep,ev,re,r,rp,chk)\n\tif chk==0 then return ${2:true} end\nend\nfunction s.${3:operation}(e,tp,eg,ep,ev,re,r,rp)\n\t$0\nend",
  },
];

// ---------------------------------------------------------------- errori di sintassi (wasmoon)

let lua = null;
async function luaEngine() {
  if (!lua) {
    lua = (async () => {
      const [{ LuaFactory }, { default: glue }] = await Promise.all([import("wasmoon"), import("wasmoon/dist/glue.wasm?url")]);
      return new LuaFactory(glue).createEngine();
    })();
  }
  return lua;
}

/** Errore di sintassi dello script ({ line, message }) o null. Non esegue niente: compila soltanto. */
export async function luaSyntaxError(code) {
  try {
    const engine = await luaEngine();
    engine.global.set("__src", code);
    const err = await engine.doString("local f, e = load(__src, '=script') return e");
    if (!err) return null;
    const m = String(err).match(/^script:(\d+):\s*(.*)$/s);
    return m ? { line: +m[1], message: m[2] } : { line: 1, message: String(err) };
  } catch (e) {
    return null; // senza wasmoon niente controllo dal vivo (resta "Check script" nel motore)
  }
}

/**
 * Editor in un elemento. opts: { value, readOnly, onChange(value) }. Restituisce { editor, monaco, value(), insert(text) }.
 * Gli errori di sintassi compaiono mentre si scrive (sottolineati, con il messaggio passandoci sopra).
 */
export async function createLuaEditor(el, { value = "", readOnly = false, onChange = null } = {}) {
  const monaco = await loadMonaco();
  const editor = monaco.editor.create(el, {
    value,
    language: "lua",
    theme: "helios",
    readOnly,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    tabSize: 4,
    insertSpaces: false,
    scrollBeyondLastLine: false,
    renderWhitespace: "none",
    wordBasedSuggestions: "currentDocument",
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestOnTriggerCharacters: true,
    fixedOverflowWidgets: true,
    // Senza livelli separati (will-change) per le righe: in alcuni browser il testo non si vedeva più.
    disableLayerHinting: true,
    fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
  });
  if (!readOnly) {
    let timer = 0;
    const lint = async () => {
      const err = await luaSyntaxError(editor.getValue());
      const model = editor.getModel();
      if (!model) return;
      monaco.editor.setModelMarkers(model, "lua", err ? [{ severity: monaco.MarkerSeverity.Error, message: err.message, startLineNumber: err.line, endLineNumber: err.line, startColumn: 1, endColumn: model.getLineMaxColumn(Math.min(err.line, model.getLineCount())) }] : []);
    };
    editor.onDidChangeModelContent(() => {
      onChange?.(editor.getValue());
      clearTimeout(timer);
      timer = setTimeout(lint, 400);
    });
    lint();
  }
  return {
    editor,
    monaco,
    value: () => editor.getValue(),
    /** Testo al cursore (o al posto della selezione). */
    insert(text) {
      const sel = editor.getSelection();
      editor.executeEdits("insert", [{ range: sel, text, forceMoveMarkers: true }]);
      editor.focus();
    },
    selection: () => editor.getModel().getValueInRange(editor.getSelection()),
    dispose: () => editor.dispose(),
  };
}
