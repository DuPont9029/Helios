// Piccolo helper per creare elementi senza framework.
//   h("div.card.big", { onclick, dataset: {code} }, child1, "testo", ...)
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (props != null && props !== false && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += " " + v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// Icona Material Symbols (font caricato in index.html).
export const icon = (name) => h("span.icon", { "aria-hidden": "true" }, name);

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function download(filename, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, onchange: () => resolve(input.files[0] ?? null) });
    input.click();
  });
}

// --- Zoom dell'interfaccia (vedi fitScreen in main.js).
// Con lo zoom sulla pagina, getBoundingClientRect() può restituire pixel dello schermo mentre le lunghezze
// assegnate in CSS vengono di nuovo moltiplicate per lo zoom. Il fattore si misura con un elemento di prova
// (i browser non si comportano tutti allo stesso modo) e rect() riporta le misure in pixel CSS.
let rectScale = 1;
export function measureRectScale() {
  const probe = h("div", { style: { position: "fixed", left: "0", top: "0", width: "100px", height: "1px", visibility: "hidden" } });
  document.body.append(probe);
  rectScale = probe.getBoundingClientRect().width / 100 || 1;
  probe.remove();
}

/** getBoundingClientRect() in pixel CSS della pagina (da usare per posizionare elementi). */
export function rect(el) {
  const r = el.getBoundingClientRect();
  const k = rectScale;
  return { left: r.left / k, top: r.top / k, right: r.right / k, bottom: r.bottom / k, width: r.width / k, height: r.height / k, x: r.x / k, y: r.y / k };
}

/** Dimensioni della finestra in pixel CSS della pagina. */
export const viewportSize = () => ({ width: window.innerWidth / rectScale, height: window.innerHeight / rectScale });

/** Coordinate di un evento del puntatore in pixel CSS della pagina. */
export const pointer = (e) => ({ x: e.clientX / rectScale, y: e.clientY / rectScale });
