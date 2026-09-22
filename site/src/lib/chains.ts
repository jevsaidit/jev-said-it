import { defineChain, type Chain } from "viem";
import { ANVIL_ALLOWED } from "@/lib/supported";

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
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_ANVIL_RPC ?? "http://127.0.0.1:8545"] } },
  testnet: true,
});

export const CHAINS: Record<number, Chain> = ANVIL_ALLOWED
  ? { 4663: robinhood, 46630: robinhoodTestnet, 31337: anvil }
  : { 4663: robinhood, 46630: robinhoodTestnet };

// The errors are listed so viem can name a revert ("QuestionClosed") instead of printing its selector.
// Names copied from contracts/src/CallLedger.sol and contracts/src/RewardsDistributor.sol.
const err = (name: string) => ({ type: "error" as const, name, inputs: [] as const });

export const LEDGER_ABI = [
  { type: "function", name: "submit", stateMutability: "nonpayable", inputs: [{ name: "ids", type: "bytes32[]" }, { name: "agree", type: "bool[]" }], outputs: [] },
  { type: "function", name: "callsUsed", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "answered", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "capacity", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "currentEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  err("NotAuthorized"),
  err("LengthMismatch"),
  err("QuestionClosed"),
  err("NoCapacity"),
  err("AlreadyAnswered"),
  err("BadDeadline"),
  err("AlreadyOpen"),
  err("WrongEpoch"),
  err("DeadlinePastEpoch"),
] as const;

export const DISTRIBUTOR_ABI = [
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "epoch", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "proof", type: "bytes32[]" }], outputs: [] },
  { type: "function", name: "hasClaimed", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "epochSetAt", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochVoided", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "CLAIM_DELAY", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "CLAIM_WINDOW", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  err("ZeroAddress"),
  err("NotAuthorized"),
  err("RootExists"),
  err("BudgetTooLarge"),
  err("InvalidProof"),
  err("AlreadyClaimed"),
  err("BudgetExceeded"),
  err("NotExpired"),
  err("AlreadySwept"),
  err("NoRoot"),
  err("EpochNotIncreasing"),
  err("EpochTooSoon"),
  err("ClaimsNotOpen"),
  err("VoidedEpoch"),
  err("VoidWindowClosed"),
  err("AlreadyVoided"),
  err("EpochNotEnded"),
  err("ClaimWindowClosed"),
  err("ZeroBudget"),
] as const;

// What each revert means to the person holding the wallet. Anything not listed is shown by its name.
export const REVERT_TEXT: Record<string, string> = {
  QuestionClosed: "Calls on one of these questions have closed. Reload and pick again.",
  NoCapacity: "This wallet does not hold enough tokens for that many calls.",
  AlreadyAnswered: "This wallet already answered one of these questions.",
  LengthMismatch: "The call list was malformed. Reload and pick again.",
  ClaimsNotOpen: "Claims for this epoch are not open yet: the guardian's window is still running.",
  ClaimWindowClosed: "The 90-day claim window for this epoch has closed.",
  VoidedEpoch: "The guardian voided this epoch's payouts. Nothing can be claimed from it.",
  AlreadyClaimed: "This reward was already claimed.",
  InvalidProof: "The proof does not match the published root. Reload and try again.",
  BudgetExceeded: "This epoch's budget is already fully claimed.",
  NoRoot: "No payouts have been published for this epoch.",
};
