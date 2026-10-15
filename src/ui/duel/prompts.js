// Interfacce per rispondere alle richieste del core (MSG_SELECT_*, MSG_ANNOUNCE_*...).
// Ogni funzione restituisce una Promise con l'oggetto risposta per ocgcore-wasm.
import { h, clear } from "../dom.js";
import { cardFace } from "../card.js";
import { openModal } from "../modal.js";
import { key } from "./board.js";
import { locName } from "./describe.js";
import { db, cardName, descString, hintString, sysString, counterName } from "../../data/db.js";
import { settings } from "../../data/settings.js";
import { ATTRIBUTES, BATTLE, IDLE, LOC, MSG, POS, RACES, RESP } from "../../core/constants.js";
import { availableZones } from "../../core/zones.js";
import { isValidSum, findSum } from "../../core/sum.js";
import { isDeclarable } from "../../core/declarable.js";

/** Promemoria nelle finestre che si possono rifiutare con il tasto destro. */
const DECLINE_HINT = (what) => h("p.muted.small.decline-hint", `Right-click: ${what}`);

/**
 * Più effetti attivabili sulla stessa carta: "Activate (1)", "Activate (2)"...
 * Il testo completo dell'effetto resta nel suggerimento (title) della voce.
 */
function numberActivations(list) {
  const acts = list.filter((e) => e.glow === "activate");
  if (acts.length > 1) acts.forEach((e, n) => (e.label = `Activate (${n + 1})`));
  return list;
}

const IDLE_LABELS = {
  [IDLE.SUMMON]: "Normal Summon",
  [IDLE.SPSUMMON]: "Special Summon",
  [IDLE.REPOS]: "Change Position",
  [IDLE.MSET]: "Set",
  [IDLE.SSET]: "Set",
  [IDLE.ACTIVATE]: "Activate",
};

export class Prompter {
  /** @param view DuelView */
  constructor(view) {
    this.view = view;
    this.board = view.board;
    this.cancelCurrent = null;
    // Risposta "no / non attivare / annulla" della richiesta aperta, se rifiutarla è lecito (tasto destro).
    this.decline = null;
  }

  get me() {
    return this.view.me;
  }

  /**
   * Testo guida dell'ultima HINT_SELECTMSG ricevuta.
   * cardMsg: stringa di sistema da usare quando il suggerimento è il codice di una carta.
   */
  title(fallback, cardMsg = 0) {
    const hint = this.view.selectHint;
    this.view.selectHint = null;
    return hint ? hintString(hint, cardMsg) : fallback;
  }

  /** Argomenti per i segnaposto delle descrizioni: nome della carta e zona in cui si trova. */
  descArgs(c) {
    return [cardName(c.code), locName(c.location)];
  }

  /** Visibilità di una carta proposta in una scelta. */
  visible(c) {
    // Le proprie carte sono sempre visibili; di quelle avversarie nascondiamo
    // mano e carte coperte (il core, in lockstep, conosce comunque tutto).
    if (this.view.reveal || c.controller === this.me) return true;
    if (c.location === LOC.HAND) return false;
    if (c.location & LOC.ONFIELD) return !(c.position & POS.FACEDOWN);
    return true;
  }

  where(c) {
    const own = c.controller === this.me ? "yours" : "opponent's";
    let loc = locName(c.location);
    if (c.location & (LOC.MZONE | LOC.SZONE)) loc += ` ${c.sequence + 1}`;
    return `${loc} (${own})`;
  }

  abort() {
    this.cancelCurrent?.();
    this.cancelCurrent = null;
    this.board.clearClickable();
    this.board.cancelZonePick();
    this.view.setActionBar(null);
  }

  ask(msg) {
    this.decline = null;
    switch (msg.type) {
      case MSG.SELECT_IDLECMD: return this.idle(msg);
      case MSG.SELECT_BATTLECMD: return this.battle(msg);
      case MSG.SELECT_EFFECTYN: return this.effectYN(msg);
      case MSG.SELECT_YESNO: return this.yesNo(msg);
      case MSG.SELECT_OPTION: return this.option(msg);
      case MSG.SELECT_CARD: return this.selectCards(msg, RESP.SELECT_CARD, msg.selects);
      case MSG.SELECT_TRIBUTE: return this.selectCards(msg, RESP.SELECT_TRIBUTE, msg.selects);
      case MSG.SELECT_UNSELECT_CARD: return this.selectUnselect(msg);
      case MSG.SELECT_CHAIN: return this.chain(msg);
      case MSG.SELECT_PLACE:
      case MSG.SELECT_DISFIELD: return this.place(msg);
      case MSG.SELECT_POSITION: return this.position(msg);
      case MSG.SORT_CHAIN:
      case MSG.SORT_CARD: return this.sort(msg);
      case MSG.SELECT_COUNTER: return this.counter(msg);
      case MSG.SELECT_SUM: return this.sum(msg);
      case MSG.ANNOUNCE_RACE: return this.announceBits(msg, RACES, RESP.ANNOUNCE_RACE, "races", "Declare a Type", true);
      case MSG.ANNOUNCE_ATTRIB: return this.announceBits(msg, ATTRIBUTES, RESP.ANNOUNCE_ATTRIB, "attributes", "Declare an Attribute", false);
      case MSG.ANNOUNCE_CARD: return this.announceCard(msg);
      case MSG.ANNOUNCE_NUMBER: return this.announceNumber(msg);
      case MSG.ROCK_PAPER_SCISSORS: return this.rps();
    }
    return Promise.reject(new Error(`Unsupported request: ${msg.type}`));
  }

