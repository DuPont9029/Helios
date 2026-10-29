// Motore del duello (ocgcore WASM) in un Web Worker: chiamate con risposta asincrona.
// Lo usano la partita (session.js) e chi la guarda da spettatore (ui/coaching.js).
import { STANDALONE } from "../data/bundle.js";

// Helios in un solo file: il worker del motore è incorporato nel bundle (niente file worker.js da caricare).
const InlineWorker = STANDALONE ? (await import("./worker.js?worker&inline")).default : null;

export class EngineClient {
  constructor() {
    this.worker = InlineWorker ? new InlineWorker() : new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (error) p?.reject(new Error(error));
      else p?.resolve(result);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "Engine worker error"));
      this.pending.clear();
    };
  }

  call(cmd, args) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd, args });
    });
  }

  terminate() {
    this.worker.terminate();
  }
}
