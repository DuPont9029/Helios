// Schermata del duello: campo, HUD, registro/chat e animazioni dei messaggi.
import { h, clear, sleep } from "../dom.js";
import { cardFace } from "../card.js";
import { openModal } from "../modal.js";
import { createDetailPanel } from "../detail.js";
import { Board, key } from "./board.js";
import { Prompter } from "./prompts.js";
import { describe } from "./describe.js";
import { cardName, descString, getCard, victoryString } from "../../data/db.js";
import { settings } from "../../data/settings.js";
import { HINT, LOC, MSG, PHASE, PHASE_NAMES, POS } from "../../core/constants.js";
import { formatClock } from "../../duel/clock.js";

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
      onHover: (code) => this.hover(code),
      onPile: (p, loc) => this.openPile(p, loc),
    });
    this.prompter = new Prompter(this);
    this.build();
    // Sul documento: le finestre delle richieste stanno fuori dal campo (in <body>).
    this.contextHandler = (e) => this.onContextMenu(e);
    document.addEventListener("contextmenu", this.contextHandler);
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
      const el = h(`div.lp.lp-${side}`, h("div.avatar", ""), h("div.lp-body", name, h("div.lp-track", fill), h("div.lp-row", num, clock)));
      return { el, fill, num, name, clock, avatar: el.firstChild };
    };
    this.lpEls = [lpBar("me"), lpBar("op")];
    this.lpEls[0].name.textContent = this.names[this.me];
    this.lpEls[1].name.textContent = this.names[1 - this.me];
    this.lpEls[0].avatar.textContent = (this.names[this.me] || "?")[0].toUpperCase();
    this.lpEls[1].avatar.textContent = (this.names[1 - this.me] || "?")[0].toUpperCase();

    this.phaseEl = h("div.phase-track", PHASES.map(([, label]) => h("div.phase-pip", label)));
    this.turnEl = h("div.turn-counter", "Turn 0");
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
    for (const [id, label] of [["log", "Log"], ["chat", "Chat"]]) {
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
    panes.chat.hidden = true;

    this.chainMode = h(
      "select.select.small",
      { title: "When to ask about activating in Chain", onchange: (e) => (settings.chainMode = e.target.value) },
      h("option", { value: "auto" }, "Chain: auto"),
      h("option", { value: "always" }, "Chain: always ask"),
      h("option", { value: "never" }, "Chain: never")
    );
    this.chainMode.value = settings.chainMode;

    this.overlay = h("div.fx-layer");
    this.el = h(
      "div.duel-screen",
      h("div.duel-side", this.detail.el, h("div.side-tabs", tabs, panes.log, panes.chat)),
      h(
        "div.duel-main",
        h("div.hud-top", this.lpEls[1].el, this.board.handEls[1]),
        h("div.field-wrap", this.board.el),
        h("div.hud-bottom", this.board.handEls[0], this.lpEls[0].el),
        this.overlay
      ),
      h(
        "div.duel-controls",
        this.turnEl,
        this.phaseEl,
        this.statusEl,
        this.actionBar,
        h("div.spacer"),
        this.chainMode,
        h("label.check", h("input", { type: "checkbox", checked: settings.autoPlace, onchange: (e) => (settings.autoPlace = e.target.checked) }), "Auto-place"),
        h("label.check", "Animations", h("input", { type: "range", min: 0, max: 2, step: 0.25, value: settings.animSpeed, oninput: (e) => (settings.animSpeed = +e.target.value) })),
        this.opts.onSurrender && h("button.btn.danger", { onclick: () => this.opts.onSurrender() }, "Surrender"),
        h("button.btn", { onclick: () => this.opts.onLeave?.() }, "Leave")
      )
    );
  }

  // ---------------------------------------------------------------- HUD

  /** Timer del giocatore p: null lo nasconde, altrimenti { left (ms), speed, running }. */
  setClock(p, state) {
    const ui = this.lpEls[this.board.side(p)].clock;
    ui.hidden = !state;
    if (!state) return;
    const [, time, speed] = ui.children;
    time.textContent = formatClock(state.left);
    speed.textContent = state.speed > 1 ? `×${state.speed}` : "";
    ui.classList.toggle("running", state.running);
    ui.classList.toggle("fast", state.speed > 1);
    ui.classList.toggle("low", state.left < 30000);
  }

  setLP(p, lp, animate = true) {
    const old = this.lp[p];
    this.lp[p] = lp;
    const ui = this.lpEls[this.board.side(p)];
    const pct = Math.max(0, Math.min(100, (lp / (this.startLP || 8000)) * 100));
    ui.fill.style.width = pct + "%";
    ui.fill.classList.toggle("low", pct < 25);
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
    for (const b of cfg.buttons ?? []) this.actionBar.append(h("button.btn.primary.phase-btn", { onclick: b.onClick }, b.label));
    if (cfg.all) this.actionBar.append(h("button.btn.ghost", { onclick: cfg.all }, "All actions"));
  }

  openActionMenu(anchor, items) {
    this.closeActionMenu();
    const r = anchor.getBoundingClientRect();
    const menu = h(
      "div.action-menu",
      items.map((it) => h(`button.action-item${it.glow === "attack" ? ".attack" : ""}`, { onclick: (e) => { e.stopPropagation(); this.closeActionMenu(); it.onClick(); } }, it.label))
    );
    document.body.append(menu);
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.left + r.width / 2 - mw / 2)) + "px";
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
   */
  onContextMenu(e) {
    const inDuel = this.el.contains(e.target) || e.target.closest?.(".modal-backdrop, .action-menu");
    if (!inDuel) return;
    e.preventDefault();
    if (document.querySelector(".action-menu")) return this.closeActionMenu();
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

  openPile(p, loc) {
    const snap = this.board.snapshot;
    if (!snap) return;
    const ps = snap.players[p];
    const list = loc === LOC.GRAVE ? ps.grave : loc === LOC.REMOVED ? ps.removed : ps.extra;
    const title = `${this.names[p]}'s ${loc === LOC.GRAVE ? "GY" : loc === LOC.REMOVED ? "Banished cards" : "Extra Deck"}`;
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
        const tile = h("div.pile-item", face, actions.length > 0 && h("div.pile-actions", actions.map((a) => h("button.btn.small.primary", { onclick: () => { m.close(); a.onClick(); } }, a.label))));
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

  log(entry) {
    if (!entry) return;
    const line = h(`div.log-line.${entry.cls || "plain"}`, entry.text);
    this.logEl.append(line);
    while (this.logEl.childElementCount > 400) this.logEl.firstChild.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
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
    return el?.getBoundingClientRect() ?? null;
  }

  async fly(from, to, code, faceDown, owner) {
    if (!this.speed || !from || !to) return;
    const ghost = cardFace(faceDown ? 0 : code, { faceDown });
    if (owner != null) ghost.dataset.owner = owner;
    ghost.classList.add("fly-ghost");
    const w = 64;
    const host = this.overlay.getBoundingClientRect();
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
      : this.lpEls[this.board.side(1 - attacker.controller)].el.getBoundingClientRect();
    if (!a || !t) return;
    const host = this.overlay.getBoundingClientRect();
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

  async confirmCards(cards, title = "Revealed cards") {
    if (!cards.length) return;
    const m = openModal({
      title,
      className: "prompt picker",
      body: [h("div.pick-grid", cards.map((c) => h("div.pick-card.static", cardFace(c.code), h("div.pick-where", cardName(c.code)))))],
      actions: [{ label: "OK", value: true, primary: true }],
    });
    cards.forEach((c) => this.hover(c.code));
    await Promise.race([m.result, this.wait(2200 + cards.length * 300)]);
    m.close(true);
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
      this.log(describe(m, this.names, (p, loc, pos) => this.canSeeMsg(p, loc, pos)));
      await this.animate(m);
    }
  }

  async animate(m) {
    switch (m.type) {
      case MSG.HINT:
        if (m.hint_type === HINT.SELECTMSG && m.player === this.me) this.selectHint = m.hint;
        if (m.hint_type === HINT.SELECTMSG && this.reveal) this.selectHint = m.hint;
        if (m.hint_type === HINT.MESSAGE && (m.player === this.me || this.reveal)) await this.banner(descString(m.hint), "hint");
        if (m.hint_type === HINT.OPSELECTED && m.player === this.me) await this.banner(descString(m.hint), "hint");
        return;
      case MSG.NEW_TURN:
        this.setTurn(this.turn = (this.turn ?? 0) + 1, m.player, 0);
        this.turnPlayer = m.player;
        return this.banner(m.player === this.me ? "YOUR TURN" : "OPPONENT'S TURN", "turn");
      case MSG.NEW_PHASE:
        this.setTurn(this.turn, this.turnPlayer, m.phase);
        return this.banner(PHASE_NAMES[m.phase] ?? "", "phase");
      case MSG.DRAW: {
        const from = this.rectOf(m.player, LOC.DECK, 0);
        const to = this.board.handEl(m.player).getBoundingClientRect();
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
        return this.splash(m.code, "Special Summon", "spsummon");
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
      case MSG.CONFIRM_DECKTOP:
      case MSG.CONFIRM_EXTRATOP:
        return this.confirmCards(m.cards);
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
    this.overlay.append(h(`div.result.${draw ? "draw" : won ? "win" : "lose"}`, h("div.result-title", title), sub && h("div.result-sub", sub)));
  }

  destroy() {
    document.removeEventListener("contextmenu", this.contextHandler);
    this.prompter.abort();
    this.closeActionMenu();
    this.el.remove();
  }
}

export { getCard };
