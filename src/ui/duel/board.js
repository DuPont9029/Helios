// Campo di gioco: disegna lo snapshot del core dal punto di vista di `me`.
// Il giocatore locale sta in basso, l'avversario in alto (zone specchiate).
import { h, clear } from "../dom.js";
import { cardFace } from "../card.js";
import { getCard, counterName } from "../../data/db.js";
import { pendulumIcons, validPendulumIcons, mirrorFor } from "../../data/pendulum.js";
import { LOC, POS, STATUS_DISABLED, TYPE } from "../../core/constants.js";

export const key = (p, loc, seq) => `${p}:${loc}:${seq}`;

// Colore delle gemme delle zone Pendulum, come sulle carte: scala sinistra blu, scala destra rossa.
const SCALE_COLOR = { left: "blue", right: "red" };

/**
 * Gemma di una zona Pendulum: l'immagine scelta dal proprietario della zona (custom) o quella disegnata in CSS
 * (una gemma allungata, schiacciata e girata con la punta lunga verso l'esterno del campo).
 */
function pendulumGem(scale, extraCls = "", custom = null) {
  const color = SCALE_COLOR[scale];
  const cls = `pz-gem.${color}.${scale}${extraCls ? "." + extraCls : ""}`;
  // L'immagine personalizzata è disegnata per una sola zona: nell'altra si mostra specchiata.
  return custom ? h(`img.${cls}.custom${mirrorFor(custom, scale) ? ".mirror" : ""}`, { src: custom[color], alt: "", draggable: false }) : h(`div.${cls}`, h("i"));
}

const isFaceDown = (pos) => (pos & POS.FACEDOWN) !== 0;
const isDefense = (pos) => (pos & POS.DEFENSE) !== 0;

export class Board {
  /**
   * @param opts { me, reveal (mostra tutto: modalità solo), onHover(code, info), onPile(player, loc) }
   */
  constructor(opts) {
    this.opts = opts;
    this.me = opts.me;
    this.tags = null; // tag della board finale (Combo Trainer): [{ code, text }]
    this.snapshot = null;
    this.zoneEls = new Map(); // key -> elemento zona
    this.cardEls = new Map(); // key -> elemento carta
    this.clickHandlers = new Map(); // key -> fn(event)
    this.zonePicker = null;
    this.el = h("div.board");
    this.field = h("div.duel-field");
    this.handEls = [h("div.hand.hand-0"), h("div.hand.hand-1")];
    this.el.append(this.field);
    this.buildField();
  }

  /** Posizione a schermo: 0 = in basso (io), 1 = in alto (avversario). */
  side(player) {
    return player === this.me ? 0 : 1;
  }

  /**
   * Gemme Pendulum del giocatore p: come gli sleeve, ognuno vede quelle scelte dall'altro sul suo lato.
   * Senza elenco (opts.pendulums) le proprie vengono dalle impostazioni e l'avversario ha quelle predefinite.
   */
  gems(p) {
    if (this.opts.pendulums) return validPendulumIcons(this.opts.pendulums[p]);
    return p === this.me ? pendulumIcons() : null;
  }

  /** Tag della board finale: etichette sopra le carte con quel codice (una per tag). */
  setTags(tags) {
    this.tags = tags?.length ? tags : null;
    if (this.snapshot) this.render(this.snapshot);
  }

  handEl(player) {
    return this.handEls[this.side(player)];
  }

