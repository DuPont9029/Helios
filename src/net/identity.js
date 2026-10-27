// Identità del giocatore per le partite classificate (ELO): una chiave Nostr (schnorr secp256k1) creata nel
// browser, senza account né password. La chiave pubblica è il "nome" del giocatore in classifica; quella
// segreta firma i risultati e resta solo qui (si può esportare per non perdere il rating cambiando browser).
import { schnorr } from "@noble/secp256k1";

const KEY = "ygoweb.identity";
const HEX64 = /^[0-9a-f]{64}$/;

export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

export async function sha256Hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/** Testo canonico di un oggetto (chiavi in ordine): stesso hash su tutti i client. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    return v && HEX64.test(v.sk) ? v : null;
  } catch {
    return null;
  }
}

function save(sk) {
  const v = { sk, pk: toHex(schnorr.getPublicKey(fromHex(sk))) };
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage non disponibile: l'identità vale solo per questa sessione */
  }
  return v;
}

let current = null;
/** L'identità del giocatore ({ sk, pk } in esadecimale), creata al primo uso. */
export function identity() {
  current ??= read() ?? save(toHex(schnorr.keygen().secretKey));
  return current;
}

/** Sostituisce l'identità con una chiave segreta esportata prima (64 caratteri esadecimali). */
export function importIdentity(sk) {
  const s = String(sk ?? "").trim().toLowerCase();
  if (!HEX64.test(s)) throw new Error("The key must be 64 hexadecimal characters");
  schnorr.getPublicKey(fromHex(s)); // lancia se la chiave non è valida
  current = save(s);
  return current;
}

/** Firma dell'hash (64 caratteri esadecimali) con la chiave del giocatore. */
export async function signHash(hash) {
  return toHex(await schnorr.signAsync(fromHex(hash), fromHex(identity().sk)));
}

/** true se `sig` è la firma di `pk` sull'hash. */
export async function verifyHash(sig, hash, pk) {
  try {
    return /^[0-9a-f]{128}$/.test(sig) && HEX64.test(pk) && HEX64.test(hash) && (await schnorr.verifyAsync(fromHex(sig), fromHex(hash), fromHex(pk)));
  } catch {
    return false;
  }
}

/** Forma breve della chiave pubblica da mostrare (es. "a1b2c3…f9e8"). */
export const shortKey = (pk) => `${pk.slice(0, 6)}…${pk.slice(-4)}`;
