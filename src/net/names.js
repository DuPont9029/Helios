// Username di Helios sul registro on-chain (contracts/HeliosNames.sol, configurazione in data/names-config.js).
//
// - Un nome si registra in due passi (commit, poi register da 1 minuto a 1 giorno dopo): lo paga il giocatore (wallet
//   del profilo o estensione del browser) oppure un amico, con un'autorizzazione EIP-712 firmata dal giocatore che gli
//   arriva come messaggio cifrato su Nostr (social.js: "name-pay"). Lo stesso per la card NFT.
// - Il nome di un altro giocatore vale solo se il suo profilo pubblico (firmato con la sua chiave Nostr) dichiara
//   username e wallet E il registro dice che quel nome è di quel wallet con quella chiave Nostr. Chi non ha un nome
//   verificato si vede come "Duelist-xxxxxx" (inizio della sua chiave): due giocatori non hanno mai lo stesso nome.
// - Tutto passa da ethers (libreria di riferimento), caricato solo quando serve.
import { NAMES_CONFIG } from "../data/names-config.js";
import { settings } from "../data/settings.js";
import { identity } from "./identity.js";

// In sviluppo si può puntare a una blockchain locale (localStorage "ygoweb.namesDev": { chainId, address, rpc: [url] }).
function config() {
  if (import.meta.env?.DEV) {
    try {
      const dev = JSON.parse(localStorage.getItem("ygoweb.namesDev") || "null");
      if (dev?.address) return { ...NAMES_CONFIG, ...dev };
    } catch {
      /* configurazione normale */
    }
  }
  return NAMES_CONFIG;
}
export const namesConfig = config;
/** Gli username sono attivi (il registro è deployato). */
export const namesActive = () => /^0x[0-9a-fA-F]{40}$/.test(config().address);

const NAME_RE = /^[A-Za-z0-9_]{3,20}$/;
/** Nome provvisorio di chi non ha uno username verificato (l'inizio della chiave: unico come la chiave). */
export const provisionalName = (pk) => `Duelist-${String(pk).slice(0, 6)}`;
/** Errore leggibile se il nome non va bene (prima di chiederlo al contratto), null se il formato è giusto. */
export function nameProblem(name) {
  if (!NAME_RE.test(name)) return "3–20 characters: letters, numbers and _";
  if (name.toLowerCase() === "duelist") return "Duelist is the default name: pick your own";
  return null;
}

// ---------------------------------------------------------------- ethers, provider e contratto

let lib = null;
const ethersLib = () => (lib ??= import("ethers").then((m) => m.ethers));
let artifact = null;
const abi = () => (artifact ??= import("../data/names-contract.json").then((m) => m.default ?? m));

let readProvider = null;
async function provider() {
  if (readProvider) return readProvider;
  const ethers = await ethersLib();
  const c = config();
  const list = c.rpc.map((url) => new ethers.JsonRpcProvider(url, c.chainId, { staticNetwork: true }));
  readProvider = list.length > 1 ? new ethers.FallbackProvider(list.map((p, i) => ({ provider: p, priority: i + 1, stallTimeout: 2500 })), c.chainId, { quorum: 1 }) : list[0];
  return readProvider;
}

export async function contract(runner = null) {
  const ethers = await ethersLib();
  return new ethers.Contract(config().address, (await abi()).abi, runner ?? (await provider()));
}

/** Messaggio leggibile da un errore del contratto o del wallet. */
export async function friendlyError(e) {
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001 || e?.info?.error?.code === 4001) return "Cancelled in the wallet";
  if (e?.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(e?.message ?? "")) return "Not enough ETH in this wallet to pay the gas";
  let name = e?.revert?.name;
  if (!name && typeof e?.data === "string") {
    try {
      name = (await contract()).interface.parseError(e.data)?.name;
    } catch {
      /* non è un errore del contratto */
    }
  }
  const text = {
    BadName: "This name is not valid (3–20 letters, numbers or _, not Duelist)",
    NameTaken: "This name is already taken",
    AlreadyRegistered: "This wallet already has a name (free it first to take another)",
    BadCommitment: "The first step is missing or too old: start again",
    Expired: "The authorization expired: ask for a new one",
    BadSignature: "The signature is not valid (or was already used)",
    NotRegistered: "This wallet has no name yet",
    CardExists: "This player already has a card",
    BadBio: "The line can use only plain characters (no < > & \" \\), at most 48",
    BadNostrKey: "Invalid Nostr key",
  }[name];
  return text ?? e?.shortMessage ?? e?.message ?? String(e);
}

