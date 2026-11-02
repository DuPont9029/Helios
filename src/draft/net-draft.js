// Draft online (Helios Bundle Draft, vedi "Helios Bundle Draft — Implementation Guide.md" §5): ogni giocatore tiene
// sul suo computer i posti che "ospita" (il suo; l'host anche quelli dei bot) e si passa i pacchetti con i vicini.
// Nessun coordinatore: lo stato pubblico (scelte fatte e pacchetti in coda di ogni posto) gira a tutti, i pacchetti
// e i binder solo a chi servono. Stessa interfaccia di DraftTable (table.js), così il tavolo (draft-table.js) è lo
// stesso del draft contro i bot.
//
// Rete astratta (vedi draft-room.js): { selfId, send(peerId, msg), broadcast(msg), on(fn(msg, from)) } più
// peerLeft(peerId) e peerJoined(peerId) chiamati da fuori.
//
// Anello e caduta di un giocatore (guida §5, con le decisioni del 2026-11-01):
//   - Ogni posto S ha un "custode" (escrow): chi ospita il primo posto dopo S ospitato da un altro computer. Chi
//     passa un pacchetto a S ne manda una copia anche al custode, e S gli dice ogni sua scelta: il custode sa
//     sempre la coda e il binder di S, ma non li mostra (li tiene solo per restituirli).
//   - Se il computer che ospita S cade, il custode prende il posto: un fantasma (sceglie solo allo scadere del
//     tempo) o, per un bot, il bot. Tutti fanno lo stesso calcolo sulla stessa mappa, quindi non serve accordarsi.
//   - S torna con il suo gettone (session token): il custode gli restituisce coda e binder e il posto torna suo.
//   - Se cade anche un vicino di un posto fantasma (chi lo ospita o il posto prima) il draft si annulla.
//   - I pacchetti hanno un id e il numero di scelte fatte: chi riceve due volte lo stesso pacchetto lo ignora.
import { getCard, isExtraDeckCard } from "../data/db.js";
import { PACK_SIZE, rarityRank } from "./format.js";
import { makePack, seededRandom } from "./packs.js";
import { pickTime, DEFAULT_TIMER, DEFAULT_TIMERS, ROUNDS } from "./table.js";

