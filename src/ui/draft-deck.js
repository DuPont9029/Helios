// Mazzo del draft: si costruisce dal proprio pool (Main almeno 30, Extra al massimo 15, il resto è il sideboard,
// nessun limite di copie, nessuna banlist) e si gioca contro i bot del tavolo e, nel draft online, contro gli altri
// giocatori (torneo tutti contro tutti, vedi draft-tour.js: sfide, voti per togliere chi abbandona, bot tolti
// dall'host). Dalla prima partita il mazzo è bloccato: tra un duello e l'altro si scambiano carte con il sideboard
// una per una (Main ed Extra Deck restano della stessa dimensione).
import { h, clear, icon } from "./dom.js";
import { toast, confirmModal, alertModal, openModal } from "./modal.js";
import { loadDecks, saveDecks, emptyDeck, sortDeckPart } from "../deck/deck.js";
import { getRun, storeRun, draftDeckErrors, sideErrors, runRecord, botMatches, allMatches, matchesLeft, standings, DRAFT_DECK } from "../draft/runs.js";
import { playDraftMatch, playTournamentMatch } from "./play.js";
import { openTournament } from "./draft-tour.js";
import { backupRun } from "../net/tournament-store.js";
import { tourState, outSeats } from "../draft/tournament.js";
import { identity } from "../net/identity.js";
import { openPoolEditor, openDeckViewer } from "./editor.js";
import { poolCards } from "../draft/table.js";

const poolOf = (binder) => {
  const { main, extra } = poolCards(binder);
  return [...main, ...extra];
};

/** Deck builder sulla collezione del draft (mazzo libero finché non è bloccato). Salva nel run e risolve con true. */
export async function editDraftDeck(run) {
  const binder = run.seats[run.me].binder;
  const out = await openPoolEditor({
    title: "Your draft deck",
    subtitle: `Main ${DRAFT_DECK.minMain}+ · Extra max ${DRAFT_DECK.maxExtra} · the rest is your sideboard`,
    pool: poolOf(binder),
    deck: run.deck,
    validate: (d) => draftDeckErrors({ ...d, side: [] }, binder),
  });
  if (!out || out.surrendered) return false;
  run.deck = out;
  storeRun(run);
  if (run.online) backupRun(run).catch(() => {});
  return true;
}

/** Side tra i duelli nel deck builder: Main ed Extra Deck della stessa dimensione del mazzo bloccato. */
function draftSide(run, deck, game) {
  const editor = openPoolEditor({
    title: `Side deck · Game ${game}`,
    subtitle: "Swap one for one: Main and Extra keep their size",
    pool: poolOf(run.seats[run.me].binder),
    deck,
    lock: { main: run.deck.main.length, extra: run.deck.extra.length },
    game,
    validate: (d) => sideErrors(d, run.deck),
    help: "Click a card of the deck to move it to your sideboard, click a card of your collection to put it in the deck. The Main and Extra Deck must end with the same number of cards. Ctrl+Z undo.",
  });
  const out = editor.then((v) => v ?? { ...deck });
  out.close = editor.close; // l'avversario si arrende mentre si fa il side
  return out;
}

