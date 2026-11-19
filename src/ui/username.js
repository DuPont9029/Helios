// Username on-chain (net/names.js): scelta e registrazione del nome (pagato da sé o da un amico), richieste di pagamento
// ricevute dagli amici, conio della card NFT e pagina di deploy del registro (#deploy-names).
import { h, clear, icon } from "./dom.js";
import { openModal, toast } from "./modal.js";
import { settings } from "../data/settings.js";
import { identity } from "../net/identity.js";
import { copyText } from "../net/clipboard.js";
import { socialState, sendDirect, onNameMessage } from "../net/social.js";
import { cardFace } from "./card.js";
import * as names from "../net/names.js";
import { CHAINS } from "../data/names-config.js";

const fmtEth = (wei) => {
  const s = (Number(wei) / 1e18).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `${s} ETH`;
};

/** Scelta di chi paga: wallet del profilo, wallet del browser o un amico. Restituisce un elemento e get(). */
function payerPicker({ allowFriend = true, note = "" } = {}) {
  let via = identity().seed ? "helios" : "browser";
  let friendPk = "";
  const box = h("div.payer-box");
  const paint = async () => {
    const friends = socialState().friends.filter((f) => f.status === "friend");
    const opt = (v, label, desc, disabled = false) => h(`label.payer-opt${via === v ? ".on" : ""}${disabled ? ".off" : ""}`,
      h("input", { type: "radio", name: "payer", checked: via === v, disabled, onchange: () => { via = v; paint(); } }),
      h("div", h("b", label), h("div.muted.small", desc)));
    const helios = h("div.muted.small", "…");
    clear(box).append(...[
      opt("helios", "My Helios wallet", helios, !identity().seed),
      opt("browser", "My browser wallet", "OneKey, MetaMask, Rabby… (the extension asks you to confirm)"),
      allowFriend ? opt("friend", "Ask a friend to pay", friends.length ? "You sign for free with your Helios wallet, your friend pays the gas" : "Add a friend first (Online → Friends)", !friends.length || !identity().seed) : null,
      via === "friend" && friends.length
        ? h("select.select", { onchange: (e) => (friendPk = e.target.value) }, h("option", { value: "" }, "Choose a friend…"), friends.map((f) => h("option", { value: f.pk, selected: friendPk === f.pk }, names.displayName(f.pk, f.name))))
        : null,
      note ? h("p.muted.small", note) : null].filter(Boolean)); // append() scriverebbe "null"
    if (identity().seed) {
      try {
        const s = await names.heliosSigner();
        const a = await s.getAddress();
        const bal = await names.balanceOf(a);
        helios.replaceChildren(`${a.slice(0, 8)}…${a.slice(-4)} · ${fmtEth(bal)}`, bal === 0n ? " · send it a little ETH to pay from here" : "",
          h("button.btn.small.ghost", { title: "Copy the address", onclick: (e) => { e.preventDefault(); copyText(a).then((ok) => toast(ok ? "Address copied" : "Copy failed")); } }, icon("content_copy")));
      } catch (e) {
        helios.textContent = `Unavailable (${e.message})`;
      }
    }
  };
  paint();
  return { el: box, get: () => ({ via, friendPk }) };
}

const signerFor = (via) => (via === "browser" ? names.browserSigner() : names.heliosSigner());

// ---------------------------------------------------------------- username

