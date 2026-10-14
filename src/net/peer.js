// Collegamento WebRTC tra due giocatori: RTCPeerConnection + un DataChannel
// ordinato e affidabile per i messaggi del duello. STUN serve a scoprire
// l'indirizzo pubblico, TURN fa da relay quando la connessione diretta è
// impossibile (NAT simmetrici, reti aziendali, CGNAT mobile).

// JSON con supporto BigInt (le risposte del core possono contenerne).
export const encode = (obj) =>
  JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? { $big: v.toString() } : v));
export const decode = (text) =>
  JSON.parse(text, (_, v) => (v && typeof v === "object" && "$big" in v ? BigInt(v.$big) : v));

export class PeerLink extends EventTarget {
  /**
   * @param {RTCIceServer[]} iceServers
   * @param {{initiator: boolean, forceRelay?: boolean, trickle?: boolean, onSignal?: (data) => void}} opts
   *   trickle=false: aspetta la raccolta completa dei candidati (modalità codice invito).
   */
  constructor(iceServers, opts) {
    super();
    this.opts = opts;
    this.pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: opts.forceRelay ? "relay" : "all",
    });
    this.channel = null;
    this.pendingCandidates = [];
    this.closed = false;
    if (import.meta.env?.DEV) (globalThis.__links ??= []).push(this);

    if (opts.initiator) {
      this.attach(this.pc.createDataChannel("duel", { ordered: true }));
    } else {
      this.pc.ondatachannel = (e) => this.attach(e.channel);
    }
    this.pc.onicecandidate = (e) => {
      if (e.candidate && opts.trickle !== false) opts.onSignal?.({ candidate: e.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.dispatchEvent(new CustomEvent("state", { detail: s }));
      if (s === "failed" || s === "closed") this.close(s === "failed" ? "WebRTC connection failed (TURN server needed?)" : undefined);
    };
  }

  attach(channel) {
    this.channel = channel;
    channel.onopen = () => this.dispatchEvent(new Event("open"));
    channel.onclose = () => this.close("The data channel closed");
    channel.onmessage = (e) => {
      let msg;
      try {
        msg = decode(e.data);
      } catch {
        return;
      }
      this.dispatchEvent(new CustomEvent("message", { detail: msg }));
    };
  }

  /** Solo per chi avvia: crea l'offerta. In modalità non-trickle la restituisce completa. */
  async createOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    if (this.opts.trickle === false) {
      await this.iceGatheringDone();
      return this.pc.localDescription.toJSON();
    }
    this.opts.onSignal?.({ sdp: this.pc.localDescription.toJSON() });
    return null;
  }

  /** Gestisce un messaggio di segnalazione ricevuto dall'altro peer. */
  async handleSignal(data) {
    if (data.sdp) {
      await this.pc.setRemoteDescription(data.sdp);
      for (const c of this.pendingCandidates.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === "offer") {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        if (this.opts.trickle === false) {
          await this.iceGatheringDone();
          return this.pc.localDescription.toJSON();
        }
        this.opts.onSignal?.({ sdp: this.pc.localDescription.toJSON() });
      }
    } else if (data.candidate) {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.candidate).catch(() => {});
      else this.pendingCandidates.push(data.candidate);
    }
    return null;
  }

  iceGatheringDone(timeoutMs = 6000) {
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.pc.removeEventListener("icegatheringstatechange", check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => this.pc.iceGatheringState === "complete" && done();
      const timer = setTimeout(done, timeoutMs);
      this.pc.addEventListener("icegatheringstatechange", check);
    });
  }

  send(obj) {
    if (this.channel?.readyState === "open") this.channel.send(encode(obj));
  }

  /** Tipo di percorso scelto da ICE: "host" (LAN), "srflx" (diretto via STUN), "relay" (TURN). */
  async routeInfo() {
    const stats = await this.pc.getStats();
    let pair = null;
    stats.forEach((s) => {
      if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) stats.forEach((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded" && (pair = s));
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return {
      local: local?.candidateType,
      remote: remote?.candidateType,
      protocol: local?.protocol,
      rtt: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    };
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.channel?.close();
      this.pc.close();
    } catch {
      /* ignore */
    }
    this.dispatchEvent(new CustomEvent("close", { detail: reason }));
  }
}

// ------------------------------------------------------------- codici invito
// SDP compresso (deflate) + base64url: si incolla in chat senza server.

async function pipeBytes(bytes, stream) {
  const s = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function packSignal(desc) {
  const bytes = await pipeBytes(new TextEncoder().encode(JSON.stringify(desc)), new CompressionStream("deflate-raw"));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function unpackSignal(code) {
  const clean = code.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(clean + "===".slice((clean.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const json = await pipeBytes(bytes, new DecompressionStream("deflate-raw"));
  return JSON.parse(new TextDecoder().decode(json));
}