export function showDraftDeck(app, runId) {
  const root = clear(app.root);
  let run = getRun(runId);
  if (!run) return app.home();
  const binder = run.seats[run.me].binder;
  // Il torneo aggiorna i suoi record nel run salvato: prima di salvare li si riprende, per non cancellarli.
  const save = () => {
    const fresh = getRun(runId);
    if (fresh?.tourRecords) run.tourRecords = fresh.tourRecords;
    storeRun(run);
    // Draft online: pool, mazzo e partite anche nel backup privato sui relay (lo legge solo questo giocatore).
    if (run.online) backupRun(run).catch(() => {});
  };
  let pageEl = null;
  const isHost = !!run.online && run.online.hostPk === identity().pk;
  // Torneo online: chi è online, sfide, record sui relay (vedi draft-tour.js).
  const tour = run.online
    ? openTournament(run, {
        update: () => {
          run = getRun(runId) ?? run;
          if (pageEl?.isConnected) renderStatus();
        },
        alive: () => !!pageEl?.isConnected,
        challenged: (seat) => challenged(seat),
        play: (link, host, seat) => playOnline(link, host, seat),
      })
    : null;
  const statusEl = h("div.dd-status");
  const matchesEl = h("div.dd-matches");
  const tableEl = h("div.dd-table");
  // Le partite tra bot si decidono (testa o croce) la prima volta che si apre il run.
  if (!run.botMatches) {
    botMatches(run);
    save();
  }

  function renderStatus() {
    const errs = draftDeckErrors(run.deck, binder);
    clear(statusEl).append(
      run.locked
        ? h("span.draft-status.ok", icon("lock"), " Deck locked since your first match: side between Duels")
        : errs.length
          ? h("span.draft-status.warn", { title: errs.join("\n") }, icon("pending"), ` ${errs[0]}`)
          : h("span.draft-status.ok", icon("check_circle"), " Valid deck: it locks when you play your first match")
    );
    renderMatches();
  }

  // Si può giocare: mazzo valido (al primo match si blocca).
  const deckOk = () => !draftDeckErrors(run.deck, binder).length;
  const tourLine = h("p.muted.small.dd-tour-line");

  async function lockFirst(what) {
    if (run.locked) return true;
    if (!(await confirmModal("Lock your deck?", `${what}From your first match the deck stays the same: between Duels you can only swap cards with your sideboard one for one.`, "Lock and play", "Cancel"))) return false;
    run.locked = true;
    save();
    return true;
  }

  /** Sfida ricevuta: si accetta (bloccando il mazzo se serve) o si rifiuta; dopo 40 s vale il rifiuto. */
  async function challenged(seat) {
    const who = run.seats[seat].name;
    if (!deckOk()) {
      toast(`${who} challenged you, but your deck is not valid yet`, { kind: "error" });
      return false;
    }
    const m = openModal({
      title: "Challenge",
      body: [h("p", `${who} challenges you to your tournament match (best of ${run.bestOf}).`), run.locked ? null : h("p.muted.small", "Your deck locks when the match starts.")],
      actions: [{ label: "Decline", value: false }, { label: "Accept", value: true, primary: true }],
    });
    const timer = setTimeout(() => m.close(false), 40000);
    const ok = await m.result;
    clearTimeout(timer);
    if (!ok) return false;
    if (!run.locked) {
      run.locked = true;
      save();
    }
    return true;
  }

  /** Partita del torneo contro un giocatore (collegamento già aperto). Risolve a partita finita. */
  function playOnline(link, host, seat) {
    return new Promise((resolve) => {
      playTournamentMatch(app, {
        link,
        host,
        deck: run.deck,
        bestOf: run.bestOf,
        sideEditor: (deck, game) => draftSide(run, deck, game),
        onDone: (result) => {
          run = getRun(runId) ?? run;
          if (result) recordResult(seat, result);
          resolve();
          showDraftDeck(app, runId);
        },
      });
    });
  }

  function recordResult(opp, result) {
    if (run.results.some((r) => r.opp === opp)) return;
    run.results.push({ id: Math.random().toString(36).slice(2, 10), opp, wins: result.wins, won: result.won, at: Date.now(), replay: null });
    save();
    tour?.result(opp, result.wins).catch(() => toast("The result could not reach the relays: it will be sent again next time", { kind: "error" }));
    toast(result.won ? `Match won ${result.wins[0]}–${result.wins[1]}` : `Match lost ${result.wins[0]}–${result.wins[1]}`);
  }

  async function challenge(seat) {
    if (!(await lockFirst(`You challenge ${run.seats[seat].name}. `))) return;
    await tour.challenge(seat);
  }

  async function voteRemove(seat) {
    const who = run.seats[seat].name;
    const m = openModal({
      title: `Remove ${who}?`,
      body: [
        h("p", `If most of the players agree, ${who} leaves the tournament (a tie is decided by the host).`),
        h("p.muted.small", "Choose also whether the matches they already played still count for their opponents."),
      ],
      actions: [
        { label: "Cancel", value: null },
        { label: "Remove, cancel their matches", value: "drop" },
        { label: "Remove, their matches count", value: "keep", primary: true },
      ],
    });
    const v = await m.result;
    if (v) await tour.vote(seat, true, v === "keep");
  }

  async function removeBot(seat) {
    if (!(await confirmModal(`Remove ${run.seats[seat].name}?`, "The bot leaves the tournament as if it had never been there: all its matches disappear for everyone.", "Remove", "Cancel", { danger: true }))) return;
    await tour.removeBot(seat);
  }

  /** Pool di un altro giocatore (pool aperto, o un bot), nel deck builder in sola lettura. */
  function viewPool(seat) {
    const s = run.seats[seat];
    const { main, extra } = poolCards(s.binder);
    // Ordinato come nel deck editor: niente indizi sull'ordine in cui le carte sono state scelte.
    openDeckViewer({ main: sortDeckPart(main), extra: sortDeckPart(extra), side: [], title: `${s.name}'s pool`, subtitle: `${s.binder.length} picks · their deck stays secret` });
  }

  /** Voti in corso: uno per giocatore proposto per l'uscita. */
  function votesView(st) {
    const open = [...st.votes].filter(([, v]) => !v.decision);
    if (!open.length) return null;
    return h(
      "div.dd-votes",
      open.map(([target, v]) => {
        const mine = v.voted.get(run.me);
        const who = run.seats[target].name;
        const canVote = target !== run.me && v.eligible.includes(run.me);
        return h(
          "div.dd-vote",
          icon("how_to_vote"),
          h("div", h("b", `Remove ${who} from the tournament?`), h("span.muted.small", ` ${v.yes} yes · ${v.no} no · ${v.eligible.length} can vote${mine ? ` · you voted ${mine.remove ? (mine.keep ? "remove (matches count)" : "remove (cancel matches)") : "keep"}` : ""}`)),
          canVote ? h("button.btn.small", { onclick: () => tour.vote(target, false, true) }, "Keep") : null,
          canVote ? h("button.btn.small", { onclick: () => tour.vote(target, true, false) }, "Remove, cancel matches") : null,
          canVote ? h("button.btn.small.primary", { onclick: () => tour.vote(target, true, true) }, "Remove, matches count") : null
        );
      })
    );
  }

  function renderMatches() {
    const valid = deckOk();
    const rec = runRecord(run);
    const st = run.online ? tourState(run) : null;
    const out = run.online ? outSeats(run, st) : new Set();
    const played = (i) => allMatches(run).find((m) => (m.a === run.me && m.b === i) || (m.b === run.me && m.a === i));
    const openPool = run.online?.pool !== "closed";
    if (tour) {
      const online = [...tour.presence.keys()].filter((i) => !out.has(i)).length;
      tourLine.textContent = tour.status || (tour.synced ? `Tournament synced · ${online} other player${online === 1 ? "" : "s"} online · challenge anyone you have not played yet` : "Syncing the tournament from the relays…");
    }
    clear(matchesEl).append(
      h("div.dd-part-head", h("b", run.online ? "Matches" : "Matches vs the bots"), h("span.muted.small", `Best of ${run.bestOf} · ${rec.won} won · ${rec.lost} lost`)),
      h(
        "div.dd-opponents",
        run.seats.map((s, i) => {
          if (i === run.me || s.gone || st?.bots.has(i)) return null;
          const poolBtn = run.online && (openPool || s.bot) && s.binder?.length ? h("button.btn.ghost.small", { title: "Look at their pool", onclick: () => viewPool(i) }, icon("inventory_2")) : null;
          if (st?.removed.has(i)) return h("div.dd-opp.out", h("b", s.name), h("span.muted.small", "Removed from the tournament"));
          // Giocatore del torneo online: si sfida quando è online e libero.
          if (!s.bot) {
            const m = played(i);
            if (m) {
              const mine = m.a === run.me ? m.wins : [m.wins[1], m.wins[0]];
              const won = mine[0] > mine[1];
              return h(`div.dd-opp${won ? ".won" : ".lost"}`, h("div.dd-opp-top", h("b", s.name), poolBtn), h("span.dd-opp-result", won ? "Won" : "Lost", h("b", ` ${mine[0]}–${mine[1]}`)));
            }
            const p = tour?.presence.get(i);
            const state = !p ? "offline" : p.busy ? "busy" : "online";
            const can = state === "online" && valid && !tour.busy && !out.has(run.me);
            return h(
              `div.dd-opp.human.${state}`,
              h("div.dd-opp-top", h("b", s.name), poolBtn),
              h("span.dd-presence", h("i"), state === "online" ? "Online" : state === "busy" ? "In a match" : "Offline"),
              h("div.dd-opp-actions",
                h("button.btn.small", { disabled: !can, title: !valid ? "Build a valid deck first" : state !== "online" ? "They must be online and free" : "", onclick: () => challenge(i) }, icon("swords"), " Challenge"),
                state === "offline" && !st?.votes.has(i) ? h("button.btn.ghost.small", { title: "Propose to remove them from the tournament", onclick: () => voteRemove(i) }, icon("person_remove")) : null
              )
            );
          }
          // Tutti contro tutti: una partita per avversario.
          const r = run.results.find((x) => x.opp === i);
          return h(
            `div.dd-opp${r ? (r.won ? ".won" : ".lost") : ""}`,
            h("div.dd-opp-top", h("b", s.name), poolBtn, isHost ? h("button.btn.ghost.small", { title: "Remove this bot from the tournament", onclick: () => removeBot(i) }, icon("person_remove")) : null),
            r
              ? h("span.dd-opp-result", r.won ? "Won" : "Lost", h("b", ` ${r.wins[0]}–${r.wins[1]}`))
              : [
                  h("span.muted.small", "Not played"),
                  h("button.btn.small", { disabled: !valid, title: valid ? "" : "Build a valid deck first", onclick: () => play(i) }, icon("swords"), " Play"),
                ]
          );
        })
      ),
      ...(st ? [votesView(st)].filter(Boolean) : [])
    );
    renderTable();
  }

  const pct = (x) => `${Math.round(x * 100)}%`;
  function renderTable() {
    const rows = standings(run);
    const left = matchesLeft(run);
    const matches = allMatches(run).sort((x, y) => (x.coin === y.coin ? y.at - x.at : x.coin ? 1 : -1));
    const name = (i) => run.seats[i]?.name ?? "?";
    const winner = left
      ? null
      : h("div.dd-winner", icon("emoji_events"), h("span", h("b", rows[0].name), rows[0].seat === run.me ? " — you won the draft!" : " won the draft"));
    clear(tableEl).append(
      ...(winner ? [winner] : []),
      h(
        "div.dd-standings",
        h("div.dd-part-head", h("b", "Standings"), h("span.muted.small", left ? `${left} matches left · match win rate, then game win rate` : "All matches played")),
        h(
          "table.dd-rank",
          h("thead", h("tr", h("th", "#"), h("th", "Player"), h("th", "Matches"), h("th", "Match %"), h("th", "Games"), h("th", "Game %"))),
          h(
            "tbody",
            rows.map((r, i) =>
              h(
                `tr${r.seat === run.me ? ".me" : ""}`,
                h("td", `${i + 1}`),
                h("td", r.name),
                h("td", `${r.won}–${r.lost}`),
                h("td", r.played ? pct(r.mwr) : "—"),
                h("td", `${r.games[0]}–${r.games[1]}`),
                h("td", r.games[0] + r.games[1] ? pct(r.gwr) : "—")
              )
            )
          )
        )
      ),
      h(
        "div.dd-history",
        h("div.dd-part-head", h("b", "Matches"), h("span.muted.small", "Bot vs bot: coin flip")),
        h(
          "div.dd-history-list",
          matches.map((m) => {
            const aWon = m.wins[0] > m.wins[1];
            return h(
              `div.dd-match${m.a === run.me || m.b === run.me ? ".mine" : ""}`,
              h(`span.dd-side${aWon ? ".win" : ""}`, name(m.a)),
              h("b.dd-score", `${m.wins[0]}–${m.wins[1]}`),
              h(`span.dd-side${aWon ? "" : ".win"}`, name(m.b)),
              m.coin ? h("span.muted.small.dd-coin", { title: "Decided by a coin flip" }, icon("casino")) : h("span.dd-coin"),
              // Posto riservato al replay della partita (in arrivo).
              h("button.btn.ghost.small.dd-replay", { disabled: true, title: m.coin ? "No replay for coin flips" : "Replays: coming soon" }, icon("replay"))
            );
          })
        )
      )
    );
  }

  async function play(opp) {
    if (!run.locked) {
      if (!(await confirmModal("Lock your deck?", "From your first match the deck stays the same: between Duels you can only swap cards with your sideboard one for one.", "Lock and play", "Cancel"))) return;
      run.locked = true;
      save();
    }
    const s = run.seats[opp];
    playDraftMatch(app, {
      mine: run.deck,
      theirs: s.deck,
      theirName: s.name,
      bestOf: run.bestOf,
      sideEditor: (deck, game) => draftSide(run, deck, game),
      onDone: (result) => {
        run = getRun(runId) ?? run;
        if (result) recordResult(opp, result);
        showDraftDeck(app, runId);
      },
    });
  }

  function copyToDecks() {
    const errs = draftDeckErrors(run.deck, binder);
    if (errs.length) return alertModal("Invalid deck", errs.join("\n"));
    const d = { ...emptyDeck(), name: `Limited · ${run.format.name}`, main: [...run.deck.main], extra: [...run.deck.extra], side: [...run.deck.side].slice(0, 15) };
    saveDecks([...loadDecks(), d]);
    toast(`Saved in your decks as "${d.name}" (outside the draft the usual deck rules apply)`);
  }

  async function goBack() {
    const { showDraft } = await import("./draft-editor.js");
    showDraft(app);
  }

  // Il mazzo si guarda e si modifica solo nel deck builder: finché non è bloccato si modifica, poi si guarda.
  const openDeck = async () => {
    if (!run.locked) {
      if (await editDraftDeck(run)) showDraftDeck(app, runId);
    } else
      openDeckViewer({ ...run.deck, title: "Your draft deck", subtitle: "Locked since your first match: side between Duels" });
  };
  root.append(
    (pageEl = h(
      "div.page.draft-deck",
      h(
        "div.page-head",
        h("button.btn.ghost.round.page-back", { title: "Back (right-click)", onclick: goBack }, icon("chevron_left")),
        h("h1", "Your draft", h("small.page-sub", `${run.format.name} · ${new Date(run.created).toLocaleDateString()}`)),
        h("span.grow"),
        statusEl,
        h(
          "button.btn.primary",
          { title: `Main ${run.deck.main.length} · Extra ${run.deck.extra.length} · Side ${run.deck.side.length}`, onclick: openDeck },
          icon(run.locked ? "visibility" : "edit"),
          run.locked ? " View deck" : " Edit deck"
        ),
        h("button.btn", { title: "Copy to your decks (to use it elsewhere)", onclick: copyToDecks }, icon("content_copy"), " Copy to my decks")
      ),
      h("p.muted.small.dd-counts", `Main ${run.deck.main.length} · Extra ${run.deck.extra.length} · Sideboard ${run.deck.side.length}`),
      run.online ? tourLine : null,
      matchesEl,
      tableEl
    ))
  );
  renderStatus();
}
