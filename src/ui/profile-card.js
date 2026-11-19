// Scheda di un giocatore: immagine, nome e frase dal suo profilo pubblico (net/public-profile.js), statistiche ELO
// (net/elo.js: le stesse della classifica), i mazzi che gioca online (nel deck viewer) e le azioni: chiedere
// l'amicizia, accettare una richiesta, mandargli crypto (se ha pubblicato gli indirizzi), condividerla.
// La stessa scheda si apre in una finestra (amici, classifica) o da sola in una pagina, dal link breve
// https://…/#p/<primi 10 caratteri della chiave> (showProfilePage, aperta da main.js).
import { h, clear, icon } from "./dom.js";
import { openModal, toast } from "./modal.js";
import { cardFace } from "./card.js";
import { openDeckViewer } from "./editor.js";
import { identity, npubOf, shortKey, pubkeyFrom } from "../net/identity.js";
import { copyText } from "../net/clipboard.js";
import { fetchProfile, cachedProfile, findProfileByCode, profileCode } from "../net/public-profile.js";
import { socialState, addFriend, acceptRequest, declineRequest, presenceOf, onSocialChange } from "../net/social.js";
import { cachedLeaderboard, START_RATING } from "../net/elo.js";
import { titleOf, MASTER_TITLES } from "../data/titles.js";
export { titleOf };

const SITE = "https://ygoweb.eu/";

/** Link breve alla scheda del giocatore. */
export const profileLink = (pk) => `${SITE}#p/${profileCode(pk)}`;

export { TITLES, UNRATED } from "../data/titles.js";

/** Colore e motivo della scheda scelti dal giocatore (Settings → Profile). */
export const CARD_PATTERNS = { rays: "Rays", grid: "Grid", waves: "Waves", hex: "Hexagons", stars: "Stars", plain: "Plain" };
export const CARD_COLORS = ["#38c6ff", "#7dffb0", "#ffcf3b", "#ff7a1a", "#ff3b4e", "#ff7ad9", "#9b8cff", "#e6ecf5"];

/** Immagine del giocatore: la sua, o l'iniziale su un colore che dipende dalla chiave. */
export function avatarEl(pk, profile, name = "", size = 36) {
  const style = { width: `${size}px`, height: `${size}px` };
  if (profile?.avatar) return h("img.avatar", { src: profile.avatar, alt: "", style });
  const hue = parseInt(String(pk ?? "0").slice(0, 6), 16) % 360 || 200;
  const letter = [...(profile?.name || name || "?").trim()][0]?.toUpperCase() ?? "?";
  return h("span.avatar.blank", { style: { ...style, background: `linear-gradient(140deg, hsl(${hue} 65% 46%), hsl(${(hue + 40) % 360} 60% 28%))`, fontSize: `${Math.round(size * 0.45)}px` } }, letter);
}

const getBoard = cachedLeaderboard;

/** Cerchio della percentuale di vittorie (SVG). */
function ring(pct, color) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 44 44");
  svg.classList.add("pc-ring");
  const c = (r, stroke, w, dash) => {
    const e = document.createElementNS(NS, "circle");
    for (const [k, v] of Object.entries({ cx: 22, cy: 22, r, fill: "none", stroke, "stroke-width": w, ...(dash ? { "stroke-dasharray": dash, "stroke-linecap": "round", transform: "rotate(-90 22 22)" } : {}) })) e.setAttribute(k, v);
    return e;
  };
  const len = 2 * Math.PI * 18;
  svg.append(c(18, "rgba(255,255,255,.08)", 5), c(18, color, 5, `${(len * pct) / 100} ${len}`));
  return h("div.pc-ring-box", svg, h("div.pc-ring-text", h("span.pc-ring-v", `${pct}%`), h("span.pc-ring-l", "win rate")));
}

/**
 * La scheda (elemento). page: aperta da sola dal link (niente finestra intorno). onOpenOther: apre la scheda di un
 * altro giocatore (dagli ultimi duelli).
 */
