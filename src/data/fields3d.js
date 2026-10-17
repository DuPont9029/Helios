// Campi 3D: elenco e scelta. I file dei campi NON fanno parte della repository: si caricano da fuori.
// Sorgenti possibili (impostazione "fieldsUrl", oppure VITE_FIELDS_URL nella build):
//   - indirizzo della cartella dei campi (es. .../web/fields)
//   - indirizzo di un file .zip con quella cartella: si scarica una volta e resta salvato nel browser
//   - "file:<nome>": uno .zip caricato dal computer (Settings → Field), salvato nel browser
// Contenuto della cartella (o dello zip, anche dentro sottocartelle):
//   index.json                 [{ id: "Mat_001", sides: ["near", "far"], name? }]
//   names.json (facoltativo)   { "Mat_001": { en: "Ritual Cage", it: "..." } } (anche nella cartella superiore)
//   Mat_001/near.glb, near.json, far.glb, far.json
// Un indirizzo esterno deve permettere le richieste da altri siti (CORS), come GitHub Pages o raw.githubusercontent.com.
import { settings } from "./settings.js";
import { ZipReader } from "./zip.js";

const ENV = import.meta.env ?? {};
export const BUILD_FIELDS_URL = ENV.VITE_FIELDS_URL || "";

/** Indirizzo (o "file:<nome>") della sorgente dei campi, "" se non configurata. */
export function fieldsBase() {
  return String(settings.fieldsUrl || BUILD_FIELDS_URL || "")
    .trim()
    .replace(/\/index\.json$/, "")
    .replace(/\/+$/, "");
}

const isFile = (src) => src.startsWith("file:");
// Link di condivisione di ArDrive (app.ardrive.io, ardrive.ar.io, …): https://<host>/#/file/<id>/view
const ardriveId = (src) => src.match(/^https?:\/\/[^/]*ardrive[^/]*\/.*#\/file\/([0-9a-f-]{36})/i)?.[1] ?? null;
export const isZip = (src) => isFile(src) || !!ardriveId(src) || /\.zip$/i.test(src.split(/[?#]/)[0]);

// ---------------------------------------------------------------- archivio nel browser (IndexedDB)

const DB = "ygoweb-fields";
const STORE = "zips";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDo(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Browser storage unavailable"));
    });
  } finally {
    db.close();
  }
}

const storedZip = (key) => idbDo("readonly", (s) => s.get(key));
const storeZip = (key, blob) => idbDo("readwrite", (s) => s.put({ blob, date: Date.now() }, key));

/** Dimensione dello .zip salvato per questa sorgente (0 se non c'è). */
export async function storedSize(src = fieldsBase()) {
  if (!src) return 0;
  return (await storedZip(zipKey(src)).catch(() => null))?.blob?.size ?? 0;
}

/** Cancella gli .zip salvati nel browser. */
export async function forgetZips() {
  await idbDo("readwrite", (s) => s.clear());
  sources.clear();
}

const zipKey = (src) => (isFile(src) ? "file" : `url:${src}`);

/** Salva uno .zip scelto dal computer e lo rende la sorgente dei campi. */
export async function useZipFile(file) {
  const zip = await new ZipReader(file).open(); // verifica che sia uno zip con i campi
  rootOf(zip);
  navigator.storage?.persist?.().catch(() => {});
  await storeZip("file", file);
  sources.clear();
  settings.fieldsUrl = `file:${file.name}`;
}

/** Scarica uno .zip (con avanzamento 0..1) leggendolo a pezzi. */
async function download(url, onProgress) {
  let r;
  try {
    r = await fetch(url);
  } catch {
    throw new Error("Download blocked: the site must allow cross-site requests (CORS)");
  }
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const total = +r.headers.get("content-length") || 0;
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress?.(total ? got / total : null, got);
  }
  return new Blob(parts, { type: "application/zip" });
}

/** Cartella dell'archivio che contiene index.json (la meno profonda). */
function rootOf(zip) {
  const idx = zip.names().filter((n) => /(^|\/)index\.json$/.test(n)).sort((a, b) => a.length - b.length)[0];
  if (idx == null) throw new Error("The .zip archive has no index.json");
  return idx.slice(0, idx.length - "index.json".length);
}

// ---------------------------------------------------------------- sorgenti

const sources = new Map(); // sorgente -> Promise<{ list, url(path) }>

const TYPES = { glb: "model/gltf-binary", json: "application/json" };

/** Link di condivisione → download diretto (Dropbox, Google Drive); gli altri indirizzi restano uguali. */
function directLink(src) {
  try {
    const u = new URL(src);
    if (/(^|\.)dropbox\.com$/.test(u.hostname)) {
      u.searchParams.set("dl", "1");
      return u.href;
    }
    if (/(^|\.)drive\.google\.com$/.test(u.hostname)) {
      const id = u.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || u.searchParams.get("id");
      if (id) return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
    }
  } catch {
    /* non è un URL completo */
  }
  return src;
}

/** true se il Blob è un archivio .zip (firma "PK" all'inizio). */
async function isZipBlob(blob) {
  const b = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
}

async function openFolder(src) {
  const getJson = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  };
  const parent = src.replace(/\/[^/]*$/, "");
  return {
    index: await getJson(`${src}/index.json`),
    names: await getJson(`${src}/names.json`).catch(() => getJson(`${parent}/names.json`)).catch(() => ({})),
    url: async (path) => `${src}/${path}`,
  };
}

