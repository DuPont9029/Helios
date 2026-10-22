// Combo Trainer: segue la combo durante il duello, segnala i passi giusti e quelli sbagliati e pilota
// l'avversario, che usa le hand trap dopo i passi scelti. Dopo un'interruzione si gioca liberamente.
// Ogni passo può avere dei dettagli (carte da scegliere, zona, posizione, sì/no, opzione): il trainer li
// suggerisce, li controlla (in modalità strict blocca le scelte sbagliate) e l'auto-play li usa per giocare da solo.
import { h, clear } from "../ui/dom.js";
import { miniCards } from "../ui/card.js";
import { cardName, descString, getCard, isExtraDeckCard } from "../data/db.js";
import { sortDeckPart, loadDecks } from "../deck/deck.js";
import { MSG, RESP, IDLE, BATTLE, PHASE, LOC, POS } from "../core/constants.js";
import { availableZones } from "../core/zones.js";

export const STEP_ACTIONS = { summon: "Normal Summon", spsummon: "Special Summon", pendulum: "Pendulum Summon", set: "Set", activate: "Activate", endphase: "End Phase" };
// Passi senza carta (il codice è un segnaposto). La Pendulum Summon: le carte evocate sono una scelta del passo.
export const NO_CARD = new Set(["endphase", "pendulum"]);
const EP = "EP";
const PEND = "PEND";

// Eventi del duello che corrispondono ai tipi di passo.
const EVENT_KIND = { [MSG.SUMMONING]: "summon", [MSG.SPSUMMONING]: "spsummon", [MSG.SET]: "set", [MSG.CHAINING]: "activate" };
// Azioni scelte dal giocatore (risposta a MSG_SELECT_IDLECMD): elenco nel messaggio da cui prendere la carta.
const IDLE_LIST = { [IDLE.SUMMON]: "summons", [IDLE.SPSUMMON]: "special_summons", [IDLE.MSET]: "monster_sets", [IDLE.SSET]: "spell_sets", [IDLE.ACTIVATE]: "activates" };
const IDLE_KIND = { [IDLE.SUMMON]: "summon", [IDLE.SPSUMMON]: "spsummon", [IDLE.MSET]: "set", [IDLE.SSET]: "set", [IDLE.ACTIVATE]: "activate" };

// Effetto preciso di un passo "Activate" (carte con più effetti attivabili): descrizione dell'effetto (stringa
// del core: codice << 20 | indice). "way": quale modo di evocazione per le carte con più procedure (1, 2...).
export const effectText = (desc) => {
  try {
    return descString(BigInt(desc)) || "";
  } catch {
    return "";
  }
};
export const stepText = (s) =>
  NO_CARD.has(s.kind)
    ? STEP_ACTIONS[s.kind]
    : `${STEP_ACTIONS[s.kind] ?? s.kind} "${cardName(s.code)}"${s.desc ? ` · ${effectText(s.desc) || "effect"}` : ""}${s.way ? ` · way ${s.way}` : ""}`;

/** Effetti attivabili di una carta (per scegliere quello del passo): [{ desc, text, from? }]. */
export function cardEffects(code, decklist = []) {
  const of = (k) => (getCard(k)?.strings ?? []).map((text, i) => ({ desc: String((BigInt(k) << 20n) | BigInt(i)), text })).filter((e) => e.text);
  // Effetti che altre carte della decklist danno al mostro (es. un Equip "...gains the following effects").
  const granted = [...new Set(decklist)].filter((k) => k !== code && /gains? the following effects?/i.test(getCard(k)?.desc ?? ""))
    .flatMap((k) => of(k).map((e) => ({ ...e, from: k })));
  return [...of(code), ...granted];
}

/** Posizione (1, 2...) della carta tra quelle con lo stesso codice nell'elenco (le procedure di evocazione). */
const wayOf = (list, index) => {
  const c = list?.[index];
  if (!c) return 0;
  return list.slice(0, index + 1).filter((x) => x.code === c.code && x.location === c.location && x.sequence === c.sequence).length;
};
const descOf = (c) => (c?.description != null ? String(c.description) : undefined);

// ------------------------------------------------------------- azioni e dettagli

/**
 * Azione scelta dal giocatore: { kind, code } (kind "other" = azione che non è un tipo di passo,
 * es. Battle Phase o cambio di posizione), null = nessuna azione (es. passare in catena) o richiesta di dettaglio.
 */