function cardView(pk, { name = "", page = false, onOpenOther } = {}) {
  const me = identity().pk === pk;
  let profile = cachedProfile(pk);
  let rank = null; // { p, i, total, games }
  const root = h("article.pcard");
  const banner = h("div.pc-banner");
  const head = h("div.pc-head");
  const actions = h("div.pc-actions");
  const stats = h("div.pc-stats", h("p.muted.small", "Loading the ranking…"));
  const decks = h("div.pc-decks", h("p.muted.small", "Loading the profile…"));
  const shareMsg = h("span.pc-share-msg.muted.small");

  const shownName = () => profile?.name || name || "Duelist";
  const title = () => titleOf(rank?.p?.rating ?? START_RATING, rank?.p?.games ?? 0, rank?.p?.peak);
  // colore e motivo li sceglie il giocatore; senza (schede vecchie) un colore dalla chiave
  const paintColor = () => {
    const hue = parseInt(pk.slice(0, 6), 16) % 360;
    root.style.setProperty("--pc", profile?.theme?.color || `hsl(${hue} 70% 62%)`);
    root.dataset.pattern = profile?.theme?.pattern || "rays";
  };

  const paintHead = () => {
    const f = socialState().friends.find((x) => x.pk === pk);
    const pres = f?.status === "friend" ? presenceOf(f).status : null;
    const t = title();
    clear(head).append(
      h("div.pc-avatar", avatarEl(pk, profile, name, page ? 128 : 112), pres ? h(`span.presence-dot.pc-presence.${pres === "online" ? "online" : pres === "duel" ? "duel" : "offline"}`, { title: pres }) : null),
      h("div.pc-who",
        h("div.pc-badges",
          h("span.pc-tier", { title: t.name, style: { "--tc": t.color } }, MASTER_TITLES.has(t.abbr) ? h("b", t.abbr) : null, ` ${t.name}${rank?.p ? ` · ${rank.p.rating}` : ""}`),
          me ? h("span.pc-tag", "You") : f?.status === "friend" ? h("span.pc-tag.friend", "Friend") : null),
        h("h2.pc-name", shownName()),
        profile?.bio ? h("p.pc-bio", profile.bio) : null,
        h("div.pc-key", { title: npubOf(pk) }, icon("key"), shortKey(npubOf(pk)),
          h("button.pc-mini", { title: "Copy the friend code", onclick: () => copyText(npubOf(pk)).then((ok) => toast(ok ? "Friend code copied" : "Copy failed")) }, icon("content_copy")))));
  };

  const share = async () => {
    const url = profileLink(pk);
    const title = `${shownName()} on Helios`;
    if (navigator.share) {
      try {
        await navigator.share({ title, text: `${title}: player card`, url });
        return;
      } catch (e) {
        if (e?.name === "AbortError") return;
      }
    }
    const ok = await copyText(url);
    shareMsg.textContent = ok ? `Link copied: ${url}` : url;
  };

  const paintActions = () => {
    const { friends, requests } = socialState();
    const f = friends.find((x) => x.pk === pk);
    const req = requests.find((x) => x.pk === pk);
    const has = !!profile?.wallets.xmr;
    clear(actions).append(...[
      !me && req ? h("button.btn.primary", { onclick: async () => { await acceptRequest(pk); toast("Friend request accepted", { kind: "ok" }); paintActions(); paintHead(); } }, icon("check"), " Accept friend") : null,
      !me && req ? h("button.btn.ghost", { onclick: () => { declineRequest(pk); paintActions(); } }, icon("close"), " Decline") : null,
      !me && !req && !f ? h("button.btn.primary", { onclick: () => addFriend(pk, shownName()).then(() => { toast("Friend request sent", { kind: "ok" }); paintActions(); }, (e) => toast(e.message, { kind: "error" })) }, icon("person_add"), " Add friend") : null,
      !me && f?.status === "sent" ? h("span.pc-pill", icon("schedule"), " Request sent") : null,
      !me && has ? h("button.btn", { title: "Send Monero (XMR) to this player", onclick: () => openSendCrypto(profile, shownName()) }, icon("send"), " Send XMR") : null,
      h("button.btn", { title: "Share a short link that opens this card", onclick: share }, icon("share"), " Share"),
      shareMsg,
    ].filter(Boolean));
  };

  const deckTile = (d) => {
    const cover = d.cover && [...d.main, ...d.extra, ...d.side].includes(d.cover) ? d.cover : d.main[0] ?? d.extra[0];
    return h("button.pc-deck", { title: `Open ${d.name}`, onclick: () => openDeckViewer({ main: d.main, extra: d.extra, side: d.side, title: d.name, subtitle: `${shownName()} · played ${d.games} time${d.games === 1 ? "" : "s"} online` }) },
      h("div.pc-deck-cover", cardFace(cover)),
      h("b.pc-deck-name", d.name),
      h("span.pc-deck-meta", `${d.main.length} + ${d.extra.length} · ${d.games} game${d.games === 1 ? "" : "s"}`));
  };
  const paintDecks = () => {
    if (!profile) return clear(decks).append(h("p.muted.small", me ? "Your card is not published yet: it is published when you change it or play online." : "This player has no public card yet."));
    if (!profile.decks.length) return clear(decks).append(h("p.muted.small", me ? "The decks you play online appear here (Settings → Profile to hide them)." : "No decks shown."));
    clear(decks).append(...profile.decks.map(deckTile));
  };

  const stat = (label, value, hint = "") => h("div.pc-stat", { title: hint }, h("span.pc-stat-v", String(value)), h("span.pc-stat-l", label));
  const paintStats = () => {
    if (!rank) return;
    const p = rank.p;
    if (!p) return clear(stats).append(h("div.pc-empty", icon("military_tech"), h("span", "No ranked Duels yet: the rating starts at ", h("b", START_RATING), ".")));
    const pct = p.games ? Math.round((p.wins / p.games) * 100) : 0;
    const form = rank.games.slice(0, 10);
    clear(stats).append(
      h("div.pc-stat-row",
        ring(pct, "var(--pc)"),
        h("div.pc-stat-grid",
          stat("Rank", `#${rank.i + 1}`, `of ${rank.total} players`),
          stat("Rating", p.rating),
          stat("Peak", p.peak, "Highest rating reached"),
          stat("Duels", p.games),
          stat("W / L / D", `${p.wins}/${p.losses}/${p.draws}`),
          stat("Left", p.abandons, "Duels lost by leaving"))),
      form.length
        ? h("div.pc-form", h("span.pc-form-l", "Last Duels"),
            form.map((g) => {
              const other = g.a === pk ? g.b : g.a;
              const res = g.winner === null ? (g.kind === "abandon-both" ? "L" : "D") : g.winner === pk ? "W" : "L";
              const delta = (g.a === pk ? 1 : -1) * g.delta;
              const otherName = rank.names.get(other) ?? shortKey(other);
              return h(`button.pc-dot.${res}`, { title: `${res === "W" ? "Won" : res === "L" ? "Lost" : "Draw"} vs ${otherName} · ${delta > 0 ? "+" : ""}${delta} · ${new Date(g.at * 1000).toLocaleDateString()}`, onclick: () => onOpenOther?.(other, otherName) }, res);
            }))
        : null);
  };

  root.append(banner, head, actions,
    h("h3.pc-sec", icon("leaderboard"), " Ranked stats"), stats,
    h("h3.pc-sec", icon("style"), " Decks they play"), decks,
    h("footer.pc-foot", h("span.pc-logo", "HELI", h("b", "OS")), h("span.muted.small", profileLink(pk).replace("https://", ""))));

  const paintAll = () => { paintColor(); paintHead(); paintActions(); paintDecks(); paintStats(); };
  paintAll();
  getBoard().then(({ players, games }) => {
    const i = players.findIndex((x) => x.pk === pk);
    rank = { p: players[i] ?? null, i, total: players.length, games: games.filter((g) => g.a === pk || g.b === pk), names: new Map(players.map((x) => [x.pk, x.name])) };
    paintColor(); paintHead(); paintStats();
  }, (e) => clear(stats).append(h("p.muted.small", `Ranking unavailable: ${e.message}`)));
  fetchProfile(pk, { fresh: true }).then((p) => {
    profile = p;
    paintColor(); paintHead(); paintActions(); paintDecks();
  });
  // richieste e amicizie cambiano mentre la scheda è aperta
  const off = onSocialChange(() => (root.isConnected ? (paintHead(), paintActions()) : off()));
  return root;
}

