// Wallet del profilo: un indirizzo Ethereum e uno Monero (derivati dalle parole come Cake Wallet, net/wallets.js)
// con i loro saldi. ETH: eth_getBalance su RPC pubblici. XMR: scansione dei blocchi qui nel browser
// (net/monero-scan.js) da quando il wallet è stato aperto la prima volta (xmrBirthdays, salvato con il profilo);
// il punto raggiunto e gli output trovati restano in questo browser, così la volta dopo si riparte da lì.
// Accesso: con un OneKey KeyTag (ui/keytag.js: si rifanno i buchi della piastra e le parole diventano il profilo) o
// collegando il wallet del browser (net/web-wallet.js: OneKey, MetaMask… ne mostra indirizzo e saldo ETH).
import { h, clear, icon } from "./dom.js";
import { openModal, toast, confirmModal, promptModal } from "./modal.js";
import { identity, importIdentity } from "../net/identity.js";
import { openKeyTag } from "./keytag.js";
import { discoverWallets, connectWallet, restoreWallet, forgetWallet } from "../net/web-wallet.js";
import { copyText } from "../net/clipboard.js";
import { settings } from "../data/settings.js";

const ETH_RPC = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"];
const STATE = "ygoweb.xmrScan"; // { indirizzo: { scanned, outs: [{ tx, i, height, amount, ki }] } }

async function ethBalance(address) {
  for (const url of ETH_RPC) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }) });
      const v = await r.json();
      if (typeof v.result === "string") return BigInt(v.result);
    } catch {
      /* il prossimo */
    }
  }
  throw new Error("No Ethereum node answered");
}

/** Importo intero (wei, piconero) con `decimals` cifre decimali, al massimo 6 mostrate. */
function fmt(n, decimals) {
  const s = n.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals, -decimals + 6).replace(/0+$/, "");
  return BigInt(int).toLocaleString("en-US") + (frac ? `.${frac}` : "");
}

