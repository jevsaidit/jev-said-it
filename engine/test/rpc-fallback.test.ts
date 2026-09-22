import { describe, expect, it } from "vitest";
import { errText, transportFor } from "../src/chain/client.js";

describe("RPC endpoints", () => {
  it("one URL is a plain http transport, a comma list falls back in order", () => {
    expect(transportFor("https://a.example")({}).config.type).toBe("http");
    expect(transportFor("https://a.example, https://b.example")({}).config.type).toBe("fallback");
  });
  // 22/09/2026: "HTTP request failed." alone hid whether the public RPC answered 429, 403 or nothing.
  it("an error keeps its HTTP status", () => {
    const e = Object.assign(new Error("HTTP request failed.\n\nStatus: 429\nURL: x"), { status: 429 });
    expect(errText(e)).toBe("HTTP request failed. (HTTP 429)");
    expect(errText(new Error("plain\nmore"))).toBe("plain");
  });
});

import { forX } from "../src/announcer/x.js";
describe("X without hex until the API allows it", () => {
  const post = "the fees came in.\n0.01 ETH bought $JEV. 3M burned. the rest pays the callers.\ntx: https://robinhoodchain.blockscout.com/tx/0xabc123\n\njev said it.\n#jevsaidit";
  const before = Date.parse("2026-09-23T00:00:00Z");
  it("drops the lines with 0x… and names the site, before the signature", () => {
    expect(forX(post, before)).toBe("the fees came in.\n0.01 ETH bought $JEV. 3M burned. the rest pays the callers.\nreceipts: www.jevsaidit.com/play\n\njev said it.\n#jevsaidit #robinhoodchain");
  });
  it("leaves a post without hex alone, and everything alone after the date", () => {
    expect(forX("epoch 1 is open.\n\njev said it.\n#jevsaidit", before)).toBe("epoch 1 is open.\n\njev said it.\n#jevsaidit #robinhoodchain");
    expect(forX(post, Date.parse("2026-10-01T00:00:00Z"))).toBe(`${post} #robinhoodchain`);
  });
});

import { progressOf } from "../src/server/curve.js";
describe("graduation progress", () => {
  const E = 10n ** 18n;
  // Measured on this chain on 02/09/2026: 40% of quoteReserve is a virtual reserve.
  it("takes the virtual 40% out", () => {
    expect(progressOf(2_321_670_000_000_000_000n, 42n * E / 10n)).toBe(641_670_000_000_000_000n);
    expect(progressOf((42n * E) / 10n, (42n * E) / 10n)).toBe(2_520_000_000_000_000_000n); // 60% of 4.2
  });
  it("never reads negative before the first buy", () => expect(progressOf(0n, 42n * E / 10n)).toBe(0n));
});
