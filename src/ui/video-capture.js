// Registrazione video del duello (Combo Trainer): cattura della scheda con getDisplayMedia (il browser
// chiede il permesso), ritagliata sull'area del duello dove è possibile (Region Capture di Chrome),
// e MediaRecorder in MP4 se supportato, altrimenti WebM. I sottotitoli sono nella pagina, quindi nel video.

const TYPES = [
  ["video/mp4;codecs=avc1", "mp4"],
  ["video/mp4", "mp4"],
  ["video/webm;codecs=vp9", "webm"],
  ["video/webm;codecs=vp8", "webm"],
  ["video/webm", "webm"],
];

export const canRecordVideo = () => !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined";

/**
 * Avvia la registrazione. Restituisce { stop() -> Promise<{ blob, ext }>, done } oppure lancia un errore
 * (permesso negato, browser non compatibile).
 * @param el elemento da inquadrare (es. .duel-screen)
 */
export async function startVideo(el) {
  if (!canRecordVideo()) throw new Error("This browser cannot record videos");
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  });
  const [track] = stream.getVideoTracks();
  // Solo l'area del duello (Chrome); altrove si registra tutta la scheda condivisa.
  if (window.CropTarget && track.cropTo) {
    try {
      await track.cropTo(await window.CropTarget.fromElement(el));
    } catch {
      /* si registra la scheda intera */
    }
  }
  const [mimeType, ext] = TYPES.find(([t]) => MediaRecorder.isTypeSupported(t)) ?? ["", "webm"];
  const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((resolve) => {
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      resolve({ blob: new Blob(chunks, { type: mimeType || "video/webm" }), ext });
    };
  });
  // L'utente può interrompere la condivisione dal browser: si chiude la registrazione.
  track.addEventListener("ended", () => rec.state !== "inactive" && rec.stop());
  rec.start(1000);
  return {
    done,
    stop() {
      if (rec.state !== "inactive") rec.stop();
      return done;
    },
  };
}
