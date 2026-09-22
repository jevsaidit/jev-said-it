import { describe, expect, it } from "vitest";
import { kindOfKey, xAllowed } from "../src/announcer/announcer.js";

// The failure this guards against was measured on a sister project: a source of the lowest strength
// posted at 08:54 and 10:20, and at 21:00 the day's cap withheld the one post that mattered.

describe("xAllowed", () => {
  it("the weakest source cannot spend the slots reserved for the epoch verdict and the buyback", () => {
    // 3 openings already out of a cap of 6: 2 settled + 1 swap are still owed, so no 4th opening.
    expect(xAllowed("batch_opened", { batch_opened: 3 }, 6)).toBe(false);
    expect(xAllowed("outcome", { batch_opened: 3 }, 6)).toBe(false);
    // ... but the strong kinds still go out.
    expect(xAllowed("epoch_settled", { batch_opened: 3 }, 6)).toBe(true);
    expect(xAllowed("swap", { batch_opened: 3 }, 6)).toBe(true);
  });
  it("once the strong kinds have had their reserved slots, the weak ones use what is left", () => {
    expect(xAllowed("batch_opened", { epoch_settled: 2, swap: 1, batch_opened: 2 }, 6)).toBe(true);
    expect(xAllowed("batch_opened", { epoch_settled: 2, swap: 1, batch_opened: 3 }, 6)).toBe(false);
  });
  it("the cap is absolute for everyone", () => {
    expect(xAllowed("epoch_settled", { epoch_settled: 6 }, 6)).toBe(false);
    expect(xAllowed("epoch_settled", { batch_opened: 6 }, 6)).toBe(false);
  });
  it("swap owes nothing to outcome but still owes the verdict its slots", () => {
    expect(xAllowed("swap", { outcome: 3 }, 6)).toBe(true);
    // 4 outcomes sent, 2 settled still owed: 4 + 2 = 6, no room for a swap before the verdicts
    expect(xAllowed("swap", { outcome: 4, swap: 0 }, 6)).toBe(false);
  });
});

describe("kindOfKey", () => {
  it("maps every key prefix the collector produces", () => {
    expect(kindOfKey("open:0xabc")).toBe("batch_opened");
    expect(kindOfKey("settled:41")).toBe("epoch_settled");
    expect(kindOfKey("swap:0x1")).toBe("swap");
    expect(kindOfKey("outcome:0x2")).toBe("outcome");
    expect(kindOfKey("nope:1")).toBeUndefined();
  });
});