// ---------------------------------------------------------------- lettura

/** Registrazione di un nome: { owner, nostr, display } (owner = 0x0… se è libero). */
export async function lookup(name) {
  const r = await (await contract()).lookup(name);
  return { owner: r.owner, nostr: r.nostr, atBlock: Number(r.atBlock), number: Number(r.number), display: r.display };
}

export async function nameOfWallet(address) {
  const r = await (await contract()).nameOfOwner(address);
  return { name: r.display, nostr: r.nostr, number: Number(r.number) };
}

/** La card del wallet (null se non l'ha), con l'immagine SVG (data URL) e i metadati. */
export async function cardOfWallet(address) {
  const c = await contract();
  const r = await c.cardOf(address);
  if (r.tokenId === 0n) return null;
  const meta = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob((await c.tokenURI(r.tokenId)).split(",")[1]), (ch) => ch.charCodeAt(0))));
  return { tokenId: r.tokenId, number: Number(r.card.number), og: r.card.og, decks: r.card.decks.length, image: meta.image, name: meta.name };
}

// ---------------------------------------------------------------- nomi verificati (cache)

const verified = new Map(); // pk → { name, wallet, number, at } o { name: null, at }
/** I primi OG_LIMIT username registrati sono gli OG (contracts/HeliosNames.sol). */
export const OG_LIMIT = 100;
const pendingChecks = new Map();
const TTL = 10 * 60 * 1000;

/** Nome verificato di un giocatore (null se non ne ha uno): profilo Nostr e registro devono dire la stessa cosa. */
export function verifiedName(pk, { fresh = false } = {}) {
  if (!namesActive()) return Promise.resolve(null);
  const c = verified.get(pk);
  if (!fresh && c && Date.now() - c.at < TTL) return Promise.resolve(c.name);
  if (pendingChecks.has(pk)) return pendingChecks.get(pk);
  const job = (async () => {
    let name = null;
    let wallet = null;
    let number = 0;
    try {
      const { fetchProfile } = await import("./public-profile.js");
      const p = await fetchProfile(pk, { fresh });
      if (p?.username && p?.wallet) {
        const r = await lookup(p.username);
        if (r.owner.toLowerCase() === p.wallet.toLowerCase() && r.nostr.toLowerCase() === `0x${pk}`) {
          name = r.display;
          wallet = r.owner;
          number = r.number;
        }
      }
    } catch {
      return verified.get(pk)?.name ?? null; // rete: si riprova la prossima volta
    }
    verified.set(pk, { name, wallet, number, at: Date.now() });
    return name;
  })().finally(() => pendingChecks.delete(pk));
  pendingChecks.set(pk, job);
  return job;
}

/** Verifica più giocatori (per gli elenchi); poi displayName li mostra con il nome giusto. */
export async function resolveNames(pks) {
  if (!namesActive()) return;
  const list = [...new Set(pks)].filter(Boolean);
  for (let i = 0; i < list.length; i += 6) await Promise.all(list.slice(i, i + 6).map((pk) => verifiedName(pk).catch(() => null)));
}

/**
 * Nome da mostrare per un giocatore: lo username verificato, altrimenti "Duelist-xxxxxx". Senza registro (non ancora
 * deployato) il nome dichiarato, come prima.
 */
export function displayName(pk, claimed = "") {
  if (!namesActive()) return claimed || "Duelist";
  if (pk === identity().pk && settings.username) return settings.username;
  return verified.get(pk)?.name ?? provisionalName(pk);
}

/** Lo username verificato di un giocatore è in cache (per mostrare il segno di spunta). */
export const isVerified = (pk) => !!verified.get(pk)?.name || (pk === identity().pk && !!settings.username);

