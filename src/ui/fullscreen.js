// Schermo intero (solo desktop): pulsante che entra ed esce dal fullscreen del browser.
// Sui dispositivi touch non compare: lì il fullscreen del browser è limitato o manca (iPhone).
import { h, icon, clear } from "./dom.js";

const supported = () => !!document.documentElement.requestFullscreen && document.fullscreenEnabled !== false;
const isDesktop = () => matchMedia("(hover: hover) and (pointer: fine)").matches;

export function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  return document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
}

function paint(btn) {
  const on = !!document.fullscreenElement;
  btn.title = on ? "Exit fullscreen (Esc)" : "Fullscreen";
  clear(btn).append(icon(on ? "fullscreen_exit" : "fullscreen"), btn.dataset.label ? ` ${on ? "Exit fullscreen" : btn.dataset.label}` : "");
}
// Un solo ascoltatore per tutti i pulsanti presenti nella pagina (anche se si esce con Esc).
document.addEventListener("fullscreenchange", () => document.querySelectorAll(".fs-btn").forEach(paint));

/** Pulsante del fullscreen (label: testo accanto all'icona); null dove il fullscreen non ha senso. */
export function fullscreenButton(cls = "btn.ghost.round", label = "") {
  if (!supported() || !isDesktop()) return null;
  const btn = h(`button.${cls}.fs-btn`, { onclick: () => toggleFullscreen(), dataset: label ? { label } : {} });
  paint(btn);
  return btn;
}
