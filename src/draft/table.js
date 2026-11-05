// Tavolo di un Helios Bundle Draft (vedi "Helios Bundle Draft — Implementation Guide.md"): posti, pacchetti, passaggi
// asincroni, timer e scelte automatiche. Nessuna interfaccia e nessuna rete: chi lo usa chiama pick/select e tick, e
// ascolta onChange. Per ora tutti i posti sono su questo computer (giocatore + bot); nella fase online i posti degli
// altri giocatori arriveranno dalla rete con le stesse operazioni.
//
// Regole:
//   2 round (1 = bundle, 2 = carte singole), N pacchetti per round (uno per posto) da 15 oggetti, 15 scelte a round.
//   Round 1 passa a sinistra (al posto successivo), round 2 a destra (al precedente).
//   Code asincrone: chi sceglie passa subito il resto del pacchetto al vicino; i pacchetti si accumulano da chi è lento.
//   Il round 2 si apre quando tutti hanno finito il round 1 (i pacchetti si aprono insieme).
//   Timer dall'arrivo del pacchetto sullo schermo; allo scadere si conferma la selezione oppure si sceglie a caso tra
//   gli oggetti della rarità più alta del pacchetto (senza rarità = sotto tutte; nessuna rarità nel pacchetto = a caso).
import { getCard, isExtraDeckCard } from "../data/db.js";
import { PACK_SIZE, rarityRank } from "./format.js";
import { makePack, seededRandom } from "./packs.js";

export const ROUNDS = 2;
export const DEFAULT_TIMER = { start: 90, end: 10 };
/** Timer di un tavolo: uno per round ([round 1, round 2]), scelti dall'host. */
export const DEFAULT_TIMERS = [DEFAULT_TIMER, DEFAULT_TIMER];

/**
 * Tempo per una scelta (secondi, continuo) con `remaining` oggetti nel pacchetto prima della scelta. Riparte a ogni
 * pacchetto che arriva sullo schermo (quindi dopo ogni scelta) e si accorcia man mano che il pacchetto si svuota, da
 * T_start (pacchetto pieno) a circa T_end (ultimo oggetto).
 */
export function pickTime(remaining, { start, end } = DEFAULT_TIMER) {
  return end + (start - end) * (Math.max(0, Math.min(PACK_SIZE, remaining)) / PACK_SIZE);
}

