// Cloudflare Worker: genera credenziali TURN temporanee per Helios.
// Il token di Cloudflare resta qui come secret: il sito (es. GitHub Pages) chiama
// questo Worker e riceve solo credenziali che scadono dopo TTL secondi.
//
// Secret (wrangler secret put ...):  TURN_KEY_ID, TURN_KEY_API_TOKEN
// Variabili (wrangler.toml):         ALLOWED_ORIGINS, TTL

const API = "https://rtc.live.cloudflare.com/v1/turn/keys";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    // I browser mandano l'host in minuscolo: il confronto ignora le maiuscole (es. "DuPont9029.github.io").
    const allowed = String(env.ALLOWED_ORIGINS || "").split(/[\s,]+/).filter(Boolean).map((o) => o.replace(/\/+$/, "").toLowerCase());
    const okOrigin = allowed.includes(origin.toLowerCase());
    const cors = okOrigin ? { "access-control-allow-origin": origin, vary: "Origin" } : {};

    if (request.method === "OPTIONS") {
      return new Response(null, { status: okOrigin ? 204 : 403, headers: { ...cors, "access-control-allow-methods": "GET", "access-control-max-age": "86400" } });
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    // Solo le pagine del sito possono chiedere credenziali (un client fuori dal browser può falsificare
    // l'Origin, ma ottiene comunque solo credenziali a scadenza: il token non esce mai da qui).
    if (!okOrigin) return new Response("Forbidden", { status: 403 });

    const res = await fetch(`${API}/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: Number(env.TTL) || 14400 }),
    });
    if (!res.ok) return new Response("TURN credentials unavailable", { status: 502, headers: cors });

    const data = await res.json();
    // Il client non usa il trickle ICE: gli URL sulla porta 53 (bloccata dai browser) farebbero solo aspettare.
    const iceServers = (data.iceServers ?? []).map((s) => ({
      ...s,
      urls: [s.urls].flat().filter((u) => !/:53(\?|$)/.test(u)),
    })).filter((s) => s.urls.length);
    return Response.json({ iceServers }, { headers: { ...cors, "cache-control": "no-store" } });
  },
};
