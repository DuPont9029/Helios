// Combo Trainer: segue la combo durante il duello, segnala i passi giusti e quelli sbagliati e pilota
// l'avversario, che usa le hand trap dopo i passi scelti. Dopo un'interruzione si gioca liberamente.
// Ogni passo può avere dei dettagli (carte da scegliere, zona, posizione, sì/no, opzione): il trainer li
// suggerisce, li controlla (in modalità strict blocca le scelte sbagliate) e l'auto-play li usa per giocare da solo.
import { h, clear } from "../ui/dom.js";
import { cardName, descString } from "../data/db.js";
import { MSG, RESP, IDLE, BATTLE, PHASE, LOC, POS } from "../core/constants.js";
import { availableZones } from "../core/zones.js";

export const STEP_ACTIONS = { summon: "Normal Summon", spsummon: "Special Summon", set: "Set", activate: "Activate", endphase: "End Phase" };
// Passi senza carta (il codice è un segnaposto).
export const NO_CARD = new Set(["endphase"]);
const EP = "EP";

// Eventi del duello che corrispondono ai tipi di passo.
const EVENT_KIND = { [MSG.SUMMONING]: "summon", [MSG.SPSUMMONING]: "spsummon", [MSG.SET]: "set", [MSG.CHAINING]: "activate" };
// Azioni scelte dal giocatore (risposta a MSG_SELECT_IDLECMD): elenco nel messaggio da cui prendere la carta.
const IDLE_LIST = { [IDLE.SUMMON]: "summons", [IDLE.SPSUMMON]: "special_summons", [IDLE.MSET]: "monster_sets", [IDLE.SSET]: "spell_sets", [IDLE.ACTIVATE]: "activates" };
const IDLE_KIND = { [IDLE.SUMMON]: "summon", [IDLE.SPSUMMON]: "spsummon", [IDLE.MSET]: "set", [IDLE.SSET]: "set", [IDLE.ACTIVATE]: "activate" };

export const stepText = (s) => (NO_CARD.has(s.kind) ? STEP_ACTIONS[s.kind] : `${STEP_ACTIONS[s.kind] ?? s.kind} "${cardName(s.code)}"`);

// ------------------------------------------------------------- azioni e dettagli

/**
 * Azione scelta dal giocatore: { kind, code } (kind "other" = azione che non è un tipo di passo,
 * es. Battle Phase o cambio di posizione), null = nessuna azione (es. passare in catena) o richiesta di dettaglio.
 */
export function actionOf(prompt, response) {
  if (!response) return null;
  if (prompt.type === MSG.SELECT_IDLECMD) {
    if (response.action === IDLE.TO_EP) return { kind: "endphase", code: EP };
    const kind = IDLE_KIND[response.action];
    if (!kind) return { kind: "other", code: 0 };
    return { kind, code: prompt[IDLE_LIST[response.action]]?.[response.index]?.code ?? 0 };
  }
  if (prompt.type === MSG.SELECT_BATTLECMD) {
    if (response.action === BATTLE.TO_EP) return { kind: "endphase", code: EP };
    if (response.action === BATTLE.ACTIVATE) return { kind: "activate", code: prompt.chains?.[response.index]?.code ?? 0 };
    return { kind: "other", code: 0 };
  }
  if (prompt.type === MSG.SELECT_CHAIN && response.index != null) return { kind: "activate", code: prompt.selects?.[response.index]?.code ?? 0 };
  return null;
}

const ACTION_PROMPTS = new Set([MSG.SELECT_IDLECMD, MSG.SELECT_BATTLECMD, MSG.SELECT_CHAIN]);

/** Tipo di dettaglio che una richiesta del core produce (null = non registrata). */
export function detailKind(type) {
  switch (type) {
    case MSG.SELECT_CARD: case MSG.SELECT_TRIBUTE: case MSG.SELECT_SUM: return "cards";
    case MSG.SELECT_UNSELECT_CARD: return "pick";
    case MSG.SELECT_PLACE: case MSG.SELECT_DISFIELD: return "zone";
    case MSG.SELECT_POSITION: return "pos";
    case MSG.SELECT_YESNO: case MSG.SELECT_EFFECTYN: return "yesno";
    case MSG.SELECT_OPTION: return "option";
  }
  return null;
}

