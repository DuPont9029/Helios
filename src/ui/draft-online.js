// Draft online: la stanza (codice da condividere), chi entra, i bot dell'host, l'avvio e il rientro di chi è caduto.
// Il draft vero e proprio è NetDraft (draft/net-draft.js) sul tavolo di sempre (draft-table.js). Finito il draft
// ognuno salva il suo run e costruisce il mazzo; le partite tra giocatori arrivano con il torneo.
import { h, clear, icon } from "./dom.js";
import { toast, alertModal, confirmModal, promptModal } from "./modal.js";
import { settings } from "../data/settings.js";
import { openDraftRoom } from "../net/draft-room.js";
import { resolveIceServers } from "../net/signaling.js";
import { copyText } from "../net/clipboard.js";
import { NetDraft, sha256 } from "../draft/net-draft.js";
import { botDeck } from "../draft/table.js";
import { storeRun, emptyDraftDeck } from "../draft/runs.js";
import { newId } from "../draft/format.js";
import { identity } from "../net/identity.js";
import { backupRun } from "../net/tournament-store.js";
import { showDraftTable, BOT_NAMES } from "./draft-table.js";
import { version } from "../../package.json";

const LIVE_KEY = "ygoweb.draftLive";
const LIVE_HOURS = 12;
// Fine del draft: quanto si aspettano i pool degli altri (bot sempre; giocatori se il pool è aperto).
const POOLS_WAIT_MS = 8000;
const REJOIN_WAIT_MS = 30000;

/** Draft online in corso su questo computer (per rientrare): { code, seat, token, start, saved }. */
export function liveDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(LIVE_KEY) || "null");
    return d && Date.now() - d.saved < LIVE_HOURS * 3600e3 ? d : null;
  } catch {
    return null;
  }
}

export function forgetLiveDraft() {
  localStorage.removeItem(LIVE_KEY);
}

function saveLive(d) {
  try {
    localStorage.setItem(LIVE_KEY, JSON.stringify({ ...d, saved: Date.now() }));
  } catch {
    /* pieno: senza rientro */
  }
}

const token = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const backToLimited = async (app) => (await import("./draft-editor.js")).showDraft(app);

async function room(code = null) {
  const iceServers = await resolveIceServers().catch(() => []);
  return openDraftRoom({ code, iceServers, forceRelay: settings.forceRelay });
}

// ---------------------------------------------------------------- stanza (lobby)

/**
 * Pagina della stanza: codice, giocatori, bot e impostazioni. host: può cambiare i bot e avviare.
 * Restituisce { render(state), status(text) }.
 */
function lobbyPage(app, { code, host, onStart, onBots, onLeave }) {
  const root = clear(app.root);
  const players = h("div.ol-players");
  const info = h("div.ol-info");
  const statusEl = h("p.muted.small.ol-status");
  const startBtn = host && h("button.btn.primary", { onclick: onStart }, icon("play_arrow"), " Start the draft");
  const copy = () => copyText(code).then(() => toast("Room code copied"));
  root.append(
    h(
      "div.page.draft-online",
      h(
        "div.page-head",
        h("button.btn.ghost.round.page-back", { title: "Leave the room", onclick: onLeave }, icon("chevron_left")),
        h("h1", host ? "Your draft room" : "Draft room", h("small.page-sub", "Limited · online draft")),
        h("span.grow"),
        startBtn
      ),
      h(
        "div.ol-code",
        h("span.muted.small", "Room code"),
        h("b", code),
        h("button.btn", { onclick: copy }, icon("content_copy"), " Copy"),
        h("span.muted.small", host ? "Your friends join from Online Duel → Limited → Join a draft." : "Waiting for the host to start the draft.")
      ),
      h("div.ol-body", h("section.ol-panel", h("h2", "Players"), players), h("section.ol-panel", h("h2", "Draft"), info)),
      statusEl
    )
  );
  return {
    render({ list, bots, cfg }) {
      clear(players).append(
        ...list.map((p) => h(`div.ol-player${p.me ? ".me" : ""}`, icon(p.host ? "star" : "person"), h("span", p.name), p.host ? h("span.muted.small", "host") : null, p.me ? h("span.muted.small", "you") : null)),
        ...Array.from({ length: bots }, (_, i) => h("div.ol-player.bot", icon("smart_toy"), h("span", `Bot ${i + 1}`))),
        host
          ? h(
              "div.ol-bots",
              h("span.muted.small", "Bots"),
              h("button.btn.small", { disabled: bots <= 0, onclick: () => onBots(-1) }, icon("remove")),
              h("b", `${bots}`),
              h("button.btn.small", { disabled: list.length + bots >= 12, onclick: () => onBots(1) }, icon("add"))
            )
          : null
      );
      if (cfg)
        clear(info).append(
          h("div.ol-row", h("span.muted", "Format"), h("b", cfg.name)),
          h("div.ol-row", h("span.muted", "Round 1"), h("span", `${cfg.timers[0].start}s → ${cfg.timers[0].end}s per pick`)),
          h("div.ol-row", h("span.muted", "Round 2"), h("span", `${cfg.timers[1].start}s → ${cfg.timers[1].end}s per pick`)),
          h("div.ol-row", h("span.muted", "Matches"), h("span", `Best of ${cfg.bestOf}`)),
          h("div.ol-row", h("span.muted", "Pools"), h("span", cfg.pool === "closed" ? "Closed: what everyone drafted stays secret" : "Open: everyone sees every pool after the draft"))
        );
      if (startBtn) {
        const seats = list.length + bots;
        startBtn.disabled = list.length < 2 || seats > 12;
        startBtn.title = list.length < 2 ? "At least one more player must join" : "";
      }
    },
    status(text) {
      statusEl.textContent = text || "";
    },
  };
}

