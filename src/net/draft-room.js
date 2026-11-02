// Stanza di un draft online: una stanza Trystero (strategia Nostr, come le stanze dei duelli in nostr-room.js) con
// più giocatori collegati tutti con tutti. Il codice della stanza fa anche da password. NetDraft (draft/net-draft.js)
// ci parla con send / broadcast / on; chi entra ed esce arriva da onJoin / onLeave.
import { encode, decode } from "./peer.js";
import { newNostrCode } from "./nostr-room.js";

const APP_ID = "helios-ygo-draft";

/**
 * @returns {Promise<{ code, selfId, send, broadcast, on, onJoin, onLeave, peers(), leave() }>}
 */
export async function openDraftRoom({ code = null, iceServers = [], forceRelay = false } = {}) {
  const room = (code ?? newNostrCode()).trim().toUpperCase();
  const { joinRoom, selfId } = await import("trystero/nostr");
  const handlers = new Set();
  const joins = new Set();
  const leaves = new Set();
  const troom = joinRoom({ appId: APP_ID, password: room, rtcConfig: { iceServers, iceTransportPolicy: forceRelay ? "relay" : "all" } }, room, {
    onJoinError: (e) => console.warn("Draft room:", e.error),
  });
  const action = troom.makeAction("draft", {
    onMessage: (data, { peerId }) => {
      let msg;
      try {
        msg = decode(data);
      } catch {
        return;
      }
      for (const fn of handlers) fn(msg, peerId);
    },
  });
  troom.onPeerJoin = (peerId) => joins.forEach((fn) => fn(peerId));
  troom.onPeerLeave = (peerId) => leaves.forEach((fn) => fn(peerId));
  const sub = (set) => (fn) => {
    set.add(fn);
    return () => set.delete(fn);
  };
  return {
    code: room,
    selfId,
    send: (peerId, msg) => action.send(encode(msg), { target: peerId }).catch(() => {}),
    broadcast: (msg) => action.send(encode(msg)).catch(() => {}),
    on: sub(handlers),
    onJoin: sub(joins),
    onLeave: sub(leaves),
    peers: () => Object.keys(troom.getPeers()),
    leave: () => troom.leave().catch(() => {}),
  };
}