  buildField() {
    const f = this.field;
    clear(f);
    this.zoneEls.clear();
    const zone = (player, loc, seq, cls, row, col) => {
      const z = h(`div.zone.${cls}`, { dataset: { player, loc, seq } });
      // Lato del campo (0 = in basso, il mio): per il bagliore del turno. Le zone Extra Monster sono condivise.
      if (!cls.includes("emz")) z.classList.add(`side-${this.side(player)}`);
      z.style.gridRow = row;
      z.style.gridColumn = col;
      z.addEventListener("click", (e) => this.onZoneClick(player, loc, seq, e));
      this.zoneEls.set(key(player, loc, seq), z);
      f.append(z);
      return z;
    };
    const me = this.me;
    const op = 1 - me;
    // Avversario (righe 1-2), zone specchiate.
    zone(op, LOC.DECK, 0, "pile deck", 1, 1);
    for (let s = 0; s < 5; s++) zone(op, LOC.SZONE, s, "st", 1, 6 - s);
    zone(op, LOC.EXTRA, 0, "pile extra", 1, 7);
    zone(op, LOC.GRAVE, 0, "pile grave", 2, 1);
    for (let s = 0; s < 5; s++) zone(op, LOC.MZONE, s, "mon", 2, 6 - s);
    zone(op, LOC.SZONE, 5, "fieldspell", 2, 7);
    // Zone mostri extra (condivise): la sinistra è la 5 per me e la 6 per l'avversario.
    const emzL = zone(me, LOC.MZONE, 5, "mon emz", 3, 3);
    const emzR = zone(me, LOC.MZONE, 6, "mon emz", 3, 5);
    this.zoneEls.set(key(op, LOC.MZONE, 6), emzL);
    this.zoneEls.set(key(op, LOC.MZONE, 5), emzR);
    emzL.dataset.alt = key(op, LOC.MZONE, 6);
    emzR.dataset.alt = key(op, LOC.MZONE, 5);
    zone(op, LOC.REMOVED, 0, "pile removed", 3, 1);
    zone(me, LOC.REMOVED, 0, "pile removed", 3, 7);
    // Zone pendulum separate (solo Master Rule 3).
    // Ogni zona ha la gemma della sua scala (sinistra = 6, destra = 7 dal punto di vista del proprietario).
    zone(op, LOC.SZONE, 7, "pz pz-op", 3, 2).append(pendulumGem("right", "", this.gems(op)));
    zone(op, LOC.SZONE, 6, "pz pz-op", 3, 6).append(pendulumGem("left", "", this.gems(op)));
    zone(me, LOC.SZONE, 6, "pz", 3, 2).append(pendulumGem("left", "", this.gems(me)));
    zone(me, LOC.SZONE, 7, "pz", 3, 6).append(pendulumGem("right", "", this.gems(me)));
    this.centerEl = h("div.field-center");
    this.centerEl.style.gridRow = 3;
    this.centerEl.style.gridColumn = 4;
    f.append(this.centerEl);
    // Io (righe 4-5).
    zone(me, LOC.SZONE, 5, "fieldspell", 4, 1);
    for (let s = 0; s < 5; s++) zone(me, LOC.MZONE, s, "mon", 4, 2 + s);
    zone(me, LOC.GRAVE, 0, "pile grave", 4, 7);
    zone(me, LOC.EXTRA, 0, "pile extra", 5, 1);
    for (let s = 0; s < 5; s++) zone(me, LOC.SZONE, s, "st", 5, 2 + s);
    zone(me, LOC.DECK, 0, "pile deck", 5, 7);
    // Master Rule 4/2020: la gemma (o l'immagine scelta) è proiettata sempre sulla prima e
    // sull'ultima zona Magie/Trappole, anche vuote: sono loro le zone Pendulum.
    if (!this.opts.separatePz) {
      for (const p of [me, op]) {
        this.zoneEls.get(key(p, LOC.SZONE, 0)).classList.add("pz-slot");
        this.zoneEls.get(key(p, LOC.SZONE, 0)).append(pendulumGem("left", "pz-floor", this.gems(p)));
        this.zoneEls.get(key(p, LOC.SZONE, 4)).classList.add("pz-slot");
        this.zoneEls.get(key(p, LOC.SZONE, 4)).append(pendulumGem("right", "pz-floor", this.gems(p)));
      }
    }
  }

