// Registro degli username di Helios (contracts/HeliosNames.sol). address vuoto = non ancora deployato: gli username
// restano spenti e Helios si comporta come prima. Dopo il deploy (pagina #deploy-names) si scrive qui l'indirizzo.
/** Reti conosciute: RPC pubblici, explorer e marketplace (per i link alla card). */
export const CHAINS = {
  1: { name: "Ethereum", rpc: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://cloudflare-eth.com"], explorer: "https://etherscan.io", opensea: "https://opensea.io/assets/ethereum" },
  11155111: { name: "Sepolia (testnet)", rpc: ["https://ethereum-sepolia-rpc.publicnode.com", "https://1rpc.io/sepolia"], explorer: "https://sepolia.etherscan.io", opensea: "https://testnets.opensea.io/assets/sepolia" },
  1337: { name: "Local (ganache)", rpc: ["http://127.0.0.1:8545"], explorer: "", opensea: "" },
};

export const NAMES_CONFIG = {
  chainId: 1, // Ethereum mainnet
  // Deploy del 19/11/2026, blocco 26451515, tx 0x7c4765423466e5cae3170cbbf71f3b83ca315b36d5ea0e153553251ae9cb734b
  // (initcode identico a src/data/names-contract.json a parte i metadata; sorgente verificato su Sourcify).
  address: "0x8539D33A42cf1f2ACDD72DEBD3e31A75C9F136C6",
  rpc: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://cloudflare-eth.com"],
  explorer: "https://etherscan.io",
};
