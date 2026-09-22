// The chains a wallet can play on, without viem: the play panel's shell reads this to decide whether
// to load the wallet code at all, so a visitor who never connects never downloads it.

export type SupportedChain = { id: number; name: string };

const MAINNET: SupportedChain[] = [
  { id: 4663, name: "Robinhood Chain" },
  { id: 46630, name: "Robinhood Chain Testnet" },
];

// Local anvil only outside production builds: a real visitor must never be asked to "Switch to Anvil".
export const ANVIL_ALLOWED = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_ALLOW_ANVIL === "1";

export const SUPPORTED: SupportedChain[] = ANVIL_ALLOWED ? [...MAINNET, { id: 31337, name: "Anvil" }] : MAINNET;

export const supportedChain = (id: number | null | undefined) => SUPPORTED.find((c) => c.id === id);
