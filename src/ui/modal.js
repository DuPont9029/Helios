import { h } from "./dom.js";

/**
 * Finestra modale. Restituisce { el, body, close(value), result }.
 * actions: [{ label, value, primary, disabled, onClick }]
 */
export function openModal({ title, body = [], actions = [], dismissable = true, className = "", onClose, minimizable = /\bprompt\b/.test(className) } = {}) {
  let resolve;
  const result = new Promise((r) => (resolve = r));
  const footer = h("div.modal-actions");
  const bodyEl = h("div.modal-body", body);
  // Le scelte del duello si possono ridurre a una piccola barra per guardare campo e pile, poi riaprire.
  const minimize = (on) => backdrop.classList.toggle("minimized", on);
  const titleEl = title && h("h2.modal-title", title);
  const head = minimizable
    ? h("div.modal-head", titleEl, h("button.modal-min", { title: "Minimize: look at the field, then reopen", onclick: () => minimize(true) }, h("span.icon", "remove")))
    : titleEl;
  const box = h(`div.modal.${className || "plain"}`, head, bodyEl, footer);
  const restore = minimizable && h("button.modal-restore", { onclick: () => minimize(false) }, h("span.icon", "open_in_full"), h("span", title || "Show the choice"));
  const backdrop = h("div.modal-backdrop", box, restore);
  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    backdrop.classList.add("closing");
    setTimeout(() => backdrop.remove(), 160);
    onClose?.(value);
    resolve(value);
  };
  const buttons = [];
  for (const a of actions) {
    const b = h(`button.btn${a.primary ? ".primary" : ""}${a.danger ? ".danger" : ""}`, {
      disabled: a.disabled,
      onclick: () => (a.onClick ? a.onClick(close) : close(a.value)),
    }, a.label);
    buttons.push(b);
    footer.append(b);
  }
  if (dismissable) {
    backdrop.addEventListener("mousedown", (e) => e.target === backdrop && close(undefined));
    // Chiudibile anche con il tasto destro (vedi l'ascoltatore qui sotto).
    backdrop.classList.add("dismissable");
    backdrop.modalClose = close;
  }
  const onKey = (e) => {
    if (e.key === "Escape" && dismissable) close(undefined);
  };
  document.addEventListener("keydown", onKey);
  result.then(() => document.removeEventListener("keydown", onKey));
  document.body.append(backdrop);
  return { el: box, body: bodyEl, footer, buttons, close, result };
}

// Tasto destro: chiude la finestra in primo piano se si può chiudere (Close/Annulla, clic fuori, Esc).
// Fase di cattura: arriva prima del tasto destro del duello, che altrimenti rifiuterebbe la scelta sotto.
// Nei campi di testo resta il menu del browser (incolla, ecc.).
window.addEventListener(
  "contextmenu",
  (e) => {
    const top = [...document.querySelectorAll(".modal-backdrop:not(.closing)")].at(-1);
    if (!top?.modalClose || top.classList.contains("minimized")) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    e.preventDefault();
    e.stopPropagation();
    top.modalClose(undefined);
  },
  true
);

export function alertModal(title, message) {
  return openModal({ title, body: [h("p", message)], actions: [{ label: "OK", primary: true, value: true }] }).result;
}

/** danger: il pulsante di conferma è rosso (azioni distruttive come l'eliminazione). */
export function confirmModal(title, message, yes = "Yes", no = "No", { danger = false } = {}) {
  return openModal({
    title,
    className: danger ? "danger" : "",
    body: [h("p", message)],
    actions: [{ label: no, value: false }, { label: yes, value: true, primary: !danger, danger }],
  }).result.then((v) => v === true);
}

export function promptModal(title, label, value = "") {
  const input = h("input.input", { value, onkeydown: (e) => e.key === "Enter" && m.close(input.value) });
  const m = openModal({
    title,
    body: [h("label.field", h("span", label), input)],
    actions: [{ label: "Cancel", value: null }, { label: "OK", primary: true, onClick: (close) => close(input.value) }],
  });
  setTimeout(() => input.select(), 30);
  return m.result.then((v) => (v == null ? null : String(v)));
}

let toastRoot = null;
export function toast(message, { kind = "info", ms = 2600 } = {}) {
  if (!toastRoot) {
    toastRoot = h("div.toasts");
    document.body.append(toastRoot);
  }
  const t = h(`div.toast.${kind}`, message);
  toastRoot.append(t);
  setTimeout(() => {
    t.classList.add("hide");
    setTimeout(() => t.remove(), 300);
  }, ms);
}
