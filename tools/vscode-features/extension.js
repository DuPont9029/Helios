// Estensione di VS Code: nella preview di features-and-improvements.md, bug-reports.md e reminders.md accanto a ogni voce ci sono i link per
// spostarla nelle altre sezioni (Da implementare / Da testare / Verificate).
// La preview non può chiamare direttamente l'estensione: i link sono indirizzi vscode://helios.helios-features/move,
// che la preview lascia aprire a VS Code, e VS Code li passa al gestore registrato qui sotto (registerUriHandler).
// Lo spostamento modifica il documento aperto (anche se non salvato) e lo salva; la preview si aggiorna da sola.
"use strict";

const vscode = require("vscode");
const path = require("path");
const core = require("./features-core.js");

const FILES = new Set(Object.values(core.FILES));
const ID = "helios.helios-features";
const SHORT = { todo: "To do", test: "To test", done: "Verified" };

function activate(context) {
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }));
  return {
    extendMarkdownIt(md) {
      md.core.ruler.push("helios_features", markItems);
      md.renderer.rules.helios_features_moves = renderMoves;
      return md;
    },
  };
}

// Plugin di markdown-it, in due tempi perché VS Code dice quale file si sta mostrando (env.currentDocument) solo
// quando disegna la pagina, non quando legge il markdown:
// 1. lettura: in fondo a ogni voce delle tre sezioni metto un segnaposto con nome e sezione della voce;
// 2. disegno: il segnaposto diventa i link solo in features-and-improvements.md (negli altri file non disegna niente).
function markItems(state) {
  let section = null;
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading_open" && t.tag === "h2") {
      const m = /^(\d)\./.exec(tokens[i + 1].content);
      section = m ? core.KEYS[+m[1] - 1] || null : null;
      continue;
    }
    if (!section || t.type !== "inline" || !/^\[[ x]\] /.test(t.content) || tokens[i - 1].type !== "paragraph_open") continue;
    const name = (/\*\*(.+?)\*\*/.exec(t.content) || [])[1];
    if (!name) continue;
    const mark = new state.Token("helios_features_moves", "", 0);
    mark.meta = { name, section };
    t.children.push(mark);
  }
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderMoves(tokens, idx, options, env) {
  const doc = env && env.currentDocument;
  if (!doc || !FILES.has(path.basename(doc.fsPath || doc.path))) return "";
  const { name, section } = tokens[idx].meta;
  const links = core.KEYS.filter((to) => to !== section).map((to) => {
    const q = new URLSearchParams({ doc: doc.toString(), name, to }).toString();
    const href = `${vscode.env.uriScheme}://${ID}/move?${q}`;
    return `<a href="${esc(href)}" class="hf-move hf-${to}" title="${esc(`Move to "${core.LABEL[to]}"`)}">→ ${SHORT[to]}</a>`;
  });
  return `<span class="hf-moves">${links.join("")}</span>`;
}

async function handleUri(uri) {
  if (uri.path !== "/move") return;
  const q = new URLSearchParams(uri.query);
  const to = q.get("to");
  const name = q.get("name");
  if (!core.KEYS.includes(to) || !name) return;
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(q.get("doc")));
    const text = doc.getText();
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const item = core.scan(lines).find((it) => it.name === name);
    if (!item) return vscode.window.showWarningMessage(`"${name}" is no longer in ${path.basename(doc.uri.fsPath)}.`);
    if (!core.move(lines, item, to)) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), lines.join(eol));
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    vscode.window.setStatusBarMessage(`"${name}" → ${core.labels(lines)[to]}`, 4000);
  } catch (e) {
    vscode.window.showErrorMessage(`Helios Features: ${e.message}`);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
