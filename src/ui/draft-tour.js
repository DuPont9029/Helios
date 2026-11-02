// Torneo di un draft online, dal vivo: i record sui relay (risultati, voti, bot tolti; net/tournament-store.js) e una
// stanza Trystero del torneo per sapere chi è online e sfidarsi. La sfida accettata apre una stanza Nostr da due
// (come i duelli online, con il ripiego sui relay) e la partita si gioca con playTournamentMatch.
import { toast } from "./modal.js";
import { openDraftRoom } from "../net/draft-room.js";
import { connectViaNostr } from "../net/nostr-room.js";
import { resolveIceServers } from "../net/signaling.js";
import { settings } from "../data/settings.js";
import { identity } from "../net/identity.js";
import { tournamentKeys, publishRecord, fetchRecords, watchRecords, republish, latest } from "../net/tournament-store.js";
import { pairId } from "../draft/tournament.js";
import { storeRun } from "../draft/runs.js";

const HERE_MS = 15000;
const CHALLENGE_MS = 45000;
const rid = () => Math.random().toString(36).slice(2, 10);

let active = null; // un torneo aperto alla volta (quello della pagina del draft)

/**
 * Apre (o riprende) il torneo del run. hooks: { update(), challenged(seat) → Promise<bool>, play(link, host, seat) }
 * (play gioca la partita e risolve a partita finita). Restituisce il controller.
 */