/** L'host apre la stanza: chi entra manda "hello", l'host risponde con lo stato della stanza. */
export async function hostDraft(app, { format, timers, bestOf, bots, pool }) {
  let net;
  try {
    net = await room();
  } catch (e) {
    return alertModal("Room not available", String(e?.message ?? e));
  }
  const players = new Map([[net.selfId, settings.name || "Host"]]);
  // Chiave Nostr di ogni giocatore: nel torneo (anche nei giorni dopo) è quella che dice chi è chi.
  const keys = new Map([[net.selfId, identity().pk]]);
  let started = false;
  const cfg = { name: format.name, timers, bestOf, pool };
  const lobbyState = () => ({
    list: [...players].map(([peer, name]) => ({ peer, name, host: peer === net.selfId, me: peer === net.selfId })),
    bots,
    cfg,
  });
  const broadcastLobby = () => net.broadcast({ t: "lobby", players: [...players].map(([peer, name]) => ({ peer, name })), host: net.selfId, bots, cfg });
  const refresh = () => {
    page.render(lobbyState());
    broadcastLobby();
  };
  const offs = [
    net.on((msg, from) => {
      if (started || !msg) return;
      if (msg.t === "hello") {
        if (msg.v !== version) return net.send(from, { t: "refused", why: `Different Helios version (yours ${msg.v}, the host's ${version}): update and reload the page.` });
        players.set(from, String(msg.name || "Player").slice(0, 24));
        if (/^[0-9a-f]{64}$/.test(msg.pk ?? "")) keys.set(from, msg.pk);
        toast(`${players.get(from)} joined`);
        refresh();
      }
    }),
    net.onLeave((peer) => {
      if (started || !players.has(peer)) return;
      toast(`${players.get(peer)} left`);
      players.delete(peer);
      keys.delete(peer);
      refresh();
    }),
  ];
  const leave = async () => {
    if (players.size > 1 && !(await confirmModal("Close the room?", "The players in the room are sent back.", "Close", "Stay"))) return;
    net.broadcast({ t: "closed" });
    offs.forEach((f) => f());
    net.leave();
    backToLimited(app);
  };
  const page = lobbyPage(app, {
    code: net.code,
    host: true,
    onLeave: leave,
    onBots: (d) => {
      bots = Math.max(0, Math.min(12 - players.size, bots + d));
      settings.lastOnlineBots = bots;
      refresh();
    },
    onStart: async () => {
      if (started) return;
      started = true;
      offs.forEach((f) => f());
      // Posti in ordine casuale; i bot girano sul computer dell'host.
      const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
      const humans = [...players].map(([peer, name]) => ({ name, bot: false, peer, pk: keys.get(peer) ?? null }));
      const botSeats = Array.from({ length: bots }, (_, i) => ({ name: `${names[i % names.length]} (bot)`, bot: true, peer: net.selfId }));
      const seats = [...humans, ...botSeats].sort(() => Math.random() - 0.5);
      const tokens = seats.map((s) => (s.bot ? null : token()));
      const hashes = await Promise.all(tokens.map((t) => (t ? sha256(t) : null)));
      const start = { t: "start", code: net.code, host: net.selfId, hostPk: identity().pk, format, seats, hashes, timers, bestOf, pool, seed: (Math.random() * 2 ** 32) >>> 0 };
      net.broadcast(start);
      seats.forEach((s, i) => s.peer !== net.selfId && !s.bot && net.send(s.peer, { t: "token", seat: i, token: tokens[i] }));
      const me = seats.findIndex((s) => s.peer === net.selfId && !s.bot);
      runDraft(app, net, start, me, tokens[me]);
    },
  });
  page.render(lobbyState());
  page.status("Room open on the Nostr relays: share the code. Players connect directly to each other (P2P).");
}

