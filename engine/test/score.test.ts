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
    const w = (address: string, score: bigint) => ({ address, score, callsOnChain: 0, callsValid: 0, callsResolved: 3 });
    const out = allocate([w("0xa", 64n), w("0xb", 8n)], 1000n);
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
