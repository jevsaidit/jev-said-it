import { parseAbiItem, zeroAddress, type PublicClient } from "viem";
import { getLogsBisect } from "../chain/logs.js";
import { PONS_HOOK, PONS_POOL_FEE, PONS_TICK_SPACING, POOL_MANAGER } from "../config.js";
import { type Db, getCursor, inTx, setCursor } from "../db/db.js";

const INITIALIZE = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);
const SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

export const V4_CURSOR = "v4";

/**
 * Every token that graduates on Pons drags along dozens of junk pools opened by bots on the same
 * token (null hook, random fee and tickSpacing: measured on 21/09, up to 13 pools for a single
 * token). The real pool is ONE: native ETH as currency0, Pons hook, fee 0, tickSpacing 200.
 * Everything else is discarded here, before a junk price can become an outcome.
 */
export function isPonsEthPool(a: { currency0: string; hooks: string; fee: number; tickSpacing: number }): boolean {
  return (
    a.currency0.toLowerCase() === zeroAddress &&
    a.hooks.toLowerCase() === PONS_HOOK.toLowerCase() &&
    a.fee === PONS_POOL_FEE &&
    a.tickSpacing === PONS_TICK_SPACING
  );
}

/**
 * A single cursor for the whole PoolManager. In each range the Initialize events are read first and
 * then the Swaps, so a swap on a pool born in the same range finds the pool already registered.
 */
export async function indexV4(client: PublicClient, db: Db, startBlock: bigint, target: bigint, chunk: bigint, maxSpan: bigint = 0n): Promise<number> {
  let from = ((await getCursor(db, V4_CURSOR)) ?? startBlock - 1n) + 1n;
  let written = 0;
  // A cycle covers at most maxSpan blocks: a long catch-up becomes many short cycles, and /health
  // stays current instead of going silent for a quarter of an hour on first start.
  if (maxSpan > 0n && target > from + maxSpan - 1n) target = from + maxSpan - 1n;
  while (from <= target) {
    const to = from + chunk - 1n < target ? from + chunk - 1n : target;
    const inits = await getLogsBisect(
      (a, b) => client.getLogs({ address: POOL_MANAGER, event: INITIALIZE, fromBlock: a, toBlock: b, strict: true }),
      from,
      to,
    );
    const swaps = await getLogsBisect(
      (a, b) => client.getLogs({ address: POOL_MANAGER, event: SWAP, fromBlock: a, toBlock: b, strict: true }),
      from,
      to,
    );
    const pons = inits.filter((l) => isPonsEthPool(l.args));
    await inTx(db, async (c) => {
      if (pons.length > 0) {
        await c.query(
          `INSERT INTO pools (pool_id, token, start_block)
           SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[]) ON CONFLICT (pool_id) DO NOTHING`,
          [
            pons.map((l) => l.args.id.toLowerCase()),
            pons.map((l) => l.args.currency1.toLowerCase()),
            pons.map((l) => l.blockNumber.toString()),
          ],
        );
      }
      if (swaps.length > 0) {
        // The JOIN does the Pons-pool filtering: a swap on a junk pool never gets in.
        const r = await c.query(
          `INSERT INTO swaps (pool_id, block, log_index, tx_hash, sender, amount0, amount1, sqrt_price_x96, liquidity, tick, fee)
           SELECT s.* FROM unnest($1::text[], $2::bigint[], $3::int[], $4::text[], $5::text[], $6::numeric[], $7::numeric[],
                                  $8::numeric[], $9::numeric[], $10::int[], $11::int[])
                AS s(pool_id, block, log_index, tx_hash, sender, amount0, amount1, sqrt_price_x96, liquidity, tick, fee)
             JOIN pools p ON p.pool_id = s.pool_id
           ON CONFLICT DO NOTHING`,
          [
            swaps.map((l) => l.args.id.toLowerCase()),
            swaps.map((l) => l.blockNumber.toString()),
            swaps.map((l) => l.logIndex),
            swaps.map((l) => l.transactionHash),
            swaps.map((l) => l.args.sender.toLowerCase()),
            swaps.map((l) => l.args.amount0.toString()),
            swaps.map((l) => l.args.amount1.toString()),
            swaps.map((l) => l.args.sqrtPriceX96.toString()),
            swaps.map((l) => l.args.liquidity.toString()),
            swaps.map((l) => l.args.tick),
            swaps.map((l) => l.args.fee),
          ],
        );
        written += r.rowCount ?? 0;
      }
      await setCursor(c, V4_CURSOR, to);
    });
    written += pons.length;
    from = to + 1n;
  }
  return written;
}

/** Last price observed on `poolId` up to and including block `block`, or null if there is no swap. */
export async function lastSqrtPriceAt(db: Db, poolId: string, block: bigint): Promise<{ sqrtPriceX96: bigint; block: bigint } | null> {
  const r = await db.query<{ sqrt_price_x96: string; block: string }>(
    `SELECT sqrt_price_x96, block FROM swaps WHERE pool_id = $1 AND block <= $2
      ORDER BY block DESC, log_index DESC LIMIT 1`,
    [poolId.toLowerCase(), block.toString()],
  );
  const row = r.rows[0];
  return row ? { sqrtPriceX96: BigInt(row.sqrt_price_x96), block: BigInt(row.block) } : null;
}
