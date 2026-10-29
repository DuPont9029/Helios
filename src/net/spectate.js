// Spettatori: gli amici guardano un duello (contro la CPU o online) e segnalano gli errori del giocatore.
// Il duello è deterministico: chi guarda riceve la configurazione (seed, mazzi, regole) e le risposte date al core
// e lo rigioca nel proprio motore, come i due giocatori in lockstep. Tutto passa dai relay Nostr come eventi
// sostituibili (NIP-78, d = "cfg", "r0", "r1"..., "end"): chi arriva a duello iniziato trova sui relay l'ultima
// versione di ognuno. Gli eventi sono firmati da una chiave usa e getta del duello e cifrati (NIP-44) con una chiave
// casuale; le due chiavi arrivano solo agli amici, dentro la presenza (social.js). Scadono dopo qualche ora (NIP-40).
// Senza spettatori non si pubblica niente: la trasmissione parte (con tutto il duello fin lì) al primo amico che guarda.
// Le segnalazioni tornano al giocatore come messaggi cifrati tra amici (social.js, sendWatch / onWatchMessage).
import { finalizeEvent, getPublicKey, generateSecretKey } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { db } from "../data/db.js";
import { toHex, fromHex } from "./identity.js";
import { publishEvent, subscribeRelays } from "./social.js";

const KIND = 30078;
const CHUNK = 250; // risposte per evento (restano sotto i 64 KB di NIP-44)
const FLUSH_MS = 1500; // al massimo un aggiornamento ogni tanto: i relay rifiutano le raffiche
const TTL_S = 8 * 3600;
const MAX_CHUNKS = 200;
const now = () => Math.floor(Date.now() / 1000);

/** Duello trasmesso agli amici dal giocatore. */
export class Broadcast {
  /**
   * @param cfg { duel, names, me, mode ("Vs CPU", "Online Duel"), match: { bestOf, game } | null, report (id del report) }
   */
  constructor(cfg) {
    this.sk = generateSecretKey();
    this.pk = getPublicKey(this.sk);
    this.key = crypto.getRandomValues(new Uint8Array(32));
    this.id = toHex(crypto.getRandomValues(new Uint8Array(8)));
    this.history = [];
    this.length = 0; // risposte definitive (le summon annullabili restano fuori finché non avvengono)
    this.sent = []; // lunghezza già pubblicata di ogni pezzo
    this.lastAt = 0;
    this.timer = 0;
    this.closed = false;
    this.active = false;
    this.cfg = {
      v: 1,
      duel: cfg.duel,
      names: cfg.names,
      me: cfg.me,
      mode: cfg.mode,
      match: cfg.match ? { bestOf: cfg.match.bestOf, game: cfg.match.game } : null,
      report: cfg.report,
      data: db.manifest?.version ?? "?",
    };
  }

  /** Un amico guarda: si pubblicano configurazione e risposte fin qui, poi gli aggiornamenti. */
  activate() {
    if (this.active || this.closed) return;
    this.active = true;
    this.put("cfg", this.cfg);
    this.flush();
  }

  /** Chiavi da mettere nella presenza (solo gli amici la leggono). */
  info() {
    return this.closed || this.ended ? null : { id: this.id, pk: this.pk, key: toHex(this.key) };
  }

  /** Risposte date al core: le prime `length` sono definitive. */
  update(history, length = history.length) {
    if (this.closed) return;
    this.history = history;
    this.length = Math.min(length, CHUNK * MAX_CHUNKS);
    if (this.active) this.schedule();
  }

  /** Fine del duello: { winner, reason, text, sub } (le uscite e le rese non si vedono dal motore). */
  end(result) {
    if (this.closed || this.ended) return;
    this.ended = { ...result, n: this.length };
    if (this.active) this.flush();
  }

