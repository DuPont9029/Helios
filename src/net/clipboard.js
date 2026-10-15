// Osserva gli appunti per lo scambio dei codici invito: quando l'utente copia il codice dell'altro
// giocatore (es. dalla chat) e torna sulla pagina, il codice viene letto da solo.
// Solo dove la lettura si può autorizzare una volta per tutte (Chromium, permesso "clipboard-read"):
// Firefox e Safari mostrerebbero un menu "Incolla" a ogni lettura, quindi lì si incolla a mano.

/** true se gli appunti si possono leggere senza un gesto dell'utente per ogni lettura. */
export async function clipboardWatchable() {
  if (!navigator.clipboard?.readText || !navigator.permissions?.query) return false;
  try {
    const st = await navigator.permissions.query({ name: "clipboard-read" });
    return st.state !== "denied";
  } catch {
    return false; // permesso sconosciuto al browser
  }
}

/** Copia il testo negli appunti; false se il browser lo impedisce. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Legge gli appunti quando la pagina torna in primo piano e, con un intervallo leggero, finché è visibile.
 * @param onText(text, initial)  chiamata a ogni contenuto nuovo; initial = era già negli appunti all'avvio
 * @param onDenied()             l'utente ha negato il permesso: si torna all'incolla manuale
 */
export function watchClipboard({ onText, onDenied, intervalMs = 1500 }) {
  let last = null;
  let stopped = false;
  let busy = false;
  const check = async () => {
    if (stopped || busy || document.visibilityState !== "visible" || !document.hasFocus()) return;
    busy = true;
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!stopped && text !== last) {
        const initial = last === null;
        last = text;
        if (text) await onText(text, initial);
      }
    } catch (e) {
      // "Document is not focused" non è un rifiuto: si riprova al prossimo giro.
      if (!/focus/i.test(e?.message ?? "")) {
        stop();
        onDenied?.(e);
      }
    } finally {
      busy = false;
    }
  };
  const onVisible = () => setTimeout(check, 50);
  window.addEventListener("focus", onVisible);
  document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(check, intervalMs);
  check();
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    window.removeEventListener("focus", onVisible);
    document.removeEventListener("visibilitychange", onVisible);
  }
  return {
    stop,
    /** Segna il testo come già visto (es. il codice che abbiamo appena copiato noi). */
    seen(text) {
      last = text.trim();
    },
  };
}