  zoneEl(player, loc, seq = 0) {
    if (loc & LOC.ONFIELD || loc === LOC.FZONE || loc === LOC.PZONE) {
      if (loc === LOC.FZONE) return this.zoneEls.get(key(player, LOC.SZONE, 5));
      return this.zoneEls.get(key(player, loc & LOC.MZONE ? LOC.MZONE : LOC.SZONE, seq));
    }
    if (loc === LOC.HAND) return this.handEl(player).children[seq] ?? this.handEl(player);
    if (loc & LOC.OVERLAY) return this.zoneEls.get(key(player, LOC.MZONE, seq));
    for (const l of [LOC.DECK, LOC.EXTRA, LOC.GRAVE, LOC.REMOVED]) {
      if (loc & l) return this.zoneEls.get(key(player, l, 0));
    }
    return null;
  }

  /** Un giocatore può vedere questa carta? */
  canSee(player, loc, info, seq = -1) {
    if (this.opts.reveal) return true;
    if (!info) return false;
    if (player === this.me) {
      return loc !== LOC.DECK;
    }
    if (loc & (LOC.MZONE | LOC.SZONE)) return !isFaceDown(info.position);
    // Mano: carte rivelate (pubbliche) o appena mostrate al giocatore da un effetto.
    if (loc === LOC.HAND) return !!info.isPublic || !!this.opts.isConfirmed?.(player, seq);
    if (loc === LOC.EXTRA) return !isFaceDown(info.position ?? POS.FACEDOWN);
    return loc === LOC.GRAVE || loc === LOC.REMOVED ? !isFaceDown(info.position ?? POS.FACEUP) || info.isPublic : false;
  }

  render(snap) {
    this.snapshot = snap;
    this.cardEls.clear();
    this.tagUsed = new Set();
    for (const z of new Set(this.zoneEls.values())) {
      z.querySelectorAll(".card, .zone-badge, .stat, .materials, .pz-mark, .card-tag").forEach((n) => n.remove());
      z.classList.remove("occupied");
    }
    for (let p = 0; p < 2; p++) {
      const ps = snap.players[p];
      ps.mzone.forEach((c, s) => c && this.renderFieldCard(p, LOC.MZONE, s, c));
      ps.szone.forEach((c, s) => c && this.renderFieldCard(p, LOC.SZONE, s, c));
      this.renderPile(p, LOC.DECK, ps.deck, null);
      this.renderPile(p, LOC.GRAVE, ps.grave.length, ps.grave[ps.grave.length - 1]);
      this.renderPile(p, LOC.REMOVED, ps.removed.length, ps.removed[ps.removed.length - 1]);
      const faceupExtra = ps.extra.filter((c) => c && !isFaceDown(c.position));
      this.renderPile(p, LOC.EXTRA, ps.extra.length, null, faceupExtra.length);
      this.renderHand(p, ps.hand);
    }
    // Le zone pendulum separate si mostrano solo se usate.
    this.field.classList.toggle("has-pz", [0, 1].some((p) => snap.players[p].szone[6] || snap.players[p].szone[7]));
    this.applyHighlights();
  }

