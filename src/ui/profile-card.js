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
import { leaderboard, START_RATING } from "../net/elo.js";
import { savedWallet, discoverWallets, connectWallet, sendEth, toWei } from "../net/web-wallet.js";

const SITE = "https://ygoweb.eu/";

/** Link breve alla scheda del giocatore. */
export const profileLink = (pk) => `${SITE}#p/${profileCode(pk)}`;

/** Grado dal rating (colore della scheda). */
export function tierOf(rating, games) {
  if (!games) return { name: "Unranked", color: "#8b93a7" };
  if (rating >= 2000) return { name: "Master", color: "#ff5ad1" };
  if (rating >= 1850) return { name: "Diamond", color: "#9b8cff" };
  if (rating >= 1700) return { name: "Platinum", color: "#5fe3ff" };
  if (rating >= 1550) return { name: "Gold", color: "#ffcf3b" };
  if (rating >= 1400) return { name: "Silver", color: "#c3cad6" };
  return { name: "Bronze", color: "#d4884a" };
}

/** Immagine del giocatore: la sua, o l'iniziale su un colore che dipende dalla chiave. */
export function avatarEl(pk, profile, name = "", size = 36) {
  const style = { width: `${size}px`, height: `${size}px` };
  if (profile?.avatar) return h("img.avatar", { src: profile.avatar, alt: "", style });
  const hue = parseInt(String(pk ?? "0").slice(0, 6), 16) % 360 || 200;
  const letter = [...(profile?.name || name || "?").trim()][0]?.toUpperCase() ?? "?";
  return h("span.avatar.blank", { style: { ...style, background: `linear-gradient(140deg, hsl(${hue} 65% 46%), hsl(${(hue + 40) % 360} 60% 28%))`, fontSize: `${Math.round(size * 0.45)}px` } }, letter);
}

