// Pilota un'istanza di ocgcore (sync) e ne espone lo stato in forma serializzabile.
// Non dipende dal DOM: gira nel Web Worker del browser e negli script Node.
import { LOC, MSG, PROCESS, PROMPT_MSGS, QUERY } from "./constants.js";
import { toCoreCard } from "./carddata.js";

const FIELD_QUERY =
  QUERY.CODE | QUERY.POSITION | QUERY.ALIAS | QUERY.TYPE | QUERY.LEVEL | QUERY.RANK |
  QUERY.ATTRIBUTE | QUERY.RACE | QUERY.ATTACK | QUERY.DEFENSE | QUERY.BASE_ATTACK |
  QUERY.BASE_DEFENSE | QUERY.OVERLAY_CARD | QUERY.COUNTERS | QUERY.OWNER | QUERY.STATUS |
  QUERY.IS_PUBLIC | QUERY.LSCALE | QUERY.RSCALE | QUERY.LINK | QUERY.IS_HIDDEN |
  QUERY.EQUIP_CARD | QUERY.TARGET_CARD;
const PILE_QUERY = QUERY.CODE | QUERY.POSITION | QUERY.TYPE | QUERY.IS_PUBLIC | QUERY.ATTACK | QUERY.DEFENSE | QUERY.LEVEL | QUERY.RANK | QUERY.LINK;

