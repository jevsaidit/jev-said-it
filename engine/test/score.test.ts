import { describe, expect, it } from "vitest";
import { decide } from "../src/resolve/resolve.js";
import { allocate, callSkill, parseProb, scoreEpoch, TOKENS_PER_CALL, type Call, type ScoredQuestion, capacityAt } from "../src/score/score.js";

describe("decide: the price direction", () => {
  const b0 = 100n;
  it("sqrtPriceX96 measures token per ETH: if it FALLS, the token is worth more in ETH and the outcome is 1", () => {
    expect(decide({ sqrtPriceX96: 1000n, block: 90n }, { sqrtPriceX96: 900n, block: 150n }, b0)).toBe("1");
    expect(decide({ sqrtPriceX96: 1000n, block: 90n }, { sqrtPriceX96: 1100n, block: 150n }, b0)).toBe("0");
  });
  it("unchanged price = 0: the rule asks for 'strictly higher'", () => {
    expect(decide({ sqrtPriceX96: 1000n, block: 90n }, { sqrtPriceX96: 1000n, block: 150n }, b0)).toBe("0");
  });
  it("no swap after the deadline = VOID, not 0", () => {
    expect(decide({ sqrtPriceX96: 1000n, block: 90n }, { sqrtPriceX96: 1000n, block: 90n }, b0)).toBe("VOID");
    expect(decide(null, null, b0)).toBe("VOID");
  });
});

describe("callSkill", () => {
  it("against the 0.5 baseline with p=0.7: right agreement +0.16, wrong agreement -0.24 (scale 1e8)", () => {
    expect(callSkill(7000n, true, 1n, 5000n)).toBe(16_000_000n);
    expect(callSkill(7000n, true, 0n, 5000n)).toBe(-24_000_000n);
    expect(callSkill(7000n, false, 0n, 5000n)).toBe(16_000_000n);
  });
  it("against the model, agreeing is always worth zero", () => {
    expect(callSkill(7000n, true, 1n, 7000n)).toBe(0n);
    expect(callSkill(7000n, true, 0n, 7000n)).toBe(0n);
  });
  it("accepts only probabilities in canonical form", () => {
    expect(parseProb("0.7000")).toBe(7000n);
    expect(() => parseProb("0.7")).toThrow();
  });
});

const q = (id: string, outcome: ScoredQuestion["outcome"]): ScoredQuestion => ({ id, p: 7000n, baseline: 5000n, outcome });
let li = 0;
const call = (caller: string, questionId: string, agree: boolean): Call => ({ caller, questionId, agree, block: 1n, logIndex: li++ });
const TOK = (n: bigint) => n * TOKENS_PER_CALL;

describe("scoreEpoch", () => {
  const questions = [q("a", "1"), q("b", "0"), q("c", "1"), q("d", "0"), q("e", "VOID")];
  const perfect = (w: string) => [call(w, "a", true), call(w, "b", false), call(w, "c", true), call(w, "d", false), call(w, "e", true)];
  const base = { epoch: 0, questions, excluded: new Set<string>(), reference: "baseline" as const, topFraction: 1 };

  it("flash-buying does not pay: zero balance at epoch start = zero valid calls, even if they went through on-chain", () => {
    const out = scoreEpoch({ ...base, calls: [...perfect("0xhonest"), ...perfect("0xflash")], balanceAtStart: new Map([["0xhonest", TOK(10n)]]) });
    const flash = out.wallets.find((w) => w.address === "0xflash")!;
    expect(flash.callsOnChain).toBe(5);
    expect(flash.callsValid).toBe(0);
    expect(out.state === "PAYABLE" && out.winners.map((w) => w.address)).toEqual(["0xhonest"]);
  });

  it("capacity is consumed in log order: with a capacity of 2 calls the first 2 count", () => {
    const out = scoreEpoch({ ...base, calls: perfect("0xw"), balanceAtStart: new Map([["0xw", TOK(2n)]]) });
    expect(out.wallets[0]!.callsValid).toBe(2);
  });

  it("excluded addresses (team, contracts) never appear, not even with a perfect score", () => {
    const out = scoreEpoch({ ...base, calls: [...perfect("0xteam"), ...perfect("0xw")], balanceAtStart: new Map([["0xteam", TOK(10n)], ["0xw", TOK(10n)]]), excluded: new Set(["0xteam"]) });
    expect(out.wallets.map((w) => w.address)).toEqual(["0xw"]);
  });

  it("VOID questions don't count, and below 3 resolved calls a wallet does not enter the ranking", () => {
    const out = scoreEpoch({ ...base, calls: [call("0xw", "a", true), call("0xw", "b", false), call("0xw", "e", true)], balanceAtStart: new Map([["0xw", TOK(10n)]]) });
    expect(out.wallets[0]!.callsResolved).toBe(2);
    expect(out.state).toBe("NOT_PAYABLE");
  });

  it("above 20% unresolvable questions the epoch is not paid", () => {
    const out = scoreEpoch({ ...base, questions: [q("a", "1"), q("b", "UNRESOLVABLE"), q("c", "1"), q("d", "0")], calls: perfect("0xw"), balanceAtStart: new Map([["0xw", TOK(10n)]]) });
    expect(out.state).toBe("NOT_PAYABLE");
  });

  it("whoever always agrees with a model that is wrong half the time ends up negative and does not win", () => {
    const always = ["a", "b", "c", "d"].map((x) => call("0xyes", x, true));
    const out = scoreEpoch({ ...base, calls: [...always, ...perfect("0xw")], balanceAtStart: new Map([["0xyes", TOK(10n)], ["0xw", TOK(10n)]]) });
    expect(out.wallets.find((w) => w.address === "0xyes")!.score).toBe(-16_000_000n);
    expect(out.state === "PAYABLE" && out.winners.map((w) => w.address)).toEqual(["0xw"]);
  });
});

