import { describe, expect, it } from "vitest";
import { displaySymbol } from "../src/questions/open.js";

describe("displaySymbol", () => {
  it("keeps a plain ticker", () => expect(displaySymbol("PONS")).toBe("PONS"));
  it("drops a symbol that is a sentence or a link", () => {
    expect(displaySymbol("buy at x.com/y")).toBeNull();
    expect(displaySymbol(42)).toBeNull();
  });
  // Seven other tokens called JEV existed on Robinhood Chain on 22/09/2026: a post saying "$JEV up?"
  // about one of them would read as a verdict on ours.
  it("never prints a clone of our own ticker, in any case", () => {
    expect(displaySymbol("JEV")).toBeNull();
    expect(displaySymbol("jev")).toBeNull();
    expect(displaySymbol("JEVX")).toBe("JEVX");
  });
});