export function openTournament(run, hooks) {
  if (active && active.runId === run.id && !active.closed) {
    active.hooks = hooks;
    active.run = run;
    return active;
  }
  active?.close();
  const t = {
    runId: run.id,
    run,
    hooks,
    closed: false,
    synced: false,
    busy: false,
    presence: new Map(), // posto → { peer, busy, at }
    peers: new Map(), // peer → posto
    waiting: new Map(), // id sfida → resolve
    status: "Connecting to the relays…",
  };
  active = t;
  const members = new Set(run.seats.filter((s) => s.pk).map((s) => s.pk));
  let keys = null;
  let net = null;
  let sub = null;
  let timer = 0;
  const update = () => !t.closed && t.hooks.update?.();
  const merge = (recs) => {
    t.run.tourRecords = latest([...(t.run.tourRecords ?? []), ...recs]);
    storeRun(t.run);
    update();
  };
  const me = () => t.run.me;
  const here = (to = null) => {
    const msg = { t: "here", seat: me(), pk: identity().pk, busy: t.busy };
    if (to) net?.send(to, msg);
    else net?.broadcast(msg);
  };

  t.close = () => {
    if (t.closed) return;
    t.closed = true;
    clearInterval(timer);
    sub?.close();
    net?.leave();
    if (active === t) active = null;
  };

  t.setBusy = (b) => {
    t.busy = b;
    here();
  };

  /** Pubblica un record (risultato, voto, bot tolto) e lo applica subito qui. */
  t.publish = async (rec) => {
    if (!keys) keys = await tournamentKeys(t.run);
    const ev = await publishRecord(keys, rec);
    merge([{ ...rec, at: Date.now(), pk: identity().pk, created: ev.created_at }]);
    net?.broadcast({ t: "rec" });
  };

  t.result = (opp, wins) => t.publish({ type: "result", id: pairId(me(), opp), a: me(), b: opp, wins });
  t.vote = (target, remove, keep) => t.publish({ type: "vote", id: String(target), target, remove, keep });
  t.removeBot = (seat) => t.publish({ type: "rmbot", id: String(seat), seat });

  /** Sfida il giocatore del posto `seat` (deve essere online). Risolve quando la partita è finita (o rifiutata). */
  t.challenge = async (seat) => {
    const p = t.presence.get(seat);
    if (!p || !net) return toast(`${t.run.seats[seat].name} is not online`, { kind: "error" });
    if (p.busy) return toast(`${t.run.seats[seat].name} is busy`, { kind: "error" });
    const id = rid();
    t.setBusy(true);
    t.status = `Waiting for ${t.run.seats[seat].name} to accept…`;
    update();
    net.send(p.peer, { t: "ch", id, seat: me() });
    const answer = await new Promise((resolve) => {
      t.waiting.set(id, resolve);
      setTimeout(() => resolve({ ok: false, why: "no answer" }), CHALLENGE_MS);
    });
    t.waiting.delete(id);
    if (!answer.ok) {
      t.setBusy(false);
      t.status = "";
      update();
      return toast(`${t.run.seats[seat].name} declined the challenge${answer.why ? ` (${answer.why})` : ""}`);
    }
    // Stanza da due per il duello: la crea chi sfida, l'altro entra con il codice.
    const iceServers = await resolveIceServers().catch(() => []);
    const c = connectViaNostr({ room: null, iceServers, forceRelay: settings.forceRelay, onStatus: (s) => ((t.status = s), update()) });
    const code = await c.room;
    net.send(p.peer, { t: "ch-go", id, code });
    await duel(c, true, seat);
  };

  const duel = async (c, host, seat) => {
    let link;
    try {
      ({ link } = await Promise.race([c.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("The connection did not open")), 60000))]));
    } catch (e) {
      c.cancel();
      t.setBusy(false);
      t.status = "";
      update();
      return toast(`Match not started: ${e.message}`, { kind: "error" });
    }
    t.status = "";
    await t.hooks.play(link, host, seat);
    t.setBusy(false);
  };

  const onMessage = async (msg, from) => {
    if (!msg || t.closed) return;
    const seat = t.peers.get(from);
    switch (msg.t) {
      case "here": {
        const s = t.run.seats[msg.seat];
        if (!s || s.bot || s.pk !== msg.pk || msg.seat === me()) return;
        const fresh = !t.presence.has(msg.seat);
        t.peers.set(from, msg.seat);
        t.presence.set(msg.seat, { peer: from, busy: !!msg.busy, at: Date.now() });
        if (fresh) here(from);
        update();
        break;
      }
      case "rec":
        // Qualcuno ha appena pubblicato: si rilegge dai relay (arriva anche dall'iscrizione, questo è più veloce).
        if (keys) fetchRecords(keys, members).then(merge);
        break;
      case "ch": {
        if (seat == null) return;
        if (t.busy) return net.send(from, { t: "ch-no", id: msg.id, why: "busy" });
        t.setBusy(true);
        const ok = await t.hooks.challenged(seat);
        net.send(from, ok ? { t: "ch-ok", id: msg.id } : { t: "ch-no", id: msg.id, why: "" });
        if (!ok) t.setBusy(false);
        else {
          t.status = "Waiting for the Duel room…";
          update();
          t.pendingGo = { id: msg.id, seat, at: Date.now() };
          setTimeout(() => {
            if (t.pendingGo?.id === msg.id) {
              t.pendingGo = null;
              t.setBusy(false);
              t.status = "";
              update();
            }
          }, 30000);
        }
        break;
      }
      case "ch-ok":
        t.waiting.get(msg.id)?.({ ok: true });
        break;
      case "ch-no":
        t.waiting.get(msg.id)?.({ ok: false, why: msg.why });
        break;
      case "ch-go": {
        if (t.pendingGo?.id !== msg.id) return;
        const s = t.pendingGo.seat;
        t.pendingGo = null;
        const iceServers = await resolveIceServers().catch(() => []);
        const c = connectViaNostr({ room: msg.code, iceServers, forceRelay: settings.forceRelay, onStatus: (st) => ((t.status = st), update()) });
        await duel(c, false, s);
        break;
      }
    }
  };

  (async () => {
    keys = await tournamentKeys(run);
    republish(keys).catch(() => {});
    fetchRecords(keys, members).then((recs) => {
      t.synced = true;
      t.status = "";
      merge(recs);
    });
    sub = watchRecords(keys, members, (rec) => merge([rec]));
    const iceServers = await resolveIceServers().catch(() => []);
    if (t.closed) return;
    net = await openDraftRoom({ code: keys.room, iceServers, forceRelay: settings.forceRelay });
    if (t.closed) return net.leave();
    net.on(onMessage);
    net.onJoin((peer) => here(peer));
    net.onLeave((peer) => {
      const seat = t.peers.get(peer);
      t.peers.delete(peer);
      if (seat != null && t.presence.get(seat)?.peer === peer) t.presence.delete(seat);
      update();
    });
    here();
    timer = setInterval(() => {
      // La pagina del draft non c'è più (e non si sta giocando): il torneo si chiude.
      if (!t.busy && !t.hooks.alive?.()) return t.close();
      here();
      for (const [seat, p] of t.presence) if (Date.now() - p.at > HERE_MS * 3) t.presence.delete(seat);
    }, HERE_MS);
  })().catch((e) => {
    t.status = `Tournament offline: ${e.message}`;
    update();
  });
  return t;
}
