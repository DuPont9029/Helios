// Logica comune per spostare le voci tra le tre sezioni (## 1. / ## 2. / ## 3.) dei file delle liste del progetto
// (FILES), usata dalla CLI scripts/feature.mjs e dall'estensione di VS Code. Lavora su un array di righe, senza leggere o scrivere file.
// La voce va sotto la stessa categoria (### ...) nella sezione di arrivo, che si crea se manca; [x] solo in "verificate".
"use strict";

const SECTIONS = { todo: "## 1.", test: "## 2.", done: "## 3." };
const KEYS = ["todo", "test", "done"];
// Una voce: "- [ ]" o "- [x]" (anche con lo spazio non separabile che alcuni editor mettono nella casella).
const ITEM = /^- \[[\sxX]\]\s/;
const LABEL = { todo: "Da implementare", test: "Da testare", done: "Verificate" };
const FILES = { features: "features-and-improvements.md", bugs: "bug-reports.md", reminders: "reminders.md" };

/** Nomi delle sezioni presi dai titoli del file (es. "Corretti, da testare"); LABEL se mancano. */
function labels(lines) {
  const out = { ...LABEL };
  for (const k of KEYS) {
    const l = lines.find((x) => x.startsWith(SECTIONS[k]));
    if (l) out[k] = l.slice(SECTIONS[k].length).trim();
  }
  return out;
}

/** Voci del file: { section, category, name, big, line }. */
function scan(lines) {
  const items = [];
  let section = null;
  let category = null;
  lines.forEach((line, i) => {
    const sec = Object.entries(SECTIONS).find(([, p]) => line.startsWith(p));
    if (sec) [section, category] = [sec[0], null];
    else if (line.startsWith("## ")) section = null;
    else if (line.startsWith("### ")) category = line.slice(4).trim();
    else if (section && ITEM.test(line)) {
      const name = (line.match(/\*\*(.+?)\*\*/) || [])[1] || line.slice(6);
      items.push({ section, category, name, big: /^- \[[\sxX]\]\s+\*\s/.test(line), line: i });
    }
  });
  return items;
}

// Fine di una sezione: prima del "---" o del "## " successivo (righe vuote escluse), o fine del file.
function sectionEnd(lines, start) {
  let i = start + 1;
  while (i < lines.length && !lines[i].startsWith("## ") && lines[i] !== "---") i++;
  while (i > start + 1 && lines[i - 1].trim() === "") i--;
  return i;
}

/** Sposta la voce nella sezione `to` modificando `lines`. False se era già lì. */
function move(lines, item, to) {
  if (item.section === to) return false;
  const text = lines[item.line].replace(/^- \[[\sxX]\]\s/, to === "done" ? "- [x] " : "- [ ] ");
  lines.splice(item.line, 1);
  // categoria rimasta vuota nella sezione di partenza: tolgo il titolo
  if (item.category && !scan(lines).some((it) => it.section === item.section && it.category === item.category)) {
    for (let h = item.line - 1; h >= 0 && !lines[h].startsWith("## "); h--) {
      if (lines[h] === `### ${item.category}`) {
        lines.splice(h, lines[h + 1] !== undefined && lines[h + 1].trim() === "" ? 2 : 1);
        break;
      }
    }
  }
  const same = scan(lines).filter((it) => it.section === to && it.category === item.category);
  if (same.length) lines.splice(same[same.length - 1].line + 1, 0, text);
  else {
    const end = sectionEnd(lines, lines.findIndex((l) => l.startsWith(SECTIONS[to])));
    lines.splice(end, 0, ...(item.category ? ["", `### ${item.category}`, text] : ["", text]));
  }
  // la sezione di arrivo non è più vuota: tolgo la riga "Nessuno." / "Nessun bug aperto."
  const start = lines.findIndex((l) => l.startsWith(SECTIONS[to]));
  for (let i = start + 1; i < sectionEnd(lines, start); i++) if (/^Nessun/.test(lines[i])) lines.splice(i--, 1);
  // la sezione di partenza è rimasta vuota: lo scrivo
  if (!scan(lines).some((it) => it.section === item.section)) {
    const from = lines.findIndex((l) => l.startsWith(SECTIONS[item.section]));
    lines.splice(sectionEnd(lines, from), 0, "", "Nessuno.");
  }
  // niente righe vuote doppie
  for (let i = lines.length - 1; i > 0; i--) if (lines[i].trim() === "" && lines[i - 1].trim() === "") lines.splice(i, 1);
  return true;
}

module.exports = { SECTIONS, KEYS, LABEL, FILES, labels, scan, move };