  close() {
    if (this.ended && this.active) this.flush();
    this.closed = true;
    clearTimeout(this.timer);
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.closed || !this.active) return;
    for (let k = 0; k * CHUNK < this.length; k++) {
      const n = Math.min(CHUNK, this.length - k * CHUNK);
      if (this.sent[k] === n) continue;
      this.sent[k] = n;
      this.put(`r${k}`, { k, r: this.history.slice(k * CHUNK, k * CHUNK + n) });
    }
    if (this.ended && !this.endSent) {
      this.endSent = true;
      this.put("end", this.ended);
    }
  }

  put(d, data) {
    // Stesso secondo = il relay tiene l'evento con l'id più basso, non il più recente: le date crescono sempre.
    const at = (this.lastAt = Math.max(now(), this.lastAt + 1));
    const ev = finalizeEvent({
      kind: KIND,
      created_at: at,
      tags: [["d", d], ["expiration", String(at + TTL_S)]],
      content: nip44.v2.encrypt(JSON.stringify(data), this.key),
    }, this.sk);
    publishEvent(ev).then((n) => !n && console.warn(`Spectators: the relays did not accept "${d}"`));
  }
}

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** Configurazione ricevuta: solo la forma prevista (la manda un amico, ma passa dalla rete). */
function cleanCfg(c) {
  const codes = (a, max) => Array.isArray(a) && a.length <= max && a.every((x) => Number.isInteger(x) && x > 0);
  const d = c?.duel;
  if (c?.v !== 1 || !isObj(d) || !Array.isArray(d.decks) || d.decks.length !== 2 || !d.decks.every((x) => isObj(x) && codes(x.main, 200) && codes(x.extra, 50))) return null;
  if (!Array.isArray(d.seed) || d.seed.length !== 4 || !(c.me === 0 || c.me === 1) || !Array.isArray(c.names)) return null;
  return {
    duel: d,
    names: c.names.slice(0, 2).map((n) => String(n ?? "").slice(0, 40) || "Duelist"),
    me: c.me,
    mode: String(c.mode ?? "").slice(0, 40),
    match: isObj(c.match) && Number.isInteger(c.match.bestOf) && Number.isInteger(c.match.game) ? { bestOf: c.match.bestOf, game: c.match.game } : null,
    report: String(c.report ?? "").slice(0, 40),
    data: String(c.data ?? "?").slice(0, 100),
  };
}

/**
 * Guarda un duello trasmesso (info: { id, pk, key } dalla presenza dell'amico).
 * onConfig(cfg) una volta; onResponses(list) quando arrivano risposte nuove (sempre tutta la lista, in ordine);
 * onEnd({ winner, reason, text, sub, n }). Restituisce { close() }.
 */
export function watchStream(info, { onConfig, onResponses, onEnd }) {
  const key = fromHex(info.key);
  const chunks = [];
  let cfg = null;
  let ended = null;
  let count = 0;
  const responses = () => {
    const out = [];
    for (let k = 0; chunks[k]; k++) {
      out.push(...chunks[k]);
      if (chunks[k].length < CHUNK) break; // l'ultimo pezzo, ancora da riempire
    }
    return out;
  };
  const sub = subscribeRelays({ kinds: [KIND], authors: [info.pk] }, (ev) => {
    if (ev.pubkey !== info.pk || ev.content.length > 200000) return;
    const d = ev.tags.find((t) => t[0] === "d")?.[1] ?? "";
    let data;
    try {
      data = JSON.parse(nip44.v2.decrypt(ev.content, key));
    } catch {
      return;
    }
    if (d === "cfg") {
      if (cfg) return;
      cfg = cleanCfg(data);
      if (cfg) onConfig(cfg);
    } else if (/^r\d+$/.test(d)) {
      const k = Number(d.slice(1));
      if (data?.k !== k || k >= MAX_CHUNKS || !Array.isArray(data.r) || data.r.length > CHUNK) return;
      // Più relay, versioni diverse dello stesso pezzo: vale la più lunga (le risposte si aggiungono soltanto).
      if ((chunks[k]?.length ?? -1) >= data.r.length) return;
      chunks[k] = data.r;
    } else if (d === "end") {
      if (ended || !isObj(data) || !Number.isInteger(data.n)) return;
      ended = { winner: data.winner, reason: data.reason, text: data.text == null ? undefined : String(data.text).slice(0, 120), sub: data.sub == null ? undefined : String(data.sub).slice(0, 200), n: data.n };
      onEnd?.(ended);
      return;
    } else return;
    // Anche dopo la configurazione: i pezzi di risposte possono arrivare prima di lei (ordine dei relay).
    const list = responses();
    if (cfg && list.length > count) {
      count = list.length;
      onResponses(list);
    }
  });
  return {
    connected: !!sub,
    close: () => sub?.close(),
  };
}
