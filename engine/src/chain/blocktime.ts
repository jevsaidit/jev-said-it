import type { PublicClient } from "viem";

/**
 * The last block with timestamp <= ts. Deadlines are timestamps, events live in blocks: this is
 * the only translation between the two, and the committed JSON's rule ("at or before") uses it.
 * The RPC does serve old block headers (it is historical STATE that is missing).
 */
export async function blockAtOrBefore(client: PublicClient, ts: number): Promise<bigint | null> {
  const time = async (n: bigint) => Number((await client.getBlock({ blockNumber: n })).timestamp);
  let hi = await client.getBlockNumber({ cacheTime: 0 });
  if ((await time(hi)) <= ts) return hi;
  let lo = 0n;
  if ((await time(lo)) > ts) return null;
  // invariant: time(lo) <= ts < time(hi)
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await time(mid)) <= ts) lo = mid;
    else hi = mid;
  }
  return lo;
}
