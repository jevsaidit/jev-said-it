import { createPublicClient, createWalletClient, defineChain, http, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Some of the chain's endpoints reject requests without a User-Agent: always send one.
export const USER_AGENT = "jevsaidit-engine/0.1";

export function makeClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    // cacheTime 0: otherwise viem caches getBlockNumber, and a stalled engine would keep
    // seeing the same head and believe the chain had stopped.
    cacheTime: 0,
    transport: http(rpcUrl, {
      fetchOptions: { headers: { "User-Agent": USER_AGENT } },
      // viem retries 429 and 5xx with exponential backoff: 400ms, 800ms, ... ~25s in total.
      retryCount: 6,
      retryDelay: 400,
      timeout: 30_000,
    }),
  });
}

/** Signing client. The chain is declared from the id read from the node, so it also works for anvil and testnet. */
export function makeWallet(rpcUrl: string, chainId: number, pk: Hex): WalletClient {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return createWalletClient({
    account: privateKeyToAccount(pk),
    chain,
    transport: http(rpcUrl, { fetchOptions: { headers: { "User-Agent": USER_AGENT } } }),
  });
}