/** Generatore pseudo-casuale deterministico (xorshift128) dai quattro valori del seed del duello. */
export function seededRandom(seed) {
  const words = (seed ?? []).flatMap((v) => {
    const b = BigInt(v);
    return [Number(b & 0xffffffffn), Number((b >> 32n) & 0xffffffffn)];
  });
  let [x, y, z, w] = [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0xdeadbeef];
  for (let i = 0; i < words.length; i++) {
    // Mescola ogni parola del seed nello stato (finalizzatore di murmur3).
    let h = (words[i] ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h = (h ^ (h >>> 16)) >>> 0;
    [x, y, z, w] = [y, z, w, (x ^ h ^ Math.imul(w, 31)) >>> 0];
  }
  if (!(x | y | z | w)) w = 1;
  return () => {
    const t = (x ^ (x << 11)) >>> 0;
    [x, y, z] = [y, z, w];
    w = (w ^ (w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return w / 4294967296;
  };
}

/** Fisher-Yates con il generatore dato. */
export function shuffle(list, rand) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export class DuelEngine {
  /**
   * @param lib   istanza di ocgcore-wasm creata con { sync: true }
   * @param opts  { getCard(code) -> carta parseCard | null, readScript(name) -> string | null, log(type, text) }
   */
  constructor(lib, opts) {
    this.lib = lib;
    this.opts = opts;
    this.handle = null;
    this.lp = [8000, 8000];
    this.turn = 0;
    this.turnPlayer = 0;
    this.phase = 0;
    this.lastPrompt = null;
    this.ended = false;
    this.winner = null;
  }

  start(cfg) {
    const { lib, opts } = this;
    const team = { startingLP: cfg.lp, startingDrawCount: cfg.hand, drawCountPerTurn: cfg.draw };
    this.lp = [cfg.lp, cfg.lp];
    this.handle = lib.createDuel({
      flags: BigInt(cfg.flags),
      seed: cfg.seed.map((s) => BigInt(s)),
      team1: team,
      team2: { ...team },
      cardReader: (code) => {
        const c = opts.getCard(code);
        return c ? toCoreCard(c) : null;
      },
      scriptReader: (name) => opts.readScript(name),
      errorHandler: (type, text) => opts.log?.(type, text),
    });
    if (!this.handle) throw new Error("Unable to create the duel");

    for (const name of ["constant.lua", "utility.lua"]) {
      const src = opts.readScript(name);
      if (src == null || !lib.loadScript(this.handle, name, src)) {
        throw new Error(`Unable to load ${name}`);
      }
    }

    // Il core non mescola i mazzi a inizio duello (in EDOPro lo fa chi lo ospita): li mescoliamo qui con un
    // generatore ricavato dal seed del duello, così entrambi i peer ottengono lo stesso ordine e online nessuno
    // dei due può sceglierlo (il seed nasce da un commit-reveal). L'ultima carta inserita è la prima pescata.
    // cfg.shuffle[p] === false: il giocatore p pesca nell'ordine del mazzo (prima carta = prima pescata).
    const rand = seededRandom(cfg.seed);
    cfg.decks.forEach((deck, p) => {
      const add = (code, location) =>
        lib.duelNewCard(this.handle, {
          team: p, duelist: 0, code, controller: p, location, sequence: 0, position: 0x8,
        });
      const main = cfg.shuffle?.[p] === false ? [...deck.main].reverse() : shuffle([...deck.main], rand);
      for (const code of main) add(code, LOC.DECK);
      for (const code of deck.extra) add(code, LOC.EXTRA);
    });
    lib.startDuel(this.handle);
  }

  /** Avanza finché il core non chiede una risposta o il duello finisce. */
  run() {
    const out = [];
    let prompt = null;
    for (let guard = 0; guard < 100000; guard++) {
      const status = this.lib.duelProcess(this.handle);
      const msgs = this.lib.duelGetMessage(this.handle);
      for (const m of msgs) {
        this.track(m);
        if (m.type === MSG.RETRY) {
          // Risposta non valida: il core ripete l'ultima richiesta.
          out.push(m);
          if (this.lastPrompt) prompt = this.lastPrompt;
          continue;
        }
        if (PROMPT_MSGS.has(m.type)) {
          prompt = m;
          this.lastPrompt = m;
        }
        out.push(m);
      }
      if (status === PROCESS.END) {
        this.ended = true;
        return { messages: out, prompt: null, ended: true };
      }
      if (status === PROCESS.WAITING) {
        if (this.ended) return { messages: out, prompt: null, ended: true };
        return { messages: out, prompt, ended: false };
      }
    }
    throw new Error("The core is not responding (infinite loop?)");
  }

  respond(response) {
    this.lib.duelSetResponse(this.handle, response);
  }

  track(m) {
    switch (m.type) {
      case MSG.NEW_TURN: this.turn++; this.turnPlayer = m.player; break;
      case MSG.NEW_PHASE: this.phase = m.phase; break;
      case MSG.DAMAGE: case MSG.PAY_LPCOST: this.lp[m.player] = Math.max(0, this.lp[m.player] - m.amount); break;
      case MSG.RECOVER: this.lp[m.player] += m.amount; break;
      case MSG.LPUPDATE: this.lp[m.player] = m.lp; break;
      case MSG.WIN: this.ended = true; this.winner = m.player; this.winReason = m.reason; break;
    }
  }

  queryLocation(player, location, flags) {
    return this.lib.duelQueryLocation(this.handle, { flags, controller: player, location });
  }

  /** Stato completo del campo (dal punto di vista del core, quindi con info nascoste). */
  snapshot() {
    const players = [0, 1].map((p) => ({
      lp: this.lp[p],
      deck: this.lib.duelQueryCount(this.handle, p, LOC.DECK),
      hand: this.queryLocation(p, LOC.HAND, FIELD_QUERY),
      mzone: this.queryLocation(p, LOC.MZONE, FIELD_QUERY),
      szone: this.queryLocation(p, LOC.SZONE, FIELD_QUERY),
      grave: this.queryLocation(p, LOC.GRAVE, PILE_QUERY),
      removed: this.queryLocation(p, LOC.REMOVED, PILE_QUERY),
      extra: this.queryLocation(p, LOC.EXTRA, PILE_QUERY),
    }));
    const field = this.lib.duelQueryField(this.handle);
    return {
      players,
      chain: field.chain,
      turn: this.turn,
      turnPlayer: this.turnPlayer,
      phase: this.phase,
      ended: this.ended,
      winner: this.winner,
    };
  }

  /** Impronta dello stato usata per rilevare desincronizzazioni tra i due peer. */
  checksum() {
    let h = 2166136261 >>> 0;
    const mix = (n) => {
      h ^= n & 0xffffffff;
      h = Math.imul(h, 16777619) >>> 0;
    };
    for (let p = 0; p < 2; p++) {
      mix(this.lp[p]);
      for (const loc of [LOC.DECK, LOC.HAND, LOC.MZONE, LOC.SZONE, LOC.GRAVE, LOC.REMOVED, LOC.EXTRA]) {
        for (const c of this.queryLocation(p, loc, QUERY.CODE | QUERY.POSITION)) {
          mix(c ? (c.code ?? 0) : 0);
          mix(c ? (c.position ?? 0) : 0);
        }
      }
    }
    return h;
  }

  destroy() {
    if (this.handle) this.lib.destroyDuel(this.handle);
    this.handle = null;
  }
}
