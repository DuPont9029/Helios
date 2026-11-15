// Layout per telefono: lo stesso Helios (e lo stesso Helios.html) sceglie all'avvio, e a ogni rotazione o cambio
// di dimensione, se usare l'interfaccia del telefono. Con html.mobile l'interfaccia non viene scalata con lo zoom
// (main.js: fitScreen) e valgono le regole di styles/mobile.css; il resto del codice è lo stesso del desktop.
// Telefono = schermo touch stretto in verticale o basso in orizzontale (html.mobile.landscape: regole del telefono girato).
// Per provare: ?ui=mobile o ?ui=desktop nell'indirizzo (resta salvato; ?ui=auto torna alla scelta automatica).
import { h, icon } from "./dom.js";
import { openModal } from "./modal.js";
import { createDetailPanel } from "./detail.js";

const QUERY = "(pointer: coarse) and (max-width: 700px) and (orientation: portrait), (pointer: coarse) and (max-height: 500px) and (orientation: landscape)";
const LANDSCAPE = "(orientation: landscape)";
const KEY = "helios.ui";

function forced() {
  try {
    const p = new URLSearchParams(location.search).get("ui");
    if (p === "auto") localStorage.removeItem(KEY);
    else if (p === "mobile" || p === "desktop") localStorage.setItem(KEY, p);
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

const force = forced();
const media = window.matchMedia(QUERY);
const landscape = window.matchMedia(LANDSCAPE);

/** True se adesso si usa il layout del telefono. */
export function isMobile() {
  return force ? force === "mobile" : media.matches;
}

/** Mette html.mobile e la aggiorna quando cambia l'orientamento; onChange() dopo ogni cambio. */
export function initMobile(onChange) {
  const root = document.documentElement;
  const apply = () => {
    const on = isMobile();
    const wide = on && landscape.matches;
    if (root.classList.contains("mobile") === on && root.classList.contains("landscape") === wide) return;
    root.classList.toggle("mobile", on);
    root.classList.toggle("landscape", wide);
    onChange?.(on);
  };
  apply();
  media.addEventListener("change", apply);
  landscape.addEventListener("change", apply);
}

/**
 * Pressione lunga con il dito (sul telefono sostituisce il tasto destro): fn() dopo `ms` senza spostarsi.
 * Il clic e il "tasto destro" (Android) che seguono la pressione non contano.
 */
export function onLongPress(el, fn, ms = 450) {
  let timer = null;
  let start = null;
  let fired = false;
  let touch = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    touch = performance.now();
    fired = false;
    start = [e.clientX, e.clientY];
    cancel();
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      fn();
    }, ms);
  });
  el.addEventListener("pointermove", (e) => timer && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 8 && cancel());
  for (const ev of ["pointerup", "pointercancel", "dragstart"]) el.addEventListener(ev, cancel);
  // In cattura: vengono prima dei gestori di clic e tasto destro dell'elemento.
  el.addEventListener("click", (e) => {
    if (!fired) return;
    fired = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  el.addEventListener("contextmenu", (e) => {
    if (performance.now() - touch > 2000) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
}

/**
 * Scheda di una carta (immagine e testo) con le sue azioni: sul telefono prende il posto del pannello laterale
 * dei dettagli e del tasto destro. actions: [{ label, run, primary?, danger? }].
 */
export function openCardSheet(code, actions = []) {
  const detail = createDetailPanel({ related: true });
  detail.show(code);
  return openModal({
    className: "card-sheet",
    body: [detail.el],
    actions: [
      { label: "Close", value: null },
      ...actions.map((a) => ({ label: a.label, primary: a.primary, danger: a.danger, onClick: (close) => { close(null); a.run(); } })),
    ],
  });
}

/**
 * Schede in basso per le pagine con più pannelli affiancati (es. Deck e ricerca nel deck builder): solo sul telefono
 * (la barra è nascosta sul desktop). page.dataset.mtab = scheda aperta; i pannelli si mostrano con mobile.css.
 * tabs: [{ id, label, icon }]. Restituisce set(id).
 */
export function mobileTabs(page, tabs) {
  const bar = h("nav.m-tabs", tabs.map((t) => h("button.m-tab", { dataset: { tab: t.id }, onclick: () => set(t.id) }, icon(t.icon), h("span", t.label))));
  const set = (id) => {
    page.dataset.mtab = id;
    for (const b of bar.children) b.classList.toggle("on", b.dataset.tab === id);
  };
  set(tabs[0].id);
  page.append(bar);
  return set;
}