// Gateway di ArDrive (AR.IO): indice GraphQL e dati di Arweave, con richieste CORS permesse.
const AR_GATEWAY = "https://ardrive.net";

/** File pubblico di ArDrive → indirizzo dei suoi dati sul gateway. */
async function ardriveData(fileId) {
  const gql = async (query) => {
    const r = await fetch(`${AR_GATEWAY}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
    if (!r.ok) throw new Error(`ArDrive: ${r.status}`);
    return (await r.json()).data;
  };
  // Ultima versione dei metadati del file (ArFS): JSON con dataTxId.
  const d = await gql(`query { transactions(first: 1, sort: HEIGHT_DESC, tags: [{ name: "File-Id", values: ["${fileId}"] }, { name: "Entity-Type", values: ["file"] }]) { edges { node { id tags { name value } } } } }`);
  const node = d?.transactions?.edges?.[0]?.node;
  if (!node) throw new Error("ArDrive file not found (if it was just uploaded, try again in a few minutes)");
  if (node.tags.some((t) => t.name === "Cipher")) throw new Error("This ArDrive file is private (encrypted): share it from a public drive");
  const meta = await (await fetch(`${AR_GATEWAY}/${node.id}`)).json();
  if (!meta?.dataTxId) throw new Error("ArDrive file without data");
  return `${AR_GATEWAY}/${meta.dataTxId}`;
}

/** Scarica uno .zip dall'indirizzo e lo salva nel browser; errore se il link non dà uno .zip. */
async function downloadZip(src, key, onProgress) {
  const id = ardriveId(src);
  const blob = await download(id ? await ardriveData(id) : directLink(src), onProgress);
  if (!(await isZipBlob(blob)))
    throw new Error("The link does not download a .zip file (a sharing page? use a direct download link)");
  navigator.storage?.persist?.().catch(() => {});
  await storeZip(key, blob).catch(() => {}); // senza spazio si usa lo stesso, ma andrà riscaricato
  return blob;
}

async function openSource(src, onProgress) {
  // Uno .zip già salvato nel browser per questa sorgente (caricato dal computer o scaricato da un link).
  const key = zipKey(src);
  let blob = (await storedZip(key).catch(() => null))?.blob;
  if (!blob) {
    if (isFile(src)) throw new Error("The .zip file is no longer stored in this browser: upload it again");
    if (isZip(src)) blob = await downloadZip(src, key, onProgress);
    else {
      // Cartella dei campi, altrimenti un link a uno .zip che non finisce in ".zip" (si riconosce dal contenuto).
      try {
        return await openFolder(src);
      } catch (folderError) {
        try {
          blob = await downloadZip(src, key, onProgress);
        } catch (e) {
          if (/CORS/.test(e.message)) throw e;
          console.warn("Fields folder:", folderError.message, "· .zip:", e.message);
          throw new Error("This address is neither a fields folder nor a .zip file. For a shared file, use its direct download link.");
        }
      }
    }
  }
  const zip = await new ZipReader(blob).open();
  const root = rootOf(zip);
  const parent = root.replace(/[^/]*\/$/, "");
  const json = async (name) => JSON.parse(await (await zip.file(name)).text());
  return {
    index: await json(`${root}index.json`),
    names: await json(`${root}names.json`).catch(() => json(`${parent}names.json`)).catch(() => ({})),
    url: async (path) => {
      const blob = await zip.file(root + path, TYPES[path.split(".").pop()]);
      if (!blob) throw new Error(`Missing in the .zip archive: ${path}`);
      const u = URL.createObjectURL(blob);
      setTimeout(() => URL.revokeObjectURL(u), 60000); // il caricamento lo legge subito
      return u;
    },
  };
}

function source(src, onProgress) {
  if (!sources.has(src)) {
    const p = openSource(src, onProgress).then((s) => {
      if (!Array.isArray(s.index)) throw new Error("index.json is not a list of fields");
      const list = s.index
        .filter((f) => f?.id && f.sides?.length)
        .map((f) => ({ id: f.id, sides: f.sides, name: s.names[f.id]?.en || f.name || `Field ${f.id.replace(/^Mat_0*/, "#")}` }));
      return { list, url: s.url };
    });
    sources.set(src, p);
    p.catch(() => sources.delete(src));
  }
  return sources.get(src);
}

/** Elenco dei campi disponibili: [{ id, name, sides }]. onProgress(0..1 | null, byte) durante il download di uno .zip. */
export async function fieldList(src = fieldsBase(), onProgress) {
  if (!src) return [];
  return (await source(src, onProgress)).list;
}

/** Funzione che dà l'URL di un file dei campi (per Field.load). */
export async function fieldFiles(src = fieldsBase()) {
  return (await source(src)).url;
}

/** Campo da usare nel prossimo duello secondo le impostazioni, oppure null (campo 2D). */
export async function chooseField() {
  const src = fieldsBase();
  const want = settings.field3d;
  if (!src || !want) return null;
  const { list, url } = await source(src);
  if (!list.length) return null;
  const f = (want !== "random" && list.find((x) => x.id === want)) || list[Math.floor(Math.random() * list.length)];
  return { base: url, ...f };
}
