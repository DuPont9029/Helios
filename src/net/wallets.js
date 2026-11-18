// Indirizzi Ethereum e Monero dalle stesse parole del profilo (BIP39), come fa Cake Wallet (FOSS):
//
//   parole + passphrase ─ PBKDF2-HMAC-SHA512 (2048, sale "mnemonic"+passphrase) → seed 512 bit → BIP32 secp256k1
//   ├─ ETH  m/44'/60'/0'/0/i: chiave pubblica non compressa → keccak256 → ultimi 20 byte → EIP-55
//   └─ XMR  m/44'/128'/acc'/0/0: i 32 byte della chiave letti little-endian e ridotti modulo l (sc_reduce32, senza
//           keccak: cw_monero/lib/bip39_seed.dart) = spend key; view key = sc_reduce32(keccak256(spend key));
//           indirizzo primario (prefisso 0x12, base58 di Monero); spend key → seed legacy a 25 parole.
//
// Il sale non passa per la normalizzazione NFKD (Cake Wallet non la fa): con passphrase non ASCII coincide con
// Cake Wallet, non con altri wallet BIP39.
import { HDKey } from "@scure/bip32";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { getPublicKey } from "@noble/secp256k1";
import { MONERO_WORDS } from "../data/monero-words.js";

const enc = new TextEncoder();
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Seed BIP39 di 512 bit (come bip39MnemonicToSeed di Cake Wallet). */
export function bip39Seed(mnemonic, passphrase = "") {
  const words = String(mnemonic).trim().toLowerCase().split(/\s+/).join(" ");
  return pbkdf2(sha512, enc.encode(words), enc.encode(`mnemonic${passphrase}`), { c: 2048, dkLen: 64 });
}

// ---------------------------------------------------------------- Ethereum

function eip55(addrHex) {
  const h = hex(keccak_256(enc.encode(addrHex)));
  return "0x" + [...addrHex].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

/** I primi `count` indirizzi Ethereum (m/44'/60'/0'/0/i). */
export function ethAddresses(seed, count = 3) {
  const acc = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0");
  const out = [];
  for (let i = 0; i < count; i++) {
    const pub = getPublicKey(acc.deriveChild(i).privateKey, false).slice(1);
    out.push({ path: `m/44'/60'/0'/0/${i}`, address: eip55(hex(keccak_256(pub).slice(-20))) });
  }
  return out;
}

// ---------------------------------------------------------------- Monero

const L = 2n ** 252n + 27742317777372353535851937790883648493n; // ordine del gruppo di ed25519
const leToInt = (b) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
const intToLe = (n) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const scReduce32 = (b) => intToLe(leToInt(b) % L);
const pubOf = (sc) => ed25519.Point.BASE.multiply(leToInt(sc)).toBytes(); // scalare già ridotto (niente clamping)

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11]; // caratteri per un blocco di n byte

/** Base58 di Monero: blocchi di 8 byte → 11 caratteri, l'ultimo blocco più corto. */
function moneroBase58(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8) {
    const block = bytes.slice(i, i + 8);
    let n = block.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
    let part = "";
    for (let k = 0; k < B58_SIZES[block.length]; k++) {
      part = B58[Number(n % 58n)] + part;
      n /= 58n;
    }
    s += part;
  }
  return s;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Seed legacy a 25 parole (electrum-words): 3 parole ogni 4 byte, più quella di controllo (CRC32 dei prefissi). */
function legacySeed(spend) {
  const n = MONERO_WORDS.length;
  const words = [];
  for (let i = 0; i < 32; i += 4) {
    const x = (spend[i] | (spend[i + 1] << 8) | (spend[i + 2] << 16) | (spend[i + 3] << 24)) >>> 0;
    const w1 = x % n;
    const w2 = (Math.floor(x / n) + w1) % n;
    const w3 = (Math.floor(x / n / n) + w2) % n;
    words.push(MONERO_WORDS[w1], MONERO_WORDS[w2], MONERO_WORDS[w3]);
  }
  const check = crc32(enc.encode(words.map((w) => w.slice(0, 3)).join("")));
  words.push(words[check % words.length]);
  return words.join(" ");
}

/** Wallet Monero dell'account `account` (m/44'/128'/account'/0/0), come Cake Wallet. */
export function moneroWallet(seed, account = 0) {
  const key = HDKey.fromMasterSeed(seed).derive(`m/44'/128'/${account}'/0/0`);
  const spend = scReduce32(key.privateKey);
  const view = scReduce32(keccak_256(spend));
  const body = new Uint8Array([0x12, ...pubOf(spend), ...pubOf(view)]);
  const address = moneroBase58(new Uint8Array([...body, ...keccak_256(body).slice(0, 4)]));
  return {
    path: `m/44'/128'/${account}'/0/0`,
    address,
    spendKey: hex(spend),
    viewKey: hex(view),
    seed: legacySeed(spend),
    // per la scansione dei blocchi (net/monero-scan.js)
    scanKeys: { viewInt: leToInt(view), spendInt: leToInt(spend), spendPub: pubOf(spend) },
  };
}