/** Finestra dello username. first: proposta all'avvio (si può rimandare). */
export function openUsernameDialog({ first = false, onDone } = {}) {
  const input = h("input.input", { maxLength: 20, placeholder: "YourName", autocomplete: "off", value: settings.username || "" });
  const status = h("p.small.muted.name-status");
  const progress = h("p.small.name-progress");
  const payer = payerPicker({ note: "Registering costs only Ethereum gas (a few cents today): the name is yours until you free it. Two steps, one minute apart, so nobody can steal the name while it is being registered." });
  let free = false;
  let t = 0;
  const check = () => {
    clearTimeout(t);
    free = false;
    const v = input.value.trim();
    const bad = v ? names.nameProblem(v) : "Write a name";
    status.className = "small name-status muted";
    if (bad) return (status.textContent = bad);
    status.textContent = "Checking…";
    t = setTimeout(async () => {
      try {
        const r = await names.lookup(v);
        if (input.value.trim() !== v) return;
        free = /^0x0+$/.test(r.owner);
        status.className = `small name-status ${free ? "ok" : "bad"}`;
        status.textContent = free ? `✓ ${v} is free` : `${r.display} is taken`;
      } catch (e) {
        status.textContent = `Cannot check now: ${await names.friendlyError(e)}`;
      }
    }, 450);
  };
  input.addEventListener("input", check);
  let busy = false;
  const m = openModal({
    title: first ? "Choose your username" : "Username",
    className: "username-modal",
    dismissable: !busy,
    body: [
      h("p", first
        ? "Helios usernames are now unique: each one belongs to one wallet, on Ethereum. Until you register yours, other players see you as "
        : "Your unique name on Helios, registered on Ethereum. Other players see you as ",
        h("b", first || !settings.username ? names.provisionalName(identity().pk) : settings.username), "."),
      h("label.field", h("span", "Username"), input),
      status,
      payer.el,
      progress,
    ],
    actions: [
      { label: first ? "Later" : "Close", value: null },
      {
        label: "Register",
        primary: true,
        onClick: async (close) => {
          if (busy) return;
          const name = input.value.trim();
          if (!free) return check();
          const { via, friendPk } = payer.get();
          busy = true;
          progress.className = "small name-progress muted";
          const steps = (s) => (progress.textContent = s);
          try {
            const signer = await signerFor(via === "friend" ? "helios" : via);
            if (via === "friend") {
              if (!friendPk) throw new Error("Choose a friend");
              steps("Signing the request (free)…");
              const req = await names.signNameRequest(signer, name);
              const n = await sendDirect(friendPk, { t: "name-pay", req });
              if (!n) throw new Error("The Nostr relays did not answer: try again");
              toast("Request sent: when your friend pays, the name becomes yours", { kind: "ok", ms: 5000 });
              settings.usernameAsked = { name, owner: req.owner, at: Date.now() };
              close(true);
              return;
            }
            const r = await names.registerName(signer, name, { steps });
            await names.adoptUsername(r.name, r.owner);
            toast(`You are ${r.name} on Helios`, { kind: "ok" });
            close(true);
            onDone?.();
          } catch (e) {
            progress.className = "small name-progress error";
            progress.textContent = await names.friendlyError(e);
          } finally {
            busy = false;
          }
        },
      },
    ],
  });
  if (input.value) check();
  setTimeout(() => input.focus(), 30);
  return m.result;
}

// ---------------------------------------------------------------- card NFT