  // ---------------------------------------------------------------- comandi

  /** Raccoglie le azioni per carta e mostra il menu quando si clicca. */
  commandPrompt(entries, phaseButtons) {
    return new Promise((resolve) => {
      const byCard = new Map();
      for (const e of entries) {
        const k = key(e.card.controller, e.card.location, e.card.sequence);
        if (!byCard.has(k)) byCard.set(k, []);
        byCard.get(k).push(e);
      }
      const done = (resp) => {
        this.view.closeActionMenu();
        this.board.clearClickable();
        this.view.setActionBar(null);
        this.view.onPileActions = null;
        resolve(resp);
      };
      const handlers = new Map();
      const menuItems = (list) => list.map((e) => ({ label: e.label, title: e.desc, glow: e.glow, onClick: () => done(e.response) }));
      for (const [k, list] of byCard) {
        numberActivations(list);
        handlers.set(k, (ev, el) => this.view.openActionMenu(el, menuItems(list)));
      }
      // Ogni carta brilla secondo l'azione più importante che ha: effetto attivabile > attacco > altro.
      const glows = new Map();
      for (const [k, list] of byCard) {
        glows.set(k, list.some((e) => e.glow === "activate") ? "activate" : list.some((e) => e.glow === "attack") ? "attack" : "action");
      }
      this.board.setClickable(handlers, glows);
      // Azioni da pile (Cimitero, Esilio, Extra Deck...): disponibili dall'elenco della pila.
      this.view.onPileActions = (k) => menuItems(byCard.get(k) ?? []);
      this.view.setActionBar({
        buttons: phaseButtons.map((b) => ({ ...b, onClick: () => done(b.response) })),
        all: entries.length ? () => this.allActions(entries, done) : null,
      });
    });
  }

  allActions(entries, done) {
    const m = openModal({
      title: "Available actions",
      className: "wide",
      body: [
        h(
          "div.action-list",
          entries.map((e) =>
            h(
              "button.action-row",
              { onclick: () => { m.close(); done(e.response); }, onmouseenter: () => this.view.hover(e.card.code) },
              cardFace(e.card.code),
              h("div", h("b", cardName(e.card.code)), h("div.muted", `${e.label}${e.desc ? " — " + e.desc : ""}`), h("div.muted.small", this.where(e.card)))
            )
          )
        ),
      ],
      actions: [{ label: "Close", value: null }],
    });
  }

  idle(msg) {
    const entries = [];
    const add = (list, action, label) =>
      list.forEach((card, index) =>
        entries.push({
          card, label: label(card), glow: action === IDLE.ACTIVATE ? "activate" : "action",
          desc: action === IDLE.ACTIVATE && card.description != null ? descString(card.description, this.descArgs(card)) : "",
          response: { type: RESP.SELECT_IDLECMD, action, index },
        })
      );
    add(msg.summons, IDLE.SUMMON, () => IDLE_LABELS[IDLE.SUMMON]);
    add(msg.special_summons, IDLE.SPSUMMON, () => IDLE_LABELS[IDLE.SPSUMMON]);
    add(msg.pos_changes, IDLE.REPOS, () => IDLE_LABELS[IDLE.REPOS]);
    add(msg.monster_sets, IDLE.MSET, () => IDLE_LABELS[IDLE.MSET]);
    add(msg.spell_sets, IDLE.SSET, () => IDLE_LABELS[IDLE.SSET]);
    add(msg.activates, IDLE.ACTIVATE, () => IDLE_LABELS[IDLE.ACTIVATE]);
    const phase = [];
    if (msg.to_bp) phase.push({ label: "Battle Phase", response: { type: RESP.SELECT_IDLECMD, action: IDLE.TO_BP, index: 0 } });
    if (msg.to_ep) phase.push({ label: "End Phase", response: { type: RESP.SELECT_IDLECMD, action: IDLE.TO_EP, index: 0 } });
    return this.commandPrompt(entries, phase);
  }

