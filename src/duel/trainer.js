// Combo Trainer: segue la combo durante il duello, segnala i passi giusti e quelli sbagliati e pilota
// l'avversario, che usa le carte di interruzione dopo i passi scelti. Dopo un'interruzione si gioca liberamente.
import { h, clear } from "../ui/dom.js";
import { cardName } from "../data/db.js";
import { MSG, RESP, IDLE } from "../core/constants.js";

export const STEP_ACTIONS = { summon: "Normal Summon", spsummon: "Special Summon", set: "Set", activate: "Activate" };

// Eventi del duello che corrispondono ai tipi di passo.
const EVENT_KIND = { [MSG.SUMMONING]: "summon", [MSG.SPSUMMONING]: "spsummon", [MSG.SET]: "set", [MSG.CHAINING]: "activate" };
// Azioni scelte dal giocatore (risposta a MSG_SELECT_IDLECMD): elenco nel messaggio da cui prendere la carta.
const IDLE_LIST = { [IDLE.SUMMON]: "summons", [IDLE.SPSUMMON]: "special_summons", [IDLE.MSET]: "monster_sets", [IDLE.SSET]: "spell_sets", [IDLE.ACTIVATE]: "activates" };

export const stepText = (s) => `${STEP_ACTIONS[s.kind] ?? s.kind} "${cardName(s.code)}"`;

export class ComboTrainer {
  /**
   * @param combo { name, steps: [{ kind, code }], interrupts: [{ after, code }] }
   * @param notify (text, kind) avviso a schermo
   */
  constructor(combo, { notify, onRestart }) {
    this.combo = combo;
    this.notify = notify;
    this.next = 0; // indice del prossimo passo atteso
    this.interrupted = null; // carta con cui l'avversario ha interrotto
    this.used = new Set(); // interruzioni già usate
    this.chosen = 0; // carta dell'ultima azione scelta dal giocatore (per distinguere gli errori dagli effetti automatici)
    this.me = 0;
    this.list = h("ol.trainer-steps");
    this.status = h("div.trainer-status");
    this.el = h(
      "div.trainer-panel",
      h("div.trainer-head", h("b", combo.name), h("button.btn.small.ghost", { title: "Restart the practice with the same hand", onclick: () => onRestart?.() }, "Restart")),
      this.status,
      this.list
    );
    this.render();
  }

  get done() {
    return !this.interrupted && this.next >= this.combo.steps.length;
  }

  render() {
    const { steps, interrupts = [] } = this.combo;
    const rows = [];
    const interruptRow = (it) => h(`li.trainer-interrupt${this.interrupted === it ? ".fired" : ""}`, `⚡ Opponent: "${cardName(it.code)}"`);
    for (const it of interrupts.filter((x) => x.after === 0)) rows.push(interruptRow(it));
    steps.forEach((s, i) => {
      const state = this.interrupted && i >= this.next ? "skipped" : i < this.next ? "ok" : i === this.next ? "current" : "todo";
      rows.push(h(`li.trainer-step.${state}`, h("span.trainer-mark", state === "ok" ? "✓" : state === "current" ? "▶" : ""), stepText(s)));
      for (const it of interrupts.filter((x) => x.after === i + 1)) rows.push(interruptRow(it));
    });
    clear(this.list).append(...rows);
    this.status.className = "trainer-status";
    if (this.interrupted) {
      this.status.classList.add("interrupted");
      this.status.textContent = `Interrupted by "${cardName(this.interrupted.code)}". Free play: find a way around it!`;
    } else if (this.done) {
      this.status.classList.add("complete");
      this.status.textContent = "Combo complete!";
    } else {
      this.status.textContent = `Next: ${stepText(steps[this.next])}`;
    }
  }

  /** Il core chiede di nuovo un'azione al giocatore: se la combo è finita senza interruzioni, lo si dice. */
  onPrompt(prompt) {
    if (!this.completePending || prompt.player !== this.me) return;
    if (prompt.type !== MSG.SELECT_IDLECMD && prompt.type !== MSG.SELECT_BATTLECMD) return;
    this.completePending = false;
    if (!this.interrupted) this.notify("✓ Combo complete!", "ok");
  }

  /** Risposta data dal giocatore: si ricorda la carta scelta (azione voluta, non un effetto automatico). */
  onResponse(prompt, response) {
    if (prompt.player !== this.me) return;
    if (prompt.type === MSG.SELECT_IDLECMD) this.chosen = prompt[IDLE_LIST[response.action]]?.[response.index]?.code ?? 0;
    else if (prompt.type === MSG.SELECT_BATTLECMD && response.action === 0) this.chosen = prompt.chains?.[response.index]?.code ?? 0;
    else if (prompt.type === MSG.SELECT_CHAIN && response.index != null) this.chosen = prompt.selects?.[response.index]?.code ?? 0;
  }

  /** Eventi del duello: avanzano i passi o, se sono azioni scelte dal giocatore ma sbagliate, lo avvisano. */
  onMessages(messages) {
    for (const m of messages) {
      const kind = EVENT_KIND[m.type];
      if (!kind) continue;
      if (m.controller !== this.me) {
        // Attivazione dell'avversario: se è un'interruzione, da qui in poi si gioca liberamente.
        const it = (this.combo.interrupts ?? []).find((x) => x.code === m.code && this.used.has(x) && !this.interrupted);
        if (kind === "activate" && it) {
          this.interrupted = it;
          this.notify(`Interrupted by "${cardName(it.code)}"! Find a way around it.`, "error");
          this.render();
        }
        continue;
      }
      if (this.interrupted || this.done) continue;
      const want = this.combo.steps[this.next];
      if (want.kind === kind && want.code === m.code) {
        this.next++;
        this.chosen = 0;
        this.notify(`✓ ${stepText(want)}`, "ok");
        // "Combo complete" solo quando si torna a poter agire senza essere stati interrotti (vedi onPrompt).
        if (this.done) this.completePending = true;
        this.render();
      } else if (m.code && m.code === this.chosen) {
        this.chosen = 0;
        this.notify(`✗ Expected: ${stepText(want)}. You did: ${stepText({ kind, code: m.code })}`, "error");
      }
    }
  }

  /**
   * Risposta dell'avversario. Dopo il passo indicato usa la carta di interruzione alla prima occasione
   * in cui il core gliela propone; per il resto passa (base = IA passiva).
   */
  respond(prompt, base) {
    if (prompt.type === MSG.SELECT_CHAIN && !this.interrupted) {
      for (const it of this.combo.interrupts ?? []) {
        if (this.used.has(it) || this.next < it.after) continue;
        const i = prompt.selects.findIndex((c) => c.code === it.code);
        if (i >= 0) {
          this.used.add(it);
          return { type: RESP.SELECT_CHAIN, index: i };
        }
      }
    }
    return base(prompt);
  }
}

// ------------------------------------------------------------- archivio delle combo (per mazzo)

const KEY = "ygoweb.combos";

export function loadCombos() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") ?? {};
  } catch {
    return {};
  }
}

export function saveCombos(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage non disponibile */
  }
}