/** Numero della registrazione dello username verificato (0 se non c'è): i primi OG_LIMIT sono OG. */
export const usernameNumber = (pk) => (pk === identity().pk && settings.username ? settings.usernameNumber || 0 : verified.get(pk)?.number || 0);

// ---------------------------------------------------------------- wallet che firmano e pagano

/** Il wallet del profilo (dalle 12 parole), collegato alla rete: firma e paga da sé se ha ETH. */
export async function heliosSigner() {
  if (!identity().seed) throw new Error("This profile has no seed words: use a browser wallet");
  const ethers = await ethersLib();
  const { bip39Seed, ethPrivateKey } = await import("./wallets.js");
  return new ethers.Wallet(ethPrivateKey(bip39Seed(identity().seed)), await provider());
}

/** Il wallet del browser collegato (net/web-wallet.js), sulla rete del registro. */
export async function browserSigner() {
  const { savedWallet, discoverWallets } = await import("./web-wallet.js");
  const s = savedWallet();
  if (!s) throw new Error("Connect a browser wallet first (Settings → Profile → Wallets)");
  const w = (await discoverWallets()).find((x) => (x.info.rdns || x.info.uuid || x.info.name) === s.id);
  if (!w) throw new Error(`${s.name} is not available: unlock it, or reload the page`);
  const want = "0x" + config().chainId.toString(16);
  if ((await w.provider.request({ method: "eth_chainId" })) !== want) await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  const ethers = await ethersLib();
  return new ethers.BrowserProvider(w.provider).getSigner();
}

/** Saldo ETH di un indirizzo (wei). */
export async function balanceOf(address) {
  return (await provider()).getBalance(address);
}

// ---------------------------------------------------------------- scrittura (due passi)