/** Apre la scheda del giocatore `pk` in una finestra (name: il nome che si conosce già, finché non arriva il profilo). */
export function openProfileCard(pk, { name = "" } = {}) {
  let m = null;
  const view = cardView(pk, { name, onOpenOther: (other, n) => { m?.close(); openProfileCard(other, { name: n }); } });
  m = openModal({ className: "profile-card-modal", body: [view], actions: [{ label: "Close", value: true }] });
  return m.result;
}

/**
 * Pagina con solo la scheda, dal link breve (#p/<codice> o #p/npub1…). app: per tornare a Helios.
 * Restituisce false se il codice non è valido.
 */
export function showProfilePage(app, code) {
  const root = clear(app.root);
  const box = h("div.pc-page-card", h("p.muted", "Looking for this player on the Nostr relays…"));
  const openApp = () => {
    history.replaceState(null, "", location.pathname + location.search);
    app.home();
  };
  root.append(h("div.page.pc-page",
    h("header.pc-page-top", h("span.logo", h("span.logo-mark", "◆"), h("span", "HELI"), h("b", "OS")), h("button.btn.primary", { onclick: openApp }, icon("play_arrow"), " Open Helios")),
    box));
  const show = (pk, name) => clear(box).append(cardView(pk, { name, page: true, onOpenOther: (other) => { location.hash = `#p/${profileCode(other)}`; } }));
  const full = pubkeyFrom(code);
  if (full) {
    show(full);
    return true;
  }
  if (!/^[0-9a-f]{10}$/i.test(code)) {
    clear(box).append(h("p.status-box.error", "This link is not valid: ask for it again."));
    return false;
  }
  findProfileByCode(code.toLowerCase()).then((found) => {
    if (found) show(found.pk, found.profile?.name);
    else clear(box).append(h("p.status-box.error", "No player found for this link (the card may not be published yet, or the relays did not answer)."), h("button.btn", { onclick: () => showProfilePage(app, code) }, icon("refresh"), " Retry"));
  });
  return true;
}