  renderFieldCard(p, loc, seq, info) {
    const z = this.zoneEls.get(key(p, loc, seq));
    if (!z) return;
    const visible = this.canSee(p, loc, info);
    const el = cardFace(visible ? info.code : 0, { faceDown: !visible });
    el.dataset.owner = p; // per lo sleeve del giocatore
    if (this.side(p) === 1) el.classList.add("theirs"); // carte dell'avversario: girate verso di lui
    if (isFaceDown(info.position)) el.classList.add("facedown");
    if (isDefense(info.position) && loc === LOC.MZONE) el.classList.add("defense");
    if (info.status & STATUS_DISABLED && !isFaceDown(info.position)) el.classList.add("negated");
    el.dataset.key = key(p, loc, seq);
    this.bindCard(el, p, loc, seq, visible ? info.code : 0, info);
    z.classList.add("occupied");
    z.append(el);
    if (info.overlayCards?.length) {
      // Le materiali stanno sotto il mostro (prima nel DOM) e ne spuntano dietro.
      z.insertBefore(h("div.materials", info.overlayCards.slice(0, 4).map(() => h("div.mat"))), el);
      z.append(h("div.zone-badge.overlay", { title: "Xyz Materials" }, info.overlayCards.length));
    }
    // Master Rule 4/2020: le zone Pendulum sono la prima e l'ultima zona Magie/Trappole.
    if (loc === LOC.SZONE && (seq === 0 || seq === 4) && !isFaceDown(info.position) && ((info.type ?? getCard(info.code)?.type ?? 0) & TYPE.PENDULUM)) {
      z.append(pendulumGem(seq === 0 ? "left" : "right", "pz-mark", this.gems(p)));
    }
    // Combo Trainer: tag della board finale sopra la carta (es. "Omni-negate").
    if (this.tags && visible) {
      const i = this.tags.findIndex((t, j) => !this.tagUsed.has(j) && t.code === info.code);
      if (i >= 0) {
        this.tagUsed.add(i);
        z.append(h("div.card-tag", this.tags[i].text));
      }
    }
    const counters = Object.entries(info.counters ?? {}).filter(([, n]) => n > 0);
    if (counters.length) {
      z.append(h("div.zone-badge.counter", { title: counters.map(([t, n]) => `${counterName(+t)}: ${n}`).join("\n") }, counters.reduce((a, [, n]) => a + n, 0)));
    }
    if (loc === LOC.MZONE && !isFaceDown(info.position)) {
      const c = getCard(info.code);
      const v = (n) => (n == null ? "" : n < 0 ? "?" : n);
      const isLink = ((info.type ?? c?.type ?? 0) & TYPE.LINK) !== 0;
      const atkCls = info.attack > info.baseAttack ? "up" : info.attack < info.baseAttack ? "down" : "";
      const defCls = info.defense > info.baseDefense ? "up" : info.defense < info.baseDefense ? "down" : "";
      z.append(
        h("div.stat", h(`span.atk.${atkCls}`, v(info.attack)), !isLink && h("span.sep", "/"), !isLink && h(`span.def.${defCls}`, v(info.defense)), isLink && h("span.link", `L${info.link?.rating ?? ""}`))
      );
    }
    this.cardEls.set(key(p, loc, seq), el);
  }

  renderPile(p, loc, count, top, faceup = 0) {
    const z = this.zoneEls.get(key(p, loc, 0));
    if (!z) return;
    if (count > 0) {
      const visible = top && this.canSee(p, loc, top);
      const el = cardFace(visible ? top.code : 0, { faceDown: !visible });
      el.dataset.owner = p;
      if (this.side(p) === 1) el.classList.add("theirs");
      el.classList.add("pile-top");
      if (count > 1) el.style.setProperty("--stack", Math.min(6, Math.ceil(count / 6)));
      z.append(el);
      z.classList.add("occupied");
      el.addEventListener("mouseenter", () => visible && this.opts.onHover?.(top.code));
    }
    z.append(h("div.zone-badge.count", faceup ? `${count} (${faceup}↑)` : count));
    this.cardEls.set(key(p, loc, 0), z);
  }

  renderHand(p, hand) {
    const el = this.handEl(p);
    clear(el);
    el.style.setProperty("--n", hand.length);
    hand.forEach((info, i) => {
      const visible = info && this.canSee(p, LOC.HAND, info, i);
      const c = cardFace(visible ? info.code : 0, { faceDown: !visible });
      c.dataset.owner = p;
      c.style.setProperty("--i", i);
      if (info?.isPublic && p === this.me) c.classList.add("revealed");
      c.dataset.key = key(p, LOC.HAND, i);
      this.bindCard(c, p, LOC.HAND, i, visible ? info.code : 0, info);
      this.cardEls.set(key(p, LOC.HAND, i), c);
      el.append(c);
    });
  }

  bindCard(el, p, loc, seq, code, info) {
    el.addEventListener("mouseenter", () => code && this.opts.onHover?.(code, info));
    el.addEventListener("click", (e) => {
      const fn = this.clickHandlers.get(key(p, loc, seq));
      if (fn) {
        e.stopPropagation();
        fn(e, el);
      } else if (this.materialsAt(el.dataset.key).length) {
        // Nessuna azione su questa carta, ma ha materiali Xyz: menu con solo "View materials".
        e.stopPropagation();
        this.opts.onCardMenu?.(el, []);
      }
    });
  }

