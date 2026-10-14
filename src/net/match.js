// Accordo iniziale tra i due peer prima del duello:
//  - scambio di nomi, versione dei dati e mazzi;
//  - seed condiviso con commit-reveal (nessuno dei due può sceglierlo da solo);
//  - lancio della moneta e scelta di chi inizia.
import { db } from "../data/db.js";
import { banlistByName, validateDeck } from "../deck/deck.js";

export const PROTOCOL = 1;

/** Smista i messaggi del DataChannel per tipo, tenendo in coda quelli non ancora attesi. */
export class LinkMux {
  constructor(link) {
    this.link = link;
    this.handlers = new Map();
    this.queue = new Map();
    this.waiters = new Map();
    link.addEventListener("message", (e) => this.dispatch(e.detail));
  }

  dispatch(msg) {
    const t = msg?.t;
    const w = this.waiters.get(t)?.shift();
    if (w) return w(msg);
    const h = this.handlers.get(t);
    if (h) return h(msg);
    if (!this.queue.has(t)) this.queue.set(t, []);
    this.queue.get(t).push(msg);
  }

  on(t, fn) {
    this.handlers.set(t, fn);
    for (const m of this.queue.get(t)?.splice(0) ?? []) fn(m);
  }

  next(t, timeoutMs = 120000) {
    const q = this.queue.get(t);
    if (q?.length) return Promise.resolve(q.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${t}"`)), timeoutMs);
      const onClose = (e) => {
        clearTimeout(timer);
        reject(new Error(e.detail || "Connection closed"));
      };
      this.link.addEventListener("close", onClose, { once: true });
      if (!this.waiters.has(t)) this.waiters.set(t, []);
      this.waiters.get(t).push((m) => {
        clearTimeout(timer);
        this.link.removeEventListener("close", onClose);
        resolve(m);
      });
    });
  }

  send(msg) {
    this.link.send(msg);
  }

  onClose(fn) {
    this.link.addEventListener("close", (e) => fn(e.detail));
  }

  close() {
    this.link.close();
  }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function randomHex(n = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

function seedFrom(bytes) {
  const view = new DataView(bytes.buffer);
  const seed = [0, 8, 16, 24].map((o) => view.getBigUint64(o, true));
  if (seed.every((s) => s === 0n)) seed[0] = 1n;
  return seed.map(String);
}

/**
 * @param mux      LinkMux già connesso
 * @param opts     { host, name, deck, options: {mode, flags, lp, hand, draw, banlist} (solo host), chooseFirst() -> Promise<bool> }
 * @returns { duel, me, names, options }
 */
export async function negotiate(mux, opts) {
  const myRand = randomHex();
  mux.send({
    t: "hello",
    v: PROTOCOL,
    name: opts.name,
    data: db.manifest?.version ?? "?",
    deck: { main: opts.deck.main, extra: opts.deck.extra },
    commit: hex(await sha256(myRand)),
    options: opts.host ? opts.options : undefined,
  });
  const hello = await mux.next("hello");
  if (hello.v !== PROTOCOL) throw new Error("Protocol version mismatch: both players must update the client");
  const options = opts.host ? opts.options : hello.options;
  if (!options) throw new Error("The host did not send the Duel options");

  const sameData = hello.data === (db.manifest?.version ?? "?");
  const banlist = options.banlist ? banlistByName(options.banlist) : null;
  const theirErrors = validateDeck(hello.deck ? { ...hello.deck, side: [] } : { main: [], extra: [], side: [] }, banlist, { allowUnofficial: options.allowUnofficial });
  if (theirErrors.length) {
    mux.send({ t: "reject", reason: `Invalid Deck for banlist "${options.banlist || "none"}":\n${theirErrors.slice(0, 6).join("\n")}` });
    throw new Error(`Your opponent's Deck is invalid:\n${theirErrors.slice(0, 6).join("\n")}`);
  }
  mux.send({ t: "reveal", rand: myRand });
  const reveal = await Promise.race([
    mux.next("reveal"),
    mux.next("reject").then((r) => Promise.reject(new Error(r.reason))),
  ]);
  if (hex(await sha256(reveal.rand)) !== hello.commit) throw new Error("Your opponent's seed does not match their initial commitment");

  const hostRand = opts.host ? myRand : reveal.rand;
  const guestRand = opts.host ? reveal.rand : myRand;
  const digest = await sha256(`${hostRand}:${guestRand}`);
  const seed = seedFrom(digest);

  // Lancio della moneta deterministico: entrambi ottengono lo stesso risultato.
  const hostWinsToss = (digest[31] & 1) === 0;
  const iWinToss = hostWinsToss === opts.host;
  let hostFirst;
  if (iWinToss) {
    const goFirst = await opts.chooseFirst(true);
    hostFirst = opts.host ? goFirst : !goFirst;
    mux.send({ t: "first", hostFirst });
  } else {
    opts.chooseFirst(false);
    hostFirst = (await mux.next("first")).hostFirst;
  }
  const iAmFirst = hostFirst === opts.host;
  const myDeck = { main: opts.deck.main, extra: opts.deck.extra };
  const decks = iAmFirst ? [myDeck, hello.deck] : [hello.deck, myDeck];
  const names = iAmFirst ? [opts.name, hello.name] : [hello.name, opts.name];
  return {
    me: iAmFirst ? 0 : 1,
    names,
    sameData,
    iWinToss,
    options,
    duel: { flags: String(options.flags), seed, lp: options.lp, hand: options.hand, draw: options.draw, decks },
  };
}