let uidSeq = 0;
const uid = () => `i${(++uidSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Oggetto di un pacchetto, con le carte divise tra Main ed Extra Deck secondo il loro tipo. */
function packItem(x, round) {
  const main = x.codes.filter((c) => !isExtraDeckCard(getCard(c)));
  const extra = x.codes.filter((c) => isExtraDeckCard(getCard(c)));
  return { uid: uid(), id: x.id, round, label: x.label, rarity: x.rarity, main, extra, ...(x.cover ? { cover: x.cover } : {}) };
}

export class DraftTable {
  /**
   * @param format  formato del draft (src/draft/format.js)
   * @param seats   [{ name, bot }] in ordine attorno al tavolo
   * @param opts    { timers: [{ start, end } del round 1, del round 2], seed, now() }
   */
  constructor(format, seats, { timers = DEFAULT_TIMERS, seed = (Math.random() * 2 ** 32) >>> 0, now = () => Date.now() } = {}) {
    this.format = format;
    this.timers = timers;
    this.now = now;
    this.rnd = seededRandom(seed);
    this.seats = seats.map((s, i) => ({
      index: i,
      name: s.name,
      bot: !!s.bot,
      queue: [], // pacchetti in attesa, il primo è quello sullo schermo
      binder: [], // oggetti scelti (privato)
      picks: [0, 0], // scelte fatte per round
      selected: null, // uid selezionato ma non ancora confermato
      deadline: 0, // fine del tempo per il pacchetto sullo schermo (ms)
      botAt: 0, // quando il bot sceglie
    }));
    this.round = 0;
    this.done = false;
    this.log = []; // eventi tecnici (regole tolte da un pacchetto, ecc.)
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(ev) {
    for (const fn of this.listeners) fn(ev);
  }

  start() {
    this.openRound(1);
  }

  openRound(round) {
    this.round = round;
    for (const s of this.seats) {
      const p = makePack(this.format, round, this.rnd);
      if (!p) throw new Error(`Round ${round} has no items`);
      if (p.dropped.length) this.log.push({ round, seat: s.index, dropped: p.dropped });
      this.receive(s, { id: uid(), round, items: p.items.map((x) => packItem(x, round)) });
    }
    this.emit({ type: "round", round });
  }

  /** Il pacchetto arriva in coda al posto; se è il primo, parte il suo timer. */
  receive(seat, pack) {
    seat.queue.push(pack);
    if (seat.queue.length === 1) this.show(seat);
  }

  /** Il primo pacchetto della coda arriva sullo schermo: timer e (per un bot) il momento della sua scelta. */
  show(seat) {
    const pack = seat.queue[0];
    seat.selected = null;
    if (!pack) return;
    const t = this.now();
    const time = pickTime(pack.items.length, this.timers[pack.round - 1] ?? DEFAULT_TIMER) * 1000;
    seat.deadline = t + time;
    // I bot scelgono dopo qualche secondo (non sempre allo stesso ritmo), sempre prima dello scadere.
    seat.botAt = t + Math.min(time - 300, 1200 + this.rnd() * 3800);
  }

  /** Posto a cui va il pacchetto dopo una scelta: round 1 a sinistra (successivo), round 2 a destra (precedente). */
  nextSeat(seat, round) {
    const n = this.seats.length;
    return this.seats[(seat.index + (round === 1 ? 1 : n - 1)) % n];
  }

  select(seatIndex, itemUid) {
    const s = this.seats[seatIndex];
    if (!s.queue[0]?.items.some((x) => x.uid === itemUid)) return;
    s.selected = itemUid;
    this.emit({ type: "select", seat: seatIndex });
  }

  /** Scelta confermata: l'oggetto va nel binder, il resto del pacchetto al vicino. */
  pick(seatIndex, itemUid, auto = false) {
    const s = this.seats[seatIndex];
    const pack = s.queue[0];
    const i = pack?.items.findIndex((x) => x.uid === itemUid) ?? -1;
    if (i < 0) return false;
    const [item] = pack.items.splice(i, 1);
    s.binder.push({ ...item, pickNo: s.picks[pack.round - 1] + 1, auto });
    s.picks[pack.round - 1]++;
    s.queue.shift();
    if (pack.items.length) this.receive(this.nextSeat(s, pack.round), pack);
    this.show(s);
    this.emit({ type: "pick", seat: seatIndex, item, auto });
    this.checkRound();
    return true;
  }

  checkRound() {
    if (this.done) return;
    const all = this.seats.every((s) => s.picks[this.round - 1] >= PACK_SIZE && !s.queue.length);
    if (!all) return;
    if (this.round < ROUNDS) this.openRound(this.round + 1);
    else {
      this.done = true;
      this.emit({ type: "done" });
    }
  }

  /** Scelta automatica: tra gli oggetti della rarità più alta del pacchetto, a caso. */
  autoChoice(pack) {
    const ranks = pack.items.map((x) => rarityRank(this.format, x.rarity));
    const top = Math.max(...ranks);
    const best = pack.items.filter((_, i) => ranks[i] === top);
    return best[Math.floor(this.rnd() * best.length)];
  }

  /** Scelta di un bot: di solito la rarità più alta, a volte un oggetto a caso. */
  botChoice(pack) {
    return this.rnd() < 0.75 ? this.autoChoice(pack) : pack.items[Math.floor(this.rnd() * pack.items.length)];
  }

  /** Da chiamare spesso (es. ogni 200 ms): scelte dei bot e scadenze dei timer. */
  tick() {
    if (this.done || !this.round) return;
    const t = this.now();
    for (const s of this.seats) {
      const pack = s.queue[0];
      if (!pack) continue;
      if (s.bot && t >= s.botAt) this.pick(s.index, this.botChoice(pack).uid);
      else if (t >= s.deadline) {
        const sel = pack.items.find((x) => x.uid === s.selected);
        this.pick(s.index, (sel ?? this.autoChoice(pack)).uid, true);
      }
    }
  }

  /** Secondi rimasti per il pacchetto sullo schermo del posto (null senza pacchetto). */
  timeLeft(seatIndex) {
    const s = this.seats[seatIndex];
    return s.queue.length ? Math.max(0, (s.deadline - this.now()) / 1000) : null;
  }

  /** Pool di un posto: tutte le carte scelte, con il bundle da cui vengono. */
  pool(seatIndex) {
    return this.seats[seatIndex].binder;
  }
}

/** Carte di un pool: { main, extra } (tutte le copie). */
export function poolCards(binder) {
  return { main: binder.flatMap((x) => x.main), extra: binder.flatMap((x) => x.extra) };
}

/**
 * Mazzo di un bot dal suo pool: tutte le carte del Main Deck (al massimo 60, prima quelle dei bundle) e 15 dell'Extra
 * Deck (prima i boss dei bundle); il resto è il sideboard.
 */
export function botDeck(binder) {
  const bundles = binder.filter((x) => x.round === 1);
  const singles = binder.filter((x) => x.round !== 1);
  const main = [...bundles.flatMap((x) => x.main), ...singles.flatMap((x) => x.main)];
  const extra = [...bundles.flatMap((x) => x.extra), ...singles.flatMap((x) => x.extra)];
  return { main: main.slice(0, 60), extra: extra.slice(0, 15), side: [...main.slice(60), ...extra.slice(15)] };
}
