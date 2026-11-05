// Tavolo del draft (ispirato a draftmancer): il pacchetto sullo schermo con l'animazione di apertura secondo la
// rarità, timer, coda dei pacchetti in attesa, giro del tavolo e binder privato (Main / Extra, per bundle).
// Contro i bot (DraftTable) o online con altri giocatori (NetDraft, vedi draft-online.js); finito il draft si passa al
// mazzo (draft-deck.js).
import { h, clear, icon, scrollText } from "./dom.js";
import { openModal, toast, confirmModal } from "./modal.js";
import { cardFace, frameClass } from "./card.js";
import { getCard } from "../data/db.js";
import { artUrl } from "../data/settings.js";
import { createDetailPanel } from "./detail.js";
import { settings } from "../data/settings.js";
import { PACK_SIZE, rarityOf, rarityRank, loadFormats, draftFormat } from "../draft/format.js";
import { formatErrors, readiness } from "../draft/packs.js";
import { DraftTable, DEFAULT_TIMER, botDeck, poolCards } from "../draft/table.js";
import { newRun, storeRun } from "../draft/runs.js";
import { poolView } from "./draft-pool.js";

const DRAG = "text/x-draft-pick";
export const BOT_NAMES = ["Ishizu", "Rex", "Weevil", "Mako", "Keith", "Pegasus", "Bonz", "Mai", "Espa", "Odion", "Panik", "Arkana", "Rafael", "Valon"];

/**
 * Configurazione del draft: formato, bot, timer, partite. online: draft con altri giocatori (l'host sceglie anche
 * se i pool restano segreti), che poi apre la stanza (draft-online.js).
 */
export function openBotDraftSetup(app, { online = false } = {}) {
  const title = online ? "Host a draft" : "Draft vs bots";
  const ready = loadFormats().filter((f) => !formatErrors(f).length && !readiness(f).length);
  if (!ready.length) {
    return openModal({
      title,
      body: [h("p", "You need a draft format that is ready: create one in Limited formats, with bundles for Round 1 and single cards for Round 2.")],
      actions: [{ label: "OK", primary: true, value: true }],
    });
  }
  const fmt = h("select.select", ready.map((f) => h("option", { value: f.id }, `${f.name} (${f.bundles.length} bundles · ${f.singles.length} singles)`)));
  fmt.value = ready.some((f) => f.id === settings.lastDraftFormat) ? settings.lastDraftFormat : ready[0].id;
  const bots = h("input.input", { type: "number", min: online ? 0 : 1, max: 11, value: online ? settings.lastOnlineBots ?? 0 : settings.lastDraftBots ?? 7 });
  const pool = h(
    "select.select",
    h("option", { value: "open" }, "Open pool: after the draft everyone sees every pool (not the decks)"),
    h("option", { value: "closed" }, "Closed pool: what everyone drafted stays secret")
  );
  pool.value = settings.lastDraftPool ?? "open";
  // Timer di ogni round: con il pacchetto pieno e con l'ultimo oggetto (in mezzo si accorcia piano piano).
  const saved = Array.isArray(settings.lastDraftTimers) ? settings.lastDraftTimers : [];
  const tIn = (r, k, min) => h("input.input", { type: "number", min, max: 600, value: saved[r]?.[k] ?? DEFAULT_TIMER[k] });
  const timers = [0, 1].map((r) => ({ start: tIn(r, "start", 5), end: tIn(r, "end", 3) }));
  const bestOf = h("input.input", { type: "number", min: 1, max: 9, step: 2, value: settings.lastDraftBestOf ?? 3 });
  openModal({
    title,
    className: "wide",
    body: [
      h(
        "p.muted.small",
        online
          ? "You open a room with a code: your friends join with it, then you start the draft. Bots can fill the empty seats (they run on your computer)."
          : "You draft at a table of bots, build your deck from your pool, then play best-of matches against the bots with the CPU."
      ),
      // Impostazioni in righe allineate; i timer in una tabellina (round × pacchetto pieno / ultima scelta).
      h(
        "div.ds-grid",
        h("label.field.ds-wide", h("span", "Draft format"), fmt),
        h("label.field", h("span", online ? "Bots (also in the room)" : "Bots at the table"), bots),
        h("label.field", h("span", "Matches: best of"), bestOf),
        online ? h("label.field.ds-wide", h("span", "Pools"), pool) : null
      ),
      h(
        "div.ds-timers",
        h("span.ds-timers-title", "Pick timer (seconds)"),
        h("span.muted.small", "Full pack"),
        h("span.muted.small", "Last pick"),
        h("span", "Round 1 · bundles"),
        timers[0].start,
        timers[0].end,
        h("span", "Round 2 · cards"),
        timers[1].start,
        timers[1].end
      ),
    ],
    actions: [
      { label: "Cancel", value: null },
      {
        label: online ? "Open the room" : "Start the draft",
        primary: true,
        onClick: (close) => {
          // Al tavolo va la versione attuale del formato (senza le precedenti), con la sua impronta per le statistiche.
          const f = draftFormat(ready.find((x) => x.id === fmt.value));
          const n = Math.max(online ? 0 : 1, Math.min(11, Math.round(+bots.value) || (online ? 0 : 7)));
          const t = timers.map((x) => {
            const start = Math.max(5, +x.start.value || DEFAULT_TIMER.start);
            return { start, end: Math.max(3, Math.min(start, +x.end.value || DEFAULT_TIMER.end)) };
          });
          const bo = Math.max(1, Math.round(+bestOf.value) || 3) | 1;
          settings.lastDraftFormat = f.id;
          if (online) {
            settings.lastOnlineBots = n;
            settings.lastDraftPool = pool.value;
          } else settings.lastDraftBots = n;
          settings.lastDraftTimers = t;
          settings.lastDraftBestOf = bo;
          close();
          if (online) return import("./draft-online.js").then((m) => m.hostDraft(app, { format: f, timers: t, bestOf: bo, bots: n, pool: pool.value }));
          const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
          const seats = [{ name: settings.name, bot: false }, ...Array.from({ length: n }, (_, i) => ({ name: `${names[i % names.length]} (bot)`, bot: true }))];
          showDraftTable(app, new DraftTable(f, seats, { timers: t }), { me: 0, bestOf: bo });
        },
      },
    ],
  });
}

