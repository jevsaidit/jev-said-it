import { createPublicClient, createWalletClient, defineChain, fallback, http, type Hex, type HttpTransportConfig, type PublicClient, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Some of the chain's endpoints reject requests without a User-Agent: always send one.
export const USER_AGENT = "jevsaidit-engine/0.1";

/** RPC_URL may list several endpoints, comma-separated: the first is used while it answers, the next ones
 *  only when it fails (22/09/2026: the public endpoint stopped answering Railway for five minutes at launch,
 *  and every task went blind). A node that lags is covered by CONFIRMATIONS, raised to 100 alongside. */
export function transportFor(rpcUrl: string, opts: HttpTransportConfig = {}): Transport {
  const urls = rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
  const headers = { fetchOptions: { headers: { "User-Agent": USER_AGENT } } };
  if (urls.length === 1) return http(urls[0], { ...opts, ...headers });
  // Several endpoints: one quick retry each, then the next one. Six retries on a dead endpoint first
  // (the single-URL setting) took 51 s per call before the fallback was even tried.
  const each = urls.map((u) => http(u, { ...opts, ...headers, retryCount: 1, retryDelay: 300 }));
  return fallback(each, { rank: false, retryCount: opts.retryCount ?? 3, retryDelay: opts.retryDelay ?? 400 });
}

/** First line of an error plus the HTTP status when there is one: "HTTP request failed." alone does not say
 *  whether it was a 429, a 403 or a timeout, and each has a different cure. */
export function errText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const status = (e as { status?: number }).status ?? ((e as { cause?: { status?: number } }).cause?.status);
  const first = e.message.split("\n")[0]!;
  return status ? `${first} (HTTP ${status})` : first;
}

export function makeClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    // cacheTime 0: otherwise viem caches getBlockNumber, and a stalled engine would keep
    // seeing the same head and believe the chain had stopped.
    cacheTime: 0,
    // viem retries 429 and 5xx with exponential backoff: 400ms, 800ms, ... ~25s in total, per endpoint.
    transport: transportFor(rpcUrl, { retryCount: 6, retryDelay: 400, timeout: 30_000 }),
  });
}

/** Signing client. The chain is declared from the id read from the node, so it also works for anvil and testnet. */
export function makeWallet(rpcUrl: string, chainId: number, pk: Hex): WalletClient {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: rpcUrl.split(",").map((u) => u.trim()).filter(Boolean) } },
  });
  return createWalletClient({
    account: privateKeyToAccount(pk),
    chain,
    transport: transportFor(rpcUrl),
  });
}
