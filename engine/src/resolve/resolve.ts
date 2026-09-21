import type { PublicClient } from "viem";
import { blockAtOrBefore } from "../chain/blocktime.js";
import { type Db, getCursor } from "../db/db.js";
import { averageSqrtPrice, lastSqrtPriceAt, V4_CURSOR } from "../indexer/v4.js";

export type Outcome = "1" | "0" | "VOID" | "UNRESOLVABLE";

/**
 * The rule committed in the JSON, and nothing else. The pool has ETH as currency0 and the token as
 * currency1, so sqrtPriceX96 measures TOKEN PER ETH: the token's ETH price rises when sqrtPriceX96
 * FALLS. Getting this direction wrong would invert every outcome, and every test that compares the
 * engine with itself would still pass: that is why it is a pure function, tested by hand.
 */
export function decide(
  before: { sqrtPriceX96: bigint; block: bigint } | null,
  after: { sqrtPriceX96: bigint; block: bigint } | null,
  block0: bigint,
): "1" | "0" | "VOID" {
  if (!before || !after || after.block <= block0) return "VOID"; // no swap between the two instants
  return after.sqrtPriceX96 < before.sqrtPriceX96 ? "1" : "0";
}

export interface ResolveReport {
  resolved: number;
  waiting: number;
  reasons: string[];
}

/** Resolves the questions whose deadline+horizon has passed on the data chain. */
export async function resolveDue(db: Db, data: PublicClient, v4StartBlock: bigint): Promise<ResolveReport> {
  const now = Number((await data.getBlock({ blockTag: "latest" })).timestamp);
  const due = await db.query<{ id: string; pool_id: string; deadline: string; horizon: number; json: string }>(
    `SELECT id, pool_id, deadline, horizon, json FROM questions
      WHERE status = 'OPEN' AND outcome IS NULL AND deadline + horizon <= $1
      ORDER BY deadline, id`,
    [now],
  );
  const cursor = await getCursor(db, V4_CURSOR);
  const blockCache = new Map<number, bigint | null>();
  const blockAt = async (ts: number) => {
    if (!blockCache.has(ts)) blockCache.set(ts, await blockAtOrBefore(data, ts));
    return blockCache.get(ts)!;
  };
  const r: ResolveReport = { resolved: 0, waiting: 0, reasons: [] };
  for (const q of due.rows) {
    const deadline = Number(q.deadline);
    const b0 = await blockAt(deadline);
    const b1 = await blockAt(deadline + q.horizon);
    let outcome: Outcome;
    let before = null;
    let after = null;
    if (b0 === null || b1 === null || b0 < v4StartBlock) {
      // The index does not cover the reference instant: don't guess, declare it.
      outcome = "UNRESOLVABLE";
    } else if (cursor === null || cursor < b1) {
      r.waiting++;
      r.reasons.push(`${q.id}: v4 index is at ${cursor}, needs ${b1}`);
      continue;
    } else {
      before = await lastSqrtPriceAt(db, q.pool_id, b0);
      after = await lastSqrtPriceAt(db, q.pool_id, b1);
      // Each question is resolved by the rule it committed to: v1 = last swap, v2 = window average.
      const committed = JSON.parse(q.json) as { v?: string; window?: string };
      if (committed.v === "2" && before && after) {
        const w = Number(committed.window);
        const s0 = await blockAt(deadline - w);
        const s1 = await blockAt(deadline + q.horizon - w);
        const avg0 = s0 === null ? null : await averageSqrtPrice(db, q.pool_id, s0, b0);
        const avg1 = s1 === null ? null : await averageSqrtPrice(db, q.pool_id, s1, b1);
        before = avg0 === null ? null : { sqrtPriceX96: avg0, block: before.block };
        after = avg1 === null ? null : { sqrtPriceX96: avg1, block: after.block };
      }
      outcome = decide(before, after, b0);
    }
    await db.query(
      `UPDATE questions SET outcome = $2, block0 = $3, block1 = $4, sqrt0 = $5, sqrt1 = $6, resolved_at = now()
        WHERE id = $1 AND outcome IS NULL`,
      [q.id, outcome, b0?.toString() ?? null, b1?.toString() ?? null, before?.sqrtPriceX96.toString() ?? null, after?.sqrtPriceX96.toString() ?? null],
    );
    r.resolved++;
  }
  return r;
}
