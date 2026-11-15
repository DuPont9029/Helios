// CLI per spostare le voci delle liste del progetto tra le tre sezioni, mantenendo la categoria.
// File: features-and-improvements.md (predefinito), bug-reports.md (--bugs), reminders.md (--reminders).
//   npm run feature                          interfaccia nel terminale: frecce su/giù per scegliere, 1/2/3 per spostare,
//                                            frecce sinistra/destra per cambiare file
//   npm run feature -- test "telefono"       sposta subito la voce il cui nome contiene "telefono" (todo|test|done)
//   npm run feature -- --bugs done "popup"   lo stesso in bug-reports.md
//   npm run feature -- list                  elenco delle voci
// La voce si cerca nel nome in grassetto (senza maiuscole/minuscole). Nella sezione di arrivo va sotto la stessa
// categoria (### ...), che si crea se manca; [x] solo nella terza sezione.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import core from "../tools/vscode-features/features-core.js";

const { KEYS } = core;
const WHICH = Object.keys(core.FILES); // features, bugs, reminders
const args = process.argv.slice(2);
let which = WHICH.find((w) => args.includes(`--${w}`)) ?? "features";
const [cmd, ...rest] = args.filter((a) => !a.startsWith("--"));

let FILE, lines, LABEL;
function load(w) {
  which = w;
  FILE = fileURLToPath(new URL(`../${core.FILES[w]}`, import.meta.url));
  lines = readFileSync(FILE, "utf8").split("\n");
  LABEL = core.labels(lines);
}
load(which);
const scan = () => core.scan(lines);

/** Sposta la voce nella sezione `to` e salva il file. */
function move(item, to) {
  if (!core.move(lines, item, to)) return false;
  writeFileSync(FILE, lines.join("\n"));
  return true;
}

const find = (query) => scan().filter((it) => it.name.toLowerCase().includes(query.toLowerCase()));

// ------------------------------------------------------------------ modalità a comando
if (cmd === "list" || (!cmd && !process.stdin.isTTY)) {
  for (const it of scan()) console.log(`${it.section.padEnd(4)}  ${(it.category ?? "-").padEnd(24)}  ${it.name}`);
  process.exit(0);
}
if (cmd) {
  const query = rest.join(" ").trim();
  if (!KEYS.includes(cmd) || !query) {
    console.error('Uso: npm run feature   |   npm run feature -- [--bugs|--reminders] todo|test|done "nome"   |   npm run feature -- [--bugs|--reminders] list');
    process.exit(1);
  }
  const found = find(query);
  if (found.length !== 1) {
    console.error(found.length ? `Più voci contengono "${query}":` : `Nessuna voce contiene "${query}".`);
    for (const it of found) console.error(`  ${it.section}  ${it.name}`);
    process.exit(1);
  }
  const it = found[0];
  console.log(move(it, cmd) ? `"${it.name}": ${it.section} → ${cmd}` : `"${it.name}" è già in ${cmd}.`);
  process.exit(0);
}

// ------------------------------------------------------------------ interfaccia nel terminale
const out = process.stdout;
const C = { dim: "\x1b[2m", bold: "\x1b[1m", inv: "\x1b[7m", off: "\x1b[0m", todo: "\x1b[33m", test: "\x1b[36m", done: "\x1b[32m" };
let filter = "";
let shown = [KEYS[0], KEYS[1], KEYS[2]]; // sezioni visibili (Tab cambia)
let sel = 0;
let top = 0;
let msg = "";
let lastName = null;

const visible = () => scan().filter((it) => shown.includes(it.section) && it.name.toLowerCase().includes(filter.toLowerCase()));

function draw() {
  const list = visible();
  if (lastName) {
    const i = list.findIndex((it) => it.name === lastName);
    if (i >= 0) sel = i;
    lastName = null;
  }
  sel = Math.max(0, Math.min(sel, list.length - 1));
  const rows = (out.rows || 30) - 6;
  if (sel < top) top = sel;
  if (sel >= top + rows) top = sel - rows + 1;
  const cols = out.columns || 100;
  const count = Object.fromEntries(KEYS.map((k) => [k, scan().filter((it) => it.section === k).length]));
  let s = "\x1b[H\x1b[2J";
  s += WHICH.map((w) => (w === which ? `${C.inv} ${core.FILES[w]} ${C.off}` : `${C.dim} ${core.FILES[w]} ${C.off}`)).join(" ") + "\n";
  s += `` + KEYS.map((k, i) => `${C[k]}${i + 1} ${LABEL[k]} (${count[k]})${C.off}`).join("   ") + "\n";
  s += `${C.dim}↑↓ scegli · ←→ file · 1/2/3 sposta · Tab sezioni: ${shown.length === 3 ? "tutte" : LABEL[shown[0]]} · scrivi per filtrare · Esc esci${C.off}\n`;
  s += `Filtro: ${filter}${C.dim}${filter ? "" : "(nessuno)"}${C.off}\n\n`;
  if (!list.length) s += `${C.dim}  Nessuna voce.${C.off}\n`;
  for (const [i, it] of list.slice(top, top + rows).entries()) {
    const line = `${it.section.padEnd(4)} ${(it.category ?? "-").slice(0, 22).padEnd(22)} ${it.big ? "* " : ""}${it.name}`.slice(0, cols - 3);
    s += top + i === sel ? `${C.inv} ${line} ${C.off}\n` : ` ${C[it.section]}${line.slice(0, 4)}${C.off}${line.slice(4)}\n`;
  }
  s += `\n${msg}`;
  out.write(s);
}

function quit() {
  out.write("\x1b[?25h\x1b[?1049l");
  process.stdin.setRawMode(false);
  process.exit(0);
}

out.write("\x1b[?1049h\x1b[?25l");
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
out.on("resize", draw);
// Un blocco di input può contenere più tasti (testo incollato, tasti premuti in fretta): li separo uno per uno.
process.stdin.on("data", (chunk) => {
  for (const key of chunk.match(/\x1b\[[0-9]*~|\x1b\[[A-D]|\x1b|[\s\S]/g) ?? []) onKey(key);
  draw();
});

function onKey(key) {
  const list = visible();
  msg = "";
  if (key === "\x03" || key === "\x1b") return quit();
  if (key === "\x1b[C" || key === "\x1b[D") {
    load(WHICH[(WHICH.indexOf(which) + (key === "\x1b[C" ? 1 : WHICH.length - 1)) % WHICH.length]);
    filter = "";
    sel = top = 0;
  } else if (key === "\x1b[A") sel--;
  else if (key === "\x1b[B") sel++;
  else if (key === "\x1b[5~") sel -= 10;
  else if (key === "\x1b[6~") sel += 10;
  else if (key === "\t") {
    const order = [KEYS, ["todo"], ["test"], ["done"]];
    shown = order[(order.findIndex((o) => o.join() === shown.join()) + 1) % order.length];
    sel = top = 0;
  } else if (/^[123]$/.test(key) && list[sel]) {
    const it = list[sel];
    const to = KEYS[+key - 1];
    if (move(it, to)) {
      msg = `${C[to]}"${it.name}": ${LABEL[it.section]} → ${LABEL[to]}${C.off}`;
      lastName = it.name;
    } else msg = `${C.dim}"${it.name}" è già in ${LABEL[to]}.${C.off}`;
  } else if (key === "\x7f" || key === "\b") filter = filter.slice(0, -1);
  else if (key.length === 1 && key >= " ") {
    filter += key;
    sel = top = 0;
  }
  const n = visible().length;
  sel = Math.max(0, Math.min(sel, n - 1));
}
draw();