/** Entrare in una stanza con il codice. */
export async function joinDraft(app) {
  const code = (await promptModal("Join a draft", "Room code"))?.trim().toUpperCase();
  if (!code) return;
  let net;
  try {
    net = await room(code);
  } catch (e) {
    return alertModal("Room not available", String(e?.message ?? e));
  }
  // Tutto quello che arriva prima che il draft parta (anche i primi pacchetti di chi è partito prima) si tiene da
  // parte e si passa al draft.
  const early = [];
  let myToken = null;
  let hostPeer = null;
  let done = false;
  const offs = [];
  const leave = () => {
    done = true;
    offs.forEach((f) => f());
    net.leave();
    backToLimited(app);
  };
  const page = lobbyPage(app, { code, host: false, onLeave: leave });
  page.render({ list: [{ name: settings.name || "Player", me: true }], bots: 0, cfg: null });
  page.status(`Looking for room ${code} on the Nostr relays…`);
  const slow = setTimeout(() => !hostPeer && page.status(`Still looking for room ${code}: check the code, and that the host still has the room open.`), 20000);
  const hello = (peer) => net.send(peer, { t: "hello", name: settings.name || "Player", v: version, pk: identity().pk });
  offs.push(net.onJoin(hello));
  for (const p of net.peers()) hello(p);
  offs.push(
    net.on((msg, from) => {
      if (done || !msg) return;
      early.push([msg, from]);
      if (msg.t === "lobby") {
        hostPeer = msg.host;
        clearTimeout(slow);
        page.status("");
        page.render({
          list: msg.players.map((p) => ({ name: p.name, host: p.peer === msg.host, me: p.peer === net.selfId })),
          bots: msg.bots,
          cfg: msg.cfg,
        });
      } else if (msg.t === "refused") {
        done = true;
        offs.forEach((f) => f());
        net.leave();
        alertModal("Cannot join", msg.why).then(() => backToLimited(app));
      } else if (msg.t === "closed" && from === hostPeer) {
        done = true;
        offs.forEach((f) => f());
        net.leave();
        alertModal("Room closed", "The host closed the room.").then(() => backToLimited(app));
      } else if (msg.t === "token") myToken = msg.token;
      else if (msg.t === "start" && from === msg.host) {
        // Il gettone arriva subito dopo l'avvio: lo si aspetta un attimo.
        const me = msg.seats.findIndex((s) => s.peer === net.selfId);
        if (me < 0) return;
        const go = () => {
          done = true;
          offs.forEach((f) => f());
          runDraft(app, net, msg, me, myToken, early);
        };
        if (myToken) go();
        else {
          const t0 = Date.now();
          const wait = setInterval(() => {
            if (myToken || Date.now() - t0 > 3000) {
              clearInterval(wait);
              go();
            }
          }, 50);
        }
      }
    })
  );
  offs.push(net.onLeave((peer) => peer === hostPeer && !done && page.status("The host left the room.")));
}

// ---------------------------------------------------------------- draft