const zoneLoc = (location) => (location === LOC.MZONE ? "m" : location === LOC.SZONE ? "s" : String(location));
const unselectList = (prompt) => [...(prompt.select_cards ?? []), ...(prompt.unselect_cards ?? [])];

/** Dettaglio registrato dalla risposta del giocatore `me` (null se la richiesta non è un dettaglio). */
export function detailOf(prompt, response, me) {
  if (!response || response.back) return null;
  switch (detailKind(prompt.type)) {
    case "cards": {
      if (!response.indicies) return null;
      const list = prompt.selects ?? [];
      return { t: "cards", codes: response.indicies.map((i) => list[i]?.code ?? 0).sort((a, b) => a - b) };
    }
    case "pick":
      return { t: "pick", code: response.index == null ? 0 : unselectList(prompt)[response.index]?.code ?? 0 };
    case "zone":
      return { t: "zone", places: (response.places ?? []).map((p) => ({ mine: p.player === me, loc: zoneLoc(p.location), seq: p.sequence })) };
    case "pos":
      return { t: "pos", pos: response.position };
    case "yesno":
      return prompt.type === MSG.SELECT_EFFECTYN ? { t: "yesno", yes: !!response.yes, code: prompt.code } : { t: "yesno", yes: !!response.yes };
    case "option":
      return { t: "option", desc: String(prompt.options?.[response.index] ?? "") };
  }
  return null;
}

/** La risposta corrisponde al dettaglio atteso? */
export function sameDetail(a, b) {
  if (!a || !b || a.t !== b.t) return false;
  switch (a.t) {
    case "cards": return a.codes.length === b.codes.length && a.codes.every((c, i) => c === b.codes[i]);
    case "pick": return a.code === b.code;
    case "zone": return a.places.length === b.places.length && a.places.every((p, i) => p.mine === b.places[i].mine && p.loc === b.places[i].loc && p.seq === b.places[i].seq);
    case "pos": return a.pos === b.pos;
    case "yesno": return a.yes === b.yes;
    case "option": return a.desc === b.desc;
  }
  return false;
}

const ZONE_NAMES = { m: "Monster Zone", s: "Spell & Trap Zone" };
const POS_NAMES = { [POS.FACEUP_ATTACK]: "Face-up Attack", [POS.FACEDOWN_ATTACK]: "Face-down Attack", [POS.FACEUP_DEFENSE]: "Face-up Defense", [POS.FACEDOWN_DEFENSE]: "Face-down Defense" };
const quoted = (codes) => codes.map((c) => `"${cardName(c)}"`).join(", ");

export function zoneText(p) {
  const emz = p.loc === "m" && p.seq >= 5;
  const name = emz ? `Extra Monster Zone (${p.seq === 5 ? "left" : "right"})` : p.loc === "s" && p.seq === 5 ? "Field Zone" : p.loc === "s" && p.seq > 5 ? `Pendulum Zone (${p.seq === 6 ? "left" : "right"})` : `${ZONE_NAMES[p.loc] ?? "Zone"} ${p.seq + 1}`;
  return `${name}${p.mine ? "" : " (opponent's)"}`;
}

/** Testo leggibile di un dettaglio. */
export function detailText(d) {
  switch (d.t) {
    case "cards": return d.codes.length ? `Select ${quoted(d.codes)}` : "Select no cards";
    case "pick": return d.code ? `Select "${cardName(d.code)}"` : "Finish the selection";
    case "zone": return `Zone: ${d.places.map(zoneText).join(", ")}`;
    case "pos": return `Position: ${POS_NAMES[d.pos] ?? d.pos}`;
    case "yesno": return d.code ? `Use the effect of "${cardName(d.code)}": ${d.yes ? "Yes" : "No"}` : `Answer: ${d.yes ? "Yes" : "No"}`;
    case "option": return `Choose: ${d.desc ? descString(BigInt(d.desc)) || "option" : "option"}`;
  }
  return "?";
}

