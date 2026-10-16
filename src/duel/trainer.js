// Combo Trainer: segue la combo durante il duello, segnala i passi giusti e quelli sbagliati e pilota
// l'avversario, che usa le carte di interruzione dopo i passi scelti. Dopo un'interruzione si gioca liberamente.
import { h, clear } from "../ui/dom.js";
import { cardName } from "../data/db.js";
import { MSG, RESP, IDLE, BATTLE, PHASE } from "../core/constants.js";

export const STEP_ACTIONS = { summon: "Normal Summon", spsummon: "Special Summon", set: "Set", activate: "Activate", endphase: "End Phase" };
// Passi senza carta (il codice è un segnaposto).
export const NO_CARD = new Set(["endphase"]);
const EP = "EP";

// Eventi del duello che corrispondono ai tipi di passo.
const EVENT_KIND = { [MSG.SUMMONING]: "summon", [MSG.SPSUMMONING]: "spsummon", [MSG.SET]: "set", [MSG.CHAINING]: "activate" };
// Azioni scelte dal giocatore (risposta a MSG_SELECT_IDLECMD): elenco nel messaggio da cui prendere la carta.
const IDLE_LIST = { [IDLE.SUMMON]: "summons", [IDLE.SPSUMMON]: "special_summons", [IDLE.MSET]: "monster_sets", [IDLE.SSET]: "spell_sets", [IDLE.ACTIVATE]: "activates" };