const PENDING = "ygoweb.namePending"; // registrazioni a metà (commit fatto): si riprendono se la pagina si chiude
const readPending = () => {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const writePending = (list) => {
  try {
    localStorage.setItem(PENDING, JSON.stringify(list.slice(-10)));
  } catch {
    /* storage pieno */
  }
};
export const pendingRegistrations = () => readPending().filter((p) => Date.now() / 1000 - p.at < 86400);

// Limite di gas: la stima della rete più il 30% (le regole del gas cambiano: su Sepolia, con i prezzi nuovi della
// creazione di dati, commit costa ~128k invece di ~45k). Se la stima non riesce (es. blockchain locale che stima con
// un tempo vecchio), un limite largo: il gas non usato non si paga.
const GAS_FALLBACK = { commit: 400000n, register: 1500000n, registerFor: 1800000n, mint: 4000000n, mintFor: 4000000n, setStyle: 4000000n };
async function gasLimit(c, fn, args) {
  try {
    return ((await c[fn].estimateGas(...args)) * 13n) / 10n + 10000n;
  } catch {
    return GAS_FALLBACK[fn];
  }
}

/** Aspetta che la blockchain arrivi a `ts` (secondi): steps(text) per il conto alla rovescia. */
async function waitUntil(ts, steps) {
  const p = await provider();
  for (;;) {
    const b = await p.getBlock("latest");
    const left = ts - Number(b.timestamp);
    if (left <= 0) return;
    steps?.(`Waiting ${left} s before the second step (it stops anyone from stealing the name)…`);
    await new Promise((r) => setTimeout(r, Math.min(5000, Math.max(1000, left * 1000))));
  }
}

async function sendAndWait(promise, steps, label) {
  const tx = await promise;
  steps?.(`${label}: waiting for the block… (${tx.hash.slice(0, 10)}…)`);
  const r = await tx.wait();
  if (r.status !== 1) throw new Error(`${label} failed`);
  return r;
}

/**
 * Registra `name` per il wallet di `signer` (lo paga lui) o, con `auth` (firma del giocatore), per chi l'ha firmata
 * (lo paga l'amico). steps(text): a che punto è. Restituisce { name, owner }.
 */
export async function registerName(signer, name, { auth = null, steps } = {}) {
  const ethers = await ethersLib();
  const c = await contract(signer);
  const payer = await signer.getAddress();
  const owner = auth?.owner ?? payer;
  const nostr = auth?.nostr ?? `0x${identity().pk}`;
  const free = await lookup(name);
  if (free.owner !== ethers.ZeroAddress) throw new Error("This name is already taken");
  // ripresa: un commit fatto prima (stessi dati) vale ancora
  let pend = pendingRegistrations().find((p) => p.name.toLowerCase() === name.toLowerCase() && p.owner === owner && p.payer === payer);
  if (!pend) {
    const secret = ethers.hexlify(ethers.randomBytes(32));
    const cm = await c.makeCommitment(name, owner, nostr, secret, payer);
    steps?.("Step 1 of 2: confirm in the wallet");
    const r = await sendAndWait(c.commit(cm, { gasLimit: await gasLimit(c, "commit", [cm]) }), steps, "Step 1");
    const at = Number((await r.getBlock()).timestamp);
    pend = { name, owner, nostr, secret, payer, at };
    writePending([...readPending(), pend]);
  }
  await waitUntil(pend.at + 61, steps);
  steps?.("Step 2 of 2: confirm in the wallet");
  const args = auth ? [name, owner, nostr, pend.secret, auth.deadline, auth.sig] : [name, nostr, pend.secret];
  const fn = auth ? "registerFor" : "register";
  await c[fn].staticCall(...args, { blockTag: "latest" }); // errore vero del contratto prima di spendere gas
  await sendAndWait(c[fn](...args, { gasLimit: await gasLimit(c, fn, args) }), steps, "Step 2");
  writePending(readPending().filter((p) => p !== pend && !(p.name === pend.name && p.owner === pend.owner && p.payer === pend.payer)));
  return { name, owner };
}

/** Il giocatore firma (gratis) il permesso a un amico di pagargli `name`: { owner, nostr, name, deadline, sig }. */
export async function signNameRequest(signer, name, days = 3) {
  const c = await contract();
  const owner = await signer.getAddress();
  const nostr = `0x${identity().pk}`;
  const deadline = Math.floor(Date.now() / 1000) + days * 86400;
  const nonce = await c.nonces(owner);
  const sig = await signer.signTypedData(await domain(), { Register: [{ name: "name", type: "string" }, { name: "nostr", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }, { name, nostr, nonce, deadline });
  return { kind: "register", name, owner, nostr, deadline, sig };
}

/**
 * Il giocatore firma il permesso a un amico di pagargli la card: { kind, owner, card, deadline, sig }. La firma copre
 * l'impronta di tutti i dati (cardHash del contratto: immagini e mazzi compresi).
 */
export async function signCardRequest(signer, card, days = 3) {
  const c = await contract();
  const owner = await signer.getAddress();
  const deadline = Math.floor(Date.now() / 1000) + days * 86400;
  const nonce = await c.nonces(owner);
  const hash = await c.cardHash(card);
  const sig = await signer.signTypedData(await domain(), { Mint: [{ name: "card", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }, { card: hash, nonce, deadline });
  return { kind: "card", owner, card, deadline, sig };
}

async function domain() {
  return { name: "HeliosNames", version: "1", chainId: config().chainId, verifyingContract: config().address };
}

/**
 * Conia la card: per sé (card = cardInput) o per l'amico che l'ha firmata (auth). card: { color, pattern, bio, xmr,
 * avatar, decks: [{ name, main, extra, cover }] } con le immagini come byte esadecimali (hex di un data URL).
 */
export async function mintCard(signer, card, { auth = null, steps } = {}) {
  const c = await contract(signer);
  steps?.("Confirm in the wallet");
  const args = auth ? [auth.owner, auth.card, auth.deadline, auth.sig] : [card];
  const fn = auth ? "mintFor" : "mint";
  await c[fn].staticCall(...args, { blockTag: "latest" });
  await sendAndWait(c[fn](...args, { gasLimit: await gasLimit(c, fn, args) }), steps, "Card");
}

/**
 * Anteprima esatta di una card, disegnata dal renderer del contratto (chiamata in sola lettura, gratis): restituisce
 * un data URL SVG. card: i dati di conio/aggiornamento (CardInput); owner: il wallet del nome.
 */
export async function previewCard(card, owner) {
  const ethers = await ethersLib();
  const c = await contract();
  const [rendererAddress, name, block] = await Promise.all([c.renderer(), c.nameOfOwner(owner), (await provider()).getBlockNumber()]);
  const reg = await lookup(name.display);
  const renderer = new ethers.Contract(rendererAddress, (await abi()).rendererAbi, await provider());
  const view = {
    name: reg.display, number: reg.number, og: reg.number > 0 && reg.number <= OG_LIMIT, nostr: reg.nostr, owner, since: reg.atBlock,
    color: card.color, pattern: card.pattern, bio: card.bio, xmr: card.xmr, avatar: card.avatar,
    decks: card.decks.map((d) => ({ name: d.name, main: d.main, extra: d.extra, cover: d.cover })),
    rating: card.rating, peak: card.peak, games: card.games, rankedAt: block,
  };
  const bytes = new TextEncoder().encode(await renderer.svg(view));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:image/svg+xml;base64," + btoa(bin);
}

/** Aggiorna la propria card (setStyle): stessi dati del conio, la riscrive il wallet a cui è intestato il nome. */
export async function updateCard(signer, card, { steps } = {}) {
  const c = await contract(signer);
  steps?.("Confirm in the wallet");
  await c.setStyle.staticCall(card, { blockTag: "latest" });
  await sendAndWait(c.setStyle(card, { gasLimit: await gasLimit(c, "setStyle", [card]) }), steps, "Card");
}

/**
 * La card on-chain del wallet ha gli stessi dati di `card` (o di `card` con o senza XMR)? Confronta le impronte
 * (cardHash) dei dati salvati e di quelli nuovi. null se non c'è una card.
 */
export async function cardMatches(address, card) {
  const c = await contract();
  const r = await c.cardOf(address);
  if (r.tokenId === 0n) return null;
  const v = r.card;
  const onchain = { color: v.color, pattern: v.pattern, bio: v.bio, xmr: v.xmr, avatar: v.avatar, decks: v.decks.map((d) => ({ name: d.name, main: d.main, extra: d.extra, cover: d.cover })), rating: v.rating, peak: v.peak, games: v.games };
  const [a, b, noXmr] = await Promise.all([c.cardHash(onchain), c.cardHash(card), c.cardHash({ ...card, xmr: "" })]);
  return a === b || a === noXmr;
}

/** Il proprio username è registrato: si salva, si pubblica nel profilo e diventa il nome. */
export async function adoptUsername(name, wallet) {
  settings.username = name;
  settings.usernameWallet = wallet;
  settings.usernameNumber = await lookup(name).then((r) => r.number, () => 0);
  settings.name = name;
  verified.set(identity().pk, { name, wallet, at: Date.now() });
  const { schedulePublish } = await import("./public-profile.js");
  schedulePublish(300);
}

/** All'avvio: lo username salvato è ancora valido sul registro? Se no (liberato, profilo cambiato) si toglie. */
export async function checkMyUsername() {
  if (!namesActive()) return null;
  const me = identity().pk;
  if (settings.username && settings.usernameWallet) {
    try {
      const r = await lookup(settings.username);
      if (r.owner.toLowerCase() === settings.usernameWallet.toLowerCase() && r.nostr.toLowerCase() === `0x${me}`) {
        settings.usernameNumber = r.number;
        return settings.username;
      }
    } catch {
      return settings.username; // rete: si tiene
    }
  }
  // profilo appena importato (KeyTag, parole): il nome può essere già registrato su uno dei suoi wallet
  const wallets = [];
  try {
    if (identity().seed) wallets.push(await (await heliosSigner()).getAddress());
    const { savedWallet } = await import("./web-wallet.js");
    if (savedWallet()) wallets.push(savedWallet().address);
    for (const w of wallets) {
      const r = await nameOfWallet(w);
      if (r.name && r.nostr.toLowerCase() === `0x${me}`) {
        await adoptUsername(r.name, w);
        return r.name;
      }
    }
  } catch {
    /* rete: si riprova al prossimo avvio */
  }
  settings.username = "";
  settings.usernameWallet = "";
  settings.name = provisionalName(me);
  return null;
}
