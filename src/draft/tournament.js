// Torneo di un draft online (tutti contro tutti, nell'ordine che si vuole, anche su più giorni): dai record pubblicati
// dai giocatori (net/tournament-store.js) si ricavano le partite giocate, chi è stato tolto con un voto e i bot tolti
// dall'host. Funzioni pure: stessi record = stesso stato per tutti.
//
// Record (firmati dall'autore, vedi pk):
//   result { id: "a-b", a: posto di chi lo pubblica, b: avversario, wins: [di a, di b] }
//   vote   { id: posto votato, target, remove: bool, keep: bool }   keep = le partite già giocate valgono
//   rmbot  { id: posto, seat }                                      solo l'host
// Voti (decisioni del 2026-11-01): decide la maggioranza di chi può votare (i giocatori rimasti, tranne quello
// votato); in caso di pareggio, a voti finiti, decide l'host. Un bot tolto è come se non ci fosse mai stato.

/** Posto del giocatore con quella chiave (-1 se non è del torneo). */
const seatOf = (run, pk) => run.seats.findIndex((s) => !s.bot && s.pk && s.pk === pk);
export const pairId = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const hostPk = (run) => run.online?.hostPk ?? null;

/** Stato del torneo: { results: partite dai record, removed: Map posto → { keep }, bots: Set dei bot tolti, votes }. */
export function tourState(run) {
  const recs = run.tourRecords ?? [];
  const n = run.seats.length;
  const okSeat = (i) => Number.isInteger(i) && i >= 0 && i < n;

  // Bot tolti dall'host.
  const bots = new Set(recs.filter((r) => r.type === "rmbot" && r.pk === hostPk(run) && okSeat(r.seat) && run.seats[r.seat].bot).map((r) => r.seat));

  // Risultati: il primo pubblicato per ogni coppia (i due giocatori pubblicano lo stesso risultato).
  const results = new Map();
  for (const r of [...recs].filter((r) => r.type === "result").sort((x, y) => (x.at ?? 0) - (y.at ?? 0))) {
    if (!okSeat(r.a) || !okSeat(r.b) || r.a === r.b || seatOf(run, r.pk) !== r.a) continue;
    if (!Array.isArray(r.wins) || r.wins.length !== 2 || !r.wins.every((w) => Number.isInteger(w) && w >= 0 && w < 10) || r.wins[0] === r.wins[1]) continue;
    const id = pairId(r.a, r.b);
    if (!results.has(id)) results.set(id, { id, a: r.a, b: r.b, wins: r.wins, coin: false, at: r.at ?? 0, replay: null, by: r.a });
  }

  // Voti: l'ultimo di ogni giocatore per ogni votato.
  const votes = new Map();
  const removed = new Map();
  // Chi è già stato tolto non vota più (due passate: prima senza saperlo, poi senza i tolti).
  let outVoters = new Set();
  const voters = (target) => run.seats.map((s, i) => i).filter((i) => i !== target && !run.seats[i].bot && !run.seats[i].gone && !outVoters.has(i));
  for (const r of recs.filter((r) => r.type === "vote" && okSeat(r.target) && !run.seats[r.target].bot)) {
    const from = seatOf(run, r.pk);
    if (from < 0 || from === r.target || run.seats[from].gone) continue;
    if (!votes.has(r.target)) votes.set(r.target, new Map());
    votes.get(r.target).set(from, { remove: r.remove === true, keep: r.keep !== false });
  }
  const hostSeat = seatOf(run, hostPk(run));
  let tally = new Map();
  for (let pass = 0; pass < 2; pass++) {
    if (pass) outVoters = new Set(removed.keys());
    removed.clear();
    tally = new Map();
    for (const [target, byVoter] of votes) {
      const eligible = voters(target);
      const list = eligible.map((i) => byVoter.get(i)).filter(Boolean);
      const yes = list.filter((v) => v.remove).length;
      const no = list.length - yes;
      const half = eligible.length / 2;
      const host = byVoter.get(hostSeat);
      let decision = null; // "remove" | "stay" | null (in corso)
      if (yes > half) decision = "remove";
      else if (no > half) decision = "stay";
      else if (list.length === eligible.length && eligible.length) decision = host ? (host.remove ? "remove" : "stay") : null;
      // Le partite già giocate: maggioranza tra chi vota di toglierlo; pareggio = l'host (se no, valgono).
      const removers = list.filter((v) => v.remove);
      const keepYes = removers.filter((v) => v.keep).length;
      const keep = keepYes * 2 > removers.length ? true : keepYes * 2 < removers.length ? false : host?.remove ? host.keep : true;
      tally.set(target, { eligible, voted: byVoter, yes, no, decision, keep });
      if (decision === "remove") removed.set(target, { keep });
    }
  }
  return { results: [...results.values()], removed, bots, votes: tally };
}

/** Posti fuori dal torneo: chi ha lasciato il draft, chi è stato tolto con un voto, i bot tolti dall'host. */
export function outSeats(run, st = tourState(run)) {
  const out = new Set(run.seats.map((s, i) => (s.gone ? i : -1)).filter((i) => i >= 0));
  for (const i of st.removed.keys()) out.add(i);
  for (const i of st.bots) out.add(i);
  return out;
}