  battle(msg) {
    const entries = [];
    msg.attacks.forEach((card, index) =>
      entries.push({
        card, glow: "attack", label: card.can_direct ? "Attack (direct possible)" : "Attack",
        response: { type: RESP.SELECT_BATTLECMD, action: BATTLE.ATTACK, index },
      })
    );
    msg.chains.forEach((card, index) =>
      entries.push({
        card, glow: "activate", label: "Activate", desc: descString(card.description, this.descArgs(card)),
        response: { type: RESP.SELECT_BATTLECMD, action: BATTLE.ACTIVATE, index },
      })
    );
    const phase = [];
    if (msg.to_m2) phase.push({ label: "Main Phase 2", response: { type: RESP.SELECT_BATTLECMD, action: BATTLE.TO_M2, index: 0 } });
    if (msg.to_ep) phase.push({ label: "End Phase", response: { type: RESP.SELECT_BATTLECMD, action: BATTLE.TO_EP, index: 0 } });
    return this.commandPrompt(entries, phase);
  }

  // ---------------------------------------------------------------- domande semplici

  /** "Usare l'effetto di X?": finestra grande (si può ridurre per guardare il campo), la carta lampeggia. */
  effectYN(msg) {
    const text = msg.description ? descString(msg.description, this.descArgs(msg)) : `Activate the effect of "${cardName(msg.code)}"?`;
    const anchor = this.board.cardEls.get(key(msg.controller, msg.location, msg.sequence)) ?? this.board.zoneEl(msg.controller, msg.location, msg.sequence);
    anchor?.classList.add("flash-target");
    const m = openModal({
      title: "Activate the effect?",
      dismissable: false,
      className: "prompt activate",
      body: [
        h(
          "div.activate-q",
          h("div.activate-card", { onmouseenter: () => this.view.hover(msg.code), onclick: () => this.view.hover(msg.code) }, cardFace(msg.code)),
          h("div.activate-text", h("b", cardName(msg.code)), h("span", text))
        ),
        DECLINE_HINT("No"),
      ],
      actions: [{ label: "No", value: false }, { label: "Yes", value: true, primary: true }],
    });
    this.view.hover(msg.code);
    this.cancelCurrent = () => m.close(false);
    this.decline = () => m.close(false);
    return m.result.then((yes) => {
      anchor?.classList.remove("flash-target");
      this.cancelCurrent = null;
      this.decline = null;
      return { type: RESP.SELECT_EFFECTYN, yes: !!yes };
    });
  }

  yesNo(msg) {
    return this.question(this.title("Confirm"), descString(msg.description)).then((yes) => ({ type: RESP.SELECT_YESNO, yes }));
  }

  question(title, text, code) {
    const m = openModal({
      title,
      dismissable: false,
      className: "prompt",
      body: [code ? h("div.prompt-card", cardFace(code)) : null, h("p", text), DECLINE_HINT("No")],
      actions: [{ label: "No", value: false }, { label: "Yes", value: true, primary: true }],
    });
    this.cancelCurrent = () => m.close(false);
    this.decline = () => m.close(false);
    return m.result;
  }

  option(msg) {
    const m = openModal({
      title: this.title("Choose an option"),
      dismissable: false,
      className: "prompt",
      body: [h("div.option-list", msg.options.map((o, index) => h("button.btn.option", { onclick: () => m.close(index) }, descString(o))))],
    });
    this.cancelCurrent = () => m.close(0);
    return m.result.then((index) => ({ type: RESP.SELECT_OPTION, index }));
  }