/** Risposta che realizza il dettaglio `d` per la richiesta (auto-play); null se non è possibile. */
export function detailResponse(d, prompt, me) {
  if (!d || detailKind(prompt.type) !== d.t) return null;
  switch (d.t) {
    case "cards": {
      const list = prompt.selects ?? [];
      const used = new Set();
      const idx = [];
      for (const code of d.codes) {
        const i = list.findIndex((c, j) => c.code === code && !used.has(j));
        if (i < 0) return null;
        used.add(i);
        idx.push(i);
      }
      const type = prompt.type === MSG.SELECT_TRIBUTE ? RESP.SELECT_TRIBUTE : prompt.type === MSG.SELECT_SUM ? RESP.SELECT_SUM : RESP.SELECT_CARD;
      if (type === RESP.SELECT_CARD && (idx.length < prompt.min || idx.length > prompt.max)) return null;
      return { type, indicies: idx };
    }
    case "pick": {
      if (!d.code) return prompt.can_finish || prompt.can_cancel ? { type: RESP.SELECT_UNSELECT_CARD, index: null } : null;
      const i = (prompt.select_cards ?? []).findIndex((c) => c.code === d.code);
      return i < 0 ? null : { type: RESP.SELECT_UNSELECT_CARD, index: i };
    }
    case "zone": {
      const zones = availableZones(prompt);
      const places = d.places.map((p) => ({ player: p.mine ? me : 1 - me, location: p.loc === "m" ? LOC.MZONE : p.loc === "s" ? LOC.SZONE : +p.loc, sequence: p.seq }));
      const ok = places.every((p) => zones.some((z) => z.player === p.player && z.location === p.location && z.sequence === p.sequence));
      return ok ? { type: prompt.type === MSG.SELECT_PLACE ? RESP.SELECT_PLACE : RESP.SELECT_DISFIELD, places } : null;
    }
    case "pos":
      return prompt.positions & d.pos ? { type: RESP.SELECT_POSITION, position: d.pos } : null;
    case "yesno":
      return { type: prompt.type === MSG.SELECT_EFFECTYN ? RESP.SELECT_EFFECTYN : RESP.SELECT_YESNO, yes: d.yes };
    case "option": {
      const i = (prompt.options ?? []).findIndex((o) => String(o) === d.desc);
      return i < 0 ? null : { type: RESP.SELECT_OPTION, index: i };
    }
  }
  return null;
}

/** Risposta che esegue il passo `step` (auto-play); null se ora non si può. */
function stepResponse(step, prompt) {
  if (prompt.type === MSG.SELECT_IDLECMD) {
    if (step.kind === "endphase") return prompt.to_ep ? { type: RESP.SELECT_IDLECMD, action: IDLE.TO_EP, index: 0 } : null;
    const lists = step.kind === "set" ? [IDLE.MSET, IDLE.SSET] : Object.keys(IDLE_KIND).map(Number).filter((a) => IDLE_KIND[a] === step.kind);
    for (const action of lists) {
      const index = (prompt[IDLE_LIST[action]] ?? []).findIndex((c) => c.code === step.code);
      if (index >= 0) return { type: RESP.SELECT_IDLECMD, action, index };
    }
    return null;
  }
  if (prompt.type === MSG.SELECT_BATTLECMD) {
    if (step.kind === "endphase") return prompt.to_ep ? { type: RESP.SELECT_BATTLECMD, action: BATTLE.TO_EP, index: 0 } : null;
    if (step.kind !== "activate") return null;
    const index = (prompt.chains ?? []).findIndex((c) => c.code === step.code);
    return index >= 0 ? { type: RESP.SELECT_BATTLECMD, action: BATTLE.ACTIVATE, index } : null;
  }
  if (prompt.type === MSG.SELECT_CHAIN) {
    const index = step.kind === "activate" ? (prompt.selects ?? []).findIndex((c) => c.code === step.code) : -1;
    return index >= 0 ? { type: RESP.SELECT_CHAIN, index } : null;
  }
  return null;
}

