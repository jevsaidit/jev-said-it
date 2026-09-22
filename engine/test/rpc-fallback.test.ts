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
