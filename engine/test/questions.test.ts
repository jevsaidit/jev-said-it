import { describe, expect, it } from "vitest";
import { isPonsEthPool } from "../src/indexer/v4.js";
import { canonicalJson, fmtProb, questionId } from "../src/questions/canonical.js";
import { EPOCH_LENGTH, epochEnd, epochOf, planBatch } from "../src/questions/epoch.js";

const G = 1_790_000_000;
const base = { genesis: G, callWindowSec: 7200, minCallWindowSec: 1800, epochMarginSec: 300 };

describe("planBatch", () => {
  it("at the start of an epoch it opens with the full window", () => {
    expect(planBatch({ ...base, now: G + 60 })).toEqual({ open: true, epoch: 0, deadline: G + 60 + 7200 });
  });

  it("near the end of the epoch it shortens the deadline: it NEVER pushes it past the boundary", () => {
    const now = G + EPOCH_LENGTH - 3600; // one hour left
    const plan = planBatch({ ...base, now });
    expect(plan).toEqual({ open: true, epoch: 0, deadline: epochEnd(0, G) - 300 });
    if (plan.open) expect(plan.deadline).toBeLessThan(epochEnd(0, G));
  });

  it("if the usable window is below the minimum it does not open, and says when to retry", () => {
    const plan = planBatch({ ...base, now: G + EPOCH_LENGTH - 1000 });
    expect(plan.open).toBe(false);
    if (!plan.open) expect(plan.retryAt).toBe(epochEnd(0, G));
  });

  it("the epoch is the contract's: (ts - genesis) / 6h, rounded down", () => {
    expect(epochOf(G + EPOCH_LENGTH - 1, G)).toBe(0);
    expect(epochOf(G + EPOCH_LENGTH, G)).toBe(1);
    expect(() => epochOf(G - 1, G)).toThrow();
  });
});

describe("canonicalJson", () => {
  it("the order in which fields are written does not change the hash", () => {
    const a = canonicalJson({ b: "2", a: "1" });
    const b = canonicalJson({ a: "1", b: "2" });
    expect(a).toBe('{"a":"1","b":"2"}');
    expect(questionId(a)).toBe(questionId(b));
  });

  it("a changed field changes the hash: the committed verdict cannot be touched up", () => {
    expect(questionId(canonicalJson({ p: "0.4000" }))).not.toBe(questionId(canonicalJson({ p: "0.4001" })));
  });

  it("rejects numbers: their printing is not the same in every language", () => {
    expect(() => canonicalJson({ p: 0.4 as unknown as string })).toThrow();
  });

  it("formats probabilities to 4 decimals and rejects those outside [0,1]", () => {
    expect(fmtProb(0.40312)).toBe("0.4031");
    expect(() => fmtProb(1.01)).toThrow();
    expect(() => fmtProb(Number.NaN)).toThrow();
  });
});

describe("isPonsEthPool", () => {
  const pons = { currency0: "0x0000000000000000000000000000000000000000", hooks: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044", fee: 0, tickSpacing: 200 };
  it("recognises the real Pons pool", () => expect(isPonsEthPool(pons)).toBe(true));
  it("discards junk pools on the same token (null hook, random fee: seen on 21/09)", () => {
    expect(isPonsEthPool({ ...pons, hooks: "0x0000000000000000000000000000000000000000", fee: 0xd9038 })).toBe(false);
    expect(isPonsEthPool({ ...pons, tickSpacing: 60 })).toBe(false);
  });
  it("discards Pons pools not paired with ETH: the price would not be in ETH", () => {
    expect(isPonsEthPool({ ...pons, currency0: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" })).toBe(false);
  });
});
