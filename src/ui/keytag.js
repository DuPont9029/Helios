// OneKey KeyTag: la piastra di metallo su cui le parole del seed (BIP39) si salvano forando dei buchi. Ogni riga è una
// parola: 12 buchi che valgono 2048, 1024, …, 2, 1; la somma dei buchi forati è il numero della parola nella lista
// BIP39 inglese (da 1 "abandon" a 2048 "zoo"). Una piastra ha 12 righe per lato: 24 parole = i due lati.
// Qui si rifanno i buchi della propria piastra cliccando le celle e ne escono le parole (il checksum BIP39 scopre un
// buco sbagliato).
import { h, clear, icon } from "./dom.js";
import { openModal } from "./modal.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { profileKind } from "../net/identity.js";

export const KEYTAG_COLS = [2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1];
const PER_SIDE = 12;

/** Parola di una riga (somma dei buchi forati) o null se la somma non è tra 1 e 2048. */
export const keyTagWord = (sum) => (sum >= 1 && sum <= 2048 ? wordlist[sum - 1] : null);

/** Buchi da forare per una parola (per i test e per chi vuole controllare la piastra). */
export const keyTagHoles = (word) => {
  const n = wordlist.indexOf(word) + 1;
  return n ? KEYTAG_COLS.map((v) => (n & v ? 1 : 0)) : null;
};

/**
 * Finestra della piastra: restituisce le parole (12 o 24, già controllate con il checksum) o null.
 * action: testo del pulsante di conferma.
 */
export function openKeyTag({ title = "OneKey KeyTag", action = "Use these words", intro = "" } = {}) {
  let count = 12;
  let rows = Array.from({ length: 24 }, () => 0); // per riga: i buchi forati come bit (2048 = bit 11)
  const plates = h("div.kt-plates");
  const status = h("p.kt-status.small");
  let m;

  const words = () => rows.slice(0, count).map(keyTagWord);
  const valid = () => {
    const w = words();
    return w.every(Boolean) && profileKind(w.join(" ")) === "seed";
  };

  const paintStatus = () => {
    const w = words();
    const filled = w.filter(Boolean).length;
    const bad = rows.slice(0, count).some((r) => r && !keyTagWord(r));
    const ok = valid();
    status.className = `kt-status small ${ok ? "ok" : bad ? "bad" : "muted"}`;
    status.textContent = ok
      ? `✓ ${count} valid words: the checksum matches.`
      : bad
        ? "A row adds up to more than 2048: check its holes."
        : filled < count
          ? `${filled} of ${count} words punched.`
          : "All rows are punched but the words are not a valid seed: a hole is wrong somewhere (the checksum does not match).";
    if (m) m.buttons[m.buttons.length - 1].disabled = !ok;
  };

  const row = (i) => {
    const wordEl = h("span.kt-word");
    const holes = KEYTAG_COLS.map((v, bit) => {
      const mask = 1 << (11 - bit);
      const b = h("button.kt-hole", { type: "button", title: String(v), "aria-label": `Row ${i + 1}, ${v}` });
      b.addEventListener("click", () => {
        rows[i] ^= mask;
        paintRow();
        paintStatus();
      });
      return { b, mask };
    });
    const paintRow = () => {
      for (const { b, mask } of holes) {
        const on = !!(rows[i] & mask);
        b.classList.toggle("punched", on);
        b.setAttribute("aria-pressed", on);
      }
      const w = keyTagWord(rows[i]);
      wordEl.textContent = rows[i] ? (w ? `${w}` : "> 2048") : "";
      wordEl.classList.toggle("bad", !!rows[i] && !w);
      wordEl.title = rows[i] ? `#${rows[i]}` : "";
    };
    paintRow();
    return h("div.kt-row", h("span.kt-num", String(i + 1).padStart(2, "0")), h("div.kt-holes", holes.map((x) => x.b)), wordEl);
  };

  const paint = () => {
    const sides = Math.ceil(count / PER_SIDE);
    clear(plates).append(
      ...Array.from({ length: sides }, (_, s) =>
        h("div.kt-plate",
          h("div.kt-plate-head", h("span.kt-brand", "KeyTag"), h("span.kt-side", sides > 1 ? `Side ${s ? "B" : "A"} · words ${s * PER_SIDE + 1}–${s * PER_SIDE + PER_SIDE}` : "Words 1–12")),
          h("div.kt-row.kt-cols", h("span.kt-num"), h("div.kt-holes", KEYTAG_COLS.map((v) => h("span.kt-col", String(v)))), h("span.kt-word")),
          Array.from({ length: PER_SIDE }, (_, k) => row(s * PER_SIDE + k)))));
    for (const b of countBtns) b.classList.toggle("primary", +b.dataset.n === count);
    paintStatus();
  };

  const countBtns = [12, 24].map((n) => h("button.btn.small", { type: "button", dataset: { n }, onclick: () => { count = n; paint(); } }, `${n} words`));
  m = openModal({
    title,
    className: "keytag-modal",
    body: [
      h("p.muted.small", intro || "Click the cells where your KeyTag has a hole: each row is one word, the holes add up to its number in the BIP39 list (2048 + … + 1)."),
      h("div.row", countBtns, h("button.btn.small.ghost", { type: "button", onclick: () => { rows = rows.map(() => 0); paint(); } }, icon("restart_alt"), " Clear")),
      plates,
      status,
      h("p.muted.small", "Nothing leaves this browser: the words are checked here."),
    ],
    actions: [
      { label: "Cancel", value: null },
      { label: action, primary: true, onClick: (close) => valid() && close(words().join(" ")) },
    ],
  });
  paint();
  return m.result.then((v) => v ?? null);
}