describe("allocate", () => {
  it("splits proportionally and never exceeds the budget", () => {
    const w = (address: string, score: bigint) => ({ address, score, perCall: score / 3n, callsOnChain: 0, callsValid: 0, callsResolved: 3 });
    const out = allocate([w("0xa", 64n), w("0xb", 8n)], 1000n, 0);
    expect(out).toEqual([{ address: "0xa", amount: 888n }, { address: "0xb", amount: 111n }]);
    expect(out.reduce((s, x) => s + x.amount, 0n)).toBeLessThanOrEqual(1000n);
  });
});

describe("the stricter rule from epoch 1 (22/09/2026)", () => {
  const E = 10n ** 18n;
  it("epoch 0 keeps the launch rule: one call per 10k", () => {
    expect(capacityAt(0, 10_000n * E)).toBe(1n);
    expect(capacityAt(0, 999_999n * E)).toBe(50n);
  });
  it("from epoch 1: nothing under 1M, then one call per 100k, up to 50", () => {
    expect(capacityAt(1, 999_999n * E)).toBe(0n);
    expect(capacityAt(1, 1_000_000n * E)).toBe(10n);
    expect(capacityAt(1, 2_550_000n * E)).toBe(25n);
    expect(capacityAt(7, 19_075_478n * E)).toBe(50n);
  });
  it("a wallet under the minimum is not scored in epoch 1, even with perfect calls", () => {
    const base = { questions: [q("a", "1"), q("b", "0"), q("c", "1")], excluded: new Set<string>(), reference: "baseline" as const, topFraction: 1 };
    const small = [call("0xsmall", "a", true), call("0xsmall", "b", false), call("0xsmall", "c", true)];
    const big = [call("0xbig", "a", true), call("0xbig", "b", false), call("0xbig", "c", true)];
    const out = scoreEpoch({ ...base, epoch: 1, calls: [...small, ...big], balanceAtStart: new Map([["0xsmall", 900_000n * E], ["0xbig", 1_000_000n * E]]) });
    const w = new Map(out.wallets.map((x) => [x.address, x]));
    expect(w.get("0xsmall")!.callsValid).toBe(0);
    expect(w.get("0xbig")!.callsValid).toBe(3);
  });
});

