// Schermata del duello: campo, HUD, registro/chat e animazioni dei messaggi.
import { fullscreenButton } from "../fullscreen.js";
import { h, clear, sleep, rect, viewportSize } from "../dom.js";
import { cardFace } from "../card.js";
import { openModal } from "../modal.js";
import { createDetailPanel } from "../detail.js";
import { Board, key } from "./board.js";
import { Prompter } from "./prompts.js";
import { ChainContext } from "./chain-context.js";
import { seriesLabel } from "../../duel/series.js";
import { describe, cardList } from "./describe.js";
import { cardName, descString, getCard, victoryString } from "../../data/db.js";
import { settings } from "../../data/settings.js";
import { HINT, LOC, MSG, PHASE, PHASE_NAMES, POS } from "../../core/constants.js";
import { formatClock } from "../../duel/clock.js";
import { chooseField, fieldsBase } from "../../data/fields3d.js";

const PHASES = [
  [PHASE.DRAW, "DP"], [PHASE.STANDBY, "SP"], [PHASE.MAIN1, "M1"],
  [PHASE.BATTLE_START | PHASE.BATTLE_STEP | PHASE.DAMAGE | PHASE.DAMAGE_CAL | PHASE.BATTLE, "BP"],
  [PHASE.MAIN2, "M2"], [PHASE.END, "EP"],
];

export class DuelView {
  /**
   * @param opts { me, names, reveal, onSurrender, onChat (null = chat disattivata), onLeave }
   */
  constructor(opts) {
    this.opts = opts;
    this.me = opts.me;
    this.names = opts.names;
    this.reveal = !!opts.reveal;
    this.selectHint = null;
    this.lp = [0, 0];
    this.onPileActions = null;
    this.detail = createDetailPanel();
    this.board = new Board({
      me: this.me,
      reveal: this.reveal,
      separatePz: !!opts.separatePz,
      pendulums: opts.pendulums ?? null,
      onHover: (code) => this.hover(code),
      onPile: (p, loc) => this.openPile(p, loc),
      onCardMenu: (el, items) => this.openActionMenu(el, items),
    });
    this.prompter = new Prompter(this);
    // A cosa risponde la prossima richiesta di catena (catena in corso, summon, attacco, fase...).
    this.chainCtx = new ChainContext(
      (p) => this.names[p] ?? `Player ${p + 1}`,
      (p, loc, seq) => {
        const ps = this.board.snapshot?.players[p];
        const list = loc === LOC.MZONE ? ps?.mzone : loc === LOC.SZONE ? ps?.szone : null;
        return list?.[seq]?.code ?? 0;
      }
    );
    // Registro: anelli della catena (per dire cosa si risolve) e carte coinvolte nella risoluzione in corso.
    this.chainLinks = [];
    this.resolving = null;
    // Effetti persistenti ("lingering", come in Master Duel): descrizioni aggiunte dal core ai giocatori
    // (MSG_PLAYER_HINT) e alle carte (MSG_CARD_HINT), es. "Non puoi Evocare Specialmente mostri dall'Extra Deck".
    this.lingering = [];
    this.build();
    // Finestre aperte durante il duello (in <body>): si chiudono tutte uscendo dal duello.
    this.modals = new Set();
    this.modalObserver = new MutationObserver((list) => {
      for (const r of list) for (const n of r.addedNodes) if (n.classList?.contains("modal-backdrop")) this.modals.add(n);
    });
    this.modalObserver.observe(document.body, { childList: true });
    // Sul documento: le finestre delle richieste stanno fuori dal campo (in <body>).
    this.contextHandler = (e) => this.onContextMenu(e);
    document.addEventListener("contextmenu", this.contextHandler);
    this.heldChain = null;
    this.buttonsHandler = (e) => this.onPointerButtons(e);
    this.releaseHandler = () => this.onPointerButtons({ buttons: 0 });
    for (const ev of ["pointerdown", "pointerup", "pointermove"]) document.addEventListener(ev, this.buttonsHandler, true);
    window.addEventListener("blur", this.releaseHandler);
    this.mountField3d();
  }

  /** Campo 3D (Settings → 3D field) sotto la griglia delle zone; senza, resta il campo disegnato in CSS. */
  async mountField3d() {
    // Con un campo 3D scelto, la griglia è già quella del campo 3D (fondo scuro) mentre si carica:
    // il campo 2D non compare per un attimo prima di quello importato.
    const wanted = !!(fieldsBase() && settings.field3d);
    this.main.classList.toggle("field3d", wanted);
    this.main.classList.toggle("loading3d", wanted);
    let choice;
    try {
      choice = await chooseField();
    } catch (e) {
      console.warn("3D field list unavailable:", e);
    }
    if (!choice || this.destroyed) return this.main.classList.remove("field3d", "loading3d");
    try {
      // three.js si scarica solo quando serve.
      const { FieldStage } = await import("../../field3d/stage.js");
      if (this.destroyed) return;
      this.stage = new FieldStage(this.main, { fx: settings.field3dFx });
      const zones = this.board.zoneEls;
      this.stage.setAnchors({ center: this.board.centerEl, left: zones.get(key(this.me, LOC.MZONE, 5)), right: zones.get(key(this.me, LOC.MZONE, 6)) });
      await this.stage.load(choice.base, choice.id, choice.sides);
      if (this.destroyed) return;
      for (let p = 0; p < 2; p++) if (this.lp[p]) this.stage.syncLP(this.board.side(p), this.lp[p], this.startLP);
      this.main.classList.remove("loading3d");
      this.main.dataset.field = choice.name;
      // Clic sul pavimento (non su zone, carte o pulsanti): animazione della creatura del campo.
      this.main.addEventListener("click", (e) => {
        if (!e.target.closest(".zone, .card, button, .hand, .lp, .prompt-dock, .fx-layer > *")) this.stage?.tap(e.clientX, e.clientY);
      });
    } catch (e) {
      console.warn("3D field unavailable:", e);
      this.stage?.dispose();
      this.stage = null;
      this.main.classList.remove("field3d", "loading3d");
      this.log({ text: `3D field "${choice.name}" could not be loaded: using the standard field.`, cls: "warn" });
    }
  }