  /**
   * Catena: finestra grande con le carte attivabili (si può ridurre per guardare il campo).
   * Le carte attivabili brillano anche sul campo e si possono attivare cliccandole.
   */
  chain(msg) {
    const n = msg.selects.length;
    const auto = this.view.chainModeNow?.() ?? settings.chainMode;
    if (!msg.forced && (n === 0 || auto === "never")) return Promise.resolve({ type: RESP.SELECT_CHAIN, index: null });
    if (msg.forced && n === 1 && auto !== "always") return Promise.resolve({ type: RESP.SELECT_CHAIN, index: 0 });
    return new Promise((resolve) => {
      let finished = false;
      let m = null;
      const done = (index) => {
        if (finished) return;
        finished = true;
        this.view.closeActionMenu();
        m?.close(undefined);
        this.board.clearClickable();
        this.view.onPileActions = null;
        this.cancelCurrent = null;
        this.decline = null;
        resolve({ type: RESP.SELECT_CHAIN, index: index ?? null });
      };
      const desc = (c) => descString(c.description, this.descArgs(c));
      const byCard = new Map();
      msg.selects.forEach((c, i) => {
        const k = key(c.controller, c.location, c.sequence);
        if (!byCard.has(k)) byCard.set(k, []);
        byCard.get(k).push({ c, i });
      });
      const items = (group) => group.map(({ c, i }, j) => ({ label: group.length > 1 ? `Activate (${j + 1})` : "Activate", title: desc(c), glow: "activate", onClick: () => done(i) }));
      // Un solo effetto: il clic sulla carta lo attiva; più effetti: piccolo menu "Activate (1)/(2)".
      const handlers = new Map(
        [...byCard].map(([k, group]) => [k, (ev, el) => (group.length === 1 ? done(group[0].i) : this.view.openActionMenu(el, items(group)))])
      );
      this.board.setClickable(handlers, "activate");
      this.view.onPileActions = (k) => (byCard.has(k) ? items(byCard.get(k)) : []);
      // A cosa si sta rispondendo: catena in corso, summon, attacco, pescata, cambio di fase...
      const ctx = this.view.chainCtx?.describe(msg) ?? { title: "Activate a card or effect in Chain?", detail: "" };
      m = openModal({
        title: msg.forced ? "Choose the effect to activate" : ctx.title,
        dismissable: false,
        className: "prompt wide",
        body: [
          ctx.detail && h("p.chain-context", ctx.detail),
          h(
            "div.action-list",
            msg.selects.map((c, i) =>
              h(
                "button.action-row",
                { onclick: () => done(i), onmouseenter: () => this.view.hover(c.code) },
                cardFace(c.code),
                h("div", h("b", cardName(c.code)), h("div.muted", desc(c)), h("div.muted.small", this.where(c)))
              )
            )
          ),
          !msg.forced && DECLINE_HINT("don't activate"),
        ],
        actions: msg.forced ? [] : [{ label: "Don't activate", value: null, primary: true }],
      });
      m.result.then((v) => v === null && done(null));
      this.view.hover(msg.selects[0].code);
      this.cancelCurrent = () => done(msg.forced ? 0 : null);
      this.decline = msg.forced ? null : () => done(null);
    });
  }

  rps() {
    const m = openModal({
      title: "Rock-Paper-Scissors",
      dismissable: false,
      className: "prompt",
      body: [h("div.option-list.row", [["✊ Rock", 2], ["✋ Paper", 3], ["✌️ Scissors", 1]].map(([l, v]) => h("button.btn.option", { onclick: () => m.close(v) }, l)))],
    });
    return m.result.then((value) => ({ type: RESP.ROCK_PAPER_SCISSORS, value }));
  }

  // ---------------------------------------------------------------- selezione carte

  // ---------------------------------------------------------------- scelta delle carte sul campo
  // Durante una summon (Xyz, Link, Synchro, tributi...) i materiali si scelgono cliccandoli sul campo
  // invece che in una finestra, se sono tutti sul campo. Le scelte chieste dagli effetti restano in finestra.

  /** Chiavi delle carte sul campo da scegliere, oppure null (si usa la finestra). */
  fieldKeys(cards) {
    if (!this.summoning || !cards.length) return null;
    const keys = cards.map((c) => (c.location & LOC.ONFIELD && !(c.location & LOC.OVERLAY) ? key(c.controller, c.location, c.sequence) : null));
    return keys.every((k) => k && this.board.cardEls.has(k)) && new Set(keys).size === keys.length ? keys : null;
  }

  /**
   * Scelta sul campo. onPick(i) al clic sulla carta i; chosen(i) = carta già scelta; locked = chiavi
   * sempre scelte (non cliccabili); bar() = { text, buttons } della barra delle azioni.
   * Restituisce { repaint, done } (done pulisce campo e barra).
   */
  fieldPicker(keys, { onPick, chosen, locked = [], bar }) {
    const paint = () => {
      keys.forEach((k, i) => this.board.cardEls.get(k)?.classList.toggle("field-chosen", chosen(i)));
      locked.forEach((k) => this.board.cardEls.get(k)?.classList.add("field-chosen"));
      this.view.setActionBar(bar());
    };
    this.board.setClickable(new Map(keys.map((k, i) => [k, (e) => { e?.stopPropagation?.(); onPick(i); paint(); }])), "pick");
    paint();
    const done = () => {
      [...keys, ...locked].forEach((k) => this.board.cardEls.get(k)?.classList.remove("field-chosen"));
      this.board.clearClickable();
      this.view.setActionBar(null);
      this.cancelCurrent = null;
      this.decline = null;
    };
    return { repaint: paint, done };
  }

  cardTile(c, extraLabel) {
    const vis = this.visible(c);
    const face = cardFace(vis ? c.code : 0, { faceDown: !vis });
    if (c.controller != null) face.dataset.owner = c.controller;
    const tile = h("button.pick-card", face, h("div.pick-where", extraLabel ?? this.where(c)));
    tile.addEventListener("mouseenter", () => vis && this.view.hover(c.code));
    return tile;
  }