describe("rank by skill per call, from epoch 2 (Captain, 23/09/2026)", () => {
  const E = 10n ** 18n;
  // Four questions, all p=0.7 vs baseline 0.5: a right agreement is +0.16, a wrong one -0.24.
  const qs = [q("a", "1"), q("b", "1"), q("c", "1"), q("d", "1"), q("e", "0")];
  const base = { questions: qs, excluded: new Set<string>(), reference: "baseline" as const, topFraction: 1 };
  // "whale": 5 calls, 4 right and 1 wrong -> sum 0.40, 0.08 per call. "sharp": 3 calls, all right -> sum 0.48,
  // 0.16 per call. In epoch 1 the whale's 4 right calls (sum 0.64) beat the sharp's 0.48.
  const whale = ["a", "b", "c", "d"].map((x) => call("0xwhale", x, true)).concat([call("0xwhale", "e", true)]);
  const sharp = ["a", "b", "c"].map((x) => call("0xsharp", x, true));
  const bal = new Map([["0xwhale", 5_000_000n * E], ["0xsharp", 1_000_000n * E]]);

  it("epoch 1 still ranks by the sum: the wallet with more calls comes first", () => {
    const four = ["a", "b", "c", "d"].map((x) => call("0xwhale", x, true));
    const out = scoreEpoch({ ...base, epoch: 1, calls: [...four, ...sharp], balanceAtStart: bal });
    expect(out.wallets.map((w) => w.address)).toEqual(["0xwhale", "0xsharp"]); // 0.64 > 0.48
  });
  it("from epoch 2 the average per call decides, not the number of calls", () => {
    const out = scoreEpoch({ ...base, epoch: 2, calls: [...whale, ...sharp], balanceAtStart: bal });
    const w = new Map(out.wallets.map((x) => [x.address, x]));
    expect(w.get("0xwhale")!.score).toBe(40_000_000n); // 4 x 0.16 - 0.24
    expect(w.get("0xwhale")!.perCall).toBe(8_000_000n);
    expect(w.get("0xsharp")!.perCall).toBe(16_000_000n);
    expect(out.wallets.map((x) => x.address)).toEqual(["0xsharp", "0xwhale"]);
  });
  it("the minimum of 3 resolved calls still applies to the average", () => {
    const two = ["a", "b"].map((x) => call("0xlucky", x, true));
    const out = scoreEpoch({ ...base, epoch: 2, calls: [...two, ...whale], balanceAtStart: new Map([...bal, ["0xlucky", 1_000_000n * E]]) });
    expect(out.state === "PAYABLE" && out.winners.map((x) => x.address)).toEqual(["0xwhale"]);
  });
  it("from epoch 2 the budget is split by the average, so size does not buy a bigger share", () => {
    const w = (address: string, score: bigint, perCall: bigint) => ({ address, score, perCall, callsOnChain: 0, callsValid: 0, callsResolved: 3 });
    const out = allocate([w("0xa", 800n, 16n), w("0xb", 48n, 16n)], 1000n, 2);
    expect(out).toEqual([{ address: "0xa", amount: 500n }, { address: "0xb", amount: 500n }]);
    expect(allocate([w("0xa", 800n, 16n), w("0xb", 48n, 16n)], 1000n, 1)[0]!.amount).toBe(943n); // epoch 1: by the sum
  });
});

import { brierTable } from "../src/server/feed.js";
describe("brierTable: Jev's record, per epoch and against hindsight", () => {
  const r = (epoch: number, p: string, outcome: "0" | "1") => ({ epoch, p, baseline: "0.5000", outcome });
  it("per epoch: the model, the 0.5 baseline, and the best constant guess known only afterwards", () => {
    // epoch 0: p 0.2 on a down (0.04), p 0.2 on a down (0.04), p 0.6 on an up (0.16), p 0.3 on a down (0.09)
    const t = brierTable([r(0, "0.2000", "0"), r(0, "0.2000", "0"), r(0, "0.6000", "1"), r(0, "0.3000", "0"), r(1, "0.9000", "0")]);
    const e0 = t.byEpoch.find((e) => e.epoch === 0)!;
    expect(e0.resolved).toBe(4);
    expect(e0.brierModel).toBeCloseTo(0.0825, 10);
    expect(e0.brierBaseline).toBe(0.25);
    expect(e0.brierHindsight).toBeCloseTo(0.25 * 0.75, 10); // 1 up in 4: always 0.25
    const e1 = t.byEpoch.find((e) => e.epoch === 1)!;
    expect(e1.brierModel).toBeCloseTo(0.81, 10); // a loss stays printed
    expect(e1.brierHindsight).toBe(0);
    expect(t.brierHindsight).toBeCloseTo(0.2 * 0.8, 10); // 1 up in 5 overall
  });
});