  /** Modo della catena in questo momento: quello tenuto premuto con il mouse, altrimenti quello scelto. */
  chainModeNow() {
    return this.heldChain ?? settings.chainMode;
  }

  /** A inizio duello e a ogni nuovo turno la catena torna su On (chiedi sempre). */
  resetChainMode() {
    settings.chainMode = "always";
    this.paintChainMode();
  }

  /** Un solo pulsante colorato: il modo attivo adesso (si sposta tenendo premuto il mouse). */
  paintChainMode() {
    const now = this.chainModeNow();
    for (const b of this.chainBtns ?? []) b.classList.toggle("on", b.dataset.mode === now);
  }

  /** Pulsanti del mouse tenuti premuti (e.buttons): destro = never, sinistro = always ask. */
  onPointerButtons(e) {
    const held = e.buttons & 2 ? "never" : e.buttons & 1 ? "always" : null;
    if (held === this.heldChain) return;
    this.heldChain = held;
    this.paintChainMode();
  }

  hover(code) {
    this.detail.show(code);
  }

  build() {
    const lpBar = (side) => {
      const fill = h("div.lp-fill");
      const num = h("div.lp-num", "8000");
      const name = h("div.lp-name", "");
      const clock = h("div.lp-clock", { hidden: true, title: "Thinking time" }, h("span.icon", { "aria-hidden": "true" }, "timer"), h("b", ""), h("i", ""));
      // Effetti persistenti su questo giocatore e sulle sue carte: compare solo se ce ne sono.
      const effects = h("button.lp-effects", { hidden: true, title: "Lingering effects", onclick: () => this.showLingering() }, h("span.icon", { "aria-hidden": "true" }, "auto_awesome"), h("b", ""));
      const el = h(`div.lp.lp-${side}`, h("div.avatar", ""), h("div.lp-body", name, h("div.lp-track", fill), h("div.lp-row", num, clock, effects)));
      return { el, fill, num, name, clock, effects, avatar: el.firstChild };
    };
    this.lpEls = [lpBar("me"), lpBar("op")];
    this.lpEls[0].name.textContent = this.names[this.me];
    this.lpEls[1].name.textContent = this.names[1 - this.me];
    this.lpEls[0].avatar.textContent = (this.names[this.me] || "?")[0].toUpperCase();
    this.lpEls[1].avatar.textContent = (this.names[1 - this.me] || "?")[0].toUpperCase();

    this.phaseEl = h("div.phase-track", PHASES.map(([, label]) => h("div.phase-pip", label)));
    this.turnEl = h("div.turn-counter", "Turn 0");
    this.matchEl = h("div.match-info", { hidden: true });
    this.actionBar = h("div.action-bar");
    this.statusEl = h("div.duel-status");
    this.logEl = h("div.log");
    this.chatLog = h("div.chat-log");
    const chatInput = h("input.input.chat-input", {
      placeholder: this.opts.onChat ? "Type a message…" : "Chat unavailable",
      disabled: !this.opts.onChat,
      maxLength: 300,
      onkeydown: (e) => {
        if (e.key === "Enter" && chatInput.value.trim()) {
          this.opts.onChat?.(chatInput.value.trim());
          this.addChat(this.names[this.me], chatInput.value.trim(), true);
          chatInput.value = "";
        }
      },
    });
    const tabs = h("div.tabs");
    const panes = { log: this.logEl, chat: h("div.chat", this.chatLog, chatInput) };
    const tabList = [["log", "Log"], ["chat", "Chat"]];
    // Combo Trainer: scheda "Combo" con i passi, aperta all'inizio.
    if (this.opts.trainerEl) {
      panes.combo = this.opts.trainerEl;
      tabList.unshift(["combo", "Combo"]);
    }
    for (const [id, label] of tabList) {
      tabs.append(
        h("button.tab", {
          dataset: { tab: id },
          onclick: () => {
            tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === id));
            Object.entries(panes).forEach(([k, p]) => (p.hidden = k !== id));
            if (id === "chat") this.chatTab.classList.remove("unread");
          },
        }, label)
      );
    }
    this.chatTab = tabs.lastChild;
    tabs.firstChild.classList.add("on");
    Object.entries(panes).forEach(([k, p]) => (p.hidden = k !== tabList[0][0]));

    // Catena: tre pulsanti esclusivi (auto / always ask / never). Tenendo premuto il mouse si cambia
    // modo al volo: sinistro = always ask, destro = never; rilasciando si torna a quello scelto.
    const CHAIN_MODES = [["auto", "Auto", "Ask only when a card or effect can be activated"], ["always", "On", "Always ask (also hold the left mouse button)"], ["never", "Off", "Never ask (also hold the right mouse button)"]];
    const chainBtn = ([mode, label, title]) =>
      h("button.chain-btn", { dataset: { mode }, title, onclick: () => { settings.chainMode = mode; this.paintChainMode(); } }, label);
    const mainBtns = CHAIN_MODES.map(chainBtn);
    const floatBtns = CHAIN_MODES.map(chainBtn);
    this.chainBtns = [...mainBtns, ...floatBtns];
    this.chainMode = h("div.chain-mode", h("span.chain-label", "Chain"), h("div.chain-btns", mainBtns));
    // Barra sopra le finestre che oscurano il campo: timer di entrambi e priorità della catena restano visibili.
    const floatClock = (side) => h(`div.float-clock.side-${side}`, { hidden: true }, h("span.float-name", ""), h("span.icon", { "aria-hidden": "true" }, "timer"), h("b", ""), h("i", ""));
    this.floatClocks = [floatClock("me"), floatClock("op")];
    this.floatClocks[0].firstChild.textContent = this.names[this.me];
    this.floatClocks[1].firstChild.textContent = this.names[1 - this.me];
    // Effetti persistenti (si apre l'elenco) e istruzione del Combo Trainer, visibili anche con una finestra aperta.
    this.floatEffects = h("button.lp-effects.float-effects", { hidden: true, title: "Lingering effects", onclick: () => this.showLingering() }, h("span.icon", { "aria-hidden": "true" }, "auto_awesome"), h("b", ""));
    this.floatTrainer = h("div.float-trainer", { hidden: true });
    this.floatBar = h(
      "div.duel-float",
      h("div.float-row", this.floatClocks[1], h("div.chain-mode.float", h("span.chain-label", "Chain"), h("div.chain-btns", floatBtns)), this.floatEffects, this.floatClocks[0]),
      this.floatTrainer
    );
    document.body.append(this.floatBar);
    if (this.opts.trainerEl) {
      const sync = () => {
        const st = this.opts.trainerEl.querySelector(".trainer-status");
        this.floatTrainer.hidden = !st?.textContent;
        this.floatTrainer.textContent = st?.textContent ?? "";
        this.floatTrainer.className = `float-trainer ${st?.className.replace("trainer-status", "") ?? ""}`;
      };
      this.trainerObserver = new MutationObserver(sync);
      this.trainerObserver.observe(this.opts.trainerEl, { subtree: true, childList: true, characterData: true });
      sync();
    }
    this.resetChainMode();

    this.overlay = h("div.fx-layer");
    // Richieste compatte (catena, "usare l'effetto?"): non coprono il campo, che resta cliccabile.
    this.promptDock = h("div.prompt-dock");
    this.el = h(
      "div.duel-screen",
      h("div.duel-side", this.detail.el, h("div.side-tabs", tabs, panes.combo ?? null, panes.log, panes.chat)),
      (this.main = h(
        "div.duel-main",
        h("div.hud-top", this.lpEls[1].el, this.board.handEls[1]),
        h("div.field-wrap", this.board.el),
        h("div.hud-bottom", this.board.handEls[0], this.lpEls[0].el),
        this.overlay,
        this.promptDock
      )),
      h(
        "div.duel-controls",
        this.turnEl,
        this.matchEl,
        this.phaseEl,
        this.statusEl,
        this.actionBar,
        h("div.spacer"),
        this.chainMode,
        h("label.check", h("input", { type: "checkbox", checked: settings.autoPlace, onchange: (e) => (settings.autoPlace = e.target.checked) }), "Auto-place"),
        h("label.check", "Animations", h("input", { type: "range", min: 0, max: 2, step: 0.25, value: settings.animSpeed, oninput: (e) => (settings.animSpeed = +e.target.value) })),
        fullscreenButton("btn", "Fullscreen"),
        this.opts.onSurrender && h("button.btn.danger", { onclick: () => this.opts.onSurrender() }, "Surrender"),
        h("button.btn", { onclick: () => this.opts.onLeave?.() }, "Leave")
      )
    );
  }

  // ---------------------------------------------------------------- HUD

  /** Timer del giocatore p: null lo nasconde, altrimenti { left (ms), speed, running }. */
  setClock(p, state) {
    const side = this.board.side(p);
    for (const ui of [this.lpEls[side].clock, this.floatClocks[side]]) {
      ui.hidden = !state;
      if (!state) continue;
      const [time, speed] = [...ui.children].slice(-2);
      time.textContent = formatClock(state.left);
      speed.textContent = state.speed > 1 ? `×${state.speed}` : "";
      ui.classList.toggle("running", state.running);
      ui.classList.toggle("fast", state.speed > 1);
      ui.classList.toggle("low", state.left < 30000);
    }
  }

  setLP(p, lp, animate = true) {
    const old = this.lp[p];
    this.lp[p] = lp;
    const ui = this.lpEls[this.board.side(p)];
    const pct = Math.max(0, Math.min(100, (lp / (this.startLP || 8000)) * 100));
    ui.fill.style.width = pct + "%";
    ui.fill.classList.toggle("low", pct < 25);
    // Campo 3D: il colpo sul lato di chi subisce danno, poi il campo si rompe a fasi con pochi LP.
    if (this.stage && old !== lp) {
      if (animate && lp < old) this.stage.damage(this.board.side(p), lp, this.startLP);
      else this.stage.syncLP(this.board.side(p), lp, this.startLP);
    }
    if (!animate || old === lp || !this.speed) {
      ui.num.textContent = lp;
      return;
    }
    const start = performance.now();
    const dur = 500 / this.speed;
    const tick = (t) => {
      const k = Math.min(1, (t - start) / dur);
      ui.num.textContent = Math.round(old + (lp - old) * k);
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const delta = lp - old;
    const pop = h(`div.lp-pop.${delta < 0 ? "dmg" : "heal"}`, (delta > 0 ? "+" : "") + delta);
    ui.el.append(pop);
    setTimeout(() => pop.remove(), 1200);
  }

  setTurn(turn, turnPlayer, phase) {
    this.turnEl.textContent = turn ? `Turn ${turn}` : "";
    this.turnEl.classList.toggle("mine", turnPlayer === this.me);
    [...this.phaseEl.children].forEach((pip, i) => pip.classList.toggle("on", !!(PHASES[i][0] & phase)));
    // Medaglione al centro del campo (turno + fase) e bagliore dal lato di chi è di turno.
    const short = { "Main Phase 1": "Main 1", "Main Phase 2": "Main 2", "Draw Phase": "Draw", "Standby Phase": "Standby", "Battle Phase": "Battle", "Damage Step": "Damage", "End Phase": "End" };
    const name = PHASE_NAMES[phase] ?? "";
    clear(this.board.centerEl).append(
      turn ? h(`div.medallion${turnPlayer === this.me ? ".mine" : ".theirs"}`, h("b", `Turn ${turn}`), h("span", short[name] ?? name)) : ""
    );
    this.main?.classList.toggle("turn-me", !!turn && turnPlayer === this.me);
    this.main?.classList.toggle("turn-op", !!turn && turnPlayer !== this.me);
  }

  /**
   * Sottotitolo sul campo (Combo Trainer): resta qualche secondo, il successivo lo sostituisce.
   * È parte della pagina, quindi compare anche nei video registrati.
   */
  caption(text, kind = "") {
    this.captionEl?.remove();
    clearTimeout(this.captionTimer);
    const el = h(`div.combo-caption${kind ? "." + kind : ""}`, text);
    this.captionEl = el;
    this.overlay.append(el);
    this.captionTimer = setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 400);
    }, 3600);
  }

  /** Partita al meglio di N: formato, numero del duello e punteggio (io–avversario). */
  setMatchInfo(series) {
    this.matchEl.hidden = !series;
    if (series) this.matchEl.textContent = seriesLabel(series);
  }

  setStatus(text) {
    this.statusEl.textContent = text || "";
    this.statusEl.classList.toggle("waiting", !!text);
  }

  /** Barra azioni: pulsanti di fase + "tutte le azioni" + testo guida. */
  setActionBar(cfg) {
    clear(this.actionBar);
    if (!cfg) return;
    if (cfg.text) this.actionBar.append(h("div.action-hint", cfg.text));
    for (const b of cfg.buttons ?? []) this.actionBar.append(h(`button.btn.phase-btn${b.ghost ? ".ghost" : ".primary"}`, { onclick: b.onClick, disabled: !!b.disabled }, b.label));
    if (cfg.all) this.actionBar.append(h("button.btn.ghost", { onclick: cfg.all }, "All actions"));
  }

  openActionMenu(anchor, items) {
    this.closeActionMenu();
    // Mostro Xyz con materiali: sotto le azioni c'è sempre "View materials".
    const mats = this.board.materialsAt(anchor.dataset?.key);
    if (mats.length) items = [...items, { label: `View materials (${mats.length})`, view: true, onClick: () => this.showMaterials(anchor.dataset.key, mats) }];
    if (!items.length) return;
    const r = rect(anchor);
    const menu = h(
      "div.action-menu",
      items.map((it) =>
        h(
          `button.action-item${it.glow === "attack" ? ".attack" : ""}${it.view ? ".view" : ""}`,
          { onclick: (e) => { e.stopPropagation(); this.closeActionMenu(); it.onClick(); } },
          it.label,
          // Più effetti sulla stessa carta: il testo dell'effetto sta sotto la voce, non in un tooltip
          // (che compariva tenendo premuto e sembrava ingrandire il menu).
          /\(\d+\)$/.test(it.label) && it.title ? h("small", it.title) : null
        )
      )
    );
    document.body.append(menu);
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(viewportSize().width - mw - 8, r.left + r.width / 2 - mw / 2)) + "px";
    menu.style.top = (r.top - mh - 8 > 8 ? r.top - mh - 8 : r.bottom + 8) + "px";
    this.menu = menu;
    const off = (e) => {
      if (!menu.contains(e.target)) this.closeActionMenu();
    };
    setTimeout(() => document.addEventListener("mousedown", off), 0);
    this.menuOff = off;
  }

  /**
   * Tasto destro durante il duello: chiude il menu azioni, altrimenti rifiuta la richiesta aperta
   * se si può (non attivare in catena, "No", annulla una selezione). Mai per scelte obbligatorie.
   * Se la finestra della scelta è ridotta, invece, la riapre.
   */
  onContextMenu(e) {
    const inDuel = this.el.contains(e.target) || e.target.closest?.(".modal-backdrop, .action-menu, .prompt-pop");
    if (!inDuel) return;
    e.preventDefault();
    if (document.querySelector(".action-menu")) return this.closeActionMenu();
    // Finestra di scelta ridotta: il tasto destro la riapre invece di rifiutare la richiesta.
    const minimized = [...document.querySelectorAll(".modal-backdrop.minimized:not(.closing)")].at(-1);
    if (minimized) return minimized.classList.remove("minimized");
    const decline = this.prompter.decline;
    if (!decline) return;
    this.prompter.decline = null;
    decline();
  }

  closeActionMenu() {
    this.menu?.remove();
    this.menu = null;
    if (this.menuOff) document.removeEventListener("mousedown", this.menuOff);
    this.menuOff = null;
  }

  /**
   * Mostra una richiesta compatta. Senza `anchor` va nell'angolo in basso a destra del campo;
   * con `anchor` (elemento di una carta) compare accanto alla carta, dal lato con più spazio.
   * Restituisce la funzione che la chiude.
   */
  showPrompt(content, anchor = null) {
    const box = h("div.prompt-pop", content);
    if (!anchor) {
      clear(this.promptDock).append(box);
    } else {
      box.classList.add("floating");
      document.body.append(box);
      const r = rect(anchor);
      const bw = box.offsetWidth;
      const bh = box.offsetHeight;
      const vp = viewportSize();
      const right = r.right + 12 + bw < vp.width - 8;
      const left = right ? r.right + 12 : Math.max(8, r.left - 12 - bw);
      const top = Math.max(8, Math.min(vp.height - bh - 8, r.top + r.height / 2 - bh / 2));
      Object.assign(box.style, { left: left + "px", top: top + "px" });
      box.classList.add(right ? "at-right" : "at-left");
    }
    return () => box.remove();
  }

  /** Finestra con i materiali Xyz di un mostro (informazione pubblica: si vedono anche quelli dell'avversario). */
  showMaterials(k, mats) {
    const [p, , seq] = k.split(":").map(Number);
    const owner = this.board.snapshot?.players[p]?.mzone?.[seq];
    const items = mats.map((code) => {
      const tile = h("div.pile-item", cardFace(code));
      tile.addEventListener("mouseenter", () => this.hover(code));
      return tile;
    });
    openModal({
      title: `Xyz Materials${owner?.code ? ` of ${getCard(owner.code)?.name ?? ""}` : ""} (${mats.length})`,
      className: "wide pile-modal",
      body: [h("div.pile-grid", items)],
      actions: [{ label: "Close", value: null }],
    });
  }

  openPile(p, loc) {
    const snap = this.board.snapshot;
    if (!snap) return;
    const ps = snap.players[p];
    const list = loc === LOC.GRAVE ? ps.grave : loc === LOC.REMOVED ? ps.removed : ps.extra;
    const title = `${this.names[p]}'s ${loc === LOC.GRAVE ? "GY" : loc === LOC.REMOVED ? "Banishment" : "Extra Deck"}`;
    const items = list
      .map((info, i) => ({ info, i }))
      .filter(({ info }) => info)
      .reverse()
      .map(({ info, i }) => {
        const visible = this.board.canSee(p, loc, info);
        const actions = this.onPileActions?.(key(p, loc, i)) ?? [];
        const face = cardFace(visible ? info.code : 0, { faceDown: !visible });
        face.dataset.owner = p;
        if (info.position & POS.FACEDOWN && loc === LOC.REMOVED) face.classList.add("facedown");
        const tile = h("div.pile-item", face, actions.length > 0 && h("div.pile-actions", actions.map((a) =>
                h(
                  "button.btn.small.primary",
                  { onclick: () => { m.close(); a.onClick(); } },
                  a.label,
                  // Più effetti sulla stessa carta: il testo sta sotto la voce, non in un tooltip.
                  /\(\d+\)$/.test(a.label) && a.title ? h("small", a.title) : null
                )
              )));
        if (actions.length) tile.classList.add("has-actions");
        if (actions.some((a) => a.glow === "activate")) tile.classList.add("can-activate");
        tile.addEventListener("mouseenter", () => visible && this.hover(info.code));
        return tile;
      });
    const m = openModal({
      title: `${title} (${list.length})`,
      className: "wide pile-modal",
      body: [items.length ? h("div.pile-grid", items) : h("p.muted", "Empty")],
      actions: [{ label: "Close", value: null }],
    });
  }

  // ---------------------------------------------------------------- registro e chat

  /** Ultima riga del registro (per tornare indietro dopo una summon annullata). */
  logMark() {
    return this.logEl.lastElementChild;
  }

  logRewind(mark) {
    if (mark && !mark.isConnected) return;
    while (this.logEl.lastElementChild && this.logEl.lastElementChild !== mark) this.logEl.lastElementChild.remove();
  }

  /** Parti di una riga del registro come nodi: i nomi delle carte sono cliccabili (mostrano la carta). */
  logParts(parts) {
    return parts.map((p) =>
      typeof p === "string"
        ? p
        : p.code
          ? h("span.log-card", { title: "Show card", onclick: () => this.hover(p.code) }, cardName(p.code))
          : "a card"
    );
  }

  log(entry) {
    if (!entry) return null;
    const line = h(`div.log-line.${entry.cls || "plain"}${entry.sub ? ".sub" : ""}`, this.logParts(entry.parts ?? [entry.text]));
    this.logEl.append(line);
    while (this.logEl.childElementCount > 400) this.logEl.firstChild.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
    return line;
  }

  addChat(name, text, mine = false) {
    this.chatLog.append(h(`div.chat-line${mine ? ".mine" : ""}`, h("b", name + ": "), text));
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
    if (!mine && this.chatLog.parentElement.hidden) this.chatTab.classList.add("unread");
  }

  // ---------------------------------------------------------------- animazioni

  get speed() {
    return settings.animSpeed;
  }

  wait(ms) {
    return this.speed ? sleep(ms / this.speed) : Promise.resolve();
  }

  banner(text, cls = "") {
    if (!this.speed) return Promise.resolve();
    const b = h(`div.banner.${cls || "plain"}`, h("span", text));
    this.overlay.append(b);
    setTimeout(() => b.remove(), 1400 / this.speed);
    return this.wait(cls === "turn" ? 900 : 450);
  }

  async splash(code, label, cls = "") {
    if (!this.speed || !code) return;
    const s = h(`div.splash.${cls || "plain"}`, h("div.splash-card", cardFace(code)), h("div.splash-label", label), h("div.splash-name", cardName(code)));
    this.overlay.append(s);
    this.hover(code);
    await this.wait(750);
    s.classList.add("out");
    setTimeout(() => s.remove(), 250);
  }

  rectOf(p, loc, seq) {
    const el = this.board.zoneEl(p, loc, seq);
    return el ? rect(el) : null;
  }

  async fly(from, to, code, faceDown, owner) {
    if (!this.speed || !from || !to) return;
    const ghost = cardFace(faceDown ? 0 : code, { faceDown });
    if (owner != null) ghost.dataset.owner = owner;
    ghost.classList.add("fly-ghost");
    const w = 64;
    const host = rect(this.overlay);
    Object.assign(ghost.style, { width: w + "px", left: from.left - host.left + from.width / 2 - w / 2 + "px", top: from.top - host.top + from.height / 2 - (w * 1.46) / 2 + "px" });
    this.overlay.append(ghost);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const anim = ghost.animate(
      [{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(1.05)`, opacity: 0.9 }],
      { duration: 320 / this.speed, easing: "cubic-bezier(.2,.8,.2,1)" }
    );
    await anim.finished.catch(() => {});
    ghost.remove();
  }

  async attackLine(attacker, target) {
    if (!this.speed) return;
    const a = this.rectOf(attacker.controller, attacker.location, attacker.sequence);
    const t = target
      ? this.rectOf(target.controller, target.location, target.sequence)
      : rect(this.lpEls[this.board.side(1 - attacker.controller)].el);
    if (!a || !t) return;
    const host = rect(this.overlay);
    const x1 = a.left + a.width / 2 - host.left;
    const y1 = a.top + a.height / 2 - host.top;
    const x2 = t.left + t.width / 2 - host.left;
    const y2 = t.top + t.height / 2 - host.top;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "attack-svg");
    const line = document.createElementNS(svgNS, "line");
    Object.entries({ x1, y1, x2, y2 }).forEach(([k, v]) => line.setAttribute(k, v));
    line.setAttribute("class", "attack-line");
    const head = document.createElementNS(svgNS, "circle");
    Object.entries({ cx: x2, cy: y2, r: 10 }).forEach(([k, v]) => head.setAttribute(k, v));
    head.setAttribute("class", "attack-head");
    svg.append(line, head);
    this.overlay.append(svg);
    await this.wait(700);
    svg.remove();
  }

  showChainBadge(m) {
    const z = this.board.zoneEl(m.controller, m.location, m.sequence);
    if (!z) return;
    const badge = h("div.chain-badge", m.chain_size);
    badge.dataset.chain = m.chain_size;
    (z.classList.contains("zone") ? z : z.parentElement)?.append(badge);
  }

  clearChainBadges() {
    this.el.querySelectorAll(".chain-badge").forEach((b) => b.remove());
  }

  /**
   * Dopo un ritorno indietro (Back): la catena torna quella dello stato ricostruito. Il core annuncia
   * l'attivazione prima dei costi, quindi senza questo il segnalino di un'attivazione annullata resterebbe.
   */
  syncChain(chain = []) {
    this.clearChainBadges();
    this.chainLinks = [];
    this.resolving = null;
    this.chainCtx.chain = [];
    chain.forEach((c, i) => {
      const link = { code: c.code, controller: c.controller, location: c.location, sequence: c.sequence, chain_size: i + 1 };
      this.chainLinks[i + 1] = { code: c.code, controller: c.controller };
      this.chainCtx.chain.push({ code: c.code, player: c.controller, link: i + 1 });
      this.showChainBadge(link);
    });
  }

  /** Carte rivelate: grandi al centro del campo per poco più di un secondo, come gli effetti in catena. */
  async confirmCards(cards, label = "Revealed") {
    const codes = cards.map((c) => c.code).filter(Boolean);
    if (!this.speed || !codes.length) return;
    const shown = codes.slice(0, 8);
    const row = h("div.reveal-row", shown.map((code) => h("div.splash-card", cardFace(code))));
    row.style.setProperty("--n", shown.length);
    const s = h(
      "div.splash.reveal",
      row,
      h("div.splash-label", label),
      h("div.splash-name", shown.length === 1 ? cardName(shown[0]) : `${codes.length} cards`)
    );
    this.overlay.append(s);
    this.hover(shown[0]);
    await this.wait(1300 + (shown.length - 1) * 150);
    s.classList.add("out");
    setTimeout(() => s.remove(), 250);
  }

  canSeeMsg(p, loc, pos) {
    if (this.reveal || p === this.me) return true;
    if (loc === LOC.HAND || loc === LOC.DECK) return false;
    return !(pos & POS.FACEDOWN);
  }

  /** Riproduce un blocco di messaggi del core con animazioni e registro. */
  async playMessages(messages) {
    for (const m of messages) {
      if (m.type === MSG.WIN) {
        if (this.winLogged) continue;
        this.winLogged = true;
      }
      this.logMessage(m);
      this.trackLingering(m);
      this.chainCtx.track(m);
      await this.animate(m);
    }
  }

  /** Codice della carta in una posizione (dall'ultimo stato disegnato): campo, Cimitero, bandite, mano, Extra. 0 se non si conosce. */
  codeAt(p, loc, seq) {
    const ps = this.board.snapshot?.players[p];
    const list = loc & LOC.MZONE ? ps?.mzone : loc & LOC.SZONE ? ps?.szone : loc & LOC.GRAVE ? ps?.grave : loc & LOC.REMOVED ? ps?.removed : loc & LOC.HAND ? ps?.hand : loc & LOC.EXTRA ? ps?.extra : null;
    return list?.[seq]?.code ?? 0;
  }

  /**
   * Registro: le righe durante la risoluzione di un anello della catena stanno sotto "Chain Link N resolves",
   * i bersagli sotto l'attivazione e, a fine anello, il riepilogo delle carte coinvolte.
   */
  logMessage(m) {
    const canSee = (p, loc, pos) => this.canSeeMsg(p, loc, pos);
    const ctx = {
      codeAt: (p, loc, seq) => this.codeAt(p, loc, seq),
      chainCode: (n) => this.chainLinks[n]?.code ?? 0,
      chainTargets: (n) => this.chainLinks[n]?.targets ?? [],
      pendulum: !!this.pendulumSummon,
      me: this.me,
    };
    // Bersagli scelti all'attivazione: vanno sulla riga "Chain N: ... activates X" (e alla risoluzione).
    if (m.type === MSG.BECOME_TARGET && !this.resolving && this.lastChain?.line.isConnected && m.cards.length) {
      const parts = cardList(m.cards, canSee, ctx);
      const link = this.chainLinks[this.lastChain.link];
      if (link) link.targets = [...(link.targets ?? []), ...parts.filter((p) => p !== ", ")];
      this.lastChain.line.append(this.lastChain.targeted ? ", " : " targeting ", ...this.logParts(parts));
      this.lastChain.targeted = true;
      this.logEl.scrollTop = this.logEl.scrollHeight;
      return;
    }
    const entry = describe(m, this.names, canSee, ctx);
    switch (m.type) {
      case MSG.CHAINING:
        this.chainLinks[m.chain_size] = { code: m.code, controller: m.controller };
        break;
      case MSG.CHAIN_SOLVING:
        this.resolving = { link: m.chain_size, code: this.chainLinks[m.chain_size]?.code ?? 0, affected: [] };
        break;
    }
    if (entry) {
      if (this.resolving && m.type !== MSG.CHAIN_SOLVING && !["turn", "phase"].includes(entry.cls)) entry.sub = true;
      else if (m.type === MSG.BECOME_TARGET || m.type === MSG.CARD_SELECTED) entry.sub = true;
      const line = this.log(entry);
      // Riga dell'ultima attivazione: ci si aggiungono i bersagli che il core comunica subito dopo.
      if (m.type === MSG.CHAINING) this.lastChain = { line, link: m.chain_size, targeted: false };
      else if (m.type !== MSG.BECOME_TARGET) this.lastChain = null;
    }
    // Carte coinvolte dalla risoluzione (spostate, cambiate di posizione, equipaggiate...).
    if (this.resolving) {
      const add = (code) => code && !this.resolving.affected.includes(code) && this.resolving.affected.push(code);
      if (m.type === MSG.MOVE && m.from.location !== m.to.location && (this.canSeeMsg(m.to.controller, m.to.location, m.to.position) || this.canSeeMsg(m.from.controller, m.from.location, m.from.position))) add(m.card);
      if (m.type === MSG.POS_CHANGE || m.type === MSG.SPSUMMONING || m.type === MSG.SUMMONING) add(m.code);
      if (m.type === MSG.BECOME_TARGET) m.cards.forEach((c) => add(this.codeAt(c.controller, c.location, c.sequence)));
    }
    if (m.type === MSG.CHAIN_SOLVED && this.resolving) {
      const r = this.resolving;
      this.resolving = null;
      if (r.affected.length) {
        const list = r.affected.flatMap((code, i) => (i ? [", ", { code }] : [{ code }]));
        this.log({ cls: "affected", sub: true, parts: [...(r.code ? ["Resolved ", { code: r.code }, ": "] : ["Resolved: "]), ...list] });
      }
    }
    if (m.type === MSG.CHAIN_END) this.chainLinks = [];
  }

  // ---------------------------------------------------------------- effetti persistenti

  trackLingering(m) {
    const ADD = 6;
    const REMOVE = 7;
    if (m.type === MSG.PLAYER_HINT) {
      const desc = String(m.description);
      if (m.player_hint === ADD) this.lingering.push({ player: m.player, desc });
      else if (m.player_hint === REMOVE) {
        const i = this.lingering.findIndex((x) => x.player === m.player && x.desc === desc && x.code == null);
        if (i >= 0) this.lingering.splice(i, 1);
      } else return;
    } else if (m.type === MSG.CARD_HINT) {
      // Solo le carte sul campo: sulle carte in mano il core mette suggerimenti temporanei
      // (es. "aggiunta alla mano dall'effetto in risoluzione"), non effetti persistenti.
      if (!(m.location & LOC.ONFIELD)) return;
      const desc = String(m.description);
      if (m.card_hint === ADD) {
        this.lingering.push({ player: m.controller, desc, code: this.codeAt(m.controller, m.location, m.sequence), location: m.location, sequence: m.sequence });
      } else if (m.card_hint === REMOVE) {
        const i = this.lingering.findIndex((x) => x.code != null && x.desc === desc && x.player === m.controller && x.location === m.location && x.sequence === m.sequence);
        if (i >= 0) this.lingering.splice(i, 1);
      } else return;
    } else if (m.type === MSG.MOVE && m.from.location & LOC.ONFIELD && m.from.location !== m.to.location) {
      // La carta lascia il campo: i suoi effetti persistenti mostrati sulla carta finiscono.
      const before = this.lingering.length;
      this.lingering = this.lingering.filter((x) => !(x.code != null && x.player === m.from.controller && x.location === m.from.location && x.sequence === m.from.sequence));
      if (this.lingering.length === before) return;
    } else return;
    this.paintLingering();
  }

  paintLingering() {
    for (let p = 0; p < 2; p++) {
      const ui = this.lpEls[this.board.side(p)].effects;
      const n = this.lingering.filter((x) => x.player === p).length;
      ui.hidden = !n;
      ui.lastChild.textContent = n || "";
    }
    this.floatEffects.hidden = !this.lingering.length;
    this.floatEffects.lastChild.textContent = this.lingering.length || "";
    if (this.lingeringModal) this.fillLingering(this.lingeringModal.body);
  }

  fillLingering(body) {
    const section = (p) => {
      const items = this.lingering.filter((x) => x.player === p);
      return h(
        "section.lingering-sec",
        h("h4", p === this.me ? "Your side" : `${this.names[p]}'s side`),
        items.length
          ? items.map((x) =>
              h(
                "div.lingering-row",
                x.code ? h("div.lingering-card", { onmouseenter: () => this.hover(x.code), onclick: () => this.hover(x.code) }, cardFace(x.code)) : h("div.lingering-icon", h("span.icon", "auto_awesome")),
                h("div", x.code ? h("b", cardName(x.code)) : null, h("div", descString(BigInt(x.desc)) || "Effect active"))
              )
            )
          : h("p.muted.small", "No lingering effects.")
      );
    };
    clear(body).append(h("p.muted.small", "Effects that keep applying for the rest of the turn or the Duel (like restrictions on Special Summons)."), section(this.me), section(1 - this.me));
  }

  showLingering() {
    this.lingeringModal?.close();
    const m = openModal({ title: "Lingering effects", className: "lingering", body: [], actions: [{ label: "Close", value: null, primary: true }] });
    this.fillLingering(m.body);
    this.lingeringModal = m;
    m.result.then(() => this.lingeringModal === m && (this.lingeringModal = null));
  }

  async animate(m) {
    switch (m.type) {
      case MSG.HINT:
        if (m.hint_type === HINT.SELECTMSG && m.player === this.me) this.selectHint = m.hint;
        if (m.hint_type === HINT.SELECTMSG && this.reveal) this.selectHint = m.hint;
        if (m.hint_type === HINT.MESSAGE && (m.player === this.me || this.reveal)) await this.banner(descString(m.hint), "hint");
        if (m.hint_type === HINT.OPSELECTED && m.player === this.me) await this.banner(descString(m.hint), "hint");
        // Nome di carta dichiarato: lo si mostra come una carta rivelata.
        if (m.hint_type === HINT.CODE) await this.confirmCards([{ code: Number(m.hint) }], "Declared");
        return;
      case MSG.NEW_TURN:
        this.resetChainMode();
        this.setTurn(this.turn = (this.turn ?? 0) + 1, m.player, 0);
        this.turnPlayer = m.player;
        return this.banner(m.player === this.me ? "YOUR TURN" : "OPPONENT'S TURN", "turn");
      case MSG.NEW_PHASE:
        this.setTurn(this.turn, this.turnPlayer, m.phase);
        return this.banner(PHASE_NAMES[m.phase] ?? "", "phase");
      case MSG.DRAW: {
        const from = this.rectOf(m.player, LOC.DECK, 0);
        const to = rect(this.board.handEl(m.player));
        for (const d of m.drawn) {
          await this.fly(from, to, d.code, !(this.reveal || m.player === this.me), m.player);
        }
        return;
      }
      case MSG.MOVE: {
        const { from, to } = m;
        if (from.location === 0 || to.location === 0) return;
        if (from.location & LOC.OVERLAY && to.location & LOC.OVERLAY) return;
        const visible = this.canSeeMsg(to.controller, to.location, to.position) || this.canSeeMsg(from.controller, from.location, from.position);
        await this.fly(this.rectOf(from.controller, from.location, from.sequence), this.rectOf(to.controller, to.location, to.sequence), m.card, !visible, from.controller);
        if (to.location === LOC.GRAVE && from.location & LOC.ONFIELD) this.board.flash(from.controller, from.location, from.sequence, "flash-destroy", 500);
        return;
      }
      case MSG.SUMMONING:
        return this.splash(m.code, "Normal Summon", "summon");
      case MSG.SPSUMMONING:
        return this.splash(m.code, this.pendulumSummon ? "Pendulum Summon" : "Special Summon", "spsummon");
      case MSG.SPSUMMONED:
        this.pendulumSummon = false; // fine della Pendulum Summon (vedi DuelSession)
        return;
      case MSG.FLIPSUMMONING:
        return this.splash(m.code, "Flip Summon", "summon");
      case MSG.CHAINING:
        this.showChainBadge(m);
        return this.splash(m.code, `Chain ${m.chain_size}`, "chain");
      case MSG.CHAIN_END:
        this.clearChainBadges();
        return;
      case MSG.CHAIN_SOLVING:
        this.el.querySelectorAll(`.chain-badge[data-chain="${m.chain_size}"]`).forEach((b) => b.classList.add("solving"));
        return this.wait(250);
      case MSG.CHAIN_SOLVED:
        this.el.querySelectorAll(`.chain-badge[data-chain="${m.chain_size}"]`).forEach((b) => b.remove());
        return;
      case MSG.CHAIN_NEGATED:
      case MSG.CHAIN_DISABLED:
        return this.banner("Negated!", "warn");
      case MSG.DAMAGE:
      case MSG.PAY_LPCOST:
        this.setLP(m.player, Math.max(0, this.lp[m.player] - m.amount));
        if (m.type === MSG.DAMAGE) this.el.classList.add("shake");
        setTimeout(() => this.el.classList.remove("shake"), 400);
        return this.wait(450);
      case MSG.RECOVER:
        this.setLP(m.player, this.lp[m.player] + m.amount);
        return this.wait(400);
      case MSG.LPUPDATE:
        this.setLP(m.player, m.lp);
        return;
      case MSG.ATTACK:
        return this.attackLine(m.card, m.target);
      case MSG.BECOME_TARGET:
        for (const c of m.cards) this.board.flash(c.controller, c.location, c.sequence, "flash-target", 1200);
        return this.wait(350);
      case MSG.CARD_SELECTED:
      case MSG.RANDOM_SELECTED:
        for (const c of m.cards) this.board.flash(c.controller, c.location, c.sequence, "flash-target", 900);
        return this.wait(250);
      case MSG.CONFIRM_CARDS:
        return this.confirmCards(m.cards);
      case MSG.CONFIRM_DECKTOP:
        return this.confirmCards(m.cards, "Top of the Deck");
      case MSG.CONFIRM_EXTRATOP:
        return this.confirmCards(m.cards, "Revealed from the Extra Deck");
      case MSG.TOSS_COIN:
        return this.banner(`Coin toss: ${m.results.map((r) => (r ? "Heads" : "Tails")).join(", ")}`, "hint");
      case MSG.TOSS_DICE:
        return this.banner(`Die roll: ${m.results.join(", ")}`, "hint");
      case MSG.SHUFFLE_HAND:
        this.board.handEl(m.player).classList.add("shuffle");
        setTimeout(() => this.board.handEl(m.player).classList.remove("shuffle"), 400);
        return this.wait(200);
      case MSG.SHUFFLE_DECK:
        this.board.flash(m.player, LOC.DECK, 0, "flash-shuffle", 500);
        return;
      case MSG.CARD_HINT:
        return;
      default:
        return;
    }
  }

  render(snapshot) {
    this.board.render(snapshot);
    this.turn = snapshot.turn;
    this.turnPlayer = snapshot.turnPlayer;
    this.setTurn(snapshot.turn, snapshot.turnPlayer, snapshot.phase);
    for (let p = 0; p < 2; p++) if (this.lp[p] !== snapshot.players[p].lp) this.setLP(p, snapshot.players[p].lp, false);
  }

  showResult({ winner, reason, text, sub: extra }) {
    const won = winner === this.me;
    const draw = winner === 2 || winner == null;
    const title = text ?? (draw ? "DRAW" : won ? "VICTORY" : "DEFEAT");
    const sub = extra || (reason != null ? victoryString(reason) : "");
    this.overlay.append(h(`div.result.${draw ? "draw" : won ? "win" : "lose"}`, h(`div.result-title${title.length > 11 ? ".long" : ""}`, title), sub && h("div.result-sub", sub)));
  }

  destroy() {
    this.destroyed = true;
    this.stage?.dispose();
    document.removeEventListener("contextmenu", this.contextHandler);
    for (const ev of ["pointerdown", "pointerup", "pointermove"]) document.removeEventListener(ev, this.buttonsHandler, true);
    window.removeEventListener("blur", this.releaseHandler);
    this.prompter.abort();
    this.closeActionMenu();
    this.lingeringModal?.close();
    this.trainerObserver?.disconnect();
    this.floatBar.remove();
    // Finestre del duello rimaste aperte (anche ridotte): non devono restare né ricomparire dopo l'uscita.
    this.modalObserver.disconnect();
    for (const b of this.modals) b.remove();
    this.el.remove();
  }
}

export { getCard };
