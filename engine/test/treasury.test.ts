import { describe, expect, it } from "vitest";
import { minOutFor, quoteBuyGross } from "../src/treasury/quote.js";
import { swapTime } from "../src/treasury/schedule.js";

describe("quoteBuyGross", () => {
  it("reproduces a real buy on a Pons pool to the unit (tx 0x0a13bea3…, block 69,012,732)", () => {
    // price and liquidity from the previous Swap event of the same pool, ETH in and tokens out from this one
    const sqrtPriceX96 = 140830553852855971414591633371917n;
    const liquidity = 29277002188455995564359n;
    const ethIn = 72276166907068383n;
    expect(quoteBuyGross(sqrtPriceX96, liquidity, ethIn)).toBe(227367360458677566287712n);
  });

  it("gives more for more ETH, and zero for an empty pool", () => {
    const sp = 140830553852855971414591633371917n;
    const l = 29277002188455995564359n;
    expect(quoteBuyGross(sp, l, 2n * 10n ** 17n)).toBeGreaterThan(quoteBuyGross(sp, l, 10n ** 17n));
    expect(quoteBuyGross(sp, 0n, 10n ** 17n)).toBe(0n);
  });
});

describe("minOutFor", () => {
  it("takes the hook cut and then the slippage off the gross, rounding down", () => {
    // 1% cut (protocol fee, creator tax 0) and 3% slippage: 1,000,000 -> 990,000 -> 960,300
    expect(minOutFor(1_000_000n, 100n, 300n)).toBe(960_300n);
  });

  it("refuses bps that make no sense instead of producing a minOut", () => {
    expect(() => minOutFor(1n, 10_000n, 0n)).toThrow();
    expect(() => minOutFor(1n, 0n, -1n)).toThrow();
  });
});

describe("swapTime", () => {
  const secret = "0x59c6995e998f97a5a0044966f0945389dc9ab5ab5f9d4d8f8a8b5c4f9c0e3c1c" as const;
  const G = 1_790_000_000;
  it("falls inside the epoch, at least an hour from both edges", () => {
    for (let e = 0; e < 50; e++) {
      const t = swapTime(secret, e, G);
      expect(t).toBeGreaterThanOrEqual(G + e * 21600 + 3600);
      expect(t).toBeLessThan(G + (e + 1) * 21600 - 3600);
    }
  });

  it("is stable across restarts and differs between epochs", () => {
    expect(swapTime(secret, 7, G)).toBe(swapTime(secret, 7, G));
    const times = new Set(Array.from({ length: 20 }, (_, e) => swapTime(secret, e, G) - (G + e * 21600)));
    expect(times.size).toBeGreaterThan(15);
  });

  it("changes with the secret: nobody without it can predict the time", () => {
    const other = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
    expect(swapTime(secret, 3, G)).not.toBe(swapTime(other, 3, G));
  });
});