const readState = () => {
  try {
    const v = JSON.parse(localStorage.getItem(STATE) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
const writeState = (address, st) => {
  try {
    localStorage.setItem(STATE, JSON.stringify({ ...readState(), [address]: st }));
  } catch {
    /* storage pieno: si riscansiona la prossima volta */
  }
};

/** onProfile: il profilo è cambiato (accesso con il KeyTag), chi ha aperto Wallets si ridisegna. */
export async function showWallets({ onProfile } = {}) {
  const [{ bip39Seed, ethAddresses, moneroWallet }, scan, { syncProfileStore }] = await Promise.all([
    import("../net/wallets.js"),
    import("../net/monero-scan.js"),
    import("../net/profile-sync.js"),
  ]);
  let passphrase = "";
  let ctrl = null;

  const card = (cls, name, unit) => {
    const amount = h("span.wallet-amount", "…");
    const status = h("div.wallet-status.muted.small");
    const bar = h("div.wallet-bar", { hidden: true }, h("div"));
    const addr = h("code.mono.wallet-addr");
    const copy = h("button.btn.small.ghost", { title: "Copy the address" }, icon("content_copy"));
    const el = h(`div.wallet-card.${cls}`,
      h("div.wallet-head", h("span.wallet-coin", unit), h("span.wallet-name", name)),
      h("div.wallet-balance", amount, h("span.wallet-unit", unit)),
      bar, status,
      h("div.wallet-addr-row", addr, copy));
    return { el, amount, status, bar, addr, copy };
  };
  const eth = card("eth", "Ethereum", "ETH");
  const xmr = card("xmr", "Monero", "XMR");
  const web = card("web", "Browser wallet", "ETH");
  web.el.hidden = true;
  const webIcon = h("img.wallet-icon", { alt: "", hidden: true });
  web.el.querySelector(".wallet-head").prepend(webIcon);
  web.el.querySelector(".wallet-coin").remove();
  const webName = web.el.querySelector(".wallet-name");
  web.el.querySelector(".wallet-head").append(h("button.btn.small.ghost.wallet-off", { title: "Disconnect this wallet from Helios", onclick: async () => { await forgetWallet(); web.el.hidden = true; toast("Browser wallet disconnected"); } }, "Disconnect"));
  const noSeed = h("p.muted.small", { hidden: true }, "This profile has no seed words (it was created before they existed): log in with a KeyTag, or connect a browser wallet.");

  // ---- accesso: KeyTag o wallet del browser
  async function keyTagLogin() {
    const words = await openKeyTag({
      title: "Log in with OneKey KeyTag",
      action: "Log in",
      intro: "Punch here the holes of your KeyTag: its words become your Helios profile (rating, friends, custom cards and these wallets). Each row is one word, the holes add up to its number in the BIP39 list (2048 + … + 1).",
    });
    if (!words) return;
    if (words === identity().seed) return toast("These are already the words of your profile", { kind: "ok" });
    if (!(await confirmModal("Log in with these words?", "They replace the profile of this browser (player key, rating, friends): if you have not backed up the current one, it is lost.", "Log in", "Cancel", { danger: true, top: true }))) return;
    try {
      importIdentity(words);
    } catch (e) {
      return toast(e.message, { kind: "error" });
    }
    toast("Logged in with your KeyTag: friends, settings and custom cards are loaded from the Nostr relays", { kind: "ok", ms: 4000 });
    onProfile?.();
    derive();
  }

  function showWeb(w) {
    web.el.hidden = false;
    webName.textContent = w.name;
    webIcon.hidden = !w.icon;
    if (w.icon) webIcon.src = w.icon;
    web.addr.textContent = w.address;
    web.copy.onclick = () => copyText(w.address).then((ok) => toast(ok ? "Address copied" : "Copy failed"));
    web.status.textContent = w.missing ? `${w.name} is not available now (extension missing or locked): the balance still shows.` : "";
    web.amount.textContent = "…";
    ethBalance(w.address).then((wei) => (web.amount.textContent = fmt(wei, 18))).catch((e) => { web.amount.textContent = "—"; web.status.textContent = e.message; });
  }

  async function connectWeb() {
    const list = await discoverWallets();
    if (!list.length) {
      return openModal({
        title: "No browser wallet found",
        body: [h("p", "Install a wallet extension (for example OneKey, MetaMask or Rabby), unlock it and reload Helios. Helios only reads its address: the seed stays in the extension.")],
        actions: [{ label: "OK", primary: true, value: true }],
      });
    }
    let picker = null;
    const pick = list.length === 1 ? list[0] : await (picker = openModal({
      title: "Connect a browser wallet",
      className: "top",
      body: [h("div.web-wallets", list.map((w) => h("button.btn.web-wallet", { onclick: () => picker.close(w) }, w.info.icon ? h("img.wallet-icon", { src: w.info.icon, alt: "" }) : icon("account_balance_wallet"), w.info.name)))],
      actions: [{ label: "Cancel", value: null }],
    })).result;
    if (!pick) return;
    try {
      showWeb(await connectWallet(pick));
      toast(`${pick.info.name} connected`, { kind: "ok" });
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }

  const passInput = h("input.input", { type: "password", placeholder: "Passphrase (optional)", autocomplete: "off" });
  const seedBox = h("div", { hidden: true });
  const advanced = h("div.wallet-advanced", { hidden: true },
    h("p.muted.small", "Same derivation as Cake Wallet: restore your 12 words there (with the same passphrase) and you get the same wallets. Whoever has the words controls the funds, and Helios keeps them in this browser without a password: keep small amounts only."),
    passInput,
    h("div.row",
      h("button.btn.small", { onclick: () => showMoneroSeed() }, icon("key"), " Monero seed (25 words)"),
      h("button.btn.small", { onclick: () => rescan() }, icon("history"), " Rescan Monero from a block")),
    seedBox);

  let wallet = null;
  async function showMoneroSeed() {
    if (!(await confirmModal("Show the Monero seed", "These 25 words control the Monero wallet: make sure nobody is looking at your screen.", "Show", "Cancel"))) return;
    clear(seedBox).append(h("ol.seed-words.xmr", wallet.xmr.seed.split(" ").map((w) => h("li", w))),
      h("button.btn.small", { onclick: () => copyText(wallet.xmr.seed).then((ok) => toast(ok ? "Monero seed copied" : "Copy failed")) }, icon("content_copy"), " Copy"));
    seedBox.hidden = false;
  }

  async function rescan() {
    const v = await promptModal("Rescan Monero", "Block height to scan from (lower = slower)", String(birthdays()[wallet.xmr.address] ?? ""));
    const height = parseInt(v, 10);
    if (!Number.isInteger(height) || height <= 0) return;
    settings.xmrBirthdays = { ...birthdays(), [wallet.xmr.address]: height };
    writeState(wallet.xmr.address, { scanned: height, outs: [] });
    refreshXmr();
  }

  const birthdays = () => (settings.xmrBirthdays && typeof settings.xmrBirthdays === "object" ? settings.xmrBirthdays : {});

  async function refreshEth() {
    const address = wallet.eth.address;
    eth.amount.textContent = "…";
    eth.status.textContent = "";
    try {
      const wei = await ethBalance(address);
      if (wallet.eth.address === address) eth.amount.textContent = fmt(wei, 18);
    } catch (e) {
      eth.amount.textContent = "—";
      eth.status.textContent = e.message;
    }
  }

  async function refreshXmr() {
    ctrl?.abort();
    const my = (ctrl = new AbortController());
    const { signal } = my;
    const { address, scanKeys } = wallet.xmr;
    const alive = () => !signal.aborted && wallet.xmr.address === address;
    const show = (outs, status) => {
      if (!alive()) return;
      const total = outs.filter((o) => !o.spent).reduce((n, o) => n + BigInt(o.amount), 0n);
      xmr.amount.textContent = fmt(total, 12);
      if (status != null) xmr.status.textContent = status;
    };
    xmr.amount.textContent = "…";
    xmr.bar.hidden = true;
    try {
      xmr.status.textContent = "Connecting to a Monero node…";
      const tip = await scan.chainHeight({ signal });
      let from = birthdays()[address];
      if (!from) {
        // prima apertura: magari è già salvato con il profilo (un altro browser)
        await syncProfileStore().catch(() => {});
        from = birthdays()[address];
        if (!from) {
          from = tip - 10;
          settings.xmrBirthdays = { ...birthdays(), [address]: from };
        }
      }
      const st = readState()[address] ?? { scanned: from, outs: [] };
      if (st.scanned < from) Object.assign(st, { scanned: from, outs: [] });
      show(st.outs, null);
      if (st.scanned < tip) {
        const total = tip - st.scanned;
        xmr.bar.hidden = false;
        await scan.scanBlocks(st.scanned, tip, scanKeys, {
          signal,
          onBlock: (height, found) => {
            const seen = new Set(st.outs.map((o) => `${o.tx}:${o.i}`));
            for (const o of found) if (!seen.has(`${o.tx}:${o.i}`)) st.outs.push(o);
            found.length = 0;
            st.scanned = height;
            writeState(address, st);
            if (!alive()) return;
            const pct = ((height - (tip - total)) / total) * 100;
            xmr.bar.firstChild.style.width = `${pct}%`;
            show(st.outs, `Syncing… ${Math.floor(pct)}% (${(tip - height).toLocaleString("en-US")} blocks left)`);
          },
        });
      }
      if (!alive()) return;
      xmr.bar.hidden = true;
      // output spesi: la key image è già nella blockchain (o nel mempool)
      const status = await scan.spentStatus(st.outs.map((o) => o.ki), { signal });
      st.outs.forEach((o, k) => (o.spent = status[k] > 0));
      writeState(address, st);
      show(st.outs, `Synced · block ${tip.toLocaleString("en-US")}`);
    } catch (e) {
      if (signal.aborted) return;
      xmr.bar.hidden = true;
      const st = readState()[address];
      if (st) show(st.outs, null);
      else xmr.amount.textContent = "—";
      xmr.status.textContent = `Monero nodes unreachable (${e.message})`;
    }
  }

  function derive() {
    const has = !!identity().seed;
    eth.el.hidden = xmr.el.hidden = !has;
    noSeed.hidden = has;
    advancedBtn && (advancedBtn.hidden = !has);
    if (!has) {
      ctrl?.abort();
      return;
    }
    const seed = bip39Seed(identity().seed, passphrase);
    wallet = { eth: ethAddresses(seed, 1)[0], xmr: moneroWallet(seed) };
    for (const [c, a] of [[eth, wallet.eth.address], [xmr, wallet.xmr.address]]) {
      c.addr.textContent = a;
      c.copy.onclick = () => copyText(a).then((ok) => toast(ok ? "Address copied" : "Copy failed"));
    }
    clear(seedBox).hidden = true;
    refreshEth();
    refreshXmr();
  }

  let t = null;
  passInput.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      passphrase = passInput.value;
      derive();
    }, 400);
  });

  let advancedBtn = null;
  derive();
  restoreWallet().then((w) => w && showWeb(w));
  const access = h("div.wallet-access",
    h("button.btn.small", { title: "Punch the holes of your OneKey KeyTag: its words become your profile", onclick: keyTagLogin }, icon("grid_on"), " Log in with OneKey KeyTag"),
    h("button.btn.small", { title: "OneKey, MetaMask, Rabby… as a browser extension: Helios reads its address and ETH balance", onclick: connectWeb }, icon("link"), " Connect browser wallet"));
  const modal = openModal({
    title: "Wallets",
    className: "wallets-modal",
    body: [access, noSeed, h("div.wallet-cards", eth.el, xmr.el, web.el), advanced],
    onClose: () => ctrl?.abort(),
    actions: [
      { label: "Advanced", onClick: () => (advanced.hidden = !advanced.hidden) },
      { label: "Refresh", onClick: () => { if (identity().seed) { refreshEth(); refreshXmr(); } restoreWallet().then((w) => w && showWeb(w)); } },
      { label: "Done", primary: true, value: true },
    ],
  });
  advancedBtn = modal.buttons[0];
  advancedBtn.hidden = !identity().seed;
}
