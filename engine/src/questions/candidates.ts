import type { Db } from "../db/db.js";

// At 0.105 s/block (measured). Only used to bound the selection windows, it enters no public
// commitment: those use block timestamps.
export const BLOCKS_PER_HOUR = 34_000n;

export interface Candidate {
  poolId: string;
  token: string;
  swapsLastHour: number;
}

/**
 * Tokens graduated on Pons in the last 48h, with enough swaps in the last hour to have a price
 * that moves, AND over the last 6h: a pool that woke up for one hour and died gives a question with
 * no swap in its settlement window, i.e. a VOID (seen twice in one testnet batch, 21/09). On 57h of
 * mainnet history the 6h floor removed no question from any batch: it costs nothing today.
 * Our own token is excluded: asking about our own price is a conflict, and an invitation to pump it.
 */
export async function selectCandidates(
  db: Db,
  p: { head: bigint; minSwapsLastHour: number; minSwapsLast6h: number; limit: number; exclude: string[] },
): Promise<Candidate[]> {
  const r = await db.query<{ pool_id: string; token: string; n: string }>(
    `SELECT p.pool_id, p.token, count(s.*) FILTER (WHERE s.block > $2) n
       FROM pools p JOIN swaps s ON s.pool_id = p.pool_id AND s.block > $6
      WHERE p.start_block > $1 AND NOT (p.token = ANY($5::text[]))
      GROUP BY p.pool_id, p.token
     HAVING count(s.*) FILTER (WHERE s.block > $2) >= $3 AND count(s.*) >= $7
      ORDER BY n DESC, p.pool_id
      LIMIT $4`,
    [
      (p.head - 48n * BLOCKS_PER_HOUR).toString(),
      (p.head - BLOCKS_PER_HOUR).toString(),
      p.minSwapsLastHour,
      p.limit,
      p.exclude.map((a) => a.toLowerCase()),
      (p.head - 6n * BLOCKS_PER_HOUR).toString(),
      p.minSwapsLast6h,
    ],
  );
  return r.rows.map((x) => ({ poolId: x.pool_id, token: x.token, swapsLastHour: Number(x.n) }));
}

/**
 * What the index knows about a token, passed to the model as `state` (spec §8): it is the context
 * Jev does not have on its own. The token's ETH price is proportional to 1/sqrtPriceX96^2 (ETH is
 * currency0), so the change is (sqrt_before / sqrt_now)^2 - 1.
 */
export async function marketState(db: Db, poolId: string, token: string, head: bigint): Promise<Record<string, string | number | null>> {
  const at = async (block: bigint) => {
    const r = await db.query<{ s: string }>(
      "SELECT sqrt_price_x96 s FROM swaps WHERE pool_id = $1 AND block <= $2 ORDER BY block DESC, log_index DESC LIMIT 1",
      [poolId, block.toString()],
    );
    return r.rows[0] ? Number(r.rows[0].s) : null;
  };
  const now = await at(head);
  const change = (before: number | null) => (now && before ? Number(((before / now) ** 2 - 1).toFixed(4)) : null);
  const meta = await db.query<{ start_block: string; n1: string; n6: string }>(
    `SELECT p.start_block,
            (SELECT count(*) FROM swaps s WHERE s.pool_id = p.pool_id AND s.block > $2) n1,
            (SELECT count(*) FROM swaps s WHERE s.pool_id = p.pool_id AND s.block > $3) n6
       FROM pools p WHERE p.pool_id = $1`,
    [poolId, (head - BLOCKS_PER_HOUR).toString(), (head - 6n * BLOCKS_PER_HOUR).toString()],
  );
  const m = meta.rows[0];
  return {
    chain: "Robinhood Chain",
    venue: "Uniswap v4 pool created at Pons graduation, paired with ETH",
    token,
    hoursSinceGraduation: m ? Number(((Number(head) - Number(m.start_block)) / Number(BLOCKS_PER_HOUR)).toFixed(1)) : null,
    priceChange1h: change(await at(head - BLOCKS_PER_HOUR)),
    priceChange6h: change(await at(head - 6n * BLOCKS_PER_HOUR)),
    swapsLastHour: m ? Number(m.n1) : null,
    swapsLast6h: m ? Number(m.n6) : null,
  };
}
