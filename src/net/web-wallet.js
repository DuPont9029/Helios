// Wallet del browser (estensioni come OneKey, MetaMask, Rabby): si trovano con EIP-6963 (ogni estensione si annuncia
// con nome e icona), o con window.ethereum per quelle vecchie. Collegandolo, Helios ne legge solo l'indirizzo (mai il
// seed: resta nell'estensione) per mostrarne il saldo in Wallets. Il collegamento si ricorda in questo browser e alla
// volta dopo si riprende senza chiedere (eth_accounts), finché l'estensione lo permette.
const KEY = "ygoweb.webWallet"; // { id, name, address }

const found = new Map(); // id → { info: { name, icon, rdns, uuid }, provider }
window.addEventListener("eip6963:announceProvider", (e) => {
  const { info, provider } = e.detail ?? {};
  if (!info || !provider?.request) return;
  found.set(info.rdns || info.uuid || info.name, { info, provider });
});

const idOf = (w) => w.info.rdns || w.info.uuid || w.info.name;

/** Le estensioni installate (aspetta un attimo che si annuncino). */
export async function discoverWallets(wait = 350) {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, wait));
  const list = [...found.values()];
  const eth = window.ethereum;
  if (!list.length && eth?.request) {
    const name = eth.isOneKey ? "OneKey" : eth.isRabby ? "Rabby" : eth.isMetaMask ? "MetaMask" : "Browser wallet";
    list.push({ info: { name, icon: "", rdns: "injected" }, provider: eth });
  }
  return list;
}

const save = (v) => {
  try {
    v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY);
  } catch {
    /* storage non disponibile: il collegamento vale per questa sessione */
  }
};
export const savedWallet = () => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    return v && /^0x[0-9a-fA-F]{40}$/.test(v.address ?? "") ? v : null;
  } catch {
    return null;
  }
};

/** Chiede all'estensione l'accesso all'indirizzo (la finestra la mostra l'estensione). { id, name, icon, address }. */
export async function connectWallet(w) {
  let accounts;
  try {
    accounts = await w.provider.request({ method: "eth_requestAccounts" });
  } catch (e) {
    if (e?.code === 4001) throw new Error(`${w.info.name}: connection refused`);
    throw new Error(`${w.info.name} did not answer (${e?.message ?? e})`);
  }
  const address = Array.isArray(accounts) ? accounts[0] : null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) throw new Error(`${w.info.name} gave no address`);
  const v = { id: idOf(w), name: w.info.name, address };
  save(v);
  return { ...v, icon: w.info.icon };
}

/** Il wallet collegato l'altra volta, se l'estensione c'è ancora e lo permette ancora (senza finestre). */
export async function restoreWallet() {
  const s = savedWallet();
  if (!s) return null;
  const w = (await discoverWallets()).find((x) => idOf(x) === s.id);
  if (!w) return { ...s, missing: true };
  try {
    const accounts = await w.provider.request({ method: "eth_accounts" });
    if (!accounts?.length) return { ...s, missing: true };
    const address = accounts[0];
    if (address !== s.address) save({ ...s, address });
    return { ...s, address, icon: w.info.icon };
  } catch {
    return { ...s, missing: true };
  }
}

/** Scollega: Helios lo dimentica e, se l'estensione lo supporta, le toglie il permesso. */
export async function forgetWallet() {
  const s = savedWallet();
  save(null);
  if (!s) return;
  const w = (await discoverWallets(150)).find((x) => idOf(x) === s.id);
  await w?.provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
}

/** "0.05" → wei (BigInt); errore se non è un importo valido. */
export function toWei(text) {
  const t = String(text ?? "").trim().replace(",", ".");
  const m = t.match(/^(\d+)(?:\.(\d{1,18}))?$/);
  if (!m) throw new Error("Write an amount like 0.01");
  const wei = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0"));
  if (wei <= 0n) throw new Error("The amount must be more than 0");
  return wei;
}

/**
 * Manda ETH dal wallet del browser collegato: la transazione la mostra e la conferma l'estensione (Helios non firma
 * niente). Sempre sulla rete principale di Ethereum. Restituisce l'hash della transazione.
 */
export async function sendEth(to, amount) {
  const wei = toWei(amount);
  const s = savedWallet();
  if (!s) throw new Error("Connect a browser wallet first");
  const w = (await discoverWallets()).find((x) => idOf(x) === s.id);
  if (!w) throw new Error(`${s.name} is not available: unlock it, or reload the page`);
  const ask = (method, params) => w.provider.request(params ? { method, params } : { method });
  try {
    const [from] = await ask("eth_requestAccounts");
    if ((await ask("eth_chainId")) !== "0x1") await ask("wallet_switchEthereumChain", [{ chainId: "0x1" }]);
    return await ask("eth_sendTransaction", [{ from, to, value: "0x" + wei.toString(16) }]);
  } catch (e) {
    if (e?.code === 4001) throw new Error("Transaction cancelled in the wallet");
    throw new Error(e?.message ?? String(e));
  }
}
