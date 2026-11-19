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
  address: "",
  rpc: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://cloudflare-eth.com"],
  explorer: "https://etherscan.io",
};