// La classifica si scarica una volta ogni due minuti, anche aprendo più schede.
let board = null;
let boardAt = 0;
const getBoard = () => {
  if (!board || Date.now() - boardAt > 120000) {
    boardAt = Date.now();
    board = leaderboard().catch((e) => ((board = null), Promise.reject(e)));
  }
  return board;
};

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
  return h("div.pc-ring-box", svg, h("span.pc-ring-v", `${pct}%`));
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
  const tier = () => tierOf(rank?.p?.rating ?? START_RATING, rank?.p?.games ?? 0);
  const paintColor = () => {
    const hue = parseInt(pk.slice(0, 6), 16) % 360;
    root.style.setProperty("--pc", rank?.p ? tier().color : `hsl(${hue} 70% 62%)`);
  };

  const paintHead = () => {
    const f = socialState().friends.find((x) => x.pk === pk);
    const pres = f?.status === "friend" ? presenceOf(f).status : null;
    const t = tier();
    clear(head).append(
      h("div.pc-avatar", avatarEl(pk, profile, name, page ? 128 : 112), pres ? h(`span.presence-dot.pc-presence.${pres === "online" ? "online" : pres === "duel" ? "duel" : "offline"}`, { title: pres }) : null),
      h("div.pc-who",
        h("div.pc-badges",
          h("span.pc-tier", t.name, rank?.p ? ` · ${rank.p.rating}` : ""),
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
    const has = profile && (profile.wallets.eth || profile.wallets.xmr);
    clear(actions).append(...[
      !me && req ? h("button.btn.primary", { onclick: async () => { await acceptRequest(pk); toast("Friend request accepted", { kind: "ok" }); paintActions(); paintHead(); } }, icon("check"), " Accept friend") : null,
      !me && req ? h("button.btn.ghost", { onclick: () => { declineRequest(pk); paintActions(); } }, icon("close"), " Decline") : null,
      !me && !req && !f ? h("button.btn.primary", { onclick: () => addFriend(pk, shownName()).then(() => { toast("Friend request sent", { kind: "ok" }); paintActions(); }, (e) => toast(e.message, { kind: "error" })) }, icon("person_add"), " Add friend") : null,
      !me && f?.status === "sent" ? h("span.pc-pill", icon("schedule"), " Request sent") : null,
      !me && has ? h("button.btn", { onclick: () => openSendCrypto(profile, shownName()) }, icon("send"), " Send crypto") : null,
      h("button.btn", { title: "Share a short link that opens this card", onclick: share }, icon("share"), " Share"),
      shareMsg,
    ].filter(Boolean));
  };

  const deckTile = (d) => {
    const all = [...d.main, ...d.extra];
    const cover = d.cover && [...all, ...d.side].includes(d.cover) ? d.cover : d.main[0] ?? d.extra[0];
    // ventaglio: la copertina davanti, due carte diverse dietro
    const back = [...new Set(all)].filter((c) => c !== cover).slice(0, 2);
    return h("button.pc-deck", { title: `Open ${d.name}`, onclick: () => openDeckViewer({ main: d.main, extra: d.extra, side: d.side, title: d.name, subtitle: `${shownName()} · played ${d.games} time${d.games === 1 ? "" : "s"} online` }) },
      h("div.pc-fan", back.map((c, i) => h(`div.pc-fan-card.b${i}`, cardFace(c))), h("div.pc-fan-card.front", cardFace(cover))),
      h("b.pc-deck-name", d.name),
      h("span.pc-deck-meta", `${d.games} game${d.games === 1 ? "" : "s"} · ${d.main.length}+${d.extra.length}`));
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
    paintHead(); paintActions(); paintDecks();
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

/** Mandare crypto a un giocatore: ETH dal wallet del browser (lo conferma l'estensione), XMR dal proprio wallet Monero. */
function openSendCrypto(profile, name) {
  const { eth, xmr } = profile.wallets;
  const box = h("div.send-crypto");
  let coin = eth ? "eth" : "xmr";
  const amount = h("input.input", { type: "text", inputMode: "decimal", placeholder: "0.01", autocomplete: "off" });
  const msg = h("p.small.muted");
  const paint = () => {
    const addr = coin === "eth" ? eth : xmr;
    const unit = coin === "eth" ? "ETH" : "XMR";
    const w = savedWallet();
    clear(box).append(
      eth && xmr ? h("div.row", ["eth", "xmr"].map((c) => h(`button.btn.small${coin === c ? ".primary" : ""}`, { onclick: () => { coin = c; paint(); } }, c.toUpperCase()))) : null,
      h("label.field", h("span", `${name}'s ${coin === "eth" ? "Ethereum" : "Monero"} address`),
        h("div.wallet-addr-row", h("code.mono.wallet-addr", addr), h("button.btn.small.ghost", { title: "Copy the address", onclick: () => copyText(addr).then((ok) => toast(ok ? "Address copied" : "Copy failed")) }, icon("content_copy")))),
      h("label.field", h("span", `Amount (${unit})`), amount),
      coin === "eth"
        ? h("div.row",
            w
              ? h("button.btn.primary", { onclick: () => sendWithBrowser(addr) }, icon("send"), ` Send with ${w.name}`)
              : h("button.btn.primary", { onclick: connectThenPaint }, icon("link"), " Connect a browser wallet to send"),
            h("a.btn", { href: "#", onclick: (e) => openUri(e, `ethereum:${addr}@1`, () => `?value=${toWei(amount.value).toString()}`) }, icon("open_in_new"), " Open in a wallet app"))
        : h("div.row", h("a.btn.primary", { href: "#", onclick: (e) => openUri(e, `monero:${addr}`, () => `?tx_amount=${xmrAmount(amount.value)}&recipient_name=${encodeURIComponent(name)}`) }, icon("open_in_new"), " Open in your Monero wallet")),
      h("p.small.muted", coin === "eth"
        ? "Helios never signs anything: your wallet shows the transaction and you confirm it there. Ethereum mainnet only."
        : "Send it from your Monero wallet (Cake Wallet, Feather, Monero GUI…): the link fills in address and amount, or copy the address."),
      h("p.small.warn", "Check the address: crypto transactions cannot be undone."),
      msg);
  };
  const xmrAmount = (v) => {
    const t = String(v).trim().replace(",", ".");
    if (!/^\d+(\.\d{1,12})?$/.test(t) || +t <= 0) throw new Error("Write an amount like 0.05");
    return t;
  };
  const openUri = (e, base, query) => {
    e.preventDefault();
    try {
      location.href = base + (amount.value.trim() ? query() : "");
    } catch (err) {
      msg.textContent = err.message;
    }
  };
  async function connectThenPaint() {
    const list = await discoverWallets();
    if (!list.length) return (msg.textContent = "No browser wallet found: install OneKey, MetaMask or Rabby, unlock it and reload Helios.");
    try {
      await connectWallet(list[0]);
      paint();
    } catch (e) {
      msg.textContent = e.message;
    }
  }
  async function sendWithBrowser(addr) {
    msg.className = "small muted";
    msg.textContent = "Confirm the transaction in your wallet…";
    try {
      const hash = await sendEth(addr, amount.value);
      msg.className = "small ok";
      msg.replaceChildren("Sent! Transaction ", h("a", { href: `https://etherscan.io/tx/${hash}`, target: "_blank", rel: "noopener" }, `${String(hash).slice(0, 12)}…`));
    } catch (e) {
      msg.className = "small error";
      msg.textContent = e.message;
    }
  }
  paint();
  openModal({ title: `Send crypto to ${name}`, className: "send-crypto-modal top", body: [box], actions: [{ label: "Close", value: true }] });
}
