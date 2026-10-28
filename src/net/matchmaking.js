// Matchmaking con giocatori sconosciuti, senza server: sui relay Nostr (gli stessi di amici e classifica).
//
// - Chi cerca un duello pubblica un annuncio ("seek", NIP-78) firmato con la propria chiave, con le regole
//   scelte e la versione dei dati: si rinnova ogni 30 s e scade da solo (NIP-40), "off" quando si smette.
// - Si incontrano solo annunci con le stesse regole (stessa "coda"). Per non abbinarsi in due contro uno, propone
//   sempre chi ha la chiave pubblica più piccola: offerta → accetto → conferma con il codice di una stanza Nostr.
//   Chi aspetta una risposta rifiuta le altre offerte; chi ha la chiave più grande di tutti aspetta e basta.
// - Offerte, risposte e conferme viaggiano cifrate (gift wrap NIP-59, social.js), il duello poi è P2P come sempre.
import { identity, sha256Hex, canonical } from "./identity.js";
import { onDirect, sendDirect, publishSigned, subscribeRelays } from "./social.js";

const KIND = 30078;
const TAG = "helios-mm-v1";
const D = "helios-seek";
const REFRESH_S = 30;
const ACTIVE_S = 75; // un annuncio vale se rinnovato da meno di così
const ANSWER_MS = 9000; // attesa di una risposta (accetto, conferma)
const COOLDOWN_MS = 45000; // chi non ha risposto non si riprova subito
const HEX64 = /^[0-9a-f]{64}$/;
const ROOM = /^[A-HJ-NP-Z2-9]{8}$/;