/** Il draft parte (o riparte, per chi rientra): tavolo, cadute, fine e salvataggio del run. */
function runDraft(app, net, start, me, myToken, early = [], restored = null) {
  const draft = restored ?? new NetDraft(net, start, { me });
  if (!restored) for (const [msg, from] of early) draft.onMessage(msg, from);
  if (me != null && myToken) saveLive({ code: start.code, seat: me, token: myToken, start: stripStart(start) });
  const offLeave = net.onLeave((peer) => draft.peerLeft(peer));
  // Chi rientra chiede il suo posto anche a chi entra dopo (es. il custode collegato in ritardo).
  const offJoin = net.onJoin(() => draft.publish());
  const pools = new Map(); // posto → binder condiviso alla fine
  const offPools = net.on((msg, from) => {
    if (msg?.t === "pool" && draft.seats[msg.seat]?.peer === from) pools.set(msg.seat, msg.binder);
  });
  const cleanup = () => {
    offLeave();
    offJoin();
    offPools();
    draft.close();
  };
  if (!restored) draft.start();
  showDraftTable(app, draft, {
    me: draft.me,
    bestOf: start.bestOf,
    online: {
      onLeave: () => {
        cleanup();
        net.leave();
        backToLimited(app);
      },
      onAbort: () => {
        forgetLiveDraft();
        cleanup();
        net.leave();
        backToLimited(app);
      },
      onDone: async () => {
        // Fine: si condividono i pool dei bot (servono per giocarci contro) e, con il pool aperto, quelli dei
        // giocatori (non dei fantasmi: chi non è tornato è fuori). Poi si aspettano quelli degli altri.
        for (const s of draft.seats) {
          if (!draft.hosted(s.index) || s.ghost) continue;
          if (s.bot || (start.pool !== "closed" && s.index !== draft.me)) net.broadcast({ t: "pool", seat: s.index, binder: s.binder });
        }
        if (start.pool !== "closed") net.broadcast({ t: "pool", seat: draft.me, binder: draft.seats[draft.me].binder });
        const expected = draft.seats.filter((s) => !s.ghost && s.index !== draft.me && (s.bot || start.pool !== "closed") && !draft.hosted(s.index));
        toast("Draft complete: collecting the pools…");
        const t0 = Date.now();
        while (expected.some((s) => !pools.has(s.index)) && Date.now() - t0 < POOLS_WAIT_MS) await new Promise((r) => setTimeout(r, 200));
        const run = buildRun(draft, start, pools);
        storeRun(run);
        backupRun(run).catch(() => {});
        forgetLiveDraft();
        cleanup();
        // La stanza resta aperta ancora un po' per chi aspetta ancora i pool.
        setTimeout(() => net.leave(), 20000);
        const { showDraftDeck, editDraftDeck } = await import("./draft-deck.js");
        await editDraftDeck(run);
        showDraftDeck(app, run.id);
      },
    },
  });
  return draft;
}

/** Il messaggio di avvio senza il gettone degli altri (per rientrare serve solo il proprio). */
const stripStart = (s) => ({ code: s.code, host: s.host, hostPk: s.hostPk, format: s.format, seats: s.seats, hashes: s.hashes, timers: s.timers, bestOf: s.bestOf, pool: s.pool, seed: s.seed });

/** Run del draft online: il mio pool, quelli condivisi (bot sempre, giocatori con il pool aperto). */
function buildRun(draft, start, pools) {
  const f = start.format;
  const binderOf = (s) => (draft.hosted(s.index) && (s.index === draft.me || s.bot) ? s.binder : pools.get(s.index) ?? []);
  const strip = (x) => ({ uid: x.uid, id: x.id, round: x.round, label: x.label, rarity: x.rarity, main: x.main, extra: x.extra, pickNo: x.pickNo });
  const mine = draft.seats[draft.me].binder.map(strip);
  return {
    id: newId(),
    created: Date.now(),
    format: { id: f.id, name: f.name, mode: f.mode, rarities: f.rarities },
    bestOf: start.bestOf,
    me: draft.me,
    seed: start.seed,
    online: { code: start.code, pool: start.pool, host: start.host, hostPk: start.hostPk ?? null },
    seats: draft.seats.map((s) => {
      const binder = binderOf(s).map(strip);
      return { name: s.name, bot: s.bot, pk: start.seats[s.index]?.pk ?? null, gone: s.ghost, binder, deck: s.bot && binder.length ? botDeck(binder) : null };
    }),
    deck: emptyDraftDeck(mine),
    locked: false,
    results: [],
    botMatches: null,
  };
}

// ---------------------------------------------------------------- rientro

/** Rientrare nel draft in corso dopo essere caduti (o aver chiuso la pagina): si chiede il posto con il gettone. */
export async function rejoinDraft(app) {
  const live = liveDraft();
  if (!live) return;
  let net;
  try {
    net = await room(live.code);
  } catch (e) {
    return alertModal("Room not available", String(e?.message ?? e));
  }
  const draft = new NetDraft(net, live.start, { me: null });
  const ask = (peer) => draft.askSeat(live.seat, live.token, peer);
  const offJoin = net.onJoin(ask);
  for (const p of net.peers()) ask(p);
  const root = clear(app.root);
  root.append(h("div.page.draft-online", h("div.dt-wait", icon("hourglass_top"), h("b", "Rejoining the draft…"), h("span.muted.small", `Room ${live.code}: asking the other players for your seat`))));
  const ok = await new Promise((resolve) => {
    const off = draft.onChange((e) => e.type === "restored" && (off(), resolve(true)));
    setTimeout(() => resolve(false), REJOIN_WAIT_MS);
  });
  offJoin();
  if (!ok) {
    draft.close();
    net.leave();
    const forget = await confirmModal("Could not rejoin", "Nobody answered with your seat: the draft may be over or cancelled. Forget this draft?", "Forget it", "Keep it");
    if (forget) forgetLiveDraft();
    return backToLimited(app);
  }
  toast("You are back at the table");
  runDraft(app, net, live.start, draft.me, live.token, [], draft);
}
