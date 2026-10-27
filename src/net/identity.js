// Identità del giocatore (classifica ELO, amici, inviti): una chiave Nostr (schnorr secp256k1) creata nel
// browser, senza account né password. La chiave pubblica è il "nome" del giocatore; quella segreta firma i
// risultati e resta solo qui. Dalla 1.0.15 la chiave nasce da 12 parole (seed NIP-06, come i wallet): con le
// parole, la chiave nsec (NIP-19) o il backup con password (ncryptsec, NIP-49) il profilo si riporta su un
// altro browser. Le identità create prima non hanno parole: si esportano con nsec.
import { schnorr } from "@noble/secp256k1";
import { generateSeedWords, privateKeyFromSeedWords, validateWords } from "nostr-tools/nip06";
import * as nip19 from "nostr-tools/nip19";
import * as nip49 from "nostr-tools/nip49";

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
    if (!v || !HEX64.test(v.sk)) return null;
    v.pk = toHex(schnorr.getPublicKey(fromHex(v.sk)));
    // Le parole valgono solo se danno proprio questa chiave.
    if (v.seed && !(validateWords(v.seed) && toHex(privateKeyFromSeedWords(v.seed)) === v.sk)) delete v.seed;
    return v;
  } catch {
    return null;
  }
}

function save(sk, seed = null) {
  const v = { sk, pk: toHex(schnorr.getPublicKey(fromHex(sk))), ...(seed ? { seed } : {}) };
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage non disponibile: l'identità vale solo per questa sessione */
  }
  return v;
}

/** Nuova identità da 12 parole nuove. */
function fromNewSeed() {
  const seed = generateSeedWords();
  return save(toHex(privateKeyFromSeedWords(seed)), seed);
}

let current = null;
/** L'identità del giocatore ({ sk, pk, seed? } in esadecimale), creata al primo uso. */
export function identity() {
  current ??= read() ?? fromNewSeed();
  return current;
}

/** Cambio di identità (import, profilo nuovo): chi usa la chiave (amici, presenza) riparte. */
function changed() {
  window.dispatchEvent(new CustomEvent("helios-identity", { detail: current }));
  return current;
}

/** Normalizza le parole di un seed (spazi, maiuscole, a capo). */
const words = (text) => String(text ?? "").trim().toLowerCase().split(/\s+/).join(" ");

/** Che cosa è il testo di un profilo esportato: "seed", "nsec", "ncryptsec", "hex" o null. */
export function profileKind(text) {
  const t = String(text ?? "").trim();
  if (/^ncryptsec1[02-9ac-hj-np-z]+$/i.test(t)) return "ncryptsec";
  if (/^nsec1[02-9ac-hj-np-z]+$/i.test(t)) return "nsec";
  if (HEX64.test(t.toLowerCase())) return "hex";
  const w = words(t);
  if ([12, 24].includes(w.split(" ").length) && validateWords(w)) return "seed";
  return null;
}

/**
 * Sostituisce l'identità con un profilo esportato prima: 12/24 parole (NIP-06), nsec1…, ncryptsec1… (con
 * la password) o 64 caratteri esadecimali.
 */
export function importIdentity(text, password = "") {
  const kind = profileKind(text);
  const t = String(text ?? "").trim();
  let sk;
  let seed = null;
  if (kind === "seed") {
    seed = words(t);
    sk = toHex(privateKeyFromSeedWords(seed));
  } else if (kind === "nsec") {
    const d = nip19.decode(t.toLowerCase());
    if (d.type !== "nsec") throw new Error("Not a valid nsec key");
    sk = toHex(d.data);
  } else if (kind === "ncryptsec") {
    try {
      sk = toHex(nip49.decrypt(t, password));
    } catch {
      throw new Error("Wrong password, or the backup is damaged");
    }
  } else if (kind === "hex") sk = t.toLowerCase();
  else throw new Error("Paste your 12 seed words, an nsec1… key, a password backup (ncryptsec1…) or a 64-character hexadecimal key");
  schnorr.getPublicKey(fromHex(sk)); // lancia se la chiave non è valida
  current = save(sk, seed);
  return changed();
}

/** Profilo nuovo (parole nuove): quello di prima si perde se non è stato esportato. */
export function newIdentity() {
  current = fromNewSeed();
  return changed();
}

/** Chiave pubblica (npub1…) e segreta (nsec1…) nel formato NIP-19, usato da tutti i client Nostr. */
export const npubOf = (pk) => nip19.npubEncode(pk);
export const nsec = () => nip19.nsecEncode(fromHex(identity().sk));

/** Backup del profilo protetto da password (NIP-49): senza la password non serve a niente. */
export const passwordBackup = (password) => nip49.encrypt(fromHex(identity().sk), password);

/** Chiave pubblica esadecimale da npub1… o da 64 caratteri esadecimali, o null. */
export function pubkeyFrom(text) {
  const t = String(text ?? "").trim().replace(/^nostr:/i, "");
  if (HEX64.test(t.toLowerCase())) return t.toLowerCase();
  if (/^npub1/i.test(t)) {
    try {
      const d = nip19.decode(t.toLowerCase());
      if (d.type === "npub") return d.data;
    } catch { /* non valida */ }
  }
  return null;
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
