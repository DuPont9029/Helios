// Helios in un solo file HTML (npm run standalone, vedi scripts/build-standalone.mjs): nessun server, i dati
// (carte, stringhe, banlist, script Lua) sono in un archivio gzip incorporato nella pagina, in base64.
// Formato dell'archivio decompresso: [lunghezza dell'indice (uint32 LE)][indice JSON { nome: [inizio, lunghezza] }][file].

/** Vero solo nel build in un file (vite build --mode standalone): altrimenti i dati si scaricano da public/data. */
export const STANDALONE = import.meta.env.MODE === "standalone";

let archive = null;

/** L'archivio decompresso: { bytes, index }. Si legge una volta sola. */
export function loadArchive() {
  archive ??= (async () => {
    const el = document.getElementById("helios-data");
    if (!el) throw new Error("This Helios file is incomplete: the card data is missing");
    // fetch di un data: URL decodifica il base64 molto più in fretta di atob su ~10 MB.
    const packed = await (await fetch(`data:application/gzip;base64,${el.textContent.trim()}`)).blob();
    const bytes = new Uint8Array(await new Response(packed.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    return { bytes, index: archiveIndex(bytes) };
  })();
  return archive;
}

/** Indice dei file dell'archivio (vale anche nel worker, che riceve gli stessi byte). */
export function archiveIndex(bytes) {
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  return { size: n, files: JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n))) };
}

/** Testo di un file dell'archivio, o null se non c'è. */
export function archiveText({ bytes, index }, name) {
  const at = index.files[name];
  if (!at) return null;
  const start = 4 + index.size + at[0];
  return new TextDecoder().decode(bytes.subarray(start, start + at[1]));
}
