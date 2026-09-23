import { describe, expect, it } from "vitest";
import { batchesFrom, strikingOutcome, unpaidOf } from "../src/announcer/events.js";

const row = (id: string, tx: string, p: string, outcome: string | null = null) => ({
  id, epoch: 3, deadline: "1790019311", tx_hash: tx, token: "0x" + "1".repeat(40), symbol: "A", json: JSON.stringify({ p }), outcome,
});

describe("batchesFrom", () => {
  it("groups questions by the transaction that opened them", () => {
    const b = batchesFrom([row("a", "0xt1", "0.6000"), row("b", "0xt1", "0.3000"), row("c", "0xt2", "0.5500")]);
    expect(b.map((x) => [x.tx, x.questions.length])).toEqual([["0xt1", 2], ["0xt2", 1]]);
  });
});

describe("strikingOutcome", () => {
  it("picks the resolved question where jev was most confident (the biggest hit or miss)", () => {
    const s = strikingOutcome([row("a", "t", "0.5500", "1"), row("b", "t", "0.9000", "0"), row("c", "t", "0.2000", "0")]);
    expect(s?.id).toBe("b");
  });
  it("ignores VOID and UNRESOLVABLE", () => {
    expect(strikingOutcome([row("a", "t", "0.9000", "VOID")])).toBeNull();
  });
});

describe("unpaidOf", () => {
  it("tells an empty distributor from an epoch nobody beat, and nobody played from both", () => {
    expect(unpaidOf("distributor has no free balance", 4)).toBe("empty");
    expect(unpaidOf("no forecaster with a positive score", 3)).toBe("none_beat");
    expect(unpaidOf("no forecaster with a positive score", 0)).toBe("nobody");
    expect(unpaidOf("no question opened in the epoch", 0)).toBe("nobody");
    expect(unpaidOf("4/10 questions unresolvable: when in doubt, nothing is paid", 2)).toBe("unresolvable");
  });
});
