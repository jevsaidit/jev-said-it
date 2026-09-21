import { defineChain, type Chain } from "viem";

// The chain a wallet must be on is decided by the engine (/config.chainId), never by the page:
// the site cannot send calls to a different ledger than the one that gets scored.

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com/rpc"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

// Local anvil, for the end-to-end test of the play panel.
export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const CHAINS: Record<number, Chain> = { 4663: robinhood, 46630: robinhoodTestnet, 31337: anvil };

export const LEDGER_ABI = [
  { type: "function", name: "submit", stateMutability: "nonpayable", inputs: [{ name: "ids", type: "bytes32[]" }, { name: "agree", type: "bool[]" }], outputs: [] },
  { type: "function", name: "callsUsed", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "answered", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "capacity", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "currentEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const DISTRIBUTOR_ABI = [
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "epoch", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "proof", type: "bytes32[]" }], outputs: [] },
  { type: "function", name: "hasClaimed", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "epochSetAt", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochVoided", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "CLAIM_DELAY", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