  /** SELECT_CARD / SELECT_TRIBUTE: scelta multipla min..max. */
  selectCards(msg, respType, cards) {
    const chosen = new Set();
    const min = msg.min;
    const max = msg.max;
    const tributeValue = (sel) => [...sel].reduce((a, i) => a + (cards[i].release_param || 1), 0);
    const valid = () =>
      respType === RESP.SELECT_TRIBUTE
        ? tributeValue(chosen) >= min && chosen.size <= max
        : chosen.size >= min && chosen.size <= max;
    const keys = this.fieldKeys(cards);
    if (keys) {
      const title = this.title("Select cards");
      return new Promise((resolve) => {
        const end = (out) => { picker.done(); resolve(out); };
        const confirm = () => valid() && end({ type: respType, indicies: [...chosen] });
        const picker = this.fieldPicker(keys, {
          chosen: (i) => chosen.has(i),
          onPick: (i) => {
            if (chosen.has(i)) chosen.delete(i);
            else if (chosen.size < max) chosen.add(i);
            else if (max === 1) { chosen.clear(); chosen.add(i); }
            if (max === 1 && min === 1 && valid()) confirm();
          },
          bar: () => ({
            text: `${title} (${chosen.size}${min === max ? `/${max}` : `, min ${min}, max ${max}`})`,
            buttons: [
              ...(this.back ? [{ label: "Back", ghost: true, onClick: () => end({ back: true }) }] : []),
              ...(msg.can_cancel ? [{ label: "Cancel", ghost: true, onClick: () => end({ type: respType, indicies: null }) }] : []),
              { label: "Confirm", disabled: !valid(), onClick: confirm },
            ],
          }),
        });
        this.cancelCurrent = () => end({ type: respType, indicies: msg.can_cancel ? null : Array.from({ length: Math.max(1, min) }, (_, i) => i) });
        this.decline = this.back ? () => end({ back: true }) : msg.can_cancel ? () => end({ type: respType, indicies: null }) : null;
      });
    }
    const counter = h("span.pick-counter");
    let confirmBtn;
    const update = () => {
      counter.textContent = min === max ? `${chosen.size}/${max}` : `${chosen.size} (min ${min}, max ${max})`;
      confirmBtn.disabled = !valid();
    };
    const tiles = cards.map((c, i) => {
      const t = this.cardTile(c);
      t.addEventListener("click", () => {
        if (chosen.has(i)) chosen.delete(i);
        else {
          if (chosen.size >= max) {
            if (max !== 1) return;
            chosen.clear();
            tiles.forEach((x) => x.classList.remove("chosen"));
          }
          chosen.add(i);
        }
        t.classList.toggle("chosen", chosen.has(i));
        update();
        // Scelta singola: conferma subito.
        if (max === 1 && min === 1 && valid()) m.close([...chosen]);
      });
      return t;
    });
    const m = openModal({
      title: this.title("Select cards"),
      dismissable: false,
      className: "prompt picker",
      body: [h("div.pick-info", counter), h("div.pick-grid", tiles)],
      actions: [
        ...(msg.can_cancel ? [{ label: "Cancel", value: null }] : []),
        { label: "Confirm", primary: true, onClick: (close) => valid() && close([...chosen]) },
      ],
    });
    confirmBtn = m.buttons[m.buttons.length - 1];
    update();
    this.cancelCurrent = () => m.close(msg.can_cancel ? null : Array.from({ length: Math.max(1, min) }, (_, i) => i));
    this.decline = msg.can_cancel ? () => m.close(null) : null;
    return m.result.then((indicies) => ({ type: respType, indicies }));
  }

