// Lettura di file .zip direttamente da un Blob, senza librerie: si legge l'indice (central directory) e si
// estrae solo il file richiesto (archivi "stored" o "deflate", anche ZIP64). La decompressione usa
// DecompressionStream("deflate-raw") del browser. Il Blob può stare su disco (IndexedDB): se ne leggono solo i pezzi.

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);
const u64 = (v, o) => u32(v, o) + u32(v, o + 4) * 2 ** 32;
const view = async (blob, start, end) => new DataView(await blob.slice(start, end).arrayBuffer());

export class ZipReader {
  constructor(blob) {
    this.blob = blob;
    this.entries = null; // nome -> { method, size, offset }
  }

  async open() {
    if (this.entries) return this;
    const b = this.blob;
    // Fine della central directory: negli ultimi 22 byte + commento (max 64 KB).
    const tailStart = Math.max(0, b.size - 65557);
    const tail = await view(b, tailStart, b.size);
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("This file is not a .zip archive");
    let count = u16(tail, eocd + 10);
    let cdSize = u32(tail, eocd + 12);
    let cdOffset = u32(tail, eocd + 16);
    // ZIP64: i valori veri stanno nel record ZIP64 indicato dal "locator" subito prima.
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new Error("Unsupported .zip archive");
      const at = u64(tail, loc + 8);
      const z = await view(b, at, at + 56);
      count = u64(z, 32);
      cdSize = u64(z, 40);
      cdOffset = u64(z, 48);
    }
    const cd = await view(b, cdOffset, cdOffset + cdSize);
    const dec = new TextDecoder();
    this.entries = new Map();
    for (let i = 0, p = 0; i < count && p + 46 <= cd.byteLength; i++) {
      if (u32(cd, p) !== 0x02014b50) break;
      const method = u16(cd, p + 10);
      let csize = u32(cd, p + 20);
      let size = u32(cd, p + 24);
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      let offset = u32(cd, p + 42);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
      // Campo extra ZIP64: dimensioni e posizione che non stanno in 32 bit, in quest'ordine.
      for (let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end; ) {
        const id = u16(cd, e);
        const len = u16(cd, e + 2);
        if (id === 1) {
          let q = e + 4;
          if (size === 0xffffffff) (size = u64(cd, q)), (q += 8);
          if (csize === 0xffffffff) (csize = u64(cd, q)), (q += 8);
          if (offset === 0xffffffff) offset = u64(cd, q);
        }
        e += 4 + len;
      }
      if (!name.endsWith("/") && !name.startsWith("__MACOSX/")) this.entries.set(name, { method, csize, size, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return this;
  }

  names() {
    return [...this.entries.keys()];
  }

  /** Contenuto di un file dell'archivio come Blob (null se non c'è). */
  async file(name, type = "") {
    const e = this.entries.get(name);
    if (!e) return null;
    const head = await view(this.blob, e.offset, e.offset + 30);
    if (u32(head, 0) !== 0x04034b50) throw new Error(`Damaged .zip archive (${name})`);
    const start = e.offset + 30 + u16(head, 26) + u16(head, 28);
    const data = this.blob.slice(start, start + e.csize);
    if (e.method === 0) return new Blob([data], { type });
    if (e.method !== 8) throw new Error(`Unsupported compression in the .zip archive (${name})`);
    const out = await new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
    return new Blob([out], { type });
  }
}