  /** Codici dei materiali Xyz del mostro nella zona `k` (chiave della carta), [] se non ne ha. */
  materialsAt(k) {
    if (!k || !this.snapshot) return [];
    const [p, loc, seq] = k.split(":").map(Number);
    if (loc !== LOC.MZONE) return [];
    const mats = this.snapshot.players[p]?.mzone?.[seq]?.overlayCards ?? [];
    return mats.map((m) => (typeof m === "object" ? m?.code : m)).filter(Boolean);
  }

  onZoneClick(player, loc, seq, e) {
    if (this.zonePicker) {
      const z = e.currentTarget;
      const k = z.classList.contains("pickable") ? z.dataset.pickKey : null;
      if (k) {
        e.stopPropagation();
        this.zonePicker(k);
      }
      return;
    }
    // Le pile si aprono sempre in un elenco, dove ogni carta mostra le sue azioni.
    if ([LOC.GRAVE, LOC.REMOVED, LOC.EXTRA].includes(loc)) {
      this.opts.onPile?.(e.currentTarget.dataset.player | 0, loc);
    }
  }

  // ---------------------------------------------------------------- selezioni

  /**
   * handlers: Map key -> fn. `glow` decide lo stile dell'evidenziazione:
   * una stringa uguale per tutte le carte oppure una Map key -> stile
   * ("action" = azione semplice, "activate" = effetto attivabile, "attack").
   */
  setClickable(handlers, glow = "action") {
    this.clickHandlers = handlers;
    this.glow = glow;
    this.applyHighlights();
  }

  clearClickable() {
    this.clickHandlers = new Map();
    this.applyHighlights();
  }

  applyHighlights() {
    this.el.querySelectorAll(".selectable").forEach((n) => n.classList.remove("selectable", "glow-action", "glow-attack", "glow-pick", "glow-activate"));
    const rank = { action: 0, attack: 1, activate: 2 };
    for (const k of this.clickHandlers.keys()) {
      const [p, loc, seq] = k.split(":").map(Number);
      const glow = typeof this.glow === "string" ? this.glow : this.glow.get(k) ?? "action";
      let el = this.cardEls.get(k);
      if (!el && [LOC.GRAVE, LOC.REMOVED, LOC.EXTRA, LOC.DECK].includes(loc)) el = this.zoneEls.get(key(p, loc, 0));
      if (!el) continue;
      // Più carte nella stessa pila: vince l'evidenziazione più importante.
      const prev = ["activate", "attack", "action"].find((g) => el.classList.contains(`glow-${g}`));
      if (prev && rank[prev] >= (rank[glow] ?? 0)) continue;
      el.classList.remove("glow-action", "glow-attack", "glow-activate");
      el.classList.add("selectable", `glow-${glow}`);
    }
  }

  /** Evidenzia zone libere; restituisce una Promise con la chiave scelta. */
  pickZone(places) {
    return new Promise((resolve) => {
      const els = [];
      for (const pl of places) {
        const k = key(pl.player, pl.location, pl.sequence);
        const z = this.zoneEls.get(k);
        if (!z) continue;
        z.classList.add("pickable");
        z.dataset.pickKey = k;
        els.push(z);
      }
      this.zonePicker = (k) => {
        for (const z of els) {
          z.classList.remove("pickable");
          delete z.dataset.pickKey;
        }
        this.zonePicker = null;
        resolve(k);
      };
    });
  }

  cancelZonePick() {
    this.el.querySelectorAll(".pickable").forEach((z) => {
      z.classList.remove("pickable");
      delete z.dataset.pickKey;
    });
    this.zonePicker = null;
  }

  /** Evidenzia carte/zone coinvolte (bersagli, carte selezionate dall'avversario...). */
  flash(p, loc, seq, cls = "flash-target", ms = 900) {
    const el = this.cardEls.get(key(p, loc, seq)) ?? this.zoneEl(p, loc, seq);
    if (!el) return;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }
}