// ---------------------------------------------------------------- crypto

/** Mandare Monero a un giocatore: il link monero: apre il proprio wallet con indirizzo e importo, o si copia l'indirizzo. */
function openSendCrypto(profile, name) {
  const addr = profile.wallets.xmr;
  const amount = h("input.input", { type: "text", inputMode: "decimal", placeholder: "0.05", autocomplete: "off" });
  const msg = h("p.small.error");
  const open = (e) => {
    e.preventDefault();
    const t = amount.value.trim().replace(",", ".");
    if (t && (!/^\d+(\.\d{1,12})?$/.test(t) || +t <= 0)) return (msg.textContent = "Write an amount like 0.05");
    msg.textContent = "";
    location.href = `monero:${addr}${t ? `?tx_amount=${t}&recipient_name=${encodeURIComponent(name)}` : ""}`;
  };
  openModal({
    title: `Send XMR to ${name}`,
    className: "send-crypto-modal top",
    body: [h("div.send-crypto",
      h("label.field", h("span", `${name}'s Monero address`),
        h("div.wallet-addr-row", h("code.mono.wallet-addr", addr), h("button.btn.small.ghost", { title: "Copy the address", onclick: () => copyText(addr).then((ok) => toast(ok ? "Address copied" : "Copy failed")) }, icon("content_copy")))),
      h("label.field", h("span", "Amount (XMR)"), amount),
      h("div.row", h("a.btn.primary", { href: "#", onclick: open }, icon("open_in_new"), " Open in your Monero wallet")),
      h("p.small.muted", "Send it from your Monero wallet (Cake Wallet, Feather, Monero GUI…): the link fills in address and amount, or copy the address."),
      h("p.small.warn", "Check the address: crypto transactions cannot be undone."),
      msg)],
    actions: [{ label: "Close", value: true }],
  });
}
