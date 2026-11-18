// Saldo Monero dell'indirizzo primario senza server di terzi che conoscano le chiavi: si leggono i blocchi da un nodo
// pubblico (dati pubblici, transazioni "pruned") e si riconoscono gli output con la view key qui nel browser.
// Per sapere se un output è stato speso si calcola la sua key image (serve la spend key, che Helios ha) e si chiede
// al nodo se è già nella blockchain. Le primitive sono quelle di Monero (crypto-ops.c), verificate con
// tests/crypto/tests.txt del repository ufficiale.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ed25519 } from "@noble/curves/ed25519.js";

// ---------------------------------------------------------------- primitive

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const Point = ed25519.Point;
const enc = new TextEncoder();

export const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (s) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const leToInt = (b) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
const intToLe = (n) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
export function varint(n) {
  const out = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

const mod = (a, m = P) => ((a % m) + m) % m;
const pow = (b, e) => {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
};
const SQRTM1 = pow(2n, (P - 1n) / 4n);
const sqrt = (x) => {
  let r = pow(x, (P + 3n) / 8n);
  if (mod(r * r) !== mod(x)) r = mod(r * SQRTM1);
  return r;
};
const A = 486662n;
const FE_MA = mod(-A);
const FE_MA2 = mod(-A * A);
const FFFB1 = sqrt(mod(-2n * A * (A + 2n)));
const FFFB2 = sqrt(mod(2n * A * (A + 2n)));
const FFFB3 = sqrt(mod(-SQRTM1 * A * (A + 2n)));
const FFFB4 = sqrt(mod(SQRTM1 * A * (A + 2n)));

/** Hs: keccak256 ridotto modulo l (hash_to_scalar). */
export const hashToScalar = (data) => mod(leToInt(keccak_256(data)), L);

/** ge_fromfe_frombytes_vartime di Monero: 32 byte → punto (senza moltiplicare per 8). Coordinate affini. */
function fromFe(bytes) {
  const u = mod(leToInt(bytes));
  const v = mod(2n * u * u);
  const w = mod(v + 1n);
  let x = mod(w * w + FE_MA2 * v);
  // (w / x)^(m+1) = w * x^3 * (w x^7)^((p-5)/8)
  let X = mod(w * pow(x, 3n) * pow(mod(w * pow(x, 7n)), (P - 5n) / 8n));
  let y = mod(w - mod(X * X * x));
  let z = FE_MA;
  let sign;
  let negative = false;
  if (y !== 0n) {
    y = mod(w + mod(X * X * x));
    if (y !== 0n) negative = true;
    else X = mod(X * FFFB1);
  } else X = mod(X * FFFB2);
  if (!negative) {
    X = mod(X * u);
    z = mod(z * v);
    sign = 0n;
  } else {
    x = mod(x * SQRTM1);
    y = mod(w - mod(X * X * x));
    X = y !== 0n ? mod(X * FFFB3) : mod(X * FFFB4);
    sign = 1n;
  }
  if ((X & 1n) !== sign) X = mod(-X);
  const Z = mod(z + w);
  const Y = mod(z - w);
  const zi = pow(Z, P - 2n);
  return { x: X, y: mod(Y * zi) };
}

const encodeAffine = ({ x, y }) => {
  const b = intToLe(y);
  b[31] |= Number(x & 1n) << 7;
  return b;
};

/** hash_to_point dei test: fromFe e codifica. */
export const hashToPointTest = (bytes) => toHex(encodeAffine(fromFe(bytes)));

/** hash_to_ec: keccak, fromFe, ×8. */
const hashToEc = (pub) => Point.fromAffine(fromFe(keccak_256(pub))).multiplyUnsafe(8n);

/** Key image di un output: x · Hp(P). */
export const keyImage = (pub, secInt) => hashToEc(pub).multiplyUnsafe(secInt).toBytes();

/** Derivazione 8·(a·R), o null se R non è un punto valido. */
export function keyDerivation(pub, secInt) {
  try {
    return Point.fromBytes(pub).multiplyUnsafe(secInt).multiplyUnsafe(8n).toBytes();
  } catch {
    return null;
  }
}
export const derivationToScalar = (d, i) => hashToScalar(cat(d, varint(i)));
export const derivePublicKey = (d, i, base) => Point.BASE.multiplyUnsafe(derivationToScalar(d, i)).add(Point.fromBytes(base)).toBytes();
export const viewTag = (d, i) => keccak_256(cat(enc.encode("view_tag"), d, varint(i)))[0];

// ---------------------------------------------------------------- nodo

// nodi pubblici che accettano richieste dal browser (CORS)
export const XMR_NODES = ["https://xmr-node.cakewallet.com:18081", "https://node.sethforprivacy.com", "https://xmr.cryptostorm.is:18081"];

let nodeIdx = 0;
async function call(path, body, { signal } = {}) {
  let last;
  for (let k = 0; k < XMR_NODES.length; k++) {
    const node = XMR_NODES[(nodeIdx + k) % XMR_NODES.length];
    try {
      const r = await fetch(node + path, { method: "POST", body: JSON.stringify(body), signal, headers: { "content-type": "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const v = await r.json();
      if (v.error) throw new Error(v.error.message ?? "node error");
      nodeIdx = (nodeIdx + k) % XMR_NODES.length;
      return v;
    } catch (e) {
      if (signal?.aborted) throw e;
      last = e;
    }
  }
  throw last ?? new Error("No Monero node answered");
}
const rpc = async (method, params, opts) => (await call("/json_rpc", { jsonrpc: "2.0", id: "0", method, params }, opts)).result;

export async function chainHeight(opts) {
  return (await call("/get_info", {}, opts)).height;
}

// ---------------------------------------------------------------- scansione

/** Chiavi pubbliche nel campo extra: { main: [R…], extra: [R_i…] } (tag 0x01 e 0x04). */
function txKeys(extra) {
  const b = Uint8Array.from(extra ?? []);
  const main = [];
  let more = [];
  let i = 0;
  const readVar = () => {
    let n = 0;
    let s = 0;
    for (;;) {
      const x = b[i++];
      n += (x & 0x7f) * 2 ** s;
      if (!(x & 0x80)) return n;
      s += 7;
    }
  };
  try {
    while (i < b.length) {
      const tag = b[i++];
      if (tag === 0x01) {
        main.push(b.slice(i, i + 32));
        i += 32;
      } else if (tag === 0x04) {
        const n = readVar();
        more = Array.from({ length: n }, (_, k) => b.slice(i + 32 * k, i + 32 * (k + 1)));
        i += 32 * n;
      } else if (tag === 0x02 || tag === 0xde) i += readVar();
      else if (tag === 0x00) break; // padding fino alla fine
      else if (tag === 0x03) {
        readVar();
        i += 32;
      } else break;
    }
  } catch {
    /* extra malformato: si usa quello letto */
  }
  return { main, extra: more };
}

/** Output nostri di una transazione (JSON decodificato dal nodo). */
export function scanTx(tx, hash, height, keys) {
  const found = [];
  const { main, extra } = txKeys(tx.extra);
  const rct = tx.rct_signatures ?? {};
  const derivs = main.map((R) => keyDerivation(R, keys.viewInt)).filter(Boolean);
  (tx.vout ?? []).forEach((out, i) => {
    const target = out.target?.tagged_key ?? out.target?.key ?? out.target;
    const keyHex = typeof target === "string" ? target : target?.key;
    if (!keyHex) return;
    const tag = out.target?.tagged_key?.view_tag;
    const cands = [...derivs];
    if (extra[i]) {
      const d = keyDerivation(extra[i], keys.viewInt);
      if (d) cands.push(d);
    }
    for (const d of cands) {
      if (tag != null && viewTag(d, i).toString(16).padStart(2, "0") !== tag) continue;
      if (toHex(derivePublicKey(d, i, keys.spendPub)) !== keyHex) continue;
      const hs = derivationToScalar(d, i);
      let amount;
      if (rct.type > 0) {
        const e = rct.ecdhInfo?.[i]?.amount;
        if (!e || e.length !== 16) return; // formati RingCT precedenti al 2019: non gestiti
        const mask = keccak_256(cat(enc.encode("amount"), intToLe(hs)));
        const a = fromHex(e).map((x, k) => x ^ mask[k]);
        amount = a.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
      } else amount = BigInt(out.amount ?? 0);
      const ki = keyImage(fromHex(keyHex), mod(hs + keys.spendInt, L));
      found.push({ tx: hash, i, height, amount: amount.toString(), ki: toHex(ki) });
      return;
    }
  });
  return found;
}

/**
 * Transazione "pruned" in binario (prefisso + base di RingCT) nella stessa forma del JSON del nodo, solo con i campi
 * che servono: vout, extra, rct_signatures { type, ecdhInfo }. Un quarto dei dati del JSON.
 */
export function parsePrunedTx(hex) {
  const b = fromHex(hex);
  let i = 0;
  const v = () => {
    let n = 0n;
    let sh = 0n;
    for (;;) {
      if (i >= b.length) throw new Error("truncated");
      const x = b[i++];
      n |= BigInt(x & 0x7f) << sh;
      if (!(x & 0x80)) return n;
      sh += 7n;
    }
  };
  const bytes = (n) => {
    if (i + n > b.length) throw new Error("truncated");
    const r = b.slice(i, i + n);
    i += n;
    return r;
  };
  const version = Number(v());
  v(); // unlock_time
  const nin = Number(v());
  for (let k = 0; k < nin; k++) {
    const tag = b[i++];
    if (tag === 0xff) v();
    else if (tag === 0x02) {
      v();
      const n = Number(v());
      for (let j = 0; j < n; j++) v();
      bytes(32);
    } else throw new Error(`input type ${tag}`);
  }
  const nout = Number(v());
  const vout = [];
  for (let k = 0; k < nout; k++) {
    const amount = v();
    const tag = b[i++];
    if (tag === 0x02) vout.push({ amount, target: { key: toHex(bytes(32)) } });
    else if (tag === 0x03) {
      const key = toHex(bytes(32));
      vout.push({ amount, target: { tagged_key: { key, view_tag: toHex(bytes(1)) } } });
    } else throw new Error(`output type ${tag}`);
  }
  const extra = [...bytes(Number(v()))];
  const rct = { type: 0, ecdhInfo: [] };
  if (version >= 2 && i < b.length) {
    rct.type = b[i++];
    if (rct.type) {
      v(); // fee
      for (let k = 0; k < nout; k++) rct.ecdhInfo.push(rct.type >= 4 ? { amount: toHex(bytes(8)) } : { amount: toHex(bytes(64)).slice(64) });
    }
  }
  return { version, vout, extra, rct_signatures: rct };
}

const pmap = async (items, n, fn) => {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
};

/**
 * Scansiona i blocchi [from, to) e restituisce gli output trovati. keys: { viewInt, spendInt, spendPub (byte) }.
 * onBlock(altezza) dopo ogni gruppo di blocchi, per salvare il punto e mostrare l'avanzamento.
 */
export async function scanBlocks(from, to, keys, { signal, onBlock = () => {} } = {}) {
  const found = [];
  const STEP = 20;
  for (let h = from; h < to; h += STEP) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const heights = Array.from({ length: Math.min(STEP, to - h) }, (_, k) => h + k);
    const blocks = await pmap(heights, 6, (height) => rpc("get_block", { height }, { signal }));
    const hashes = [];
    blocks.forEach((b, k) => {
      const json = JSON.parse(b.json);
      found.push(...scanTx(json.miner_tx, b.miner_tx_hash, heights[k], keys));
      for (const t of json.tx_hashes ?? []) hashes.push([t, heights[k]]);
    });
    for (let k = 0; k < hashes.length; k += 100) {
      const part = hashes.slice(k, k + 100);
      const r = await call("/get_transactions", { txs_hashes: part.map((x) => x[0]), decode_as_json: false, prune: true }, { signal });
      for (const t of r.txs ?? []) {
        const height = part.find((x) => x[0] === t.tx_hash)?.[1] ?? t.block_height;
        try {
          found.push(...scanTx(parsePrunedTx(t.pruned_as_hex), t.tx_hash, height, keys));
        } catch {
          /* transazione illeggibile */
        }
      }
    }
    onBlock(h + heights.length, found);
  }
  return found;
}

/** Stato delle key image: 0 non spesa, 1 spesa, 2 spesa nel mempool. */
export async function spentStatus(kis, opts) {
  if (!kis.length) return [];
  return (await call("/is_key_image_spent", { key_images: kis }, opts)).spent_status ?? [];
}
