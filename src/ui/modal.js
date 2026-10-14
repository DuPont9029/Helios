import { h } from "./dom.js";

/**
 * Finestra modale. Restituisce { el, body, close(value), result }.
 * actions: [{ label, value, primary, disabled, onClick }]
 */
export function openModal({ title, body = [], actions = [], dismissable = true, className = "", onClose } = {}) {
  let resolve;
  const result = new Promise((r) => (resolve = r));
  const footer = h("div.modal-actions");
  const bodyEl = h("div.modal-body", body);
  const box = h(`div.modal.${className || "plain"}`, title && h("h2.modal-title", title), bodyEl, footer);
  const backdrop = h("div.modal-backdrop", box);
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
  }
  const onKey = (e) => {
    if (e.key === "Escape" && dismissable) close(undefined);
  };
  document.addEventListener("keydown", onKey);
  result.then(() => document.removeEventListener("keydown", onKey));
  document.body.append(backdrop);
  return { el: box, body: bodyEl, footer, buttons, close, result };
}

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
