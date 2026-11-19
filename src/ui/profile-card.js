// Scheda di un giocatore: immagine, nome e frase dal suo profilo pubblico (net/public-profile.js), statistiche ELO
// (net/elo.js: le stesse della classifica), i mazzi che gioca online (nel deck viewer) e le azioni: chiedere
// l'amicizia, accettare una richiesta, mandargli crypto (se ha pubblicato gli indirizzi).
import { h, clear, icon } from "./dom.js";
import { openModal, toast } from "./modal.js";
import { cardFace } from "./card.js";
import { openDeckViewer } from "./editor.js";
import { identity, npubOf, shortKey } from "../net/identity.js";
import { copyText } from "../net/clipboard.js";
import { fetchProfile, cachedProfile } from "../net/public-profile.js";
import { socialState, addFriend, acceptRequest, declineRequest, presenceOf } from "../net/social.js";
import { leaderboard, START_RATING } from "../net/elo.js";
import { savedWallet, discoverWallets, connectWallet, sendEth, toWei } from "../net/web-wallet.js";

/** Immagine del giocatore: la sua, o l'iniziale su un colore che dipende dalla chiave. */
export function avatarEl(pk, profile, name = "", size = 36) {
  const style = { width: `${size}px`, height: `${size}px` };
  if (profile?.avatar) return h("img.avatar", { src: profile.avatar, alt: "", style });
  const hue = parseInt(String(pk ?? "0").slice(0, 6), 16) % 360 || 200;
  const letter = [...(profile?.name || name || "?").trim()][0]?.toUpperCase() ?? "?";
  return h("span.avatar.blank", { style: { ...style, background: `hsl(${hue} 55% 38%)`, fontSize: `${Math.round(size * 0.45)}px` } }, letter);
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

/** Apre la scheda del giocatore `pk` (name: il nome che si conosce già, finché non arriva il profilo). */
export function openProfileCard(pk, { name = "" } = {}) {
  const me = identity().pk === pk;
  const head = h("div.pc-head");
  const actions = h("div.pc-actions");
  const stats = h("div.pc-stats", h("p.muted.small", "Loading the ranking…"));
  const decks = h("div.pc-decks", h("p.muted.small", "Loading the profile…"));
  let profile = cachedProfile(pk);

  const shownName = () => profile?.name || name || "Duelist";
  const paintHead = () => {
    const f = socialState().friends.find((x) => x.pk === pk);
    const pres = f?.status === "friend" ? presenceOf(f).status : null;
    clear(head).append(
      avatarEl(pk, profile, name, 84),
      h("div.pc-who",
        h("h2.pc-name", shownName(), me ? h("span.pc-tag", "You") : f?.status === "friend" ? h("span.pc-tag.friend", "Friend") : null),
        h("div.pc-key.muted.small", { title: npubOf(pk) }, shortKey(npubOf(pk)),
          h("button.btn.small.ghost", { title: "Copy the friend code", onclick: () => copyText(npubOf(pk)).then((ok) => toast(ok ? "Friend code copied" : "Copy failed")) }, icon("content_copy")),
          pres ? h(`span.presence-dot.${pres === "online" ? "online" : pres === "duel" ? "duel" : "offline"}`, { title: pres }) : null),
        profile?.bio ? h("p.pc-bio", profile.bio) : null));
  };

  const paintActions = () => {
    const { friends, requests } = socialState();
    const f = friends.find((x) => x.pk === pk);
    const req = requests.find((x) => x.pk === pk);
    const has = profile && (profile.wallets.eth || profile.wallets.xmr);
    clear(actions).append(...[
      me ? h("span.muted.small", "This is how other players see your card (Settings → Profile to change it).") : null,
      !me && req ? h("button.btn.primary", { onclick: async () => { await acceptRequest(pk); toast("Friend request accepted", { kind: "ok" }); paintActions(); paintHead(); } }, icon("check"), " Accept friend request") : null,
      !me && req ? h("button.btn.ghost", { onclick: () => { declineRequest(pk); paintActions(); } }, icon("close"), " Decline") : null,
      !me && !req && !f ? h("button.btn.primary", { onclick: () => addFriend(pk, shownName()).then(() => { toast("Friend request sent", { kind: "ok" }); paintActions(); }, (e) => toast(e.message, { kind: "error" })) }, icon("person_add"), " Add friend") : null,
      !me && f?.status === "sent" ? h("span.pc-pill", icon("schedule"), " Friend request sent") : null,
      !me && has ? h("button.btn", { onclick: () => openSendCrypto(pk, profile, shownName()) }, icon("send"), " Send crypto") : null,
      !me && profile && !has ? h("span.muted.small", { title: "They can show their addresses in Settings → Profile" }, "No crypto addresses on this card") : null,
    ].filter(Boolean));
  };

  const paintDecks = () => {
    if (!profile) return clear(decks).append(h("p.muted.small", me ? "Your card is not published yet: it is published when you change it or play online." : "This player has no public card yet (older Helios, or never online since)."));
    if (!profile.decks.length) return clear(decks).append(h("p.muted.small", me ? "No decks yet: the decks you play online appear here (Settings → Profile to hide them)." : "No decks shown."));
    clear(decks).append(...profile.decks.map((d) => {
      const cover = d.cover && [...d.main, ...d.extra, ...d.side].includes(d.cover) ? d.cover : d.main[0] ?? d.extra[0];
      return h("button.pc-deck", { title: `Open ${d.name}`, onclick: () => openDeckViewer({ main: d.main, extra: d.extra, side: d.side, title: d.name, subtitle: `${shownName()} · played ${d.games} time${d.games === 1 ? "" : "s"} online` }) },
        h("div.pc-deck-cover", cardFace(cover)),
        h("b.pc-deck-name", d.name),
        h("span.muted.small", `${d.main.length} + ${d.extra.length} · ${d.games} game${d.games === 1 ? "" : "s"}`));
    }));
  };

  const paintStats = async () => {
    try {
      const { players, games } = await getBoard();
      const i = players.findIndex((p) => p.pk === pk);
      const p = players[i];
      if (!p) return clear(stats).append(h("div.pc-stat-grid", stat("Rating", START_RATING), stat("Ranked Duels", 0)), h("p.muted.small", "No ranked Duels yet."));
      const byPk = new Map(players.map((x) => [x.pk, x.name]));
      const mine = games.filter((g) => g.a === pk || g.b === pk).slice(0, 6);
      const rate = p.games ? Math.round((p.wins / p.games) * 100) : 0;
      clear(stats).append(
        h("div.pc-stat-grid",
          stat("Rank", `#${i + 1}`, `of ${players.length}`),
          stat("Rating", p.rating),
          stat("Ranked Duels", p.games),
          stat("Win rate", `${rate}%`, `${p.wins}W ${p.losses}L ${p.draws}D`),
          stat("Left", p.abandons, "Duels lost by leaving")),
        mine.length
          ? h("ul.pc-games", mine.map((g) => {
              const other = g.a === pk ? g.b : g.a;
              const res = g.winner === null ? (g.kind === "abandon-both" ? "L" : "D") : g.winner === pk ? "W" : "L";
              const delta = (g.a === pk ? 1 : -1) * g.delta;
              return h(`li.pc-game.${res}`, h("span.pc-res", res), h("span", "vs ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); openProfileCard(other, { name: byPk.get(other) }); } }, byPk.get(other) ?? shortKey(other))),
                h("span.muted.small", new Date(g.at * 1000).toLocaleDateString()), h("span.pc-delta", `${delta > 0 ? "+" : ""}${delta}`));
            }))
          : null);
    } catch (e) {
      clear(stats).append(h("p.muted.small", `Ranking unavailable: ${e.message}`));
    }
  };
  const stat = (label, value, hint = "") => h("div.pc-stat", { title: hint }, h("span.pc-stat-v", String(value)), h("span.pc-stat-l", label), hint ? h("span.pc-stat-h", hint) : null);

  paintHead();
  paintActions();
  paintDecks();
  paintStats();
  fetchProfile(pk, { fresh: true }).then((p) => {
    profile = p;
    paintHead();
    paintActions();
    paintDecks();
  });

  return openModal({
    title: "Player card",
    className: "profile-card-modal",
    body: [head, actions, h("h3.pc-sec", icon("leaderboard"), " Stats"), stats, h("h3.pc-sec", icon("style"), " Decks they play"), decks],
    actions: [{ label: "Close", primary: true, value: true }],
  }).result;
}

// ---------------------------------------------------------------- crypto

/** Mandare crypto a un giocatore: ETH dal wallet del browser (lo conferma l'estensione), XMR dal proprio wallet Monero. */
function openSendCrypto(pk, profile, name) {
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