const rid = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Oggetto di un pacchetto, con le carte divise tra Main ed Extra Deck secondo il loro tipo (come in table.js). */
function packItem(x, round) {
  const main = x.codes.filter((c) => !isExtraDeckCard(getCard(c)));
  const extra = x.codes.filter((c) => isExtraDeckCard(getCard(c)));
  return { uid: rid(), id: x.id, round, label: x.label, rarity: x.rarity, main, extra };
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class NetDraft {
  /**
   * @param net    rete (vedi sopra)
   * @param start  messaggio "start" dell'host: { format, seats: [{ name, bot, peer }], hashes, timers, seed, bestOf, pool }
   * @param opts   { me: il mio posto (null per chi rientra), now() }
   */
  constructor(net, start, { me = null, now = () => Date.now() } = {}) {
    this.net = net;
    this.format = start.format;
    this.timers = start.timers ?? DEFAULT_TIMERS;
    this.hashes = start.hashes ?? [];
    this.settings = { seed: start.seed, bestOf: start.bestOf, pool: start.pool, code: start.code, host: start.host };
    this.now = now;
    this.rnd = seededRandom((Math.random() * 2 ** 32) >>> 0);
    this.me = me;
    // Vista pubblica di ogni posto (per il giro del tavolo); i posti ospitati qui hanno anche coda e binder veri.
    this.seats = start.seats.map((s, i) => ({
      index: i,
      name: s.name,
      bot: !!s.bot,
      peer: s.peer,
      ghost: false,
      queue: [],
      binder: [],
      picks: [0, 0],
      selected: null,
      deadline: 0,
      botAt: 0,
    }));
    this.escrow = new Map(); // posto → { queue, binder, picks, recent } dei posti di cui sono custode
    this.seen = new Set(); // "posto:pacchetto:scelte" già ricevuti
    this.round = 0;
    this.done = false;
    this.aborted = null;
    this.opened = new Set(); // round già aperti qui
    this.listeners = new Set();
    this.offNet = net.on((msg, from) => this.onMessage(msg, from));
  }

  get n() {
    return this.seats.length;
  }

  hosted(i) {
    return this.seats[i]?.peer === this.net.selfId;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(ev) {
    for (const fn of this.listeners) fn(ev);
  }

  close() {
    this.offNet?.();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- anello

  /** Custode del posto i: chi ospita il primo posto dopo i ospitato da un altro computer (null se non c'è). */
  escrowOf(i) {
    const owner = this.seats[i].peer;
    for (let k = 1; k < this.n; k++) {
      const p = this.seats[(i + k) % this.n].peer;
      if (p && p !== owner) return p;
    }
    return null;
  }

  nextSeat(i, round) {
    return (i + (round === 1 ? 1 : this.n - 1)) % this.n;
  }

  // ---------------------------------------------------------------- round e pacchetti

  start() {
    this.openRound(1);
  }

  /** Apre il round: ogni posto ospitato qui apre il suo pacchetto (nessun altro sa cosa contiene). */
  openRound(round) {
    if (this.opened.has(round) || this.done) return;
    this.opened.add(round);
    this.round = round;
    for (const s of this.seats) {
      if (!this.hosted(s.index)) continue;
      const p = makePack(this.format, round, this.rnd);
      if (!p) throw new Error(`Round ${round} has no items`);
      this.deliver(s.index, { id: rid(), round, n: 0, items: p.items.map((x) => packItem(x, round)) });
    }
    this.emit({ type: "round", round });
    this.publish();
  }

  /** Un pacchetto va al posto `to`: a chi lo ospita, e una copia al suo custode. */
  deliver(to, pack) {
    const host = this.seats[to].peer;
    if (host === this.net.selfId) this.receive(to, pack);
    else if (host) this.net.send(host, { t: "pack", seat: to, pack });
    const keeper = this.escrowOf(to);
    if (keeper && keeper !== host) {
      if (keeper === this.net.selfId) this.keep(to, pack);
      else this.net.send(keeper, { t: "esc", seat: to, pack });
    }
  }

  receive(i, pack) {
    const key = `${i}:${pack.id}:${pack.n}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const s = this.seats[i];
    s.queue.push(pack);
    if (s.queue.length === 1) this.show(s);
    this.emit({ type: "pack", seat: i });
    this.publish();
  }

  show(s) {
    const pack = s.queue[0];
    s.selected = null;
    if (!pack) return;
    const t = this.now();
    const time = pickTime(pack.items.length, this.timers[pack.round - 1] ?? DEFAULT_TIMER) * 1000;
    s.deadline = t + time;
    s.botAt = t + Math.min(time - 300, 1200 + this.rnd() * 3800);
  }

  select(i, uid) {
    const s = this.seats[i];
    if (!this.hosted(i) || !s.queue[0]?.items.some((x) => x.uid === uid)) return;
    s.selected = uid;
    this.emit({ type: "select", seat: i });
  }

  pick(i, uid, auto = false) {
    const s = this.seats[i];
    if (!this.hosted(i)) return false;
    const pack = s.queue[0];
    const k = pack?.items.findIndex((x) => x.uid === uid) ?? -1;
    if (k < 0) return false;
    const [item] = pack.items.splice(k, 1);
    s.binder.push({ ...item, pickNo: s.picks[pack.round - 1] + 1, auto });
    s.picks[pack.round - 1]++;
    s.queue.shift();
    // Prima la scelta al custode, poi il pacchetto al vicino: se questo computer cade in mezzo, il custode sa già
    // cosa è stato scelto e può far arrivare lui il resto del pacchetto.
    const keeper = this.escrowOf(i);
    const before = pack.n;
    pack.n++;
    if (keeper && keeper !== this.net.selfId) this.net.send(keeper, { t: "pk", seat: i, pack: pack.id, n: before, uid, auto });
    else if (keeper === this.net.selfId) this.kept(i, pack.id, before, uid, auto);
    if (pack.items.length) this.deliver(this.nextSeat(i, pack.round), pack);
    this.show(s);
    this.emit({ type: "pick", seat: i, item, auto });
    this.publish();
    this.checkRound();
    return true;
  }

  autoChoice(pack) {
    const ranks = pack.items.map((x) => rarityRank(this.format, x.rarity));
    const top = Math.max(...ranks);
    const best = pack.items.filter((_, k) => ranks[k] === top);
    return best[Math.floor(this.rnd() * best.length)];
  }

  botChoice(pack) {
    return this.rnd() < 0.75 ? this.autoChoice(pack) : pack.items[Math.floor(this.rnd() * pack.items.length)];
  }

  /** Scelte dei bot e scadenze dei timer dei posti ospitati qui. Un fantasma sceglie solo allo scadere del tempo. */
  tick() {
    if (this.done || this.aborted || !this.round) return;
    const t = this.now();
    for (const s of this.seats) {
      if (!this.hosted(s.index)) continue;
      const pack = s.queue[0];
      if (!pack) continue;
      if (s.bot && t >= s.botAt) this.pick(s.index, this.botChoice(pack).uid);
      else if (t >= s.deadline) {
        const sel = s.ghost ? null : pack.items.find((x) => x.uid === s.selected);
        this.pick(s.index, (sel ?? this.autoChoice(pack)).uid, true);
      }
    }
  }

  timeLeft(i) {
    const s = this.seats[i];
    return this.hosted(i) && s.queue.length ? Math.max(0, (s.deadline - this.now()) / 1000) : null;
  }

  pool(i) {
    return this.seats[i].binder;
  }

  // ---------------------------------------------------------------- stato pubblico

  /** Scelte fatte e pacchetti in coda dei posti ospitati qui, a tutti. */
  publish() {
    const st = this.seats.filter((s) => this.hosted(s.index)).map((s) => [s.index, s.picks, s.queue.length]);
    if (st.length) this.net.broadcast({ t: "st", st });
  }

  status(st, from) {
    for (const [i, picks, q] of st) {
      const s = this.seats[i];
      if (!s || s.peer !== from) continue;
      s.picks = picks;
      // Posti degli altri: la coda è solo un numero (i pacchetti non si vedono).
      s.queue = Array(q).fill(null);
    }
    this.emit({ type: "status" });
    this.checkRound();
  }

  checkRound() {
    if (this.done || this.aborted || !this.round) return;
    const r = this.round;
    // 15 scelte nel round = nessun pacchetto di quel round in coda (le code possono già avere quelli del round dopo,
    // aperti da chi se n'è accorto prima).
    if (!this.seats.every((s) => s.picks[r - 1] >= PACK_SIZE)) return;
    if (r < ROUNDS) this.openRound(r + 1);
    else {
      this.done = true;
      this.emit({ type: "done" });
    }
  }

  // ---------------------------------------------------------------- custode

  escrowFor(i) {
    if (!this.escrow.has(i)) this.escrow.set(i, { queue: [], binder: [], picks: [0, 0], recent: [], seen: new Set() });
    return this.escrow.get(i);
  }

  keep(i, pack) {
    const e = this.escrowFor(i);
    const key = `${pack.id}:${pack.n}`;
    if (e.seen.has(key)) return;
    e.seen.add(key);
    e.queue.push(structuredClone(pack));
  }

  /** Il posto i ha scelto `uid` dal pacchetto (id, n scelte prima): il custode aggiorna la sua copia. */
  kept(i, packId, n, uid, auto) {
    const e = this.escrowFor(i);
    const k = e.queue.findIndex((p) => p.id === packId && p.n === n);
    if (k < 0) return;
    const [pack] = e.queue.splice(k, 1);
    const j = pack.items.findIndex((x) => x.uid === uid);
    if (j < 0) return;
    const [item] = pack.items.splice(j, 1);
    e.binder.push({ ...item, pickNo: e.picks[pack.round - 1] + 1, auto });
    e.picks[pack.round - 1]++;
    pack.n++;
    // Il resto del pacchetto, da far arrivare se il posto cade prima di averlo passato (chi lo riceve due volte
    // lo ignora). Bastano gli ultimi.
    if (pack.items.length) e.recent = [...e.recent.slice(-3), { to: this.nextSeat(i, pack.round), pack }];
  }

  // ---------------------------------------------------------------- cadute e rientri

  /** Un computer è uscito dalla stanza: i suoi posti passano ai custodi (o il draft si annulla). */
  peerLeft(peer) {
    if (this.done || this.aborted) return;
    const lost = this.seats.filter((s) => s.peer === peer);
    if (!lost.length) return;
    // Annullamento: cade un vicino di un posto fantasma (chi lo ospita o il posto prima).
    for (const g of this.seats.filter((s) => s.ghost)) {
      const prev = this.seats[(g.index - 1 + this.n) % this.n];
      if (g.peer === peer || prev.peer === peer) return this.abort("A second player left next to a seat that was already played by the timer");
    }
    const keepers = lost.map((s) => this.escrowOf(s.index));
    if (keepers.some((k) => !k || k === peer)) return this.abort("Nobody can take over the seat of the player who left");
    lost.forEach((s, k) => {
      s.peer = keepers[k];
      s.ghost = !s.bot;
      s.selected = null;
    });
    // Prima si prendono tutti i posti (code, binder e pacchetti già visti), poi si rimandano i pacchetti forse
    // persi: un pacchetto tra due posti presi insieme non arriva due volte.
    const mine = lost.filter((s) => s.peer === this.net.selfId);
    const resend = mine.flatMap((s) => this.takeOver(s));
    for (const r of resend) this.deliver(r.to, structuredClone(r.pack));
    this.emit({ type: "ghost", seats: lost.map((s) => s.index) });
    this.publish();
  }

  /** Questo computer prende il posto s (era custode): coda e binder dalla copia. Restituisce i pacchetti forse persi. */
  takeOver(s) {
    const e = this.escrowFor(s.index);
    s.queue = e.queue.map((p) => structuredClone(p));
    s.binder = e.binder.map((x) => ({ ...x }));
    s.picks = [...e.picks];
    for (const key of e.seen) this.seen.add(`${s.index}:${key}`);
    this.escrow.delete(s.index);
    this.show(s);
    return e.recent;
  }

  abort(reason) {
    if (this.aborted) return;
    this.aborted = reason;
    this.emit({ type: "abort", reason });
  }

  /** Chi rientra chiede il suo posto a tutti (lo restituisce chi lo ospita, se il gettone è giusto). */
  askSeat(seat, token, to = null) {
    this.reclaiming = seat;
    const msg = { t: "reclaim", seat, token };
    if (to) this.net.send(to, msg);
    else this.net.broadcast(msg);
  }

  /** Rientro con il gettone: chi ospita il posto glielo restituisce. */
  async reclaim(msg, from) {
    const i = msg.seat;
    const s = this.seats[i];
    if (!s || s.bot || !s.ghost || !this.hosted(i)) return;
    if ((await sha256(String(msg.token))) !== this.hashes[i]) return;
    this.net.send(from, {
      t: "handback",
      seat: i,
      state: this.snapshot(),
      queue: s.queue,
      binder: s.binder,
      picks: s.picks,
    });
    this.net.broadcast({ t: "seat", seat: i, peer: from });
    this.reassign(i, from);
  }

  reassign(i, peer) {
    const s = this.seats[i];
    s.peer = peer;
    s.ghost = false;
    if (peer !== this.net.selfId) {
      s.queue = Array(s.queue.length).fill(null);
      s.binder = [];
    }
    this.emit({ type: "seat", seat: i });
  }

  /** Stato pubblico del tavolo, per chi rientra. */
  snapshot() {
    return {
      round: this.round,
      opened: [...this.opened],
      seats: this.seats.map((s) => ({ name: s.name, bot: s.bot, peer: s.peer, ghost: s.ghost, picks: s.picks, q: s.queue.length })),
    };
  }

  /** Rientrato: il posto torna mio, con coda e binder tenuti dal custode. */
  restore(msg) {
    const st = msg.state;
    this.round = st.round;
    for (const r of st.opened) this.opened.add(r);
    st.seats.forEach((x, i) => {
      Object.assign(this.seats[i], { peer: x.peer, ghost: x.ghost, picks: x.picks, queue: Array(x.q).fill(null) });
    });
    const s = this.seats[msg.seat];
    this.me = msg.seat;
    s.peer = this.net.selfId;
    s.ghost = false;
    s.queue = msg.queue;
    s.binder = msg.binder;
    s.picks = msg.picks;
    for (const p of s.queue) this.seen.add(`${s.index}:${p.id}:${p.n}`);
    this.show(s);
    this.emit({ type: "restored" });
    this.publish();
  }

  // ---------------------------------------------------------------- messaggi

  onMessage(msg, from) {
    if (!msg || this.aborted) return;
    switch (msg.t) {
      case "pack":
        if (this.hosted(msg.seat)) this.receive(msg.seat, msg.pack);
        // Arrivato a chi non ospita più quel posto (la mappa è cambiata nel frattempo): lo si inoltra.
        else if (this.seats[msg.seat]?.peer && this.seats[msg.seat].peer !== from) this.net.send(this.seats[msg.seat].peer, msg);
        break;
      case "esc":
        this.keep(msg.seat, msg.pack);
        break;
      case "pk":
        this.kept(msg.seat, msg.pack, msg.n, msg.uid, msg.auto);
        break;
      case "st":
        this.status(msg.st, from);
        break;
      case "reclaim":
        this.reclaim(msg, from);
        break;
      case "handback":
        // Chi rientra non sa chi ospitava il suo posto: vale la prima restituzione del posto che ha chiesto.
        if (this.me == null && msg.seat === this.reclaiming) this.restore(msg);
        break;
      case "seat":
        if (this.seats[msg.seat] && this.seats[msg.seat].peer === from) this.reassign(msg.seat, msg.peer);
        break;
      case "abort":
        this.abort(msg.reason || "The draft was cancelled");
        break;
    }
  }
}
