// Rubrica delle scelte precedenti per le impostazioni con un upload (sleeve, gemme Pendulum, sorgenti dei
// campi 3D): ogni scelta nuova si ricorda, così si può tornare a una vecchia senza ricaricare il file.
// In IndexedDB (le immagini pesano troppo per localStorage), al massimo MAX per tipo, la più recente prima.

const DB = "ygoweb-uploads";
const STORE = "history";
const MAX = 12;

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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Scelte precedenti di un tipo ("sleeve", "pendulum", "fields"): [{ value, date }], la più recente prima. */
export async function uploadHistory(kind) {
  const list = await idbDo("readonly", (s) => s.get(kind)).catch(() => null);
  return Array.isArray(list) ? list : [];
}

/** Ricorda una scelta (in cima; se c'era già si sposta in cima). */
export async function rememberUpload(kind, value) {
  if (value == null || value === "") return;
  const list = (await uploadHistory(kind)).filter((x) => !same(x.value, value));
  list.unshift({ value, date: Date.now() });
  await idbDo("readwrite", (s) => s.put(list.slice(0, MAX), kind)).catch(() => {});
}

/** Toglie una scelta dalla rubrica. */
export async function forgetUpload(kind, value) {
  const list = (await uploadHistory(kind)).filter((x) => !same(x.value, value));
  await idbDo("readwrite", (s) => s.put(list, kind)).catch(() => {});
}