  /** SELECT_UNSELECT_CARD: una carta alla volta, il core richiede finché non si termina. */
  selectUnselect(msg) {
    const all = [...msg.select_cards.map((c, i) => ({ c, i, sel: false })), ...msg.unselect_cards.map((c, i) => ({ c, i: msg.select_cards.length + i, sel: true }))];
    const keys = this.fieldKeys(all.map((x) => x.c));
    if (keys) {
      const title = this.title("Select cards");
      const out = (index) => ({ type: RESP.SELECT_UNSELECT_CARD, index });
      return new Promise((resolve) => {
        const end = (r) => { picker.done(); resolve(r); };
        const picker = this.fieldPicker(keys, {
          chosen: (i) => all[i].sel,
          onPick: (i) => end(out(all[i].i)),
          bar: () => ({
            text: `${title} (selected ${msg.unselect_cards.length}${msg.max ? `, min ${msg.min}, max ${msg.max}` : ""})`,
            buttons: [
              ...(this.back ? [{ label: "Back", ghost: true, onClick: () => end({ back: true }) }] : []),
              ...(msg.can_cancel && !msg.can_finish ? [{ label: "Cancel", ghost: true, onClick: () => end(out(null)) }] : []),
              ...(msg.can_finish ? [{ label: "Finish", onClick: () => end(out(null)) }] : []),
            ],
          }),
        });
        this.cancelCurrent = () => end(out(msg.can_finish || msg.can_cancel ? null : 0));
        this.decline = this.back ? () => end({ back: true }) : msg.can_finish || msg.can_cancel ? () => end(out(null)) : null;
      });
    }
    const m = openModal({
      title: this.title("Select cards"),
      dismissable: false,
      className: "prompt picker",
      body: [
        h("div.pick-info", `Selected: ${msg.unselect_cards.length}` + (msg.max ? ` (min ${msg.min}, max ${msg.max})` : "")),
        h(
          "div.pick-grid",
          all.map(({ c, i, sel }) => {
            const t = this.cardTile(c);
            if (sel) t.classList.add("chosen");
            t.addEventListener("click", () => m.close(i));
            return t;
          })
        ),
      ],
      actions: [
        ...(msg.can_cancel && !msg.can_finish ? [{ label: "Cancel", value: null }] : []),
        ...(msg.can_finish ? [{ label: "Finish", value: null, primary: true }] : []),
      ],
    });
    this.cancelCurrent = () => m.close(msg.can_finish || msg.can_cancel ? null : 0);
    this.decline = msg.can_finish || msg.can_cancel ? () => m.close(null) : null;
    return m.result.then((index) => ({ type: RESP.SELECT_UNSELECT_CARD, index: index ?? null }));
  }

  sum(msg) {
    const chosen = new Set();
    const keys = this.fieldKeys(msg.selects);
    const mustKeys = msg.selects_must.length ? this.fieldKeys(msg.selects_must) : [];
    if (keys && mustKeys) {
      const title = this.title("Select cards (sum)");
      return new Promise((resolve) => {
        const end = (r) => { picker.done(); resolve(r); };
        const confirm = () => isValidSum(msg, [...chosen]) && end({ type: RESP.SELECT_SUM, indicies: [...chosen] });
        const picker = this.fieldPicker(keys, {
          locked: mustKeys,
          chosen: (i) => chosen.has(i),
          onPick: (i) => (chosen.has(i) ? chosen.delete(i) : chosen.add(i)),
          bar: () => ({
            text: `${title}: required value ${msg.amount}${msg.select_max === 0 ? ` (cards ${msg.min}-${msg.max})` : " (at least)"}`,
            buttons: [
              ...(this.back ? [{ label: "Back", ghost: true, onClick: () => end({ back: true }) }] : []),
              { label: "Auto", ghost: true, onClick: () => { const f = findSum(msg); if (f) { chosen.clear(); f.forEach((i) => chosen.add(i)); picker.repaint(); } } },
              { label: "Confirm", disabled: !isValidSum(msg, [...chosen]), onClick: confirm },
            ],
          }),
        });
        this.cancelCurrent = () => end({ type: RESP.SELECT_SUM, indicies: findSum(msg) ?? [] });
        this.decline = this.back ? () => end({ back: true }) : null;
      });
    }
    let confirmBtn;
    const info = h("span.pick-counter");
    const update = () => {
      const sel = [...chosen];
      info.textContent = `Required value: ${msg.amount}` + (msg.select_max === 0 ? ` (cards ${msg.min}-${msg.max})` : " (at least)");
      confirmBtn.disabled = !isValidSum(msg, sel);
    };
    const must = msg.selects_must.map((c) => {
      const t = this.cardTile(c, `${this.where(c)} · ${c.amount & 0xffff}`);
      t.classList.add("chosen", "locked");
      return t;
    });
    const tiles = msg.selects.map((c, i) => {
      const v1 = c.amount & 0xffff;
      const v2 = c.amount >>> 16;
      const t = this.cardTile(c, `${this.where(c)} · ${v2 ? `${v1}/${v2}` : v1}`);
      t.addEventListener("click", () => {
        if (chosen.has(i)) chosen.delete(i);
        else chosen.add(i);
        t.classList.toggle("chosen", chosen.has(i));
        update();
      });
      return t;
    });
    const m = openModal({
      title: this.title("Select cards (sum)"),
      dismissable: false,
      className: "prompt picker",
      body: [h("div.pick-info", info), h("div.pick-grid", must, tiles)],
      actions: [
        {
          label: "Auto",
          onClick: () => {
            const s = findSum(msg);
            if (!s) return;
            chosen.clear();
            s.forEach((i) => chosen.add(i));
            tiles.forEach((t, i) => t.classList.toggle("chosen", chosen.has(i)));
            update();
          },
        },
        { label: "Confirm", primary: true, onClick: (close) => isValidSum(msg, [...chosen]) && close([...chosen]) },
      ],
    });
    confirmBtn = m.buttons[1];
    update();
    this.cancelCurrent = () => m.close(findSum(msg) ?? []);
    return m.result.then((indicies) => ({ type: RESP.SELECT_SUM, indicies }));
  }

