// Username on-chain (net/names.js): scelta e registrazione del nome (pagato da sé o da un amico), richieste di pagamento
// ricevute dagli amici, conio della card NFT e pagina di deploy del registro (#deploy-names).
import { h, clear, icon } from "./dom.js";
import { openModal, toast } from "./modal.js";
import { settings } from "../data/settings.js";
import { identity } from "../net/identity.js";
import { copyText } from "../net/clipboard.js";
import { socialState, sendDirect, onNameMessage } from "../net/social.js";
import * as names from "../net/names.js";

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
/** La frase della card on-chain: solo caratteri semplici, al massimo 48. */
export const cardBio = (s) => String(s ?? "").replace(/[^\x20-\x7e]|[<>&"\\]/g, "").slice(0, 48);

/** Conio della card (o richiesta a un amico): colore, motivo e frase sono quelli della scheda. */
export function openMintDialog({ onDone } = {}) {
  const style = { color: (settings.cardColor || "#38c6ff").toLowerCase(), pattern: Math.max(0, PATTERNS.indexOf(settings.cardPattern || "rays")), bio: cardBio(settings.bio) };
  const progress = h("p.small.name-progress");
  const owner = settings.usernameWallet;
  const ownWallet = async () => {
    // la card la conia il wallet a cui è intestato il nome
    const helios = identity().seed ? await (await names.heliosSigner()).getAddress() : "";
    return owner.toLowerCase() === helios.toLowerCase() ? "helios" : "browser";
  };
  const payer = payerPicker({ note: `Your card is an NFT on Ethereum, bound to ${owner.slice(0, 8)}…: it shows your username with the color, pattern and line of your player card ("${style.bio || "no line"}"). Only gas, no price.` });
  const m = openModal({
    title: "Mint your on-chain card",
    className: "username-modal",
    body: [payer.el, progress],
    actions: [
      { label: "Close", value: null },
      {
        label: "Mint",
        primary: true,
        onClick: async (close) => {
          const { via, friendPk } = payer.get();
          const steps = (s) => (progress.textContent = s);
          progress.className = "small name-progress muted";
          try {
            const mine = await ownWallet();
            const ownerSigner = await signerFor(mine);
            if (via === "friend") {
              if (!friendPk) throw new Error("Choose a friend");
              const req = await names.signCardRequest(ownerSigner, { color: style.color.replace("#", "0x"), pattern: style.pattern, bio: style.bio });
              if (!(await sendDirect(friendPk, { t: "name-pay", req }))) throw new Error("The Nostr relays did not answer: try again");
              toast("Request sent to your friend", { kind: "ok" });
              return close(true);
            }
            if (via !== mine) throw new Error(`The card is minted by the wallet that owns the name: choose "${mine === "helios" ? "My Helios wallet" : "My browser wallet"}", or ask a friend`);
            await names.mintCard(ownerSigner, { color: style.color.replace("#", "0x"), pattern: style.pattern, bio: style.bio }, { steps });
            toast("Your on-chain card is minted", { kind: "ok" });
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

// ---------------------------------------------------------------- richieste degli amici

const requests = []; // { from, name, req, at }

function cleanRequest(r) {
  const hex = (v, n) => typeof v === "string" && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(v);
  if (!r || !hex(r.owner, 40) || !Number.isInteger(r.deadline) || typeof r.sig !== "string" || r.deadline < Date.now() / 1000) return null;
  if (r.kind === "register" && typeof r.name === "string" && !names.nameProblem(r.name) && hex(r.nostr, 64)) return r;
  if (r.kind === "card" && hex(r.color, 6) && Number.isInteger(r.pattern) && r.pattern >= 0 && r.pattern <= 5 && typeof r.bio === "string" && r.bio === cardBio(r.bio)) return r;
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
            else await names.mintCard(signer, {}, { auth: x.req, steps });
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

/** Pagina #deploy-names: deploy del contratto con il wallet del browser. */
export async function showDeployPage(app) {
  const root = clear(app.root);
  const out = h("div.deploy-out");
  const art = (await import("../data/names-contract.json")).default;
  const { discoverWallets, connectWallet } = await import("../net/web-wallet.js");
  const { ethers } = await import("ethers");
  const run = async () => {
    try {
      const list = await discoverWallets();
      if (!list.length) throw new Error("No browser wallet found: install OneKey, MetaMask or Rabby");
      await connectWallet(list[0]);
      const bp = new ethers.BrowserProvider(list[0].provider);
      const net = await bp.getNetwork();
      const signer = await bp.getSigner();
      const f = new ethers.ContractFactory(art.abi, art.bytecode, signer);
      const gas = await bp.estimateGas(await f.getDeployTransaction());
      const fee = await bp.getFeeData();
      clear(out).append(h("p", `Network: chain ${net.chainId} · from ${await signer.getAddress()} · gas ≈ ${gas} (≈ ${fmtEth(gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n))} at most)`), h("p.muted.small", "Confirm in the wallet…"));
      const c = await f.deploy();
      out.append(h("p.muted.small", `Transaction ${c.deploymentTransaction().hash}: waiting for the block…`));
      await c.waitForDeployment();
      const address = await c.getAddress();
      out.append(h("p.ok", "Deployed at ", h("code", address)), h("button.btn", { onclick: () => copyText(address).then((ok) => toast(ok ? "Address copied" : "Copy failed")) }, icon("content_copy"), " Copy the address"),
        h("p.muted.small", `Put it in src/data/names-config.js (chainId ${net.chainId}) and publish Helios: usernames switch on.`));
      if (import.meta.env?.DEV) out.append(h("button.btn", { onclick: () => { localStorage.setItem("ygoweb.namesDev", JSON.stringify({ chainId: Number(net.chainId), address, rpc: ["http://127.0.0.1:8545"] })); location.hash = ""; location.reload(); } }, "Use it in this browser (development)"));
    } catch (e) {
      out.append(h("p.error", e.shortMessage ?? e.message));
    }
  };
  root.append(h("div.page.deploy-page",
    h("div.page-head", h("button.btn.ghost.round.page-back", { onclick: () => { location.hash = ""; app.home(); } }, icon("chevron_left")), h("h1", "Deploy the username registry")),
    h("p", "Deploys contracts/HeliosNames.sol (no owner, no fees) with the browser wallet. Do it once: then write the address in src/data/names-config.js."),
    h("p.muted.small", `Compiler ${art.compiler} · EVM ${art.evmVersion} · ${(art.bytecode.length - 2) / 2} bytes of init code`),
    h("button.btn.primary", { onclick: run }, icon("rocket_launch"), " Deploy with my browser wallet"),
    out));
}
