import { describe, expect, it } from "vitest";
import { decide } from "../src/resolve/resolve.js";
import { timeWeightedSqrt } from "../src/indexer/v4.js";

// Rule v2: the reference is the time-weighted average of sqrtPriceX96 over the window before the
// deadline (and before deadline+horizon), not the last swap. These are the cases that justify it.
const s = (block: number, p: number) => ({ block: BigInt(block), sqrtPriceX96: BigInt(p) });

describe("time-weighted reference price", () => {
  it("no swap in the window: the price in force at its start", () => {
    expect(timeWeightedSqrt(100n, [], 0n, 10n)).toBe(100n);
  });
  it("a price holds from its swap to the next one", () => {
    expect(timeWeightedSqrt(100n, [s(5, 200)], 0n, 10n)).toBe(150n);
  });
  it("a swap pushed into the last block of the window weighs nothing", () => {
    // the attack v1 allowed: call, then move the price in the deadline block
    expect(timeWeightedSqrt(100n, [s(10, 1000)], 0n, 10n)).toBe(100n);
    // and held for one block out of ten it moves the average by a tenth of the push, not all of it
    expect(timeWeightedSqrt(100n, [s(9, 1000)], 0n, 10n)).toBe(190n);
  });
  it("several swaps in one block: the last one is the block's price", () => {
    expect(timeWeightedSqrt(100n, [s(5, 999), s(5, 200)], 0n, 10n)).toBe(150n);
  });
  it("no price before the first swap: the average starts at it", () => {
    expect(timeWeightedSqrt(null, [s(4, 100), s(8, 300)], 0n, 10n)).toBe((100n * 4n + 300n * 2n) / 6n);
    expect(timeWeightedSqrt(null, [], 0n, 10n)).toBeNull();
  });
  it("feeds decide() like a price: a lower average sqrt is a higher token price", () => {
    const before = { sqrtPriceX96: timeWeightedSqrt(100n, [], 0n, 10n)!, block: 5n };
    const after = { sqrtPriceX96: timeWeightedSqrt(90n, [s(15, 80)], 10n, 20n)!, block: 15n };
    expect(decide(before, after, 10n)).toBe("1");
  });
});