  sort(msg) {
    const order = [];
    const badges = [];
    let confirmBtn;
    const tiles = msg.cards.map((c, i) => {
      const badge = h("div.sort-badge");
      badges.push(badge);
      const t = this.cardTile({ ...c, position: POS.FACEUP_ATTACK });
      t.append(badge);
      t.addEventListener("click", () => {
        const at = order.indexOf(i);
        if (at >= 0) order.splice(at, 1);
        else order.push(i);
        badges.forEach((b, j) => (b.textContent = order.includes(j) ? order.indexOf(j) + 1 : ""));
        confirmBtn.disabled = order.length !== msg.cards.length;
      });
      return t;
    });
    const m = openModal({
      title: msg.type === MSG.SORT_CHAIN ? "Order the effects in the Chain" : "Order the cards",
      dismissable: false,
      className: "prompt picker",
      body: [h("div.pick-info", "Click the cards in the desired order (1 = first/top)"), h("div.pick-grid", tiles)],
      actions: [
        { label: "Default order", value: null },
        { label: "Confirm", primary: true, onClick: (close) => order.length === msg.cards.length && close(order.slice()) },
      ],
    });
    confirmBtn = m.buttons[1];
    confirmBtn.disabled = true;
    this.cancelCurrent = () => m.close(null);
    // Il core vuole, per ogni carta, la sua posizione nell'ordine finale.
    return m.result.then((ord) => {
      if (!ord) return { type: RESP.SORT_CARD, order: null };
      const pos = new Array(ord.length);
      ord.forEach((cardIdx, rank) => (pos[cardIdx] = rank));
      return { type: RESP.SORT_CARD, order: pos };
    });
  }

  counter(msg) {
    const values = msg.cards.map(() => 0);
    const info = h("span.pick-counter");
    let confirmBtn;
    const total = () => values.reduce((a, b) => a + b, 0);
    const update = () => {
      info.textContent = `Remove ${msg.count} ${counterName(msg.counter_type)} — chosen: ${total()}`;
      confirmBtn.disabled = total() !== msg.count;
    };
    const rows = msg.cards.map((c, i) => {
      const val = h("span.counter-val", "0");
      const set = (d) => {
        values[i] = Math.max(0, Math.min(c.count, values[i] + d));
        val.textContent = values[i];
        update();
      };
      return h("div.counter-row", cardFace(c.code), h("div", h("b", cardName(c.code)), h("div.muted", `${c.count} available`)), h("button.btn.small", { onclick: () => set(-1) }, "−"), val, h("button.btn.small", { onclick: () => set(1) }, "+"));
    });
    const m = openModal({
      title: "Remove Counters",
      dismissable: false,
      className: "prompt",
      body: [h("div.pick-info", info), ...rows],
      actions: [{ label: "Confirm", primary: true, onClick: (close) => total() === msg.count && close(values.slice()) }],
    });
    confirmBtn = m.buttons[0];
    update();
    return m.result.then((counters) => ({ type: RESP.SELECT_COUNTER, counters }));
  }

  // ---------------------------------------------------------------- campo

  async place(msg) {
    const zones = availableZones(msg);
    const isPlace = msg.type === MSG.SELECT_PLACE;
    const respType = isPlace ? RESP.SELECT_PLACE : RESP.SELECT_DISFIELD;
    const count = Math.max(1, msg.count);
    if (settings.autoPlace && isPlace && zones.length) {
      const mine = zones.filter((z) => z.player === msg.player);
      return { type: respType, places: (mine.length ? mine : zones).slice(0, count) };
    }
    const places = [];
    // Summon in sospeso: "Back" (o tasto destro) annulla la summon e torna alla scelta dell'azione.
    let goBack = null;
    const back = this.back ? new Promise((r) => (goBack = () => r("back"))) : null;
    if (goBack) this.decline = () => goBack();
    this.view.setActionBar({
      text: this.title(isPlace ? "Select a zone" : "Select a zone to make unusable", 569),
      buttons: goBack ? [{ label: "Back", onClick: () => goBack() }] : [],
    });
    let cancelled = false;
    this.cancelCurrent = () => {
      cancelled = true;
      this.board.cancelZonePick();
    };
    for (let i = 0; i < count; i++) {
      const left = zones.filter((z) => !places.some((p) => p.player === z.player && p.location === z.location && p.sequence === z.sequence));
      const pick = await Promise.race([this.board.pickZone(left), new Promise((r) => (this.cancelCurrent = () => r(null))), ...(back ? [back] : [])]);
      if (pick === "back") {
        this.board.cancelZonePick();
        this.view.setActionBar(null);
        this.decline = null;
        return { back: true };
      }
      if (pick == null || cancelled) {
        this.board.cancelZonePick();
        this.view.setActionBar(null);
        return { type: respType, places: zones.slice(0, count) };
      }
      const [player, location, sequence] = pick.split(":").map(Number);
      places.push({ player, location, sequence });
    }
    this.view.setActionBar(null);
    this.decline = null;
    return { type: respType, places };
  }

