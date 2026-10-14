import { h, clear, icon } from "./dom.js";
import { toast, confirmModal } from "./modal.js";
import { hasDefaultTurn, settings, resetSettings, BUILD_SIGNAL_URL } from "../data/settings.js";
import { resolveIceServers } from "../net/signaling.js";
import { db } from "../data/db.js";

/** Raccoglie i candidati ICE per verificare che STUN/TURN funzionino. */
async function testIce(out) {
  out.textContent = "Testing...";
  const servers = await resolveIceServers();
  const pc = new RTCPeerConnection({ iceServers: servers });
  const found = { host: 0, srflx: 0, relay: 0 };
  const lines = [];
  pc.createDataChannel("test");
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const t = e.candidate.type;
    if (t in found) found[t]++;
    if (t !== "host") lines.push(`${t}: ${e.candidate.address ?? "?"}:${e.candidate.port ?? ""} (${e.candidate.protocol})`);
  };
  // 701 = indirizzo non risolvibile (di solito la ricerca IPv6 su reti solo IPv4): normale, non va mostrato.
  pc.onicecandidateerror = (e) => e.errorCode !== 701 && lines.push(`error ${e.errorCode} on ${e.url}: ${e.errorText}`);
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => {
    const t = setTimeout(r, 8000);
    pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && (clearTimeout(t), r());
  });
  pc.close();
  out.textContent = [
    `Servers tested: ${servers.map((s) => [s.urls].flat().join(", ")).join(" | ")}`,
    `Local: ${found.host} · STUN (srflx): ${found.srflx} · TURN (relay): ${found.relay}`,
    found.srflx ? "✓ STUN works: direct P2P connection is possible." : "✗ No STUN candidates.",
    found.relay ? "✓ TURN works: relay is available even behind strict NATs." : "· No TURN relay (configure one if direct connection fails).",
    ...lines,
  ].join("\n");
}

/** Scelta del TURN: Cloudflare (predefinito del sito), un server proprio, oppure nessuno. */
function turnPicker(field, text) {
  const custom = h(
    "div.turn-custom",
    field("TURN server (URL)", text("turnUrl", { placeholder: "turn:turn.example.com:3478" }), "Separate multiple URLs with spaces."),
    h("div.form-grid", field("TURN username", text("turnUser")), field("TURN password", text("turnPass", { type: "password" })))
  );
  const hint = h("small.muted");
  const select = h(
    "select.select",
    { onchange: (e) => { settings.turnMode = e.target.value; update(); } },
    h("option", { value: "cloudflare" }, "Cloudflare (default)"),
    h("option", { value: "custom" }, "Custom TURN server"),
    h("option", { value: "off" }, "None (STUN only)")
  );
  const update = () => {
    select.value = settings.turnMode ?? "cloudflare";
    custom.hidden = select.value !== "custom";
    hint.textContent = {
      cloudflare: hasDefaultTurn()
        ? "Relay through Cloudflare's TURN when a direct connection is not possible. Credentials are temporary and fetched automatically."
        : "Cloudflare TURN is not configured in this build (VITE_ICE_SERVERS_URL): only STUN will be used.",
      custom: "Relay through your own TURN server when a direct connection is not possible.",
      off: "No relay: Duels may fail to connect if both players are behind strict NATs.",
    }[select.value];
  };
  update();
  return h("div.field", h("span", "TURN server"), select, hint, custom);
}

export function showSettings(app) {
  const root = clear(app.root);
  const field = (label, input, hint) => h("label.field", h("span", label), input, hint && h("small.muted", hint));
  const text = (k, attrs = {}) => h("input.input", { value: settings[k] ?? "", ...attrs, oninput: (e) => (settings[k] = e.target.value) });
  const area = (k) => h("textarea.input", { rows: 3, value: settings[k] ?? "", oninput: (e) => (settings[k] = e.target.value) });
  const check = (k, label) => h("label.check", h("input", { type: "checkbox", checked: !!settings[k], onchange: (e) => (settings[k] = e.target.checked) }), label);
  const iceOut = h("pre.ice-out", "");

  root.append(
    h(
      "div.page.settings",
      h("div.page-head", h("button.btn.ghost.round", { title: "Menu", onclick: () => app.home() }, icon("chevron_left")), h("h1", "Settings")),
      h(
        "div.settings-grid",
        h(
          "section.card-box",
          h("h3", "General"),
          field("Duelist name", text("name", { maxLength: 24 })),
          field("Card image URL", text("imageUrl"), "{code} = card code. If an image is unavailable, a CSS frame is drawn instead."),
          field("Animation speed", h("input", { type: "range", min: 0, max: 2, step: 0.25, value: settings.animSpeed, oninput: (e) => (settings.animSpeed = +e.target.value) }), "0 = off"),
          check("autoPlace", "Auto-pick the zone when summoning/setting")
        ),
        h(
          "section.card-box",
          h("h3", "Network (WebRTC)"),
          field("STUN servers (one per line)", area("stun"), "Used to discover your public address for direct connection."),
          turnPicker(field, text),
          check("forceRelay", "Force TURN relay (for testing)"),
          field("Signaling server", text("signalUrl", { placeholder: BUILD_SIGNAL_URL || location.origin }), BUILD_SIGNAL_URL ? "Used for Online Rooms. Leave empty to use this site's default server." : "Used for Online Rooms. Empty = same address as this page. The server can also provide temporary TURN credentials."),
          h("div.row", h("button.btn.primary", { onclick: () => testIce(iceOut).catch((e) => (iceOut.textContent = e.message)) }, "Test STUN/TURN")),
          iceOut
        ),
        h(
          "section.card-box",
          h("h3", "Data"),
          h("p.muted", `Cards: ${db.cards.size} · Banlists: ${db.banlists.length} · Data version: ${db.manifest?.version}`),
          h("p.muted.small", `Built ${new Date(db.manifest?.built).toLocaleString("en-US")} from ProjectIgnis (CardScripts, BabelCDB, LFLists). Update with "npm run data".`),
          h("button.btn.danger", { onclick: async () => { if (await confirmModal("Reset Settings?", "Decks and data are not affected.", "Reset", "Cancel", { danger: true })) { resetSettings(); toast("Settings reset"); showSettings(app); } } }, "Reset Settings")
        )
      )
    )
  );
}