export const stepText = (s) => (NO_CARD.has(s.kind) ? STEP_ACTIONS[s.kind] : `${STEP_ACTIONS[s.kind] ?? s.kind} "${cardName(s.code)}"`);

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
    this.stepMarks = []; // per ogni passo fatto: lo stato di prima (per tornare indietro dopo un errore)
    this.me = 0;
    this.list = h("ol.trainer-steps");
    this.status = h("div.trainer-status");
    // Dopo un passo sbagliato: torna a prima del passo precedente (lo si rifà), quando lo decide il giocatore.
    this.backBtn = h("button.btn.small.primary.trainer-back", { hidden: true, title: "Undo the wrong action and the step before it", onclick: () => this.goBack() }, "↶ Back");
    this.el = h(
      "div.trainer-panel",
      h("div.trainer-head", h("b", combo.name), (this.btns = h("div.trainer-btns", this.backBtn, h("button.btn.small.ghost", { title: "Restart the practice with the same hand", onclick: () => onRestart?.() }, "Restart")))),
      this.status,
      this.list
    );
    this.render();
  }

  get done() {
    return !this.interrupted && this.next >= this.combo.steps.length;
  }

  /** Il giocatore preme "Back": la sessione ricostruisce lo stato salvato (vedi DuelSession.loop). */
  goBack() {
    const t = this.backTarget;
    if (!t) return;
    this.backTarget = null;
    this.next = t.next;
    this.stepMarks.length = t.next;
    this.completePending = false;
    this.rewindTo = t.mark;
    this.render();
    this.onBack?.();
  }

  render() {
    this.backBtn.hidden = !this.backTarget;
    if (this.backTarget) this.backBtn.textContent = `↶ Back to step ${this.backTarget.next + 1}`;
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
    if (!this.interrupted) {
      this.notify("✓ Combo complete!", "ok");
      this.caption?.("✓ Combo complete!", "done");
    }
  }

  /** Risposta data dal giocatore: si ricorda la carta scelta (azione voluta, non un effetto automatico). */
  onResponse(prompt, response, mark) {
    if (prompt.player !== this.me) return;
    let code = null;
    if (prompt.type === MSG.SELECT_IDLECMD && response.action === IDLE.TO_EP) code = EP;
    else if (prompt.type === MSG.SELECT_BATTLECMD && response.action === BATTLE.TO_EP) code = EP;
    else if (prompt.type === MSG.SELECT_IDLECMD) code = prompt[IDLE_LIST[response.action]]?.[response.index]?.code ?? 0;
    else if (prompt.type === MSG.SELECT_BATTLECMD && response.action === 0) code = prompt.chains?.[response.index]?.code ?? 0;
    else if (prompt.type === MSG.SELECT_CHAIN && response.index != null) code = prompt.selects?.[response.index]?.code ?? 0;
    if (code == null) return;
    this.chosen = code;
    this.chosenMark = mark; // stato di prima dell'azione: in caso di errore si torna qui
  }

  /** Eventi del duello: avanzano i passi o, se sono azioni scelte dal giocatore ma sbagliate, lo avvisano. */
  onMessages(messages) {
    for (const raw of messages) {
      if (raw.type === MSG.NEW_TURN) this.turnPlayer = raw.player;
      // End Phase del proprio turno: evento "endphase" (senza carta).
      const m = raw.type === MSG.NEW_PHASE && raw.phase === PHASE.END ? { type: "endphase", controller: this.turnPlayer, code: EP } : raw;
      const kind = m.type === "endphase" ? "endphase" : EVENT_KIND[m.type];
      if (!kind) continue;
      if (m.controller !== this.me) {
        // Attivazione dell'avversario: se è un'interruzione, da qui in poi si gioca liberamente.
        const it = (this.combo.interrupts ?? []).find((x) => x.code === m.code && this.used.has(x) && !this.interrupted);
        if (kind === "activate" && it) {
          this.interrupted = it;
          this.notify(`Interrupted by "${cardName(it.code)}"! Find a way around it.`, "error");
          this.caption?.(`⚡ Opponent: "${cardName(it.code)}"`, "interrupt");
          this.render();
        }
        continue;
      }
      if (this.interrupted || this.done) continue;
      const want = this.combo.steps[this.next];
      if (want.kind === kind && (NO_CARD.has(kind) || want.code === m.code)) {
        this.stepMarks[this.next] = this.chosenMark;
        this.next++;
        this.backTarget = null; // il giocatore ha rimediato da solo
        this.chosen = 0;
        this.notify(`✓ ${stepText(want)}`, "ok");
        this.caption?.(`${this.next}/${this.combo.steps.length} · ${stepText(want)}`, "ok");
        // "Combo complete" solo quando si torna a poter agire senza essere stati interrotti (vedi onPrompt);
        // se l'ultimo passo è la End Phase il turno passa, quindi lo si dice subito.
        if (this.done && kind === "endphase") {
          this.notify("✓ Combo complete!", "ok");
          this.caption?.("✓ Combo complete!", "done");
        }
        else if (this.done) this.completePending = true;
        this.render();
      } else if (m.code && m.code === this.chosen) {
        // Passo sbagliato: si annullano l'azione sbagliata e anche l'ultimo passo giusto, che va rifatto
        // (al primo passo si annulla solo l'azione). La sessione ricostruisce lo stato.
        // Il pulsante "Back" annulla l'azione sbagliata e anche l'ultimo passo giusto, che va rifatto
        // (al primo passo solo l'azione sbagliata).
        this.chosen = 0;
        const prev = this.next > 0 ? this.stepMarks[this.next - 1] : null;
        this.backTarget = prev ? { mark: prev, next: this.next - 1 } : this.chosenMark ? { mark: this.chosenMark, next: this.next } : this.backTarget;
        this.notify(`✗ Wrong step: you did ${stepText({ kind, code: m.code })}. Expected: ${stepText(want)}. Press "Back" to go back.`, "error");
        this.caption?.(`✗ ${stepText({ kind, code: m.code })}`, "wrong");
        this.chosenMark = null;
        this.render();
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

/**
 * Registrazione di una combo giocando: ogni azione scelta dal giocatore (summon, set, attivazione,
 * End Phase) diventa un passo. Stessa interfaccia del ComboTrainer, così la sessione lo usa allo stesso modo.
 */
export class ComboRecorder {
  constructor(combo, { notify, onFinish }) {
    this.combo = combo;
    this.notify = notify;
    this.steps = [];
    this.marks = []; // stato di prima di ogni passo (per "Undo last")
    this.chosen = 0;
    this.me = 0;
    this.list = h("ol.trainer-steps.recording");
    this.undoBtn = h("button.btn.small.ghost", { title: "Undo the last recorded action", onclick: () => this.goBack() }, "↶ Undo last");
    this.el = h(
      "div.trainer-panel",
      h("div.trainer-head", h("b", `● Recording: ${combo.name}`), (this.btns = h("div.trainer-btns", this.undoBtn, h("button.btn.small.primary", { onclick: () => onFinish?.(this.result()) }, "Finish")))),
      h("div.trainer-status", "Play the combo: every action you choose becomes a step. Press Finish when done."),
      this.list
    );
    this.render();
  }

  result() {
    return { ...this.combo, steps: this.steps.map((s) => ({ ...s })) };
  }

  render() {
    this.undoBtn.disabled = !this.steps.length;
    clear(this.list).append(
      ...(this.steps.length
        ? this.steps.map((s) => h("li.trainer-step.ok", h("span.trainer-mark", "●"), stepText(s)))
        : [h("li.muted.small", "No steps yet.")])
    );
  }

  goBack() {
    if (!this.steps.length) return;
    this.steps.pop();
    this.rewindTo = this.marks.pop();
    this.render();
    this.onBack?.();
  }

  onPrompt() {}

  onResponse(prompt, response, mark) {
    if (prompt.player !== this.me) return;
    let code = null;
    if ((prompt.type === MSG.SELECT_IDLECMD && response.action === IDLE.TO_EP) || (prompt.type === MSG.SELECT_BATTLECMD && response.action === BATTLE.TO_EP)) code = EP;
    else if (prompt.type === MSG.SELECT_IDLECMD) code = prompt[IDLE_LIST[response.action]]?.[response.index]?.code ?? 0;
    else if (prompt.type === MSG.SELECT_BATTLECMD && response.action === 0) code = prompt.chains?.[response.index]?.code ?? 0;
    else if (prompt.type === MSG.SELECT_CHAIN && response.index != null) code = prompt.selects?.[response.index]?.code ?? 0;
    if (code == null) return;
    this.chosen = code;
    this.chosenMark = mark;
  }

  /** Si registrano solo gli eventi delle azioni scelte (non gli effetti automatici). */
  onMessages(messages) {
    for (const raw of messages) {
      if (raw.type === MSG.NEW_TURN) this.turnPlayer = raw.player;
      const m = raw.type === MSG.NEW_PHASE && raw.phase === PHASE.END ? { type: "endphase", controller: this.turnPlayer, code: EP } : raw;
      const kind = m.type === "endphase" ? "endphase" : EVENT_KIND[m.type];
      if (!kind || m.controller !== this.me || !m.code || m.code !== this.chosen) continue;
      this.steps.push({ kind, code: kind === "endphase" ? 0 : m.code });
      this.marks.push(this.chosenMark);
      this.chosen = 0;
      this.notify(`● Recorded: ${stepText(this.steps.at(-1))}`, "ok");
      this.caption?.(`${this.steps.length}. ${stepText(this.steps.at(-1))}`, "ok");
      this.render();
    }
  }

  respond(prompt, base) {
    return base(prompt);
  }
}

// ------------------------------------------------------------- condivisione (codice di testo)

const SHARE_PREFIX = "HELIOS-COMBO:";

/** Codice da condividere: prefisso + JSON in base64 (solo i dati della combo, niente id locale). */
export function comboToCode(c) {
  const data = { v: 1, name: c.name, first: c.first, hand: c.hand, steps: c.steps, interrupts: c.interrupts };
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return SHARE_PREFIX + btoa(String.fromCharCode(...bytes));
}

/** Legge un codice condiviso; restituisce la combo (senza id) o lancia un errore leggibile. */
export function comboFromCode(text) {
  const t = String(text ?? "").trim();
  if (!t.startsWith(SHARE_PREFIX)) throw new Error("This is not a Helios combo code");
  let data;
  try {
    const bin = atob(t.slice(SHARE_PREFIX.length));
    data = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
  } catch {
    throw new Error("The combo code is damaged or incomplete");
  }
  const nums = (a) => Array.isArray(a) && a.every((x) => Number.isInteger(x));
  const okSteps = Array.isArray(data.steps) && data.steps.every((s) => s && s.kind in STEP_ACTIONS && Number.isInteger(s.code));
  const okInts = Array.isArray(data.interrupts ?? []) && (data.interrupts ?? []).every((x) => x && Number.isInteger(x.after) && Number.isInteger(x.code));
  if (!nums(data.hand) || !okSteps || !okInts) throw new Error("The combo code is not valid");
  return { name: String(data.name || "Imported combo").slice(0, 60), first: data.first !== false, hand: data.hand, steps: data.steps, interrupts: data.interrupts ?? [] };
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
