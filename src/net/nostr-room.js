// Stanze online decentralizzate con Trystero (strategia Nostr): i due browser si trovano tramite relay Nostr
// pubblici, senza un server di segnalazione nostro. Il codice stanza ha 8 caratteri (quelle del server ne hanno 6)
// e fa anche da password: le offerte WebRTC viaggiano cifrate sui relay. Dopo la connessione il duello è P2P
// come con il server. TrysteroLink si comporta come PeerLink (send, eventi message/close, routeInfo).
// Se WebRTC non riesce a collegarsi (nessuna strada diretta né TURN) il duello passa dai relay Nostr
// (nostr-relay-link.js): più lento, ma senza server.
import { encode, decode, routeOf } from "./peer.js";
import { relayChannel } from "./nostr-relay-link.js";

const APP_ID = "helios-ygo";
// Trystero segnala "could not connect" anche quando la connessione sta per riuscire (es. le due offerte partite
// insieme: una si scarta). Prima di passare ai relay (molto più lenti) si aspetta ancora un po' l'avversario.
const JOIN_ERROR_GRACE_MS = 4000;
// Da quando si sa che l'avversario è nella stanza (vedi relayChannel, onPresent): WebRTC di solito si collega in
// 1-2 s, anche passando dal TURN; se non ce la fa entro così si passa ai relay senza aspettare l'errore di Trystero
// (che arriva dopo più di 20 s).
const WEBRTC_DEADLINE_MS = 12000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // come i codici del server: niente 0/O e 1/I
export const NOSTR_CODE_LENGTH = 8;

export const isNostrCode = (code) => String(code).trim().length === NOSTR_CODE_LENGTH;

export function newNostrCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(NOSTR_CODE_LENGTH));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

class TrysteroLink extends EventTarget {
  constructor(room, action, peerId) {
    super();
    this.room = room;
    this.action = action;
    this.peerId = peerId;
    this.closed = false;
    this.queue = []; // messaggi arrivati prima che il duello si metta in ascolto
  }

  /** RTCPeerConnection verso l'avversario (per le statistiche). */
  get pc() {
    return this.room.getPeers()[this.peerId];
  }

  receive(data) {
    let msg;
    try {
      msg = decode(data);
    } catch {
      return;
    }
    if (this.listening) this.dispatchEvent(new CustomEvent("message", { detail: msg }));
    else this.queue.push(msg);
  }

  addEventListener(type, fn, opts) {
    super.addEventListener(type, fn, opts);
    if (type === "message" && !this.listening) {
      this.listening = true;
      for (const msg of this.queue.splice(0)) this.dispatchEvent(new CustomEvent("message", { detail: msg }));
    }
  }

  send(obj) {
    if (!this.closed) this.action.send(encode(obj), { target: this.peerId }).catch(() => {});
  }

  async routeInfo() {
    return this.pc ? routeOf(this.pc) : null;
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.room.leave().catch(() => {});
    this.dispatchEvent(new CustomEvent("close", { detail: reason }));
  }
}

/**
 * Entra in una stanza Nostr (code = null: la crea). Stessa forma di connectViaServer.
 * @returns {{ ready: Promise<{link, host: boolean}>, room: Promise<string>, cancel(): void }}
 */
export function connectViaNostr({ room = null, iceServers, forceRelay = false, onStatus = () => {} }) {
  const host = !room;
  const code = room ? room.trim().toUpperCase() : newNostrCode();
  let troom = null;
  let link = null;
  let cancelled = false;
  let waitTimer = 0;
  let fallback = null; // canale sui relay (ripiego)
  let fallbackTimer = 0;
  let graceTimer = 0;
  let deadlineTimer = 0;

  const ready = new Promise((resolve, reject) => {
    onStatus("Connecting to the decentralized network (Nostr relays)...");
    // Ripiego sui relay: in ascolto da subito, così se l'altro ci passa lo segue anche questo client.
    const toRelays = (why) => {
      if (!fallback || link || cancelled) return;
      clearTimeout(waitTimer);
      onStatus(why);
      troom?.leave().catch(() => {});
      troom = null;
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => !link && reject(new Error("The direct connection failed and the Nostr relays did not connect the two players either. Try again.")), 30000);
    };
    const giveUpWebRTC = () => {
      if (link || cancelled || !fallback) return;
      fallback.request();
      toRelays("Direct connection not possible: connecting through the Nostr relays (slower)...");
    };
    relayChannel(code, {
      onPeer: () => toRelays("Direct connection not possible: your opponent is connecting through the Nostr relays..."),
      onPresent: () => {
        if (link || cancelled || deadlineTimer) return;
        deadlineTimer = setTimeout(giveUpWebRTC, WEBRTC_DEADLINE_MS);
      },
    }).then((ch) => {
      if (cancelled) return ch.close();
      fallback = ch;
      ch.ready.then((l) => {
        if (cancelled || link) return l.close();
        clearTimeout(fallbackTimer);
        link = l;
        onStatus("Connected through the Nostr relays!");
        resolve({ link, host });
      });
    });
    import("trystero/nostr")
      .then(({ joinRoom }) => {
        if (cancelled) return;
        troom = joinRoom(
          { appId: APP_ID, password: code, rtcConfig: { iceServers, iceTransportPolicy: forceRelay ? "relay" : "all" } },
          code,
          {
            onJoinError: (e) => {
              console.warn("Trystero:", e.error);
              if (link || cancelled || graceTimer) return;
              // WebRTC non si collega (es. nessun TURN): si passa ai relay invece di rinunciare, ma solo se
              // l'avversario non arriva nemmeno nei secondi successivi (l'errore può essere un falso allarme).
              if (/could not connect|SDP|ICE|TURN|handshake/i.test(String(e.error))) {
                onStatus("Direct connection is taking longer than usual...");
                graceTimer = setTimeout(() => {
                  if (link || cancelled) return;
                  if (!fallback) return reject(new Error(`Unable to join the Room: ${e.error}`));
                  giveUpWebRTC();
                }, JOIN_ERROR_GRACE_MS);
              } else reject(new Error(`Unable to join the Room: ${e.error}`));
            },
          }
        );
        const action = troom.makeAction("duel", {
          onMessage: (data, { peerId }) => {
            if (link && peerId === link.peerId) link.receive(data);
          },
        });
        troom.onPeerJoin = (peerId) => {
          if (link || cancelled) return; // stanza da 2 giocatori: gli altri si ignorano
          clearTimeout(waitTimer);
          clearTimeout(graceTimer);
          clearTimeout(deadlineTimer);
          link = new TrysteroLink(troom, action, peerId);
          fallback?.close();
          onStatus("Connected!");
          resolve({ link, host });
        };
        troom.onPeerLeave = (peerId) => {
          if (link && peerId === link.peerId) link.close("Your opponent left the Room");
        };
        if (host) onStatus(`Room ${code} created (decentralized). Waiting for opponent...`);
        else {
          onStatus(`Looking for Room ${code} on the Nostr relays...`);
          waitTimer = setTimeout(() => onStatus(`Still looking for Room ${code}: check the code, and that the host is still waiting.`), 25000);
        }
      })
      .catch(reject);
  });

  return {
    ready,
    room: Promise.resolve(code),
    cancel() {
      cancelled = true;
      clearTimeout(waitTimer);
      clearTimeout(fallbackTimer);
      clearTimeout(graceTimer);
      clearTimeout(deadlineTimer);
      if (!(link && fallback && link.ch === fallback)) fallback?.close();
      if (link) link.close();
      else troom?.leave().catch(() => {});
    },
  };
}
