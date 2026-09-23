import { describe, expect, it } from "vitest";
import { xAllowed } from "../src/announcer/announcer.js";
import { devNotes, milestoneReached } from "../src/announcer/dev.js";
import { guard, render, SIGNATURE } from "../src/announcer/soul.js";
import { forX } from "../src/announcer/x.js";

// X counts a link as 23 characters.
const xLen = (t: string) => forX(t).replace(/https?:\/\/\S+/g, "x".repeat(23)).length;

const site = "https://www.jevsaidit.com";
const msg = `Sync from the working repository (cb4df85)

- fix(announcer): an unpaid epoch says why, never 'nobody beat the baseline' when someone did
- feat(score): from epoch 2, rank and pay by skill per call, not the sum (Captain, 23/09)
- fix(record): the epoch table fits a phone (the hindsight column was clipped at 390px)`;

describe("devNotes: what a showcase sync shipped", () => {
  it("reads the feat/fix lines of the body, without the type prefix or a trailing note", () => {
    expect(devNotes(msg)).toEqual([
      "an unpaid epoch says why, never 'nobody beat the baseline' when someone did",
      "from epoch 2, rank and pay by skill per call, not the sum",
      "the epoch table fits a phone (the hindsight column was clipped at 390px)",
    ]);
  });
  it("a sync with no notable change has nothing to say", () => {
    expect(devNotes("Sync from the working repository (4aee8a8)")).toEqual([]);
  });
});

describe("milestoneReached", () => {
  it("the highest threshold reached, and none before the first outside caller", () => {
    expect(milestoneReached(0)).toBeNull();
    expect(milestoneReached(1)).toBe(1);
    expect(milestoneReached(24)).toBe(10);
    expect(milestoneReached(300)).toBe(250);
  });
});

describe("dev posts render", () => {
  const log = render({ kind: "dev_log", key: "devlog:abc1234", sha: "abc1234", notes: devNotes(msg) }, site);
  const first = render({ kind: "dev_milestone", key: "devmile:1", callers: 1 }, site);
  const ten = render({ kind: "dev_milestone", key: "devmile:10", callers: 10 }, site);
  it("they pass the guard, carry the signature, fit X and link the public commit", () => {
    for (const r of [log, first, ten]) {
      const x = r.x!;
      expect(x.endsWith(SIGNATURE)).toBe(true);
      expect(guard(x, r.fmt)).toEqual({ ok: true });
      expect(xLen(x)).toBeLessThanOrEqual(280);
      expect((x.match(/\$[A-Za-z][A-Za-z0-9_]*/g) ?? []).length).toBeLessThanOrEqual(1);
    }
    expect(log.x).toContain("github.com/jevsaidit/jev-said-it/commit/abc1234");
    expect(first.x).toMatch(/first holder outside the team/);
  });
  it("a long sync is cut to what fits, never past 280", () => {
    const many = Array.from({ length: 12 }, (_, i) => `a fairly long change description number ${i} that goes on and on`);
    const r = render({ kind: "dev_log", key: "devlog:abc1234", sha: "abc1234", notes: many }, site);
    expect(xLen(r.x!)).toBeLessThanOrEqual(280);
    expect(guard(r.x!, r.fmt)).toEqual({ ok: true });
  });
});

describe("dev posts never take a reserved slot", () => {
  it("with 3 sent and the verdict and swap slots still owed, a dev post waits", () => {
    expect(xAllowed("dev_log", { batch_opened: 3 }, 6)).toBe(false);
    expect(xAllowed("dev_log", { batch_opened: 2 }, 6)).toBe(true);
  });
});
