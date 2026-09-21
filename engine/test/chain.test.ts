import { describe, expect, it } from "vitest";
import { type Backoff, getLogsBisect, isRangeRejection } from "../src/chain/logs.js";

const noWait: Backoff = { attempts: 4, baseMs: 1, sleep: async () => {} };
import { ponsEthPoolId } from "../src/chain/pool.js";

describe("ponsEthPoolId", () => {
  it("produces the real PoolId of the OpenJEV pool (the same one the Foundry test checks)", () => {
    expect(ponsEthPoolId("0x4d066AB4D924b7b3D01c6EcbFC142efe33AEb7FA")).toBe(
      "0x671b0a6a58ddd96af8b3927aa3d44d6c8cb074120e0b2a55dbe662b36bf915c6",
    );
  });
});

// A fake node that behaves like the real one: it rejects ranges that produce too many logs.
function fakeNode(logBlocks: number[], cap: number, calls: Array<[bigint, bigint]>) {
  return async (from: bigint, to: bigint) => {
    calls.push([from, to]);
    const hit = logBlocks.filter((b) => b >= Number(from) && b <= Number(to));
    if (hit.length > cap) {
      // The exact message of the public RPC, measured on 21/09.
      throw Object.assign(new Error("RPC Request failed."), { code: -32000, details: "logs matched by query exceeds limit of 10000" });
    }
    return hit;
  };
}

describe("getLogsBisect", () => {
  it("splits the range when the node rejects it and returns every log exactly once, in order", async () => {
    const blocks = Array.from({ length: 1000 }, (_, i) => i * 3);
    const calls: Array<[bigint, bigint]> = [];
    const out = await getLogsBisect(fakeNode(blocks, 100, calls), 0n, 2999n);
    expect(out).toEqual(blocks);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("a 429 is waited out and retried on the SAME range, without splitting it", async () => {
    const calls: Array<[bigint, bigint]> = [];
    let fails = 2;
    const node = async (a: bigint, b: bigint) => {
      calls.push([a, b]);
      // The real form: a JSON-RPC 429 error inside an HTTP 200 response, which viem does not retry.
      if (fails-- > 0) throw Object.assign(new Error("RPC Request failed."), { code: 429, details: "Too Many Requests" });
      return [1];
    };
    expect(await getLogsBisect(node, 0n, 1000n, noWait)).toEqual([1]);
    expect(calls).toEqual([[0n, 1000n], [0n, 1000n], [0n, 1000n]]);
  });

  it("a rate limit that does not clear exhausts the attempts and propagates: the cycle is BLIND, not split", async () => {
    let calls = 0;
    const node = async () => {
      calls++;
      throw Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429 });
    };
    await expect(getLogsBisect(node, 0n, 1000n, noWait)).rejects.toThrow(/429/);
    expect(calls).toBe(noWait.attempts);
  });

  it("a network error propagates instead of being mistaken for a range that is too wide", async () => {
    const node = async () => {
      throw new Error("fetch failed: ECONNRESET");
    };
    await expect(getLogsBisect(node, 0n, 1000n)).rejects.toThrow(/ECONNRESET/);
  });

  it("recognises the query timeout as a range rejection", () => {
    expect(isRangeRejection(new Error("Missing or invalid parameters. Details: log query timed out"))).toBe(true);
  });
});
