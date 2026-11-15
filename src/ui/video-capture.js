// Registrazione video del duello (Combo Trainer, replay): cattura della scheda con getDisplayMedia (il browser
// chiede il permesso), ritagliata sull'area del duello dove è possibile (Region Capture di Chrome),
// e MediaRecorder in MP4 se supportato, altrimenti WebM. I sottotitoli sono nella pagina, quindi nel video.
//
// Qualità: si chiede la cattura alla risoluzione reale dello schermo (pixel fisici, non quelli CSS) a 60 fps,
// si dice al codificatore che conta il dettaglio (testi e carte nitidi più che fluidità), e il bitrate cresce con
// i pixel: con i 5 Mbit/s fissi di prima un campo 3D a tutto schermo veniva sgranato.
import { h } from "./dom.js";
import { openModal } from "./modal.js";

const TYPES = [
  ["video/mp4;codecs=avc1.640033", "mp4"], // H.264 High profile, fino al 4K
  ["video/mp4;codecs=avc1", "mp4"],
  ["video/mp4", "mp4"],
  ["video/webm;codecs=vp9", "webm"],
  ["video/webm;codecs=vp8", "webm"],
  ["video/webm", "webm"],
];

export const canRecordVideo = () => !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined";

/** Bit al secondo per una certa risoluzione: ~0.12 bit per pixel per fotogramma, tra 8 e 40 Mbit/s. */
const bitrateFor = (w, h, fps) => Math.round(Math.min(40e6, Math.max(8e6, w * h * fps * 0.12)));

/**
 * Avvia la registrazione. Restituisce { stop() -> Promise<{ blob, ext }>, done } oppure lancia un errore
 * (permesso negato, browser non compatibile).
 * @param el elemento da inquadrare (es. .duel-screen)
 */
export async function startVideo(el) {
  if (!canRecordVideo()) throw new Error("This browser cannot record videos");
  const dpr = window.devicePixelRatio || 1;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 60, max: 60 },
      width: { ideal: Math.round(screen.width * dpr) },
      height: { ideal: Math.round(screen.height * dpr) },
    },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  });
  const [track] = stream.getVideoTracks();
  // Testi e carte nitidi: il codificatore non abbassa la risoluzione quando la scena si muove.
  if ("contentHint" in track) track.contentHint = "detail";
  // Solo l'area del duello (Chrome); altrove si registra tutta la scheda condivisa.
  if (window.CropTarget && track.cropTo) {
    try {
      await track.cropTo(await window.CropTarget.fromElement(el));
    } catch {
      /* si registra la scheda intera */
    }
  }
  const set = track.getSettings?.() ?? {};
  const fps = set.frameRate || 30;
  const w = set.width || el.clientWidth * dpr;
  const hgt = set.height || el.clientHeight * dpr;
  const [mimeType, ext] = TYPES.find(([t]) => MediaRecorder.isTypeSupported(t)) ?? ["", "webm"];
  const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: bitrateFor(w, hgt, fps) });
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

/** Anteprima del video registrato, con Download e (se il sistema lo permette) Share. */
export function showVideo(blob, ext, name, title = "Video") {
  const url = URL.createObjectURL(blob);
  const fileName = `${name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "video"}.${ext}`;
  const file = new File([blob], fileName, { type: blob.type });
  const canShare = !!navigator.canShare?.({ files: [file] });
  const m = openModal({
    title,
    className: "wide",
    body: [h("video.combo-video", { src: url, controls: true, playsInline: true }), h("p.muted.small", `${fileName} · ${(blob.size / 1048576).toFixed(1)} MB`)],
    actions: [
      { label: "Close", value: null },
      ...(canShare ? [{ label: "Share", onClick: () => navigator.share({ files: [file], title: name }).catch(() => {}) }] : []),
      {
        label: "Download",
        primary: true,
        onClick: () => {
          const a = h("a", { href: url, download: fileName });
          document.body.append(a);
          a.click();
          a.remove();
        },
      },
    ],
  });
  m.result.then(() => setTimeout(() => URL.revokeObjectURL(url), 60_000));
}

/** Errore all'avvio della registrazione: spiegazione per l'utente (null se l'ha annullata lui). */
export function videoErrorText(e) {
  if (e?.name === "NotAllowedError") return null;
  if (e?.name === "NotReadableError") return "The browser could not capture the screen. On macOS allow it in System Settings → Privacy & Security → Screen & System Audio Recording (enable your browser), then restart the browser.";
  return e?.message || "Unable to record the video";
}
