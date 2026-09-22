import { describe, expect, it } from "vitest";
import { collectEvents } from "../src/announcer/events.js";
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

// 22/09/2026: the engine opens a batch every couple of hours, and first-come-first-served they spent
// the day's X slots — epoch 1's opening never went out, and nothing said so.
describe("one opening per epoch on X", () => {
  const row = (tx: string, epoch: number, deadline: number, id: string) => ({
    id,
    epoch,
    deadline: String(deadline),
    tx_hash: tx,
    token: "0xtok",
    symbol: "ABC",
    json: JSON.stringify({ p: "0.7000" }),
    outcome: null,
  });
  it("puts the epoch's first still-open batch on X and keeps the rest on telegram", async () => {
    const now = 1_000;
    const rows = [row("0xa", 7, now + 600, "0x1"), row("0xb", 7, now + 7200, "0x2"), row("0xc", 8, now + 20000, "0x3")];
    const db = { query: async (q: string) => ({ rows: q.includes("FROM questions") ? rows : [] }) } as never;
    const events = await collectEvents(db, now);
    const opens = events.filter((e) => e.event.kind === "batch_opened");
    expect(opens.map((e) => [e.event.key, e.channels.join("+")])).toEqual([
      ["open:0xa", "telegram+x"],
      ["open:0xb", "telegram"],
      ["open:0xc", "telegram+x"],
    ]);
  });
  it("keeps a batch whose calls already closed off X", async () => {
    const now = 1_000;
    const rows = [row("0xa", 7, now - 10, "0x1")];
    const db = { query: async (q: string) => ({ rows: q.includes("FROM questions") ? rows : [] }) } as never;
    const events = await collectEvents(db, now);
    expect(events.filter((e) => e.event.kind === "batch_opened").map((e) => e.channels.join("+"))).toEqual(["telegram"]);
  });
});
