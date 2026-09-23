import { describe, expect, it } from "vitest";
import { CONSTANTS, Fmt, guard, render, SIGNATURE, type AnnounceEvent } from "../src/announcer/soul.js";

const q = (o: Partial<{ id: string; token: string; symbol: string | null; p: string; outcome: string | null }> = {}) => ({
  id: "0x9f3a" + "0".repeat(60),
  token: "0x3cedefe814e47b297743c82c20f947053ee667dd",
  symbol: "XYZ",
  p: "0.7123",
  outcome: null,
  ...o,
});
const site = "https://jevsaidit.com";

describe("render", () => {
  const events: AnnounceEvent[] = [
    { kind: "batch_opened", key: "open:0xa", epoch: 42, deadline: 1790019311, questions: [q(), q({ symbol: "ABC", p: "0.3100" })] },
    { kind: "closing_soon", key: "closing:0xa", epoch: 42, deadline: 1790019311, count: 10 },
    { kind: "outcome", key: "outcome:0x1", question: q({ outcome: "1" }) },
    { kind: "outcome", key: "outcome:0x2", question: q({ outcome: "0" }) },
    { kind: "epoch_settled", key: "settled:41", epoch: 41, winners: 3, top: "0x7a3f00000000000000000000000000000000fc21", claimsAt: 1790050000, players: 5, beat: 3, unpaid: null },
    { kind: "epoch_settled", key: "settled:43", epoch: 43, winners: 0, top: null, claimsAt: null, players: 4, beat: 2, unpaid: "empty" },
    { kind: "epoch_settled", key: "settled:44", epoch: 44, winners: 0, top: null, claimsAt: null, players: 0, beat: 0, unpaid: "nobody" },
    { kind: "epoch_settled", key: "settled:45", epoch: 45, winners: 0, top: null, claimsAt: null, players: 3, beat: 0, unpaid: "none_beat" },
    { kind: "epoch_settled", key: "settled:46", epoch: 46, winners: 0, top: null, claimsAt: null, players: 3, beat: 1, unpaid: "unresolvable" },
    { kind: "claims_open", key: "claims:41", epoch: 41 },
    { kind: "swap", key: "swap:0x5b", ethIn: "400000000000000000", burned: "12345678000000000000000000", tx: "0x5b1e" + "0".repeat(60) },
    { kind: "pin", key: "pin:v1" },
  ];

  // 22/09/2026: X answered 403 "Posts are limited to a maximum of one cashtag" to a post with two.
  it("every X post has at most one cashtag", () => {
    for (const e of events) {
      const x = render(e, site).x;
      if (x) expect((x.match(/\$[A-Za-z][A-Za-z0-9_]*/g) ?? []).length, x).toBeLessThanOrEqual(1);
    }
  });
  it("every post ends with the signature and passes its own guard", () => {
    for (const e of events) {
      const r = render(e, site);
      for (const text of [r.telegram, r.x].filter(Boolean) as string[]) {
        expect(text.endsWith(SIGNATURE)).toBe(true);
        expect(guard(text, r.fmt)).toEqual({ ok: true });
      }
    }
  });
  it("X posts fit in 280 characters", () => {
    for (const e of events) {
      const x = render(e, site).x;
      if (x) expect(x.length).toBeLessThanOrEqual(280);
    }
  });
  it("a wrong call is said out loud", () => {
    const r = render({ kind: "outcome", key: "outcome:0x2", question: q({ p: "0.6400", outcome: "0" }) }, site);
    expect(r.telegram).toMatch(/wrong|lied|cooked/);
    expect(r.telegram).toContain("0.64");
  });
  it("the same event always renders the same text, and different events vary", () => {
    const e: AnnounceEvent = { kind: "outcome", key: "outcome:0x2", question: q({ outcome: "0" }) };
    expect(render(e, site).telegram).toBe(render(e, site).telegram);
    const texts = new Set(Array.from({ length: 12 }, (_, i) => render({ ...e, key: `outcome:0x${i}` }, site).telegram));
    expect(texts.size).toBeGreaterThan(2);
  });
  it("$JEV appears only in posts about the token", () => {
    expect(render(events[0]!, site).telegram).not.toContain("$JEV");
    expect(render(events.find((e) => e.kind === "swap")!, site).telegram).toContain("$JEV");
  });
  // 23/09/2026: epochs 0 and 1 closed NOT_PAYABLE (only the excluded dev wallet had called) and went out
  // as "nobody beat the baseline. not even me." With an empty distributor every epoch closes
  // NOT_PAYABLE, so that sentence would have been said of epochs where wallets DID beat it.
  it("an unpaid epoch says why, and never that nobody beat the baseline when someone did", () => {
    const t = (key: string) => render(events.find((e) => e.key === key)!, site).telegram!;
    expect(t("settled:43")).not.toMatch(/nobody beat/);
    expect(t("settled:43")).toMatch(/out-called the baseline/);
    expect(t("settled:43")).toMatch(/graduat/);
    expect(t("settled:43")).not.toMatch(/claims open/);
    expect(t("settled:44")).not.toMatch(/nobody beat|not even me/);
    expect(t("settled:44")).toMatch(/no holder called/);
    expect(t("settled:45")).toMatch(/nobody beat the baseline/);
    expect(t("settled:46")).toMatch(/could not be settled/);
  });
});

describe("guard", () => {
  it("refuses a number that did not come from the data", () => {
    const f = new Fmt();
    const text = `jev said ${f.p("0.7123")}. up 300% soon.\n\n${SIGNATURE}`;
    expect(guard(text, f).ok).toBe(false);
  });
  it("accepts formatted data, declared constants, hashes and links", () => {
    const f = new Fmt();
    const text = `jev said ${f.p("0.7123")}. ${CONSTANTS[0]} = 1 call.\ntx: 0x5b1e00\n${"https://jevsaidit.com/api/feed/q/0x9f.json"}\n\n${SIGNATURE}`;
    expect(guard(text, f)).toEqual({ ok: true });
  });
  it("refuses shilling our own token", () => {
    const f = new Fmt();
    expect(guard(`buy $JEV now\n\n${SIGNATURE}`, f).ok).toBe(false);
    expect(guard(`$JEV to the moon, 100x\n\n${SIGNATURE}`, f).ok).toBe(false);
  });
});

