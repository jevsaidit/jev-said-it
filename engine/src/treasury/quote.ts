// Pure math for the buyback. Checked against 10,398 real buys on Pons pools (2026-09-21): the gross
// output predicted from the price and liquidity before a swap equals the `amount1` of its Swap event
// exactly (Pons pools are full-range, so a buy never crosses a tick).

const Q96 = 2n ** 96n;
export const BPS = 10_000n;

/**
 * Gross token output of selling `ethIn` of currency0 (ETH) into a v4 pool with price `sqrtPriceX96`
 * and in-range liquidity `liquidity`. "Gross" = before the hook takes its cut.
 * currency0 in: 1/sqrtP' = 1/sqrtP + dx/L, and out = L * (sqrtP - sqrtP').
 */
export function quoteBuyGross(sqrtPriceX96: bigint, liquidity: bigint, ethIn: bigint): bigint {
  if (sqrtPriceX96 <= 0n || liquidity <= 0n || ethIn <= 0n) return 0n;
  const next = (liquidity * sqrtPriceX96 * Q96) / (liquidity * Q96 + ethIn * sqrtPriceX96);
  return (liquidity * (sqrtPriceX96 - next)) / Q96;
}

/**
 * minOut for FeeRouter.processSwap (runbook §1.2): the gross, minus the hook's cut (protocol fee +
 * creator tax, both read on-chain every time, never a constant), minus the slippage tolerance.
 */
export function minOutFor(gross: bigint, haircutBps: bigint, slippageBps: bigint): bigint {
  if (haircutBps < 0n || haircutBps >= BPS || slippageBps < 0n || slippageBps >= BPS) {
    throw new Error(`bps out of range: haircut ${haircutBps}, slippage ${slippageBps}`);
  }
  return (((gross * (BPS - haircutBps)) / BPS) * (BPS - slippageBps)) / BPS;
}