const now = () => Math.floor(Date.now() / 1000);
const cleanName = (n) => String(n ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "Duelist";

/** Regole di un annuncio: solo i campi noti, con valori di forma giusta. */
export function cleanRules(r) {
  const str = (v, n = 60) => (typeof v === "string" ? v.slice(0, n) : "");
  const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  return {
    mode: str(r?.mode, 12),
    banlist: str(r?.banlist, 60),
    timer: str(r?.timer, 20),
    bestOf: int(r?.bestOf, 1, 15, 1),
    lp: int(r?.lp, 1, 999999, 8000),
    hand: int(r?.hand, 0, 20, 5),
    draw: int(r?.draw, 0, 10, 1),
    unofficial: r?.unofficial === true,
    ranked: r?.ranked === true,
    ...(Number.isInteger(r?.pointCap) && r.pointCap >= 0 && r.pointCap <= 10000 ? { pointCap: r.pointCap } : {}),
  };
}

/** Identificativo della coda: stesse regole e stessi dati = stessa coda. */
export const queueOf = (rules, data) => sha256Hex(canonical({ rules: cleanRules(rules), data: String(data) })).then((h) => h.slice(0, 32));

/**
 * Tutti gli annunci attivi sui relay (per la lista "chi sta cercando"), aggiornati dal vivo.
 * onChange(list): list = [{ pk, name, rules, data, queue, at }]. Restituisce stop().
 */
export function watchSeeks(onChange) {
  const seeks = new Map();
  const emit = () => {
    const t = now();
    for (const [pk, s] of seeks) if (t - s.at > ACTIVE_S) seeks.delete(pk);
    onChange([...seeks.values()]);
  };
  const sub = subscribeRelays({ kinds: [KIND], "#t": [TAG], since: now() - ACTIVE_S }, async (ev) => {
    if (!HEX64.test(ev.pubkey) || ev.content.length > 4000 || ev.created_at > now() + 60) return;
    let c;
    try {
      c = JSON.parse(ev.content);
    } catch {
      return;
    }
    const old = seeks.get(ev.pubkey);
    if (old && old.at >= ev.created_at) return;
    if (c?.status !== "searching") {
      if (old) seeks.delete(ev.pubkey), emit();
      return;
    }
    const rules = cleanRules(c.rules);
    const data = String(c.data ?? "").slice(0, 40);
    seeks.set(ev.pubkey, { pk: ev.pubkey, name: cleanName(c.name), rules, data, queue: await queueOf(rules, data), at: ev.created_at });
    emit();
  });
  const timer = setInterval(emit, 10000);
  return () => {
    clearInterval(timer);
    sub?.close();
  };
}

/**
 * Cerca un avversario con queste regole. Callbacks:
 *  - onStatus(text)
 *  - createRoom(): Promise<code> — chi propone crea la stanza Nostr quando l'altro accetta;
 *  - onMatch({ room, host, opponent: { pk, name } }) — host: true per chi ha creato la stanza (il guest ci entra).
 * Restituisce { stop() }.
 */
export async function findMatch({ rules, data, name, onStatus = () => {}, createRoom, onMatch }) {
  const me = identity().pk;
  rules = cleanRules(rules);
  const queue = await queueOf(rules, data);
  let state = "searching"; // searching | proposing | accepted | matched | stopped
  let pending = null; // proposing: { id, pk, timer } — accepted: { id, pk, timer }
  const cooldown = new Map(); // pk → fino a quando non riprovarlo
  let others = [];

  const seekEvent = (status) => publishSigned({
    kind: KIND,
    created_at: now(),
    tags: [["d", D], ["t", TAG], ["q", queue], ["expiration", String(now() + ACTIVE_S + 30)]],
    content: JSON.stringify({ v: 1, status, name: cleanName(name), rules, data }),
  });
  const announce = () => state === "searching" || state === "proposing" || state === "accepted" ? seekEvent("searching") : null;
  const refresh = setInterval(announce, REFRESH_S * 1000);
  announce();

  const stopWatch = watchSeeks((list) => {
    others = list.filter((s) => s.pk !== me && s.queue === queue);
    if (state === "searching") onStatus(others.length ? `Searching… ${others.length} other player${others.length === 1 ? "" : "s"} with these rules` : "Searching for an opponent with these rules…");
    tryPropose();
  });

  const back = (why) => {
    if (state === "matched" || state === "stopped") return;
    clearTimeout(pending?.timer);
    pending = null;
    state = "searching";
    onStatus(why ?? "Searching for an opponent with these rules…");
    setTimeout(tryPropose, 500 + Math.random() * 1500);
  };

  function tryPropose() {
    if (state !== "searching") return;
    const t = Date.now();
    const target = others
      .filter((s) => s.pk > me && (cooldown.get(s.pk) ?? 0) < t)
      .sort((a, b) => a.at - b.at)[0];
    if (!target) return;
    const id = crypto.getRandomValues(new Uint32Array(2)).join("-");
    state = "proposing";
    pending = { id, pk: target.pk, name: target.name, timer: setTimeout(() => { cooldown.set(target.pk, Date.now() + COOLDOWN_MS); back(); }, ANSWER_MS) };
    onStatus(`Opponent found: ${target.name}. Waiting for their client…`);
    sendDirect(target.pk, { t: "mm-offer", id, queue });
  }

  const finish = (m) => {
    state = "matched";
    clearTimeout(pending?.timer);
    pending = null;
    cleanup();
    seekEvent("off");
    onMatch(m);
  };

  const offDirect = onDirect(async (m) => {
    if (state === "matched" || state === "stopped" || !HEX64.test(m.from) || typeof m.id !== "string" || m.id.length > 40) return;
    const seek = others.find((s) => s.pk === m.from);
    switch (m.t) {
      case "mm-offer": {
        // Offerta da chi ha la chiave più piccola, nella stessa coda e con un annuncio attivo.
        if (m.queue !== queue || !seek || !(m.from < me) || state !== "searching") return void sendDirect(m.from, { t: "mm-decline", id: m.id });
        state = "accepted";
        pending = { id: m.id, pk: m.from, name: seek.name, timer: setTimeout(() => back("The opponent did not confirm: searching again…"), ANSWER_MS) };
        onStatus(`Opponent found: ${seek.name}. Waiting for the Room…`);
        sendDirect(m.from, { t: "mm-accept", id: m.id });
        return;
      }
      case "mm-accept": {
        if (state !== "proposing" || pending?.id !== m.id || pending.pk !== m.from) return;
        clearTimeout(pending.timer);
        const opp = { pk: m.from, name: pending.name };
        state = "matched";
        let room;
        try {
          room = await createRoom();
        } catch (e) {
          sendDirect(m.from, { t: "mm-decline", id: m.id });
          state = "searching";
          back(`Could not create the Room: ${e.message}`);
          return;
        }
        sendDirect(m.from, { t: "mm-confirm", id: m.id, room });
        finish({ room, host: true, opponent: opp });
        return;
      }
      case "mm-decline":
        // Rifiuto dell'offerta, o chi aveva proposto ha smesso di cercare.
        if ((state === "proposing" || state === "accepted") && pending?.id === m.id && pending.pk === m.from) {
          cooldown.set(m.from, Date.now() + COOLDOWN_MS / 3);
          back();
        }
        return;
      case "mm-confirm":
        if (state !== "accepted" || pending?.id !== m.id || pending.pk !== m.from || !ROOM.test(m.room ?? "")) return;
        finish({ room: m.room, host: false, opponent: { pk: m.from, name: pending.name } });
    }
  });

  function cleanup() {
    clearInterval(refresh);
    stopWatch();
    offDirect();
  }

  return {
    stop() {
      if (state === "matched" || state === "stopped") return;
      if ((state === "proposing" || state === "accepted") && pending) sendDirect(pending.pk, { t: "mm-decline", id: pending.id });
      clearTimeout(pending?.timer);
      state = "stopped";
      cleanup();
      seekEvent("off");
    },
  };
}