const PATTERNS = ["rays", "grid", "waves", "hex", "stars", "plain"];
/** Testo per la card on-chain: solo caratteri semplici (il contratto rifiuta < > & " \ e i non ASCII). */
export const cardBio = (s, max = 48) => String(s ?? "").replace(/[^\x20-\x7e]|[<>&"\\]/g, "").slice(0, max);
const MAX_AVATAR = 12000; // come nel contratto (byte del data URL)
const MAX_COVER = 8000;

/** Immagine ridotta a w × h (ritagliata al centro) come data URL WebP/JPEG sotto `max` caratteri; "" se non si carica. */
function shrinkImage(src, w, h, max) {
  return new Promise((resolve) => {
    if (!src) return resolve("");
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onerror = () => resolve("");
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d");
      const k = Math.max(w / img.width, h / img.height);
      x.drawImage(img, (w - img.width * k) / 2, (h - img.height * k) / 2, img.width * k, img.height * k);
      for (const q of [0.82, 0.7, 0.58, 0.46, 0.34]) {
        for (const type of ["image/webp", "image/jpeg"]) {
          const url = c.toDataURL(type, q);
          if (url.startsWith(`data:${type};base64,`) && url.length <= max) return resolve(url);
        }
      }
      resolve("");
    };
    img.src = src;
  });
}

/** Copertina di un mazzo: l'immagine della carta passa dal proxy wsrv.nl (le immagini delle carte non hanno CORS). */
async function coverOf(code) {
  if (!code) return "";
  const { imageUrl } = await import("../data/settings.js");
  const url = imageUrl(code);
  return shrinkImage(url.startsWith("data:") ? url : `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=240&output=jpg`, 120, 176, MAX_COVER);
}

const toHex = (dataUrl) => "0x" + [...new TextEncoder().encode(dataUrl)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Dati della card on-chain dalla scheda del giocatore: colore, motivo, frase, immagine del profilo, indirizzo XMR del
 * wallet di Helios (se showXmr) e i 3 mazzi giocati online più recenti con la copertina. Restituisce { input, preview }.
 */
export async function buildCardInput({ showXmr = true } = {}) {
  const { cardDecks } = await import("../net/public-profile.js");
  const avatar = await shrinkImage(settings.avatar, 96, 96, MAX_AVATAR);
  let xmr = "";
  if (showXmr && identity().seed) {
    const { bip39Seed, moneroWallet } = await import("../net/wallets.js");
    xmr = moneroWallet(bip39Seed(identity().seed)).address;
  }
  const decks = [];
  for (const d of cardDecks().slice(0, 3)) {
    const name = cardBio(d.name, 24).trim() || "Deck";
    const cover = await coverOf(d.cover && [...d.main, ...d.extra].includes(d.cover) ? d.cover : d.main[0]);
    decks.push({ name, main: Math.min(60, d.main.length), extra: Math.min(15, d.extra.length), cover });
  }
  // ranking ELO di Helios (classifica su Nostr): sulla card è una fotografia di adesso
  const { cachedLeaderboard, START_RATING } = await import("../net/elo.js");
  const me = (await cachedLeaderboard().catch(() => ({ players: [] }))).players.find((x) => x.pk === identity().pk);
  const rank = { rating: me?.rating ?? START_RATING, peak: Math.max(me?.peak ?? START_RATING, me?.rating ?? START_RATING), games: me?.games ?? 0 };
  const color = (settings.cardColor || "#38c6ff").toLowerCase();
  const input = {
    color: color.replace("#", "0x"),
    pattern: Math.max(0, PATTERNS.indexOf(settings.cardPattern || "rays")),
    bio: cardBio(settings.bio),
    xmr,
    avatar: avatar ? toHex(avatar) : "0x",
    decks: decks.map((d) => ({ name: d.name, main: d.main, extra: d.extra, cover: d.cover ? toHex(d.cover) : "0x" })),
    rating: Math.min(5000, rank.rating),
    peak: Math.min(5000, rank.peak),
    games: rank.games,
  };
  return { input, preview: { color, avatar, bio: input.bio, xmr, decks, rank } };
}

/**
 * Conio della card (o richiesta a un amico) e aggiornamento (update: la card esiste già, la riscrive il suo wallet).
 * Tutti i dati vengono dalla scheda del giocatore (Settings → Profile → Player card): la card NFT è la scheda di Helios.
 */
export function openMintDialog({ update = false, onDone } = {}) {
  const progress = h("p.small.name-progress");
  const owner = settings.usernameWallet;
  const preview = h("div.mint-preview", h("p.muted.small", "Preparing your card…"));
  const xmrBox = h("input", { type: "checkbox", checked: true });
  const cost = h("p.small.muted.mint-cost");
  let built = null;
  let painting = 0;
  const paintPreview = async () => {
    const my = ++painting;
    built = null;
    clear(preview).append(h("p.muted.small", "Preparing your card…"));
    const next = await buildCardInput({ showXmr: xmrBox.checked });
    if (my !== painting) return;
    built = next;
    showCost(my);
    const p = built.preview;
    const { titleOf } = await import("../data/titles.js");
    const t = titleOf(p.rank.rating, p.rank.games, p.rank.peak);
    // anteprima esatta: la card disegnata dal renderer del contratto con questi dati (per l'aggiornamento accanto a quella di adesso)
    const shots = h("div.mint-shots", h("p.muted.small", "Drawing the preview with the on-chain renderer…"));
    Promise.all([names.previewCard(built.input, owner), update ? names.cardOfWallet(owner).then((c) => c?.image ?? null) : null])
      .then(([next, now]) => {
        if (my !== painting) return;
        clear(shots).append(...[
          now ? h("figure.mint-shot", h("img", { src: now, alt: "Your card now" }), h("figcaption.muted.small", "Now")) : null,
          h("figure.mint-shot", h("img", { src: next, alt: "Your card" }), h("figcaption.muted.small", update ? "After the update" : "Your card")),
        ].filter(Boolean));
      })
      .catch((e) => clear(shots).append(h("p.muted.small", `Preview unavailable (${e.shortMessage ?? e.message})`)));
    clear(preview).append(
      shots,
      h("div.muted.small", `${t.name}${p.rank.games ? ` · ELO ${p.rank.rating} (peak ${p.rank.peak}, ${p.rank.games} ranked Duels)` : ""}: the ranking on the card is a snapshot of now.`),
      h("p.muted.small", "This is your Helios player card: change picture, line, colors and decks in Settings → Profile → Player card, then update the NFT."));
  };
  // costo di adesso (stima della rete, niente inviato): gas, prezzo e saldo del wallet a cui è intestato il nome
  const showCost = async (my) => {
    cost.className = "small muted mint-cost";
    cost.textContent = "Estimating the gas…";
    try {
      const k = await names.txCost(update ? "setStyle" : "mint", [built.input], owner);
      if (my !== painting) return;
      const gwei = (w) => (Number(w) / 1e9).toPrecision(3);
      cost.textContent = `Cost now: about ${fmtEth(k.likely)} (${Number(k.gas).toLocaleString("en")} gas at ${gwei(k.base + k.tip)} gwei), at most ${fmtEth(k.max)} if gas gets pricier. Wallet ${owner.slice(0, 6)}…${owner.slice(-4)}: ${fmtEth(k.balance)}`;
      if (k.tooBig) {
        cost.className = "small mint-cost error";
        cost.textContent = `Too big for one Ethereum transaction (${Number(k.gas).toLocaleString("en")} gas, the limit is 16,777,216): show fewer decks or use a simpler picture`;
      } else if (k.balance < k.likely) {
        cost.className = "small mint-cost error";
        cost.textContent += ` - not enough: add at least ${fmtEth(k.likely - k.balance)}`;
      }
    } catch (e) {
      if (my === painting) cost.textContent = `Cannot estimate the cost now (${e.shortMessage ?? e.message})`;
    }
  };
  const ownWallet = async () => {
    // la card la conia (e la aggiorna) il wallet a cui è intestato il nome
    const helios = identity().seed ? await (await names.heliosSigner()).getAddress() : "";
    return owner.toLowerCase() === helios.toLowerCase() ? "helios" : "browser";
  };
  const payer = payerPicker({ allowFriend: !update, note: `${update ? "Rewrites your card with the data of your player card (one transaction, same number)." : "Your card is an NFT on Ethereum, bound to " + owner.slice(0, 8) + "…, with everything stored on-chain."} Only gas, no price.` });
  xmrBox.addEventListener("change", paintPreview);
  paintPreview();
  const m = openModal({
    title: update ? "Update your on-chain card" : "Mint your on-chain card",
    className: "username-modal",
    body: [preview, h("label.check", xmrBox, "Show my Monero address (from my Helios wallet)"), payer.el, cost, progress],
    actions: [
      { label: "Close", value: null },
      {
        label: update ? "Update" : "Mint",
        primary: true,
        onClick: async (close) => {
          const { via, friendPk } = payer.get();
          const steps = (s) => (progress.textContent = s);
          progress.className = "small name-progress muted";
          try {
            if (!built) throw new Error("The card is still being prepared: wait a moment");
            const mine = await ownWallet();
            const ownerSigner = await signerFor(mine);
            if (via === "friend") {
              if (!friendPk) throw new Error("Choose a friend");
              const req = await names.signCardRequest(ownerSigner, built.input);
              if (!(await sendDirect(friendPk, { t: "name-pay", req }))) throw new Error("The Nostr relays did not answer: try again");
              toast("Request sent to your friend", { kind: "ok" });
              return close(true);
            }
            if (via !== mine) throw new Error(`The card is ${update ? "updated" : "minted"} by the wallet that owns the name: choose "${mine === "helios" ? "My Helios wallet" : "My browser wallet"}"${update ? "" : ", or ask a friend"}`);
            if (update) await names.updateCard(ownerSigner, built.input, { steps });
            else await names.mintCard(ownerSigner, built.input, { steps });
            toast(update ? "Your on-chain card is updated" : "Your on-chain card is minted", { kind: "ok" });
            close(true);
            onDone?.();
          } catch (e) {
            progress.className = "small name-progress error";
            progress.textContent = await names.friendlyError(e);
          }
        },
      },
    ],
  });
  return m.result;
}

/** La card on-chain è uguale alla scheda di adesso? (stessa impronta dei dati, ranking compreso). */
export async function cardIsCurrent() {
  const built = await buildCardInput({ showXmr: true });
  return names.cardMatches(settings.usernameWallet, built.input);
}

// ---------------------------------------------------------------- richieste degli amici

const requests = []; // { from, name, req, at }

function cleanRequest(r) {
  const hex = (v, n) => typeof v === "string" && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(v);
  if (!r || !hex(r.owner, 40) || !Number.isInteger(r.deadline) || typeof r.sig !== "string" || r.deadline < Date.now() / 1000) return null;
  if (r.kind === "register" && typeof r.name === "string" && !names.nameProblem(r.name) && hex(r.nostr, 64)) return r;
  const c = r.card;
  const isHex = (v) => typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v) && v.length <= 2 + 2 * MAX_AVATAR;
  if (r.kind === "card" && c && hex(c.color, 6) && Number.isInteger(c.pattern) && c.pattern >= 0 && c.pattern <= 5 && typeof c.bio === "string" && c.bio === cardBio(c.bio)
    && typeof c.xmr === "string" && isHex(c.avatar) && Array.isArray(c.decks) && c.decks.length <= 3
    && c.decks.every((d) => typeof d?.name === "string" && d.name === cardBio(d.name, 24) && Number.isInteger(d.main) && Number.isInteger(d.extra) && isHex(d.cover))) return r;
  return null;
}

/** Richieste di pagamento ancora aperte (per la scheda degli amici). */
export const nameRequests = () => requests.filter((x) => x.req.deadline > Date.now() / 1000);

/** Paga la richiesta di un amico (finestra con la scelta del wallet). */
export function payRequest(x, onDone) {
  const progress = h("p.small.name-progress");
  const payer = payerPicker({ allowFriend: false, note: x.req.kind === "register" ? `${x.name} asks you to register the username "${x.req.name}" for them. You pay the gas (a few cents today), the name is theirs.` : `${x.name} asks you to mint their on-chain player card. You pay the gas, the card is theirs.` });
  openModal({
    title: x.req.kind === "register" ? `Pay ${x.req.name} for ${x.name}` : `Pay the card of ${x.name}`,
    className: "username-modal",
    body: [payer.el, progress],
    actions: [
      { label: "Close", value: null },
      {
        label: "Pay",
        primary: true,
        onClick: async (close) => {
          const steps = (s) => (progress.textContent = s);
          progress.className = "small name-progress muted";
          try {
            const signer = await signerFor(payer.get().via);
            if (x.req.kind === "register") await names.registerName(signer, x.req.name, { auth: x.req, steps });
            else await names.mintCard(signer, null, { auth: x.req, steps });
            await sendDirect(x.from, { t: "name-paid", kind: x.req.kind, name: x.req.name ?? "" });
            requests.splice(requests.indexOf(x), 1);
            toast(`Paid for ${x.name}`, { kind: "ok" });
            close(true);
            onDone?.();
          } catch (e) {
            progress.className = "small name-progress error";
            progress.textContent = await names.friendlyError(e);
          }
        },
      },
    ],
  });
}

export function declineRequest(x) {
  requests.splice(requests.indexOf(x), 1);
}

const listeners = new Set();
export const onNameRequests = (fn) => (listeners.add(fn), () => listeners.delete(fn));

/** All'avvio (registro attivo): proposta dello username, richieste degli amici, nome pagato da un amico. */
export async function initUsernames({ prompt }) {
  onNameMessage(async (m) => {
    if (m.t === "name-pay") {
      const req = cleanRequest(m.req);
      if (!req) return;
      const x = { from: m.from, name: names.displayName(m.from, m.name), req, at: m.at };
      const i = requests.findIndex((y) => y.from === x.from && y.req.kind === req.kind);
      if (i >= 0) requests.splice(i, 1);
      requests.push(x);
      for (const fn of listeners) fn();
      toast(`${x.name} asks you to pay ${req.kind === "register" ? `their username "${req.name}"` : "their on-chain card"} (Online → Friends)`, { ms: 6000 });
    } else if (m.t === "name-paid") {
      if (m.kind === "register" && settings.usernameAsked?.name) {
        const asked = settings.usernameAsked;
        const r = await names.lookup(asked.name).catch(() => null);
        if (r && r.owner.toLowerCase() === asked.owner.toLowerCase() && r.nostr.toLowerCase() === `0x${identity().pk}`) {
          await names.adoptUsername(r.display, r.owner);
          settings.usernameAsked = null;
          toast(`Your friend paid: you are ${r.display} on Helios`, { kind: "ok", ms: 5000 });
        }
      } else if (m.kind === "card") toast("Your friend minted your on-chain card", { kind: "ok" });
    }
  });
  if (prompt) setTimeout(() => openUsernameDialog({ first: true }), 1500);
}

// ---------------------------------------------------------------- deploy del registro (una volta, chi lo fa paga il gas)

/** Pagina #deploy-names: deploy del contratto con il wallet del browser, sulla rete scelta (Sepolia di default). */
export async function showDeployPage(app) {
  const root = clear(app.root);
  const out = h("div.deploy-out");
  const art = (await import("../data/names-contract.json")).default;
  const { discoverWallets, connectWallet } = await import("../net/web-wallet.js");
  const { ethers } = await import("ethers");
  const wallets = await discoverWallets();
  // la rete si sceglie esplicitamente: prima del deploy il wallet passa a quella (niente deploy per sbaglio su mainnet)
  const netSel = h("select.select", Object.entries(CHAINS).filter(([id]) => id !== "1337" || import.meta.env?.DEV).map(([id, c]) => h("option", { value: id, selected: id === "1" }, `${c.name} (chain ${id})`)));
  const walletSel = h("select.select", wallets.map((w, i) => h("option", { value: i }, w.info.name)));
  const costOut = h("div.deploy-cost");
  // stima del costo senza inviare niente: nodo pubblico della rete scelta, dal wallet scelto (se già collegato)
  const checkCost = async () => {
    clear(costOut).append(h("p.muted.small", "Asking a public node of this network…"));
    try {
      const chainId = Number(netSel.value);
      const chain = CHAINS[chainId];
      const rpc = new ethers.JsonRpcProvider(chain.rpc[0], chainId, { staticNetwork: true });
      const w = wallets[+walletSel.value];
      const from = (await w?.provider.request({ method: "eth_accounts" }).catch(() => []))?.[0] ?? "0x000000000000000000000000000000000000dEaD";
      const [gas, block, fee, bal] = await Promise.all([rpc.estimateGas({ from, data: art.bytecode }), rpc.getBlock("latest"), rpc.getFeeData(), rpc.getBalance(from)]);
      const base = block.baseFeePerGas ?? fee.gasPrice ?? 0n;
      const tip = fee.maxPriorityFeePerGas ?? 0n;
      const likely = gas * (base + tip);
      const max = gas * (fee.maxFeePerGas ?? base * 2n);
      const row = (k, v) => h("tr", h("td.muted", k), h("td", v));
      clear(costOut).append(h("table.cost-table",
        row("Network", `${chain.name} (chain ${chainId})`),
        row("Gas", `${gas.toLocaleString("en-US")}`),
        row("Gas price now", `${ethers.formatUnits(base + tip, "gwei").slice(0, 8)} gwei (base ${ethers.formatUnits(base, "gwei").slice(0, 8)} + tip ${ethers.formatUnits(tip, "gwei").slice(0, 8)})`),
        row("Likely cost", h("b", `${fmtEth(likely)}`)),
        row("Most the wallet can charge", `${fmtEth(max)} (unused gas is not paid)`),
        row("Wallet", from.startsWith("0x000000") ? "not connected yet" : `${from.slice(0, 8)}…${from.slice(-4)} · ${fmtEth(bal)}${bal < max ? " · NOT ENOUGH" : ""}`)),
        h("p.muted.small", "Estimate of this moment: the gas price changes block by block. Nothing was sent."));
    } catch (e) {
      clear(costOut).append(h("p.error", e.shortMessage ?? e.message));
    }
  };
  const run = async () => {
    clear(out);
    try {
      const w = wallets[+walletSel.value];
      if (!w) throw new Error("No browser wallet found: install OneKey, MetaMask or Rabby");
      const chainId = Number(netSel.value);
      const want = "0x" + chainId.toString(16);
      out.append(h("p.muted.small", `Asking ${w.info.name} to switch to ${CHAINS[chainId].name}…`));
      if ((await w.provider.request({ method: "eth_chainId" })) !== want) {
        try {
          await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
        } catch (e) {
          // rete sconosciuta al wallet (4902) o nascosta: si chiede di aggiungerla con i suoi dati
          if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902 && !/unrecognized|not been added|unknown chain/i.test(e?.message ?? "")) throw e;
          const c = CHAINS[chainId];
          await w.provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: want, chainName: c.name.replace(/ \(.*\)$/, ""), rpcUrls: c.rpc, blockExplorerUrls: c.explorer ? [c.explorer] : [], nativeCurrency: { name: chainId === 1 ? "Ether" : "Sepolia Ether", symbol: chainId === 1 ? "ETH" : "SepoliaETH", decimals: 18 } }] });
        }
      }
      await connectWallet(w);
      const bp = new ethers.BrowserProvider(w.provider);
      const net = await bp.getNetwork();
      if (Number(net.chainId) !== chainId) throw new Error(`The wallet is on chain ${net.chainId}, not ${chainId}: switch it and try again`);
      const signer = await bp.getSigner();
      const from = await signer.getAddress();
      const f = new ethers.ContractFactory(art.abi, art.bytecode, signer);
      const gas = await bp.estimateGas(await f.getDeployTransaction());
      const fee = await bp.getFeeData();
      const bal = await bp.getBalance(from);
      out.append(h("p", `${CHAINS[chainId].name} · from ${from} (${fmtEth(bal)}) · gas ≈ ${gas} (≈ ${fmtEth(gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n))} at most)`), h("p.muted.small", "Confirm in the wallet…"));
      const c = await f.deploy();
      out.append(h("p.muted.small", `Transaction ${c.deploymentTransaction().hash}: waiting for the block…`));
      await c.waitForDeployment();
      const address = await c.getAddress();
      const chain = CHAINS[chainId];
      out.append(h("p.ok", "Deployed at ", h("code", address)),
        h("div.row",
          h("button.btn", { onclick: () => copyText(address).then((ok) => toast(ok ? "Address copied" : "Copy failed")) }, icon("content_copy"), " Copy the address"),
          chain.explorer ? h("a.btn", { href: `${chain.explorer}/address/${address}`, target: "_blank", rel: "noopener" }, icon("open_in_new"), " Explorer") : null),
        h("p.muted.small", `Put it in src/data/names-config.js (chainId ${chainId}) and publish Helios: usernames switch on.`));
      // sviluppo: Helios in questo browser usa il registro appena deployato (es. su Sepolia), senza pubblicare niente
      if (import.meta.env?.DEV) out.append(h("button.btn.primary", { onclick: () => { localStorage.setItem("ygoweb.namesDev", JSON.stringify({ chainId, address, rpc: chain.rpc, explorer: chain.explorer, opensea: chain.opensea })); location.hash = ""; location.reload(); } }, `Use it in this browser on ${chain.name} (development)`));
    } catch (e) {
      out.append(h("p.error", e.shortMessage ?? e.message));
    }
  };
  root.append(h("div.page.deploy-page",
    h("div.page-head", h("button.btn.ghost.round.page-back", { onclick: () => { location.hash = ""; app.home(); } }, icon("chevron_left")), h("h1", "Deploy the username registry")),
    h("p", "Deploys contracts/HeliosNames.sol (no owner, no fees) with the browser wallet. Do it once per network: then write the address in src/data/names-config.js."),
    h("p.muted.small", `Compiler ${art.compiler} · EVM ${art.evmVersion} · ${(art.bytecode.length - 2) / 2} bytes of init code`),
    h("div.grid2", h("label.field", h("span", "Network"), netSel), h("label.field", h("span", "Wallet"), wallets.length ? walletSel : h("span.muted.small", "No browser wallet found"))),
    h("div.row", h("button.btn", { onclick: checkCost }, icon("calculate"), " Check cost"), h("button.btn.primary", { onclick: run }, icon("rocket_launch"), " Deploy with my browser wallet")),
    costOut,
    out));
}