/** Fine del draft andata storta: si mostra l'errore e si apre il draft salvato (o la pagina Limited). */
export async function finishFailed(app, e, run) {
  console.error("Draft finish:", e);
  const { alertModal } = await import("./modal.js");
  await alertModal("Draft complete, but something went wrong", `${e?.message ?? e}${run ? "\n\nYour draft was saved: you can build your deck from the Limited page." : "\n\nThe draft could not be saved."}`);
  try {
    if (run) {
      const { showDraftDeck } = await import("./draft-deck.js");
      return showDraftDeck(app, run.id);
    }
  } catch (e2) {
    console.error("Draft page:", e2);
  }
  const { showDraft } = await import("./draft-editor.js");
  showDraft(app);
}

/**
 * Schermata del tavolo. Al termine del draft salva il run e apre il mazzo. online: { onDone(), onLeave() } per il
 * draft con altri giocatori (table è un NetDraft: posti fantasma, rientri, annullamento).
 */
export function showDraftTable(app, table, { me = 0, bestOf = 3, online = null } = {}) {
  const root = clear(app.root);
  const f = table.format;
  const seat = table.seats[me];
  const detail = createDetailPanel();
  // Binder: il mazzo che si costruisce durante il draft (scheda Deck o Side, vedi poolView); il Side resta sul tavolo
  // (table.trackedSide) e a fine draft il deck builder si apre con questo mazzo.
  const poolState = { tab: "deck", grouped: false, side: (table.trackedSide ??= []) };
  let shownPack = null; // id del pacchetto mostrato (per l'animazione di apertura solo all'arrivo)

  const head = h("div.dt-head");
  const ring = h("div.dt-ring");
  const packEl = h("div.dt-pack");
  const binderEl = h("div.dt-binder");
  const timerEl = h("div.dt-timer");
  const pickBtn = h("button.btn.primary.dt-pick", { onclick: () => seat.selected && table.pick(me, seat.selected) }, icon("check"), " Pick");

  const rarity = (id) => rarityOf(f, id);
  const tierOf = (id) => {
    const r = rarityRank(f, id);
    return f.rarities.length > 1 ? Math.max(0, r) / (f.rarities.length - 1) : 0;
  };

  function renderHead() {
    const round = table.round;
    const pack = seat.queue[0];
    const pick = Math.min(PACK_SIZE, seat.picks[round - 1] + 1);
    clear(head).append(
      ...[
        h("button.btn.ghost.round.page-back", { title: "Leave the draft", onclick: leave }, icon("chevron_left")),
        h(
          "div.dt-title",
          h("b", f.name),
          h("span.muted.small", round === 1 ? "Round 1 · Bundles · passing left" : "Round 2 · Singles · passing right", icon(round === 1 ? "arrow_back" : "arrow_forward"))
        ),
        h("div.dt-progress", h("span.muted.small", "Pick"), h("b", `${pack ? pick : seat.picks[round - 1]}/${PACK_SIZE}`), h("span.muted.small", `· Round ${round}/2`)),
        seat.queue.length > 1 ? h("span.dt-queue", { title: "Packs waiting for you" }, icon("layers"), ` +${seat.queue.length - 1}`) : null,
        timerEl,
        pickBtn,
      ].filter(Boolean)
    );
  }

  function renderRing() {
    const dir = table.round === 1 ? 1 : -1;
    clear(ring).append(
      ...table.seats.map((s, i) =>
        h(
          `div.dt-seat${i === me ? ".me" : ""}${s.bot ? ".bot" : ""}${s.ghost ? ".ghost" : ""}`,
          { title: s.ghost ? `${s.name} left: the seat is played by the timer until they come back` : `${s.name}: ${s.queue.length} pack(s) waiting` },
          s.ghost ? icon("wifi_off") : null,
          h("span.dt-seat-name", s.name),
          h("span.dt-seat-packs", Array.from({ length: Math.min(5, s.queue.length) }, () => h("i"))),
          h("span.muted.small", `${s.picks[0] + s.picks[1]}/${PACK_SIZE * 2}`)
        )
      ),
      h("span.dt-ring-dir.muted.small", icon(dir === 1 ? "east" : "west"), dir === 1 ? " Packs go to the next seat" : " Packs go to the previous seat")
    );
  }

  function itemEl(x, i, reveal) {
    const r = rarity(x.rarity);
    const tier = tierOf(x.rarity);
    const sel = seat.selected === x.uid;
    const codes = [...x.main, ...x.extra];
    const el = h(
      `button.dt-item${x.round === 1 ? ".bundle" : ".single"}${sel ? ".selected" : ""}${reveal ? ".reveal" : ""}${tier >= 0.75 && r ? ".top" : ""}`,
      {
        // Bundle: l'artwork della copertina è lo sfondo di tutto il riquadro (sfocato fuori dalla finestra della copertina).
        style: `--rc: ${r?.color ?? "#5b6070"}; --tier: ${tier}; --d: ${i * 70}ms${x.round === 1 && coverOf(x) ? `; --art: url("${artUrl(coverOf(x))}")` : ""}`,
        draggable: true,
        dataset: { uid: x.uid },
        onclick: () => table.select(me, x.uid),
        ondblclick: () => table.pick(me, x.uid),
        // Trascinato nel binder: è la scelta confermata.
        ondragstart: (e) => {
          e.dataTransfer.setData(DRAG, x.uid);
          e.dataTransfer.effectAllowed = "move";
          table.select(me, x.uid);
          showBinder();
          binderEl.classList.add("drop-ready");
        },
        ondragend: () => binderEl.classList.remove("drop-ready", "drop"),
      },
      x.round === 1
        ? [
            // Nome lungo: scorre con il mouse sopra (scrollText).
            h("div.dt-item-head", h("b", scrollText(x.label)), r ? h("span.rarity-chip", r.name) : null),
            bundleCover(x),
            bundleStrips(x),
          ]
        : [cardFace(codes[0]), r ? h("span.rarity-chip.dt-single-rarity", r.name) : null]
    );
    return el;
  }

  // Bundle: copertina (l'artwork della prima carta del bundle, come per i mazzi) e una striscia per carta.
  const coverOf = (x) => (x.cover && getCard(x.cover) ? x.cover : [...x.main, ...x.extra].find((c) => getCard(c)));
  function bundleCover(x) {
    return h("div.dt-cover", h("span.dt-cover-count", `Main ${x.main.length} · Extra ${x.extra.length}`));
  }

  function bundleStrips(x) {
    const strip = ([code, n]) =>
      h(
        `div.dt-strip.${frameClass(getCard(code))}`,
        { dataset: { code }, title: getCard(code)?.name ?? "" },
        h("img.dt-strip-art", { src: artUrl(code), alt: "", loading: "lazy", draggable: false, onerror: (e) => (e.target.style.visibility = "hidden") }),
        h("span.dt-strip-name", getCard(code)?.name ?? `#${code}`),
        n > 1 ? h("b.dt-strip-n", `×${n}`) : null
      );
    const stacks = (codes) => {
      const m = new Map();
      for (const c of codes) m.set(c, (m.get(c) ?? 0) + 1);
      return [...m];
    };
    const main = stacks(x.main);
    const extra = stacks(x.extra);
    // Altezza delle strisce secondo le carte del bundle: grandi nei bundle piccoli, più fitte in quelli grandi.
    const rows = Math.max(6, main.length + extra.length + (extra.length && main.length ? 0.5 : 0));
    const el = h(
      "div.dt-strips",
      { style: `--n: ${rows}` },
      ...main.map(strip),
      ...(extra.length && main.length ? [h("div.dt-strip-sep")] : []),
      ...extra.map(strip)
    );
    // Nessuna barra di scorrimento: la lista scorre da sola (vedi autoScroll) o con la rotella.
    el.addEventListener("wheel", (e) => {
      if (el.scrollHeight <= el.clientHeight) return;
      e.preventDefault();
      el.scrollTop += e.deltaY;
    }, { passive: false });
    return el;
  }

  let packKey = "";
  function renderPack() {
    const pack = seat.queue[0];
    pickBtn.disabled = !seat.selected;
    // Lo stesso pacchetto con la stessa selezione non si ridisegna (le scelte degli altri posti arrivano di
    // continuo): lo scorrimento delle liste dei bundle resta dov'è.
    const key = pack ? `${pack.id}:${pack.items.length}:${seat.selected}` : `wait:${table.round}:${seat.picks.join()}:${table.done}`;
    if (key === packKey) return;
    packKey = key;
    if (!pack) {
      shownPack = null;
      const waitingRound = seat.picks[table.round - 1] >= PACK_SIZE;
      clear(packEl).append(
        h(
          "div.dt-wait",
          icon("hourglass_top"),
          h("b", table.done ? "Draft complete" : waitingRound ? `Waiting for the others to finish Round ${table.round}` : "Waiting for the next pack…"),
          h("span.muted.small", waitingRound ? "Round 2 starts when every seat has made its 15 picks." : "The player before you is still choosing.")
        )
      );
      return;
    }
    const reveal = pack.id !== shownPack;
    shownPack = pack.id;
    // Tutto il pacchetto in una schermata: colonne e righe secondo gli oggetti rimasti (più grandi quando sono pochi).
    const n = pack.items.length;
    const cols = Math.min(n, pack.round === 1 ? (n > 12 ? 5 : n > 6 ? 4 : 3) : n > 10 ? 5 : n > 6 ? 4 : n > 2 ? 3 : n);
    const rows = Math.ceil(n / cols);
    // Cambia solo la selezione: le liste ripartono da dove erano.
    const scrolled = new Map([...packEl.querySelectorAll(".dt-item")].map((el) => [el.dataset.uid, el.querySelector(".dt-strips")?.scrollTop ?? 0]));
    clear(packEl).append(
      h("div.dt-pack-head", h("span.muted.small", `${n} ${pack.round === 1 ? "bundles" : "cards"} · click to select, then double-click, Pick or drag it into your binder to take it`)),
      h(`div.dt-items${pack.round === 1 ? ".bundles" : ".singles"}`, { style: `--cols: ${cols}; --rows: ${rows}` }, pack.items.map((x, i) => itemEl(x, i, reveal)))
    );
    if (!reveal) for (const el of packEl.querySelectorAll(".dt-item")) {
      const list = el.querySelector(".dt-strips");
      if (list && scrolled.get(el.dataset.uid)) list.scrollTop = scrolled.get(el.dataset.uid);
    }
  }

  // Carte dell'ultima scelta: evidenziate nel binder.
  const lastPick = () => {
    const last = seat.binder.at(-1);
    return last ? new Set([...last.main, ...last.extra]) : null;
  };

  function renderBinder() {
    const { main, extra } = poolCards(seat.binder);
    clear(binderEl).append(
      poolView([...main, ...extra], seat.binder, poolState, { fresh: lastPick(), rarityOf: rarity, empty: "Your picks appear here.", rerender: renderBinder, onContext: showCard })
    );
  }

  function renderTimer() {
    const left = table.timeLeft(me);
    if (left == null) {
      timerEl.hidden = true;
      return;
    }
    timerEl.hidden = false;
    const s = Math.ceil(left);
    timerEl.className = s <= 10 ? "dt-timer warn" : "dt-timer";
    timerEl.replaceChildren(icon("timer"), ` ${s}s`);
  }

  const renderAll = () => {
    renderHead();
    renderRing();
    renderPack();
    renderBinder();
    renderTimer();
  };

  const off = table.onChange((ev) => {
    // La scelta va nella scheda del binder aperta in quel momento: con "Side" tutte le sue carte vanno nel Side.
    if (ev.type === "pick" && ev.seat === me && poolState.tab === "side") poolState.side.push(...ev.item.main, ...ev.item.extra);
    if (ev.type === "pick" && ev.seat === me && ev.auto) toast(`Time's up: you took ${ev.item.label}`);
    if (ev.type === "round" && ev.round === 2) toast("Round 2: single cards, passing right");
    if (ev.type === "done") return void finish();
    if (ev.type === "abort") return void aborted(ev.reason);
    if (ev.type === "ghost") toast(`${ev.seats.map((i) => table.seats[i].name).join(", ")} left the draft: the seat is played by the timer until they come back`);
    if (ev.type === "seat") toast(`${table.seats[ev.seat].name} is back`);
    if (ev.type === "select" && ev.seat !== me) return;
    // L'animazione di apertura riparte solo per un pacchetto nuovo (vedi shownPack).
    renderAll();
  });
  // Un errore nel tavolo (es. un pacchetto che non si riesce a fare) non deve fermare tutto in silenzio.
  let tickError = false;
  const timer = setInterval(() => {
    if (!root.isConnected) return stop();
    try {
      table.tick();
    } catch (e) {
      console.error("Draft table:", e);
      if (!tickError) toast(`Draft error: ${e?.message ?? e}`, { kind: "error" });
      tickError = true;
    }
    renderTimer();
  }, 200);
  // Bundle con più carte di quelle che stanno nella cella: la lista scorre da sola, avanti e indietro, con una pausa
  // alle estremità; si ferma con il mouse sopra (e si scorre a mano).
  const scrollState = new WeakMap();
  let lastFrame = performance.now();
  const autoScroll = (t) => {
    if (!root.isConnected) return;
    const dt = Math.min(100, t - lastFrame);
    lastFrame = t;
    for (const el of packEl.querySelectorAll(".dt-strips")) {
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 1) continue;
      const st = scrollState.get(el) ?? { dir: 1, wait: 1200, pos: el.scrollTop };
      scrollState.set(el, st);
      if (el.matches(":hover")) {
        st.pos = el.scrollTop;
        continue;
      }
      if (st.wait > 0) {
        st.wait -= dt;
        continue;
      }
      st.pos = Math.max(0, Math.min(max, st.pos + st.dir * dt * 0.018));
      el.scrollTop = st.pos;
      if (st.pos >= max || st.pos <= 0) {
        st.dir = -st.dir;
        st.wait = 1500;
      }
    }
    requestAnimationFrame(autoScroll);
  };
  requestAnimationFrame(autoScroll);
  const stop = () => {
    clearInterval(timer);
    offReclose();
    document.removeEventListener("click", onCardClick, true);
    off();
  };
  app.onLeave = stop;

  async function leave() {
    if (online) {
      if (!table.done && !(await confirmModal("Leave the draft?", "Your seat is played by the timer: you can rejoin from the Limited page until the draft ends.", "Leave", "Stay", { danger: true }))) return;
      stop();
      return online.onLeave();
    }
    if (!table.done && !(await confirmModal("Leave the draft?", "The draft is lost: your picks are not saved.", "Leave", "Stay", { danger: true }))) return;
    stop();
    const { showDraft } = await import("./draft-editor.js");
    showDraft(app);
  }

  // Fine del draft: si salva e si apre subito il deck builder sulla collezione.
  // Un errore qui (salvataggio, mazzi dei bot, deck builder) lasciava il tavolo fermo dopo l'ultima scelta: ora si
  // dice cosa è successo e si va avanti (alla pagina del draft se è stato salvato, altrimenti a Limited).
  async function finish() {
    stop();
    if (online) return online.onDone();
    let run = null;
    try {
      const botDecks = table.seats.map((s) => (s.bot ? botDeck(s.binder) : null));
      run = storeRun(newRun(table, { me, bestOf, botDecks, side: poolState.side }));
      // Statistiche globali del cube: le mie scelte (pubbliche, senza nomi).
      import("../net/cube-stats.js").then((m) => m.shareRunStats(run));
      toast("Draft complete: build your deck");
      const { showDraftDeck, editDraftDeck } = await import("./draft-deck.js");
      await editDraftDeck(run);
      showDraftDeck(app, run.id);
    } catch (e) {
      await finishFailed(app, e, run);
    }
  }

  // A destra c'è il binder; cliccando una carta (nel pacchetto o nel binder) al suo posto compaiono i dettagli della
  // carta, finché non si clicca altrove.
  const detailBox = h("div.dt-detail", { hidden: true }, h("button.btn.ghost.small.dt-detail-close", { onclick: () => showBinder() }, icon("arrow_back"), " Binder"), detail.el);
  const showBinder = () => {
    detailBox.hidden = true;
    binderEl.hidden = false;
  };
  // Carta del binder: il clic la sposta tra Deck e Side, il tasto destro ne mostra i dettagli.
  const showCard = (code) => {
    detail.show(code);
    detailBox.hidden = false;
    binderEl.hidden = true;
  };
  const onCardClick = (e) => {
    if (!root.isConnected) return document.removeEventListener("click", onCardClick, true);
    if (detailBox.contains(e.target) || binderEl.contains(e.target)) return;
    const code = Number(e.target.closest?.(".dt-main .card[data-code], .dt-main .dt-strip[data-code]")?.dataset.code) || 0;
    if (!code) return showBinder();
    detail.show(code);
    detailBox.hidden = false;
    binderEl.hidden = true;
  };
  document.addEventListener("click", onCardClick, true);

  async function aborted(reason) {
    stop();
    const { alertModal } = await import("./modal.js");
    await alertModal("Draft cancelled", `${reason}. The draft was cancelled and its picks deleted.`);
    online?.onAbort?.();
  }

  // Binder: si rilascia qui un oggetto del pacchetto per sceglierlo.
  binderEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes(DRAG)) return;
    e.preventDefault();
    binderEl.classList.add("drop");
  });
  binderEl.addEventListener("dragleave", (e) => !binderEl.contains(e.relatedTarget) && binderEl.classList.remove("drop"));
  binderEl.addEventListener("drop", (e) => {
    const uid = e.dataTransfer.getData(DRAG);
    binderEl.classList.remove("drop", "drop-ready");
    if (!uid) return;
    e.preventDefault();
    table.pick(me, uid);
  });

  if (!online) table.start();
  // Una schermata sola, senza scorrere: pacchetto a sinistra; a destra il binder (o i dettagli della carta cliccata).
  // Binder laterale riducibile: chiuso resta una striscia; trascinando un oggetto verso di essa si riapre (e si
  // richiude dopo la scelta, se era chiuso).
  const dtMain = h("div.dt-main");
  let autoOpened = false;
  const setMin = (v) => {
    settings.draftBinderMin = v;
    dtMain.classList.toggle("binder-min", v);
  };
  const sideEl = h(
    "div.dt-side",
    h(
      "div.dt-side-head",
      h("b", "Binder"),
      h("span.muted.small.dt-side-count", ""),
      h("span.spacer"),
      h("button.btn.ghost.small.dt-side-min", { title: "Minimize the binder", onclick: () => setMin(true) }, icon("right_panel_close"))
    ),
    h("button.dt-side-open", { title: "Open the binder (or drag a pick here)", onclick: () => setMin(false) }, icon("left_panel_open"), h("span", "Binder")),
    binderEl,
    detailBox
  );
  sideEl.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer.types.includes(DRAG) || !dtMain.classList.contains("binder-min")) return;
    autoOpened = true;
    dtMain.classList.remove("binder-min");
  });
  const reclose = () => {
    if (!autoOpened) return;
    autoOpened = false;
    // Dopo un attimo: si vede dove è finita la scelta.
    setTimeout(() => settings.draftBinderMin && dtMain.classList.add("binder-min"), 900);
  };
  document.addEventListener("dragend", reclose);
  function offReclose() {
    document.removeEventListener("dragend", reclose);
  }
  setMin(!!settings.draftBinderMin);
  dtMain.append(packEl, sideEl);
  root.append(h("div.page.draft-table", head, ring, dtMain));
  renderAll();
}