  position(msg) {
    const opts = [
      [POS.FACEUP_ATTACK, "Face-up Attack Position"],
      [POS.FACEDOWN_ATTACK, "Face-down Attack Position"],
      [POS.FACEUP_DEFENSE, "Face-up Defense Position"],
      [POS.FACEDOWN_DEFENSE, "Face-down Defense Position"],
    ].filter(([p]) => msg.positions & p);
    const m = openModal({
      title: `Position of "${cardName(msg.code)}"`,
      dismissable: false,
      className: "prompt",
      body: [
        h(
          "div.position-list",
          opts.map(([p, label]) => {
            const face = cardFace(p & POS.FACEDOWN ? 0 : msg.code, { faceDown: !!(p & POS.FACEDOWN) });
            face.dataset.owner = msg.player;
            if (p & POS.DEFENSE) face.classList.add("defense");
            return h("button.position-opt", { onclick: () => m.close(p) }, h("div.position-card", face), h("span", label));
          })
        ),
        this.back && DECLINE_HINT("back"),
      ],
      // Summon in sospeso: si può ancora tornare indietro.
      actions: this.back ? [{ label: "Back", value: "back" }] : [],
    });
    this.cancelCurrent = () => m.close(opts[0][0]);
    if (this.back) this.decline = () => m.close("back");
    return m.result.then((position) => (position === "back" ? { back: true } : { type: RESP.SELECT_POSITION, position }));
  }

  // ---------------------------------------------------------------- dichiarazioni

  announceBits(msg, table, respType, field, title, big) {
    const avail = BigInt(msg.available);
    const chosen = new Set();
    let confirmBtn;
    const btns = table
      .filter(([bit]) => avail & BigInt(bit))
      .map(([bit, label]) => {
        const b = h("button.btn.toggle", label);
        b.addEventListener("click", () => {
          if (chosen.has(bit)) chosen.delete(bit);
          else if (chosen.size < msg.count) chosen.add(bit);
          b.classList.toggle("on", chosen.has(bit));
          confirmBtn.disabled = chosen.size !== msg.count;
        });
        return b;
      });
    const m = openModal({
      title: `${this.title(title)} (${msg.count})`,
      dismissable: false,
      className: "prompt",
      body: [h("div.toggle-grid", btns)],
      actions: [{ label: "Confirm", primary: true, onClick: (close) => chosen.size === msg.count && close([...chosen]) }],
    });
    confirmBtn = m.buttons[0];
    confirmBtn.disabled = true;
    return m.result.then((bits) => ({ type: respType, [field]: bits.map((b) => (big ? BigInt(b) : b)) }));
  }

  announceCard(msg) {
    const candidates = db.list.filter((c) => c.source !== 1 && isDeclarable(c, msg.opcodes));
    const input = h("input.input", { placeholder: "Search card name…", autofocus: true });
    const list = h("div.announce-list");
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const found = (q ? candidates.filter((c) => c.name.toLowerCase().includes(q)) : candidates).slice(0, 60);
      clear(list).append(
        ...found.map((c) => h("button.announce-row", { onclick: () => m.close(c.code), onmouseenter: () => this.view.hover(c.code) }, cardFace(c.code), h("span", c.name)))
      );
    };
    input.addEventListener("input", render);
    const m = openModal({
      title: this.title("Declare a card name"),
      dismissable: false,
      className: "prompt wide",
      body: [input, list],
    });
    render();
    setTimeout(() => input.focus(), 50);
    return m.result.then((card) => ({ type: RESP.ANNOUNCE_CARD, card }));
  }

  announceNumber(msg) {
    const m = openModal({
      title: this.title("Declare a number"),
      dismissable: false,
      className: "prompt",
      body: [h("div.toggle-grid", msg.options.map((o, i) => h("button.btn", { onclick: () => m.close(i) }, String(o))))],
    });
    return m.result.then((value) => ({ type: RESP.ANNOUNCE_NUMBER, value }));
  }
}

export { sysString };