/** Copia di un passo senza dettagli vuoti (per salvare e condividere). */
export const cleanStep = (s) => (s.details?.length ? { kind: s.kind, code: s.code, details: s.details.map((d) => ({ ...d })) } : { kind: s.kind, code: s.code });

// ------------------------------------------------------------- allenamento

export class ComboTrainer {
  /**
   * @param combo { name, steps: [{ kind, code, details? }], interrupts: [{ after, code }], tags? }
   * @param notify (text, kind) avviso a schermo
   * @param strict modalità strict: le azioni e le scelte diverse dalla combo vengono rifiutate
   * @param autoplay il trainer gioca la combo da solo (esportazione video)
   */
  constructor(combo, { notify, onRestart, strict = false, autoplay = false, onStrictChange }) {
    this.combo = combo;
    this.notify = notify;
    this.strict = strict;
    this.autoplay = autoplay;
    this.next = 0; // indice del prossimo passo atteso
    this.interrupted = null; // carta con cui l'avversario ha interrotto
    this.used = new Set(); // hand trap già usate
    this.chosen = 0; // carta dell'ultima azione scelta dal giocatore (per distinguere gli errori dagli effetti automatici)
    this.stepMarks = []; // per ogni passo fatto: lo stato di prima (per tornare indietro dopo un errore)
    this.active = null; // { step, pos }: passo in corso, di cui si controllano i dettagli
    this.me = 0;
    this.list = h("ol.trainer-steps");
    this.status = h("div.trainer-status");
    // Dopo un passo sbagliato: torna a prima del passo precedente (lo si rifà), quando lo decide il giocatore.
    this.backBtn = h("button.btn.small.primary.trainer-back", { hidden: true, title: "Undo the wrong action and the step before it", onclick: () => this.goBack() }, "↶ Back");
    const strictBox = h("input", { type: "checkbox", checked: strict, onchange: (e) => { this.strict = e.target.checked; onStrictChange?.(this.strict); this.render(); } });
    this.el = h(
      "div.trainer-panel",
      h("div.trainer-head", h("b", combo.name), (this.btns = h("div.trainer-btns", this.backBtn, h("button.btn.small.ghost", { title: "Restart the practice with the same hand", onclick: () => onRestart?.() }, "Restart")))),
      h("label.check.trainer-strict", { title: "Strict mode: actions and choices that differ from the combo are blocked, and the trainer tells you what to do instead" }, strictBox, "Strict mode"),
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
    this.active = null;
    this.rewindTo = t.mark;
    this.render();
    this.onBack?.();
  }

  render() {
    this.backBtn.hidden = !this.backTarget;
    if (this.backTarget) this.backBtn.textContent = `↶ Back to step ${this.backTarget.next + 1}`;
    const { steps, interrupts = [] } = this.combo;
    const rows = [];
    const interruptRow = (it) => h(`li.trainer-interrupt${this.interrupted === it ? ".fired" : ""}`, `⚡ Hand trap: "${cardName(it.code)}"`);
    for (const it of interrupts.filter((x) => x.after === 0)) rows.push(interruptRow(it));
    steps.forEach((s, i) => {
      const state = this.interrupted && i >= this.next ? "skipped" : i < this.next ? "ok" : i === this.next ? "current" : "todo";
      rows.push(
        h(
          `li.trainer-step.${state}`,
          h("span.trainer-mark", state === "ok" ? "✓" : state === "current" ? "▶" : ""),
          h("span", stepText(s), s.details?.length ? h("ul.trainer-details", s.details.map((d, j) => h(`li${this.active?.step === i && this.active.pos === j ? ".now" : ""}`, detailText(d)))) : null)
        )
      );
      for (const it of interrupts.filter((x) => x.after === i + 1)) rows.push(interruptRow(it));
    });
    clear(this.list).append(...rows);
    this.status.className = "trainer-status";
    const want = this.expectedDetail();
    if (this.interrupted) {
      this.status.classList.add("interrupted");
      this.status.textContent = `Interrupted by "${cardName(this.interrupted.code)}". Free play: find a way around it!`;
    } else if (this.done && !want) {
      this.status.classList.add("complete");
      this.status.textContent = "Combo complete!";
    } else if (want) {
      this.status.textContent = `Now: ${detailText(want)}`;
    } else {
      this.status.textContent = `Next: ${stepText(steps[this.next])}`;
    }
  }

  /** Dettaglio atteso adesso (scelta dentro il passo in corso), se c'è. */
  expectedDetail() {
    if (!this.active || this.interrupted) return null;
    return this.combo.steps[this.active.step]?.details?.[this.active.pos] ?? null;
  }

  /** Il core chiede qualcosa al giocatore: suggerimento del dettaglio atteso, "combo complete" a fine combo. */
  onPrompt(prompt) {
    if (prompt.player !== this.me) return;
    const want = this.expectedDetail();
    if (want && detailKind(prompt.type) === want.t) this.caption?.(`→ ${detailText(want)}`, "hint");
    if (!this.completePending) return;
    if (prompt.type !== MSG.SELECT_IDLECMD && prompt.type !== MSG.SELECT_BATTLECMD) return;
    this.completePending = false;
    this.active = null;
    if (!this.interrupted) this.complete();
  }

  complete() {
    this.notify("✓ Combo complete!", "ok");
    this.caption?.("✓ Combo complete!", "done");
    this.render();
    this.onComplete?.();
  }

  /**
   * Modalità strict: messaggio se la risposta va rifiutata (azione o scelta diversa dalla combo), altrimenti null.
   * Si controlla prima di mandare la risposta al core, quindi la richiesta viene semplicemente ripetuta.
   */
  check(prompt, response) {
    if (!this.strict || prompt.player !== this.me || this.interrupted || !response || response.back) return null;
    if (ACTION_PROMPTS.has(prompt.type)) {
      if (this.done) return null;
      const want = this.combo.steps[this.next];
      const act = actionOf(prompt, response);
      // Passare in catena non è mai bloccato: la carta del passo si può attivare anche in un momento successivo.
      if (!act) return null;
      if (act.kind === want.kind && (NO_CARD.has(want.kind) || act.code === want.code)) return null;
      return `Strict mode: you must ${stepText(want)}.`;
    }
    const want = this.expectedDetail();
    if (!want || detailKind(prompt.type) !== want.t) return null;
    return sameDetail(detailOf(prompt, response, this.me), want) ? null : `Strict mode: ${detailText(want)}.`;
  }

  /** Risposta data dal giocatore: si ricorda la carta scelta e si seguono i dettagli del passo. */
  onResponse(prompt, response, mark) {
    if (prompt.player !== this.me) return;
    const act = actionOf(prompt, response);
    if (act) {
      this.chosen = act.kind === "endphase" ? EP : act.code;
      this.chosenMark = mark; // stato di prima dell'azione: in caso di errore si torna qui
      const want = !this.interrupted && this.combo.steps[this.next];
      this.active = want && act.kind === want.kind && (NO_CARD.has(want.kind) || act.code === want.code) && want.details?.length ? { step: this.next, pos: 0 } : null;
      this.render();
      return;
    }
    const want = this.expectedDetail();
    if (!want || detailKind(prompt.type) !== want.t) return;
    const got = detailOf(prompt, response, this.me);
    if (!sameDetail(got, want)) {
      // Scelta diversa da quella della combo: si avvisa (in strict non arriva qui, viene rifiutata prima).
      this.notify(`✗ ${detailText(got)}. Expected: ${detailText(want)}`, "error");
      this.caption?.(`✗ ${detailText(got)}`, "wrong");
      // "Back" torna a prima dell'azione di questo passo, che va rifatto con le scelte giuste.
      if (this.chosenMark) this.backTarget = { mark: this.chosenMark, next: this.active.step };
    }
    this.active.pos++;
    if (this.active.pos >= (this.combo.steps[this.active.step].details?.length ?? 0)) this.active = null;
    this.render();
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
        // Attivazione dell'avversario: se è una hand trap della combo, da qui in poi si gioca liberamente.
        const it = (this.combo.interrupts ?? []).find((x) => x.code === m.code && this.used.has(x) && !this.interrupted);
        if (kind === "activate" && it) {
          this.interrupted = it;
          this.active = null;
          this.notify(`Interrupted by "${cardName(it.code)}"! Find a way around it.`, "error");
          this.caption?.(`⚡ Hand trap: "${cardName(it.code)}"`, "interrupt");
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
        if (this.done && kind === "endphase") this.complete();
        else if (this.done) this.completePending = true;
        this.render();
      } else if (m.code && m.code === this.chosen) {
        // Passo sbagliato: il pulsante "Back" annulla l'azione sbagliata e anche l'ultimo passo giusto,
        // che va rifatto (al primo passo solo l'azione sbagliata). La sessione ricostruisce lo stato.
        this.chosen = 0;
        this.active = null;
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
   * Auto-play: risposta per il giocatore (passo o dettaglio della combo). undefined = il trainer non sa
   * cosa fare (la sessione usa l'IA per le scelte, o lascia giocare il giocatore se manca l'azione).
   */
  autoRespond(prompt) {
    if (!this.autoplay || this.interrupted || prompt.player !== this.me) return undefined;
    const want = this.expectedDetail();
    if (want && detailKind(prompt.type) === want.t) return detailResponse(want, prompt, this.me) ?? undefined;
    if (ACTION_PROMPTS.has(prompt.type)) {
      if (this.done) {
        this.autoplay = false;
        return undefined;
      }
      const r = stepResponse(this.combo.steps[this.next], prompt);
      if (r) return r;
      // In catena e nelle finestre di battaglia si passa finché non si può fare il passo.
      if (prompt.type === MSG.SELECT_CHAIN && !prompt.forced) return { type: RESP.SELECT_CHAIN, index: null };
      if (prompt.type === MSG.SELECT_BATTLECMD && prompt.to_m2) return { type: RESP.SELECT_BATTLECMD, action: BATTLE.TO_M2, index: 0 };
      this.autoplay = false;
      this.notify(`Auto-play stopped: "${stepText(this.combo.steps[this.next])}" is not possible now. Continue yourself.`, "error");
      return undefined;
    }
    return null; // dettaglio non previsto: sceglie l'IA
  }

  /**
   * Risposta dell'avversario. Dopo il passo indicato usa la hand trap alla prima occasione
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
 * End Phase) diventa un passo, con le scelte fatte durante il passo come dettagli.
 * Stessa interfaccia del ComboTrainer, così la sessione lo usa allo stesso modo.
 */
export class ComboRecorder {
  constructor(combo, { notify, onFinish }) {
    this.combo = combo;
    this.notify = notify;
    this.steps = [];
    this.marks = []; // stato di prima di ogni passo (per "Undo last")
    this.chosen = 0;
    this.pending = []; // dettagli dell'azione in corso (diventano quelli del passo quando avviene)
    this.me = 0;
    this.list = h("ol.trainer-steps.recording");
    this.undoBtn = h("button.btn.small.ghost", { title: "Undo the last recorded action", onclick: () => this.goBack() }, "↶ Undo last");
    this.el = h(
      "div.trainer-panel",
      h("div.trainer-head", h("b", `● Recording: ${combo.name}`), (this.btns = h("div.trainer-btns", this.undoBtn, h("button.btn.small.primary", { onclick: () => onFinish?.(this.result()) }, "Finish")))),
      h("div.trainer-status", "Play the combo: every action you choose becomes a step, with the cards, zones and answers you pick. Press Finish when done."),
      this.list
    );
    this.render();
  }

  result() {
    return { ...this.combo, steps: this.steps.map(cleanStep) };
  }

  render() {
    this.undoBtn.disabled = !this.steps.length;
    clear(this.list).append(
      ...(this.steps.length
        ? this.steps.map((s) => h("li.trainer-step.ok", h("span.trainer-mark", "●"), h("span", stepText(s), s.details?.length ? h("ul.trainer-details", s.details.map((d) => h("li", detailText(d)))) : null)))
        : [h("li.muted.small", "No steps yet.")])
    );
  }

  goBack() {
    if (!this.steps.length) return;
    this.steps.pop();
    this.rewindTo = this.marks.pop();
    this.pending = [];
    this.render();
    this.onBack?.();
  }

  onPrompt() {}
  check() { return null; }
  autoRespond() { return undefined; }

  onResponse(prompt, response, mark) {
    if (prompt.player !== this.me) return;
    const act = actionOf(prompt, response);
    if (act) {
      this.chosen = act.kind === "endphase" ? EP : act.code;
      this.chosenMark = mark;
      this.pending = []; // nuova azione: i dettagli successivi sono suoi
      return;
    }
    const d = detailOf(prompt, response, this.me);
    if (d) {
      this.pending.push(d);
      this.render();
    }
  }

  /** Si registrano solo gli eventi delle azioni scelte (non gli effetti automatici). */
  onMessages(messages) {
    for (const raw of messages) {
      if (raw.type === MSG.NEW_TURN) this.turnPlayer = raw.player;
      const m = raw.type === MSG.NEW_PHASE && raw.phase === PHASE.END ? { type: "endphase", controller: this.turnPlayer, code: EP } : raw;
      const kind = m.type === "endphase" ? "endphase" : EVENT_KIND[m.type];
      if (!kind || m.controller !== this.me || !m.code || m.code !== this.chosen) continue;
      // Lo stesso array: le scelte fatte durante la risoluzione si aggiungono ancora a questo passo.
      this.steps.push({ kind, code: kind === "endphase" ? 0 : m.code, details: this.pending });
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
  const data = { v: 2, name: c.name, first: c.first, hand: c.hand, steps: c.steps.map(cleanStep), interrupts: c.interrupts, setup: c.setup, tags: c.tags };
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return SHARE_PREFIX + btoa(bin);
}

const DETAIL_TYPES = new Set(["cards", "pick", "zone", "pos", "yesno", "option"]);
const ZONE_KEYS = /^(m[0-6]|s[0-4]|f)$/;

/** Stato di partenza valido (vedi combos.js): solo codici interi e zone note. */
export function cleanSetup(s) {
  if (!s || typeof s !== "object") return undefined;
  const codes = (a) => (Array.isArray(a) ? a.filter((x) => Number.isInteger(x)).slice(0, 40) : []);
  const field = (a) => (Array.isArray(a) ? a.filter((x) => x && Number.isInteger(x.code) && ZONE_KEYS.test(x.zone)).map((x) => ({ code: x.code, zone: x.zone, pos: ["atk", "def", "set"].includes(x.pos) ? x.pos : "atk" })) : []);
  const side = (x = {}, opp) => ({ field: field(x.field), gy: codes(x.gy), banished: codes(x.banished), ...(opp ? { hand: codes(x.hand), deckTop: codes(x.deckTop), extra: codes(x.extra) } : {}) });
  return { me: side(s.me, false), opp: side(s.opp, true) };
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
  const okDetails = (d) => d == null || (Array.isArray(d) && d.every((x) => x && DETAIL_TYPES.has(x.t)));
  const okSteps = Array.isArray(data.steps) && data.steps.every((s) => s && s.kind in STEP_ACTIONS && Number.isInteger(s.code) && okDetails(s.details));
  const okInts = Array.isArray(data.interrupts ?? []) && (data.interrupts ?? []).every((x) => x && Number.isInteger(x.after) && Number.isInteger(x.code));
  if (!nums(data.hand) || !okSteps || !okInts) throw new Error("The combo code is not valid");
  const tags = Array.isArray(data.tags) ? data.tags.filter((x) => x && Number.isInteger(x.code) && typeof x.text === "string").map((x) => ({ code: x.code, text: x.text.slice(0, 40) })) : [];
  return { name: String(data.name || "Imported combo").slice(0, 60), first: data.first !== false, hand: data.hand, steps: data.steps.map(cleanStep), interrupts: data.interrupts ?? [], setup: cleanSetup(data.setup), tags };
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