export function actionOf(prompt, response) {
  if (!response) return null;
  if (prompt.type === MSG.SELECT_IDLECMD) {
    if (response.action === IDLE.TO_EP) return { kind: "endphase", code: EP };
    // "Special Summon" della carta nella zona Pendulum = Pendulum Summon.
    if (response.action === IDLE.SPSUMMON && prompt.special_summons?.[response.index]?.location & LOC.SZONE) return { kind: "pendulum", code: PEND };
    const kind = IDLE_KIND[response.action];
    if (!kind) return { kind: "other", code: 0 };
    const list = prompt[IDLE_LIST[response.action]];
    const card = list?.[response.index];
    const act = { kind, code: card?.code ?? 0 };
    if (kind === "activate") act.desc = descOf(card);
    if (kind === "spsummon" && list.filter((x) => x.code === card?.code).length > 1) act.way = wayOf(list, response.index);
    return act;
  }
  if (prompt.type === MSG.SELECT_BATTLECMD) {
    if (response.action === BATTLE.TO_EP) return { kind: "endphase", code: EP };
    if (response.action === BATTLE.ACTIVATE) return { kind: "activate", code: prompt.chains?.[response.index]?.code ?? 0, desc: descOf(prompt.chains?.[response.index]) };
    return { kind: "other", code: 0 };
  }
  if (prompt.type === MSG.SELECT_CHAIN && response.index != null) return { kind: "activate", code: prompt.selects?.[response.index]?.code ?? 0, desc: descOf(prompt.selects?.[response.index]) };
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

/**
 * Il giocatore annulla una selezione (Cancel, non Finish): il core torna alla scelta precedente (es. nelle
 * Fusion Summon, annullando i materiali si sceglie di nuovo il mostro Fusione).
 */
export function isCancel(prompt, response) {
  if (!response || response.back) return false;
  switch (prompt.type) {
    case MSG.SELECT_UNSELECT_CARD: return response.index == null && !!prompt.can_cancel && !prompt.can_finish;
    case MSG.SELECT_CARD: case MSG.SELECT_TRIBUTE: case MSG.SELECT_SUM: return response.indicies == null && !!prompt.can_cancel;
  }
  return false;
}
/** La scelta a cui riporta un annullamento: solo una selezione di carte (una zona o un Sì/No non si rifanno). */
const reselectable = (d) => d?.t === "cards" || d?.t === "pick";

/** Carta già scelta che il giocatore toglie dalla selezione (SELECT_UNSELECT_CARD), altrimenti 0. */
export function unselectedCode(prompt, response) {
  if (prompt.type !== MSG.SELECT_UNSELECT_CARD || response?.index == null) return 0;
  const n = prompt.select_cards?.length ?? 0;
  return response.index >= n ? prompt.unselect_cards?.[response.index - n]?.code ?? 0 : 0;
}

/** Dettaglio registrato dalla risposta del giocatore `me` (null se la richiesta non è un dettaglio). */
export function detailOf(prompt, response, me) {
  if (!response || response.back) return null;
  switch (detailKind(prompt.type)) {
    case "cards": {
      if (!response.indicies) return null;
      const list = prompt.selects ?? [];
      const picked = response.indicies.map((i) => list[i]);
      // Carte prese dal Deck (ricerche, materiali, evocazioni dal Deck): ognuna è una copia in più che serve nel mazzo.
      const deck = picked.filter((c) => c?.location === LOC.DECK).map((c) => c.code).sort((a, b) => a - b);
      return { t: "cards", codes: picked.map((c) => c?.code ?? 0).sort((a, b) => a - b), ...(deck.length ? { deck } : {}) };
    }
    case "pick": {
      const card = response.index == null ? null : unselectList(prompt)[response.index];
      return { t: "pick", code: card?.code ?? 0, ...(card?.location === LOC.DECK ? { deck: true } : {}) };
    }
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
    case "cards": return d.codes.length ? `Select ${quoted(d.codes)}${d.deck?.length ? " (from the Deck)" : ""}` : "Select no cards";
    case "pick": return d.code ? `Select "${cardName(d.code)}"${d.deck ? " (from the Deck)" : ""}` : "Finish the selection";
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

/**
 * Indice della carta del passo nell'elenco: con l'effetto indicato (desc) se il passo lo specifica, con il
 * modo di evocazione (way) se la carta ne ha più d'uno; altrimenti la prima con quel codice. -1 se non c'è.
 */
function pick(list = [], step, used = null) {
  const same = list.map((c, i) => [c, i]).filter(([c]) => c.code === step.code);
  if (!same.length) return -1;
  if (step.desc) {
    const exact = same.find(([c]) => descOf(c) === step.desc);
    if (exact) return exact[1];
  }
  // Passo senza l'effetto indicato (combo registrate prima): tra gli effetti della carta, uno non ancora usato
  // nella combo (di solito ogni effetto si usa una volta per turno).
  if (!step.desc && used && same.length > 1) {
    const fresh = same.find(([c]) => !used.has(`${c.code}:${descOf(c)}`));
    if (fresh) return fresh[1];
  }
  if (step.way && same[step.way - 1]) return same[step.way - 1][1];
  return same[0][1];
}

/** Risposta che esegue il passo `step` (auto-play); null se ora non si può. */
function stepResponse(step, prompt, used = null) {
  if (prompt.type === MSG.SELECT_IDLECMD) {
    if (step.kind === "endphase") return prompt.to_ep ? { type: RESP.SELECT_IDLECMD, action: IDLE.TO_EP, index: 0 } : null;
    if (step.kind === "pendulum") {
      const index = (prompt.special_summons ?? []).findIndex((c) => c.location & LOC.SZONE);
      return index >= 0 ? { type: RESP.SELECT_IDLECMD, action: IDLE.SPSUMMON, index } : null;
    }
    const lists = step.kind === "set" ? [IDLE.MSET, IDLE.SSET] : Object.keys(IDLE_KIND).map(Number).filter((a) => IDLE_KIND[a] === step.kind);
    for (const action of lists) {
      const index = pick(prompt[IDLE_LIST[action]], step, used);
      if (index >= 0) return { type: RESP.SELECT_IDLECMD, action, index };
    }
    return null;
  }
  if (prompt.type === MSG.SELECT_BATTLECMD) {
    if (step.kind === "endphase") return prompt.to_ep ? { type: RESP.SELECT_BATTLECMD, action: BATTLE.TO_EP, index: 0 } : null;
    if (step.kind !== "activate") return null;
    const index = pick(prompt.chains, step, used);
    return index >= 0 ? { type: RESP.SELECT_BATTLECMD, action: BATTLE.ACTIVATE, index } : null;
  }
  if (prompt.type === MSG.SELECT_CHAIN) {
    const index = step.kind === "activate" ? pick(prompt.selects, step, used) : -1;
    return index >= 0 ? { type: RESP.SELECT_CHAIN, index } : null;
  }
  return null;
}

/** L'azione scelta è il passo atteso? (una Pendulum Summon può realizzare anche un passo "Special Summon"). */
// Con l'effetto (desc) o il modo di evocazione (way) indicati nel passo, devono essere quelli.
const sameAction = (act, want) =>
  !!want && (act.kind === want.kind
    ? NO_CARD.has(want.kind) || (act.code === want.code && (!want.desc || !act.desc || act.desc === want.desc) && (!want.way || !act.way || act.way === want.way))
    : act.kind === "pendulum" && want.kind === "spsummon");

/** Copia di un passo senza dettagli e note vuoti (per salvare e condividere). */
export const cleanStep = (s) => ({
  kind: s.kind,
  code: s.code,
  ...(typeof s.desc === "string" && /^\d{1,20}$/.test(s.desc) ? { desc: s.desc } : {}),
  ...(Number.isInteger(s.way) && s.way > 0 && s.way < 10 ? { way: s.way } : {}),
  ...(s.details?.length ? { details: s.details.map((d) => ({ ...d })) } : {}),
  ...(s.note?.trim() ? { note: s.note.trim().slice(0, 300) } : {}),
});

// ------------------------------------------------------------- allenamento

export class ComboTrainer {
  /**
   * @param combo { name, steps: [{ kind, code, details? }], interrupts: [{ after, code }], tags? }
   * @param notify (text, kind) avviso a schermo
   * @param strict modalità strict: le azioni e le scelte diverse dalla combo vengono rifiutate
   * @param autoplay il trainer gioca la combo da solo (esportazione video)
   * @param lockAuto auto-play aperto dal menu: non si può spegnere finché la combo non finisce
   */
  constructor(combo, { notify, onRestart, strict = false, autoplay = false, lockAuto = false, onStrictChange }) {
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
    // Dopo un errore: oltre a tornare indietro di un passo, si può ricominciare la combo da capo (stessa mano).
    this.restartBtn = h("button.btn.small.trainer-back", { hidden: true, title: "Start the combo again from the beginning, with the same hand", onclick: () => onRestart?.() }, "↺ Restart from the beginning");
    const strictBox = h("input", { type: "checkbox", checked: strict, onchange: (e) => { this.strict = e.target.checked; onStrictChange?.(this.strict); this.render(); } });
    // Auto-play: il trainer gioca la combo da solo da questo punto (anche senza registrare un video).
    this.autoBox = h("input", { type: "checkbox", checked: autoplay, disabled: autoplay && lockAuto, onchange: (e) => { this.autoplay = e.target.checked; if (!this.autoplay) this.togglePause(false); this.pauseBtn.hidden = !this.autoplay; this.render(); this.onAutoplay?.(this.autoplay); this.onAutoChange?.(this.autoplay); } });
    this.el = h(
      "div.trainer-panel",
      h(
        "div.trainer-top",
        h("div.trainer-head", h("b", combo.name), (this.btns = h("div.trainer-btns", this.backBtn, this.restartBtn, h("button.btn.small.ghost", { title: "Restart the practice with the same hand", onclick: () => onRestart?.() }, "Restart")))),
        h(
          "div.trainer-toggles",
          h("label.check.trainer-strict", { title: "Strict mode: actions and choices that differ from the combo are blocked, and the trainer tells you what to do instead" }, strictBox, "Strict mode"),
          h("label.check.trainer-strict.trainer-auto", { title: autoplay && lockAuto ? "Auto-play started from the menu: it plays the whole combo" : "The trainer plays the combo by itself from here, with the choices saved in each step. While it plays, the duel does not take your clicks" }, this.autoBox, "Auto-play"),
          // Pausa dell'auto-play: la combo si ferma prima dell'azione o scelta successiva.
          (this.pauseBtn = h("button.btn.small.ghost.trainer-auto.trainer-pause", { hidden: !autoplay, title: "Pause the auto-play before the next action", onclick: () => this.togglePause() }, "❚❚ Pause"))
        ),
        this.status
      ),
      combo.notes ? h("details.trainer-notes", h("summary", "Notes"), h("p", combo.notes)) : null,
      this.list
    );
    this.render();
  }

  get done() {
    return !this.interrupted && this.next >= this.combo.steps.length;
  }

  /** Stato da ripristinare quando la sessione torna indietro (Back di una summon/attivazione, rewind). */
  save() {
    return {
      next: this.next, active: this.active ? { ...this.active } : null, chosen: this.chosen, interrupted: this.interrupted,
      used: [...this.used], stepMarks: [...this.stepMarks], completePending: !!this.completePending, pendulum: !!this.pendulum,
      lastPick: this.lastPick ? { ...this.lastPick } : null,
      lastDone: this.lastDone ? { ...this.lastDone } : null,
      usedEffects: [...(this.usedEffects ?? [])],
    };
  }

  restore(st) {
    Object.assign(this, { ...st, active: st.active ? { ...st.active } : null, used: new Set(st.used), stepMarks: [...st.stepMarks], usedEffects: new Set(st.usedEffects ?? []) });
    this.render();
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
    this.restartBtn.hidden = !this.backTarget;
    if (this.backTarget) this.backBtn.textContent = `↶ Back to step ${this.backTarget.next + 1}`;
    const { steps, interrupts = [] } = this.combo;
    const rows = [];
    const interruptRow = (it) => h(`li.trainer-interrupt${this.interrupted === it ? ".fired" : ""}`, `⚡ The opponent uses "${cardName(it.code)}"`);
    for (const it of interrupts.filter((x) => x.after === 0)) rows.push(interruptRow(it));
    steps.forEach((s, i) => {
      const state = this.interrupted && i >= this.next ? "skipped" : i < this.next ? "ok" : i === this.next ? "current" : "todo";
      rows.push(
        h(
          `li.trainer-step.${state}`,
          h("span.trainer-mark", state === "ok" ? "✓" : state === "current" ? "▶" : ""),
          h(
            "span",
            NO_CARD.has(s.kind) ? null : miniCards([s.code]),
            stepText(s),
            s.details?.length ? h("ul.trainer-details", s.details.map((d, j) => h(`li${this.active?.step === i && this.active.pos === j ? ".now" : ""}`, miniCards(detailCodes(d)), detailText(d)))) : null,
            s.note && state !== "ok" ? h("div.trainer-note", s.note) : null
          )
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
    // Combo finita: l'auto-play si ferma e il giocatore riprende i comandi (es. "Play again").
    if (this.autoplay) this.stopAuto();
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
      if (sameAction(act, want)) return null;
      // Attivazioni in catena dentro il passo in corso (es. l'effetto innescato dalla summon): permesse.
      if (prompt.type === MSG.SELECT_CHAIN && this.expectedDetail()) return null;
      return `Strict mode: you must ${stepText(want)}.`;
    }
    // Togliere una carta già scelta o annullare la selezione non è mai bloccato: si torna alla scelta di prima (vedi onResponse).
    if (unselectedCode(prompt, response) || isCancel(prompt, response)) return null;
    const want = this.expectedDetail();
    if (!want || detailKind(prompt.type) !== want.t) return null;
    return sameDetail(detailOf(prompt, response, this.me), want) ? null : `Strict mode: ${detailText(want)}.`;
  }

  /** Risposta data dal giocatore: si ricorda la carta scelta e si seguono i dettagli del passo. */
  onResponse(prompt, response, mark) {
    if (prompt.player !== this.me) return;
    // "Attivare l'effetto?" (effetto innescato, es. dopo una summon) con "Sì" per il passo atteso "Activate":
    // è l'azione del passo, che da qui segue le sue scelte precise (prima restavano all'IA o al caso).
    if (prompt.type === MSG.SELECT_EFFECTYN && response?.yes && this.expectedDetail()?.t !== "yesno") {
      const want = !this.interrupted && this.combo.steps[this.next];
      if (want?.kind === "activate" && want.code === prompt.code) {
        this.chosen = want.code;
        this.chosenMark = mark;
        this.active = want.details?.length ? { step: this.next, pos: 0 } : null;
        this.lastPick = null;
        this.lastDone = null;
        this.render();
        return;
      }
    }
    const act = actionOf(prompt, response);
    if (act?.kind === "activate") (this.usedEffects ??= new Set()).add(`${act.code}:${act.desc}`);
    if (act) {
      const want = !this.interrupted && this.combo.steps[this.next];
      const match = sameAction(act, want);
      // Un'attivazione in catena che non è il passo successivo (es. l'effetto innescato dalla summon)
      // fa parte del passo in corso: le sue scelte restano quelle attese.
      if (!match && prompt.type === MSG.SELECT_CHAIN && this.active) return;
      this.chosen = act.kind === "endphase" ? EP : act.code;
      this.chosenMark = mark; // stato di prima dell'azione: in caso di errore si torna qui
      this.pendulum = act.kind === "pendulum";
      this.active = match && want.details?.length ? { step: this.next, pos: 0 } : null;
      this.lastPick = null;
      this.lastDone = null;
      this.render();
      return;
    }
    // Selezione annullata: il core richiede la scelta precedente del passo, che torna quella attesa.
    if (isCancel(prompt, response)) {
      const step = this.active?.step ?? this.lastDone?.step;
      const pos = this.active ? this.active.pos - 1 : this.lastDone?.pos;
      const prev = step != null && pos >= 0 ? this.combo.steps[step]?.details?.[pos] : null;
      if (reselectable(prev)) {
        this.active = { step, pos };
        this.lastPick = null;
        this.render();
      }
      return;
    }
    // Carta tolta dalla selezione: se era la scelta precedente del passo, la si richiede di nuovo.
    const removed = unselectedCode(prompt, response);
    if (removed) {
      const last = this.lastPick;
      if (last?.code === removed) {
        this.active = { step: last.step, pos: last.pos };
        this.lastPick = null;
        this.render();
      }
      return;
    }
    const want = this.expectedDetail();
    if (!want || detailKind(prompt.type) !== want.t) return;
    const got = detailOf(prompt, response, this.me);
    this.lastPick = got.t === "pick" && got.code ? { step: this.active.step, pos: this.active.pos, code: got.code } : null;
    if (!sameDetail(got, want)) {
      // Scelta diversa da quella della combo: si avvisa (in strict non arriva qui, viene rifiutata prima).
      this.notify(`✗ ${detailText(got)}. Expected: ${detailText(want)}`, "error");
      this.caption?.(`✗ ${detailText(got)}`, "wrong");
      // "Back" torna a prima dell'azione di questo passo, che va rifatto con le scelte giuste.
      if (this.chosenMark) this.backTarget = { mark: this.chosenMark, next: this.active.step };
    }
    this.lastDone = { step: this.active.step, pos: this.active.pos };
    this.active.pos++;
    if (this.active.pos >= (this.combo.steps[this.active.step].details?.length ?? 0)) this.active = null;
    this.render();
  }

  /** Eventi del duello: avanzano i passi o, se sono azioni scelte dal giocatore ma sbagliate, lo avvisano. */
  onMessages(messages) {
    for (const raw of messages) {
      if (raw.type === MSG.NEW_TURN) this.turnPlayer = raw.player;
      // Fine di una Pendulum Summon fatta per un passo "Special Summon" che non ha evocato quella carta:
      // evento "pendulum" (passo sbagliato).
      const pendEnd = raw.type === MSG.SPSUMMONED && this.pendulum && this.chosen === PEND;
      if (raw.type === MSG.SPSUMMONED) this.pendulum = false;
      // End Phase del proprio turno: evento "endphase" (senza carta).
      const m =
        raw.type === MSG.NEW_PHASE && raw.phase === PHASE.END ? { type: "endphase", controller: this.turnPlayer, code: EP }
        : pendEnd ? { type: "pendulum", controller: this.me, code: 0 }
        : raw;
      let kind = m.type === "endphase" || m.type === "pendulum" ? m.type : EVENT_KIND[m.type];
      if (!kind) continue;
      // Pendulum Summon in corso: realizza il passo "Pendulum Summon" con la prima summon, o lo "Special Summon"
      // di una delle carte evocate (in qualsiasi ordine); le altre summon fanno parte dello stesso passo.
      if (kind === "spsummon" && this.pendulum && m.controller === this.me) {
        const want = this.combo.steps[this.next];
        if (this.chosen !== PEND) continue;
        if (want?.kind === "spsummon" && !this.interrupted) {
          if (want.code !== m.code) continue;
        } else kind = "pendulum";
      }
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
        if (this.chosen === PEND) this.chosen = 0; // le altre summon della Pendulum Summon non sono passi
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
      } else if ((m.code && m.code === this.chosen) || (kind === "pendulum" && this.chosen === PEND)) {
        if (this.chosen === PEND) this.chosen = 0;
        // Passo sbagliato: il pulsante "Back" annulla l'azione sbagliata e anche l'ultimo passo giusto,
        // che va rifatto (al primo passo solo l'azione sbagliata). La sessione ricostruisce lo stato.
        this.chosen = 0;
        this.active = null;
        const prev = this.next > 0 ? this.stepMarks[this.next - 1] : null;
        this.backTarget = prev ? { mark: prev, next: this.next - 1 } : this.chosenMark ? { mark: this.chosenMark, next: this.next } : this.backTarget;
        this.notify(`✗ Wrong step: you did ${stepText({ kind, code: m.code })}. Expected: ${stepText(want)}. Press "Back" to go back, or restart from the beginning.`, "error");
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
  /** Pausa / ripresa dell'auto-play. */
  togglePause(force) {
    this.paused = force ?? !this.paused;
    this.pauseBtn.textContent = this.paused ? "▶ Resume" : "❚❚ Pause";
    this.pauseBtn.classList.toggle("on", this.paused);
    if (!this.paused) for (const r of this.resumeWaiters?.splice(0) ?? []) r();
  }

  /** Attesa finché l'auto-play è in pausa (subito se non lo è). */
  waitResume() {
    if (!this.paused || !this.autoplay) return Promise.resolve();
    return new Promise((r) => (this.resumeWaiters ??= []).push(r));
  }

  stopAuto() {
    this.autoplay = false;
    this.togglePause(false);
    if (this.pauseBtn) this.pauseBtn.hidden = true;
    if (this.autoBox) Object.assign(this.autoBox, { checked: false, disabled: false });
    this.onAutoChange?.(false);
  }

  autoRespond(prompt) {
    if (!this.autoplay || this.interrupted || prompt.player !== this.me) return undefined;
    const want = this.expectedDetail();
    if (want && detailKind(prompt.type) === want.t) return detailResponse(want, prompt, this.me) ?? undefined;
    // Effetto innescato che è il passo successivo: si attiva.
    const step = !this.done && this.combo.steps[this.next];
    if (prompt.type === MSG.SELECT_EFFECTYN && step?.kind === "activate" && step.code === prompt.code) return { type: RESP.SELECT_EFFECTYN, yes: true };
    if (ACTION_PROMPTS.has(prompt.type)) {
      // Passo fatto ma con scelte ancora da fare (es. l'attivazione che si risolve dopo la catena):
      // si passa in catena e si aspettano le scelte.
      if (this.active && prompt.type === MSG.SELECT_CHAIN && !prompt.forced) return { type: RESP.SELECT_CHAIN, index: null };
      if (this.done) {
        this.stopAuto();
        return undefined;
      }
      const r = stepResponse(this.combo.steps[this.next], prompt, this.usedEffects);
      if (r) return r;
      // In catena e nelle finestre di battaglia si passa finché non si può fare il passo.
      if (prompt.type === MSG.SELECT_CHAIN && !prompt.forced) return { type: RESP.SELECT_CHAIN, index: null };
      if (prompt.type === MSG.SELECT_BATTLECMD && prompt.to_m2) return { type: RESP.SELECT_BATTLECMD, action: BATTLE.TO_M2, index: 0 };
      this.stopAuto();
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
      // Intestazione fissa: "Finish" resta visibile anche scorrendo i passi registrati (la spiegazione scorre con loro).
      h("div.trainer-top", h("div.trainer-head", h("b", `● Recording: ${combo.name}`), (this.btns = h("div.trainer-btns", this.undoBtn, h("button.btn.small.primary", { onclick: () => onFinish?.(this.result()) }, "Finish"))))),
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
        ? this.steps.map((s) => h("li.trainer-step.ok", h("span.trainer-mark", "●"), h("span", NO_CARD.has(s.kind) ? null : miniCards([s.code]), stepText(s), s.details?.length ? h("ul.trainer-details", s.details.map((d) => h("li", miniCards(detailCodes(d)), detailText(d)))) : null)))
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

  save() {
    return {
      steps: this.steps.map((x) => ({ ...x, details: [...x.details] })), marks: [...this.marks], pending: [...this.pending], chosen: this.chosen,
      // Le scelte in corso sono quelle dell'ultimo passo registrato (stesso array)?
      pendingIsLast: !!this.steps.length && this.pending === this.steps.at(-1).details,
    };
  }

  restore(st) {
    this.steps = st.steps.map((x) => ({ ...x, details: [...x.details] }));
    this.marks = [...st.marks];
    this.pending = st.pendingIsLast ? this.steps.at(-1).details : [...st.pending];
    this.chosen = st.chosen;
    this.render();
  }

  onResponse(prompt, response, mark) {
    if (prompt.player !== this.me) return;
    const act = actionOf(prompt, response);
    if (act) {
      this.chosen = act.kind === "endphase" ? EP : act.code;
      this.chosenAct = act; // effetto preciso (desc) e modo di evocazione (way), salvati nel passo
      this.chosenMark = mark;
      this.pending = []; // nuova azione: i dettagli successivi sono suoi
      return;
    }
    const last = this.pending.at(-1);
    // Selezione annullata: il core torna alla scelta precedente, che va rifatta (quella vecchia non si registra).
    if (isCancel(prompt, response)) {
      if (reselectable(last)) this.pending.pop();
      this.render();
      return;
    }
    // Carta tolta dalla selezione subito dopo averla scelta: la scelta non si registra.
    const removed = unselectedCode(prompt, response);
    if (removed && last?.t === "pick" && last.code === removed) {
      this.pending.pop();
      this.render();
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
      let kind = m.type === "endphase" ? "endphase" : EVENT_KIND[m.type];
      // Pendulum Summon: un solo passo, con le carte evocate come scelta.
      if (kind === "spsummon" && this.chosen === PEND && m.controller === this.me) kind = "pendulum";
      else if (!kind || m.controller !== this.me || !m.code || m.code !== this.chosen) continue;
      // Lo stesso array: le scelte fatte durante la risoluzione si aggiungono ancora a questo passo.
      const extra = this.chosenAct?.code === m.code ? { ...(this.chosenAct.desc && kind === "activate" ? { desc: this.chosenAct.desc } : {}), ...(this.chosenAct.way ? { way: this.chosenAct.way } : {}) } : {};
      this.steps.push({ kind, code: NO_CARD.has(kind) ? 0 : m.code, ...extra, details: this.pending });
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

const toBase64 = (bytes) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const fromBase64 = (t) => Uint8Array.from(atob(t), (ch) => ch.charCodeAt(0));

/** Dati da condividere di una combo (niente id locale). */
const comboData = (c) => ({
  v: 3, name: c.name, first: c.first, hand: c.hand, steps: c.steps.map(cleanStep), interrupts: c.interrupts, setup: c.setup, tags: c.tags,
  notes: c.notes || undefined, cards: c.cards, branch: c.branch || undefined,
  ...comboMeta(c),
});

/** Codice da condividere: prefisso + JSON in base64 (solo i dati della combo, niente id locale). */
export function comboToCode(c) {
  return SHARE_PREFIX + toBase64(new TextEncoder().encode(JSON.stringify(comboData(c))));
}

const DETAIL_TYPES = new Set(["cards", "pick", "zone", "pos", "yesno", "option"]);
const ZONE_KEYS = /^(m[0-6]|s[0-4]|f)$/;

/** Stato di partenza valido (vedi combos.js): solo codici interi e zone note. */
export function cleanSetup(s) {
  if (!s || typeof s !== "object") return undefined;
  const codes = (a) => (Array.isArray(a) ? a.filter((x) => Number.isInteger(x)).slice(0, 40) : []);
  const field = (a) => (Array.isArray(a) ? a.filter((x) => x && Number.isInteger(x.code) && ZONE_KEYS.test(x.zone)).map((x) => ({ code: x.code, zone: x.zone, pos: ["atk", "def", "set"].includes(x.pos) ? x.pos : "atk" })) : []);
  const side = (x = {}, opp) => ({ field: field(x.field), gy: codes(x.gy), banished: codes(x.banished), deckTop: codes(x.deckTop), ...(opp ? { hand: codes(x.hand), extra: codes(x.extra) } : {}) });
  return { me: side(s.me, false), opp: side(s.opp, true) };
}

/** Legge un codice condiviso; restituisce la combo (senza id) o lancia un errore leggibile. */
export function comboFromCode(text) {
  const t = String(text ?? "").trim();
  if (!t.startsWith(SHARE_PREFIX)) throw new Error("This is not a Helios combo code");
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(fromBase64(t.slice(SHARE_PREFIX.length))));
  } catch {
    throw new Error("The combo code is damaged or incomplete");
  }
  return comboFromData(data);
}

/** Combo (senza id) dai dati condivisi, o un errore leggibile se non sono validi. */
function comboFromData(data) {
  const nums = (a) => Array.isArray(a) && a.every((x) => Number.isInteger(x));
  const okDetails = (d) => d == null || (Array.isArray(d) && d.every((x) => x && DETAIL_TYPES.has(x.t)));
  const okSteps = Array.isArray(data.steps) && data.steps.every((s) => s && s.kind in STEP_ACTIONS && Number.isInteger(s.code) && okDetails(s.details));
  const okInts = Array.isArray(data.interrupts ?? []) && (data.interrupts ?? []).every((x) => x && Number.isInteger(x.after) && Number.isInteger(x.code));
  if (!nums(data.hand) || !okSteps || !okInts) throw new Error("The combo code is not valid");
  const tags = Array.isArray(data.tags) ? data.tags.filter((x) => x && Number.isInteger(x.code) && typeof x.text === "string").map((x) => ({ code: x.code, text: x.text.slice(0, 40) })) : [];
  return {
    name: String(data.name || "Imported combo").slice(0, 60), first: data.first !== false, hand: data.hand, steps: data.steps.map(cleanStep), interrupts: data.interrupts ?? [], setup: cleanSetup(data.setup), tags,
    notes: typeof data.notes === "string" ? data.notes.slice(0, NOTES_MAX) : "",
    cards: cleanCards(data.cards),
    branch: typeof data.branch === "string" ? data.branch.slice(0, 40) : "",
    ...comboMeta(data),
  };
}

// Informazioni della scheda (come ygopocket): difficoltà, formato, archetipi, OTK, board finale e carte in mano
// alla fine (salvati a "Combo complete"). Si puliscono sempre (codici condivisi da altri).
const META_DIFFICULTY = ["Beginner", "Intermediate", "Advanced", "Expert"];
const META_FORMAT = ["TCG", "OCG", "Master Duel", "Genesys", "Other"];
export function comboMeta(d) {
  const out = {};
  if (META_DIFFICULTY.includes(d?.difficulty)) out.difficulty = d.difficulty;
  if (META_FORMAT.includes(d?.format)) out.format = d.format;
  if (Array.isArray(d?.archetypes)) {
    const a = d.archetypes.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 30)).slice(0, 6);
    if (a.length) out.archetypes = a;
  }
  if (d?.otk === true) out.otk = true;
  if (Array.isArray(d?.endBoard) && d.endBoard.every((x) => Number.isInteger(x))) out.endBoard = d.endBoard.slice(0, 13);
  if (Number.isInteger(d?.endHand) && d.endHand >= 0 && d.endHand < 60) out.endHand = d.endHand;
  return out;
}

export const NOTES_MAX = 2000;

// Stato di partenza da riusare (Trainer → editor → Board state): salvato con un nome nel browser o
// condiviso come codice; le hand trap dell'avversario restano con il momento in cui vengono usate.
const BOARD_PREFIX = "HELIOS-BOARD:";
const BOARDS_KEY = "ygoweb.boards";

const cleanInts = (a) => (Array.isArray(a) ? a.filter((x) => x && Number.isInteger(x.after) && x.after >= 0 && Number.isInteger(x.code)).map((x) => ({ after: x.after, code: x.code })).slice(0, 40) : []);

/** Stati di partenza salvati: [{ id, name, setup, interrupts }]. */
export function loadBoards() {
  try {
    const list = JSON.parse(localStorage.getItem(BOARDS_KEY) || "[]");
    return Array.isArray(list) ? list.filter((b) => b && b.id && b.setup).map((b) => ({ id: String(b.id), name: String(b.name || "Board state").slice(0, 60), setup: cleanSetup(b.setup), interrupts: cleanInts(b.interrupts) })) : [];
  } catch {
    return [];
  }
}
export function saveBoards(list) {
  try {
    localStorage.setItem(BOARDS_KEY, JSON.stringify(list));
  } catch {
    /* storage non disponibile */
  }
}

export function boardToCode({ name, setup, interrupts }) {
  return BOARD_PREFIX + toBase64(new TextEncoder().encode(JSON.stringify({ v: 1, name, setup, interrupts })));
}

/** Legge un codice di stato di partenza: { name, setup, interrupts } o un errore leggibile. */
export function boardFromCode(text) {
  const t = String(text ?? "").trim();
  if (!t.startsWith(BOARD_PREFIX)) throw new Error("This is not a Helios board state code");
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(fromBase64(t.slice(BOARD_PREFIX.length))));
  } catch {
    throw new Error("The board state code is damaged or incomplete");
  }
  const setup = cleanSetup(data?.setup);
  if (!setup) throw new Error("The board state code is not valid");
  return { name: String(data.name || "Imported board state").slice(0, 60), setup, interrupts: cleanInts(data.interrupts) };
}

// Spreadsheet: nome, note, decklist d'esempio e tutte le sue combo (le varianti restano legate alla loro
// combo originale), JSON compresso (deflate) in base64: il codice resta corto anche con molte combo.
const SHEET_PREFIX = "HELIOS-SHEET:";

async function deflate(bytes, mode) {
  const stream = new Blob([bytes]).stream().pipeThrough(mode === "in" ? new CompressionStream("deflate-raw") : new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Codice da condividere di uno spreadsheet con le sue combo. */
export async function sheetToCode(sheet, combos) {
  const index = new Map(combos.map((c, i) => [c.id, i]));
  const data = {
    v: 1,
    name: sheet.name,
    notes: sheet.notes || undefined,
    sample: sheet.sample ?? undefined,
    combos: combos.map((c) => ({ ...comboData(c), parent: index.has(c.parent) ? index.get(c.parent) : undefined })),
  };
  return SHEET_PREFIX + toBase64(await deflate(new TextEncoder().encode(JSON.stringify(data)), "in"));
}

export const isSheetCode = (text) => String(text ?? "").trim().startsWith(SHEET_PREFIX);

/**
 * Legge il codice di uno spreadsheet: { name, notes, sample, combos } con le combo senza id
 * (parentIndex = indice della combo originale per le varianti), o lancia un errore leggibile.
 */
export async function sheetFromCode(text) {
  const t = String(text ?? "").trim();
  if (!t.startsWith(SHEET_PREFIX)) throw new Error("This is not a Helios spreadsheet code");
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(await deflate(fromBase64(t.slice(SHEET_PREFIX.length)), "out")));
  } catch {
    throw new Error("The spreadsheet code is damaged or incomplete");
  }
  if (!Array.isArray(data.combos)) throw new Error("The spreadsheet code is not valid");
  const combos = data.combos.map((x, i) => {
    const c = comboFromData(x);
    const p = x.parent;
    return { ...c, parentIndex: Number.isInteger(p) && p !== i && p >= 0 && p < data.combos.length ? p : null };
  });
  const sample = cleanCards(data.sample);
  return {
    name: String(data.name || "Imported spreadsheet").slice(0, 60),
    notes: typeof data.notes === "string" ? data.notes.slice(0, NOTES_MAX) : "",
    sample: sample && (sample.main.length || sample.extra.length) ? sample : null,
    combos,
  };
}

/** Decklist valida ({ main, extra, side } di codici interi) o undefined. */
export function cleanCards(x) {
  if (!x || typeof x !== "object") return undefined;
  const codes = (a) => (Array.isArray(a) ? a.filter((v) => Number.isInteger(v)).slice(0, 90) : []);
  return { main: codes(x.main), extra: codes(x.extra), side: codes(x.side) };
}

// ------------------------------------------------------------- carte necessarie

const tally = (codes) => codes.reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map());
const repeat = (m) => [...m].flatMap(([code, n]) => Array(n).fill(code));
const sideCodes = (x = {}) => [...(x.field ?? []).map((f) => f.code), ...(x.gy ?? []), ...(x.banished ?? []), ...(x.hand ?? []), ...(x.extra ?? []), ...(x.deckTop ?? [])];

/** Carte indicate da una scelta precisa. */
export function detailCodes(d) {
  switch (d.t) {
    case "cards": return d.codes;
    case "pick": case "yesno": return d.code ? [d.code] : [];
    case "option": return d.desc ? [Number(BigInt(d.desc) >> 20n)] : [];
  }
  return [];
}

/**
 * Carte che servono nel Main e nell'Extra Deck per fare la combo: mano e cima del Deck più le carte prese
 * dal Deck durante la combo (le scelte registrate sanno da dove viene ogni carta: ognuna è una copia in più),
 * le altre carte dei passi e delle scelte precise almeno una copia; nell'Extra Deck una per ogni Special Summon.
 * Non contano le carte dell'avversario e quelle già in gioco nello stato di partenza.
 * deck: se indicato, solo le carte che contiene (al più con le sue copie).
 */
export function detectCards(combo, deck = null) {
  const st = combo.setup ?? {};
  const theirs = new Set([...(combo.interrupts ?? []).map((x) => x.code), ...sideCodes(st.opp)]);
  const placed = new Set(sideCodes({ ...st.me, deckTop: [] }));
  const fromDeck = tally(combo.steps.flatMap((s) => (s.details ?? []).flatMap((d) => (d.t === "cards" ? d.deck ?? [] : d.t === "pick" && d.deck && d.code ? [d.code] : []))));
  const need = tally([...(combo.hand ?? []), ...(st.me?.deckTop ?? [])]);
  for (const [code, n] of fromDeck) if (!theirs.has(code)) need.set(code, (need.get(code) ?? 0) + n);
  // La stessa carta scelta più volte nella stessa selezione (es. due Refrain come materiali) sono copie diverse,
  // anche nelle registrazioni che non sanno da dove venivano le carte.
  const together = new Map();
  const keep = (codes) => {
    for (const [code, n] of tally(codes)) together.set(code, Math.max(n, together.get(code) ?? 0));
  };
  for (const s of combo.steps) {
    let run = []; // scelte "una carta alla volta" della stessa selezione
    for (const d of s.details ?? []) {
      if (d.t === "pick" && d.code) {
        run.push(d.code);
        continue;
      }
      keep(run);
      run = [];
      if (d.t === "cards") keep(d.codes);
    }
    keep(run);
  }
  for (const [code, n] of together) if (!theirs.has(code) && !placed.has(code)) need.set(code, Math.max(n, need.get(code) ?? 0));
  const summons = tally(combo.steps.filter((s) => s.kind === "spsummon" || s.kind === "summon").map((s) => s.code));
  const mention = (code) => {
    if (!code || !getCard(code) || need.has(code) || theirs.has(code) || placed.has(code)) return;
    need.set(code, isExtraDeckCard(getCard(code)) ? Math.max(1, summons.get(code) ?? 0) : 1);
  };
  for (const s of combo.steps) {
    if (!NO_CARD.has(s.kind)) mention(s.code);
    for (const d of s.details ?? []) detailCodes(d).forEach(mention);
  }
  for (const t of combo.tags ?? []) mention(t.code);
  if (deck) {
    const have = tally([...deck.main, ...deck.extra]);
    for (const [code, n] of need) {
      if (!have.has(code)) need.delete(code);
      else need.set(code, Math.min(n, have.get(code)));
    }
  }
  const all = repeat(need);
  return { main: sortDeckPart(all.filter((c) => !isExtraDeckCard(getCard(c)))), extra: sortDeckPart(all.filter((c) => isExtraDeckCard(getCard(c)))) };
}

const hasCards = (x) => !!(x?.main?.length || x?.extra?.length);

/**
 * Le interruzioni ({ after, code }) dicono quando l'avversario usa una carta della sua mano o del suo campo
 * (stato di partenza). Carte delle interruzioni che lì non ci sono (combo vecchie, in cui le hand trap
 * partivano in mano da sole): vanno nella mano dell'avversario.
 */
export function interruptsOutsideBoard(combo) {
  const opp = combo.setup?.opp ?? {};
  const have = tally([...(opp.hand ?? []), ...(opp.field ?? []).map((f) => f.code)]);
  const out = [];
  for (const it of combo.interrupts ?? []) {
    const n = have.get(it.code) ?? 0;
    if (n > 0) have.set(it.code, n - 1);
    else out.push(it.code);
  }
  return out;
}

/** Carte che la combo usa davvero, prese dalla sua decklist (se ne ha una). */
export const usedCards = (combo) => detectCards(combo, hasCards(combo.cards) ? combo.cards : null);

/**
 * Mazzo con cui si gioca la combo: la sua decklist (combo.cards, indipendente dai mazzi salvati) o, se è vuota,
 * le carte che usa; sempre con tutte le copie della mano e della cima del Deck.
 */
export function comboDeck(combo) {
  const cards = hasCards(combo.cards) ? combo.cards : detectCards(combo);
  const main = tally(cards.main);
  for (const [code, n] of tally([...combo.hand, ...(combo.setup?.me?.deckTop ?? [])])) main.set(code, Math.max(n, main.get(code) ?? 0));
  return { id: null, name: combo.name, main: repeat(main), extra: [...cards.extra], side: [] };
}

/**
 * Carte necessarie di uno spreadsheet: per ogni carta le copie che servono alla combo che ne usa di più
 * (le combo sono alternative tra loro), e in quante combo compare.
 * @returns {{ main: number[], extra: number[], uses: Map<number, number> }}
 */
export function sheetCards(combos) {
  const need = new Map();
  const uses = new Map();
  for (const c of combos) {
    const cards = usedCards(c);
    for (const [code, n] of tally([...cards.main, ...cards.extra])) {
      need.set(code, Math.max(n, need.get(code) ?? 0));
      uses.set(code, (uses.get(code) ?? 0) + 1);
    }
  }
  const all = repeat(need);
  return { main: sortDeckPart(all.filter((c) => !isExtraDeckCard(getCard(c)))), extra: sortDeckPart(all.filter((c) => isExtraDeckCard(getCard(c)))), uses };
}

// ------------------------------------------------------------- archivio delle combo e degli spreadsheet

const KEY = "ygoweb.combos";

/**
 * Archivio: { combos, sheets }. Le combo non dipendono dai mazzi salvati: ognuna ha la sua decklist (cards,
 * di solito copiata da un mazzo come punto di partenza); le varianti hanno parent = id della combo da cui
 * derivano. Uno spreadsheet raccoglie più combo (ids) con una decklist d'esempio (sample).
 * Formati vecchi: { [deckId]: [combo] } e combo legate a un mazzo (deckId): la decklist diventa una copia
 * di quel mazzo.
 */
export function loadComboStore() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || "{}") ?? {};
  } catch {
    raw = {};
  }
  const store = Array.isArray(raw.combos)
    ? { combos: raw.combos, sheets: Array.isArray(raw.sheets) ? raw.sheets : [] }
    : { combos: Object.entries(raw).flatMap(([deckId, list]) => (Array.isArray(list) ? list.map((c) => ({ ...c, deckId: c.deckId ?? deckId })) : [])), sheets: [] };
  if (store.combos.some((c) => "deckId" in c) || store.sheets.some((s) => "deckId" in s)) {
    const decks = loadDecks();
    for (const c of store.combos) {
      const d = c.deckId && decks.find((x) => x.id === c.deckId);
      if (d) c.cards = { main: [...d.main], extra: [...d.extra], side: [...(d.side ?? [])] };
      else if (!hasCards(c.cards)) c.cards = detectCards(c);
      delete c.deckId;
    }
    for (const s of store.sheets) delete s.deckId;
    saveComboStore(store);
  }
  return store;
}

export function saveComboStore(store) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 2, combos: store.combos, sheets: store.sheets }));
  } catch {
    /* storage non disponibile */
  }
}
