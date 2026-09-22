import { encodeFunctionData, parseAbi, type Address, type PublicClient } from "viem";
import { PONS_FACTORY } from "../treasury/treasury.js";

// Before graduation the token trades on the Pons bonding curve and there is no Uniswap v4 pool: the
// buyback refuses to swap without a price to protect it ("minOut is 0"), so the fees pile up in the
// FeeRouter until the curve fills. This is what the site shows instead of an unexplained absence.

const CURVE_ABI = parseAbi([
  "function graduated() view returns (bool)",
  "function quoteReserve() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
]);
const FACTORY_ABI = parseAbi(["function getLaunchedToken(address token)"]);

/** `quoteReserve = 0.4 * threshold + progress`: 40% of it is a virtual reserve, measured to the wei on
 *  this chain on 02/09/2026. Comparing quoteReserve with the threshold directly reads ~40% too high. */
export function progressOf(quoteReserve: bigint, threshold: bigint): bigint {
  const p = quoteReserve - (threshold * 4n) / 10n;
  return p > 0n ? p : 0n;
}

/** A read that does not come back is not "not graduated": it is a read that did not happen. The route
 *  answers 502 instead of hanging, and the page that asks does not wait on it (22/09/2026: an unbounded
 *  read of a factory that does not exist on the test chain kept the whole page loading). */
export const CURVE_TIMEOUT_MS = 5_000;

export async function curveView(chain: PublicClient, token: Address) {
  const { data } = await chain.call({ to: PONS_FACTORY, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] }) });
  if (!data || data.length < 2 + 3 * 64) throw new Error("getLaunchedToken returned no record");
  // Word 2 of the launch record is the curve (contracts/docs/addresses.md).
  const curve = `0x${data.slice(2 + 64 + 24, 2 + 2 * 64)}` as Address;
  const [graduated, quoteReserve, threshold] = await Promise.all([
    chain.readContract({ address: curve, abi: CURVE_ABI, functionName: "graduated" }),
    chain.readContract({ address: curve, abi: CURVE_ABI, functionName: "quoteReserve" }),
    chain.readContract({ address: curve, abi: CURVE_ABI, functionName: "graduationThreshold" }),
  ]);
  const progress = progressOf(quoteReserve, threshold);
  return {
    curve,
    graduated,
    progressWei: progress.toString(),
    thresholdWei: threshold.toString(),
    // Basis points, integer: the site formats it. Never a percentage rounded twice.
    progressBps: Number((progress * 10_000n) / threshold),
  };
}
