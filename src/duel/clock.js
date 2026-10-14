// Timer del duello con la logica di YGO Omega ("G/180;inc3"):
// - ogni giocatore ha 180 secondi di tempo "di riflessione";
// - il tempo scorre solo mentre il giocatore deve rispondere al motore
//   (si ferma durante animazioni, catene che si risolvono e turno altrui);
// - ogni azione fatta restituisce 3 secondi, fino a un massimo di 450 secondi
//   guadagnati (2,5 volte il tempo base) per evitare le "combo ostaggio";
// - se resta fermo sulla stessa scelta, il tempo scorre più veloce:
//   2x dopo 30 s (timer rosso), 3x dopo 45 s, 4x dopo 60 s;
// - a ogni nuovo turno il tempo di entrambi torna al valore base;
// - a 0 il giocatore perde il duello.
// Il modulo non dipende dal DOM: il tempo corrente gli viene passato (ms).

export const TIMER_PRESETS = {
  off: null,
  omega: { base: 180, inc: 3, maxBonus: 450, label: "Omega (180s, +3s per action)" },
};

// [secondi di inattività, velocità]
const ACCEL = [
  [60, 4],
  [45, 3],
  [30, 2],
];

/** Tempo consumato (ms) dopo `idle` ms di inattività continua, con l'accelerazione. */
export function consumed(idle) {
  let total = 0;
  let prevAt = 0;
  let speed = 1;
  for (const [at, s] of [...ACCEL].reverse()) {
    const ms = at * 1000;
    if (idle <= ms) break;
    total += (ms - prevAt) * speed;
    prevAt = ms;
    speed = s;
  }
  return total + (idle - prevAt) * speed;
}

/** Velocità con cui scorre il tempo dopo `idle` ms di inattività. */
export function speedAt(idle) {
  for (const [at, s] of ACCEL) if (idle >= at * 1000) return s;
  return 1;
}

export class DuelClock {
  /** @param preset { base, inc, maxBonus } in secondi */
  constructor(preset) {
    this.base = preset.base * 1000;
    this.inc = preset.inc * 1000;
    this.maxBonus = preset.maxBonus * 1000;
    this.left = [this.base, this.base];
    this.bonus = [0, 0];
    this.running = null; // { player, since }
  }

  /** Nuovo turno: entrambi i giocatori ripartono dal tempo base. */
  newTurn() {
    this.running = null;
    this.left = [this.base, this.base];
    this.bonus = [0, 0];
  }

  /** Il giocatore deve scegliere: il suo tempo inizia a scorrere. */
  start(player, now) {
    if (this.running?.player === player) return;
    this.pause(now);
    this.running = { player, since: now };
  }

  /** Ferma il tempo senza assegnare l'incremento (es. il duello finisce). */
  pause(now) {
    if (!this.running) return;
    const { player, since } = this.running;
    this.left[player] = Math.max(0, this.left[player] - consumed(now - since));
    this.running = null;
  }

  /** Il giocatore ha fatto un'azione: ferma il suo tempo e gli restituisce l'incremento. */
  act(player, now) {
    if (this.running?.player === player) this.pause(now);
    if (this.left[player] <= 0) return;
    const gain = Math.min(this.inc, this.maxBonus - this.bonus[player]);
    if (gain <= 0) return;
    this.bonus[player] += gain;
    this.left[player] += gain;
  }

  /** Imposta il tempo rimasto comunicato dall'avversario (è lui a misurare il proprio). */
  sync(player, left, bonus) {
    if (this.running?.player === player) this.running = null;
    this.left[player] = Math.max(0, left);
    if (bonus != null) this.bonus[player] = bonus;
  }

  /** Stato per l'interfaccia: { left (ms), speed, running } del giocatore. */
  view(player, now) {
    const r = this.running?.player === player ? this.running : null;
    const idle = r ? now - r.since : 0;
    return {
      left: Math.max(0, this.left[player] - (r ? consumed(idle) : 0)),
      speed: r ? speedAt(idle) : 1,
      running: !!r,
    };
  }

  /** Millisecondi reali che mancano allo scadere del tempo del giocatore che sta pensando. */
  msToTimeout(now) {
    if (!this.running) return Infinity;
    const { player, since } = this.running;
    // Ricerca binaria sul tempo d'inattività che esaurisce il tempo rimasto.
    let lo = now - since;
    let hi = lo + this.left[player] + 1;
    if (consumed(lo) >= this.left[player]) return 0;
    while (hi - lo > 5) {
      const mid = (lo + hi) / 2;
      if (consumed(mid) >= this.left[player]) hi = mid;
      else lo = mid;
    }
    return hi - (now - since);
  }
}

export function formatClock(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
