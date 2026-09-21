import { describe, expect, it } from "vitest";
import { jevModel } from "../src/questions/jev.js";

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<[number, unknown]>, calls: Call[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const [status, body] = responses.shift()!;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}
const noWait = async () => {};
const q = { kind: "A_PRICE_UP", token: "0xabc", baseline: 0.5, state: { swapsLastHour: 42 } };

describe("jevModel", () => {
  it("sends the request in the official SDK's form: /v1/systemone, Bearer, noul question", async () => {
    const calls: Call[] = [];
    const m = jevModel({ apiKey: "sk-test", model: "jev-1.13.0", fetchImpl: fakeFetch([[200, { answers: { up: { noul: 0.61 } }, model: "jev-1.13.0" }]], calls) });
    const out = await m.verdict(q);
    expect(out).toEqual({ p: 0.61, model: "typesafe/jev-1.13.0" });
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.questions.up.type).toBe("noul");
    expect(body.state).toEqual({ swapsLastHour: 42 });
    expect(body.model).toBe("jev-1.13.0");
  });

  it("the model that actually answered takes precedence over the one requested", async () => {
    const m = jevModel({ apiKey: "k", model: "jev-latest", fetchImpl: fakeFetch([[200, { answers: { up: { noul: 0.4 } }, model: "jev-1.14.0" }]], []) });
    expect((await m.verdict(q)).model).toBe("typesafe/jev-1.14.0");
  });

  it("a 429 is waited out and retried; a 401 is not: a wrong key does not get better by retrying", async () => {
    const calls: Call[] = [];
    const ok = jevModel({ apiKey: "k", sleep: noWait, fetchImpl: fakeFetch([[429, "slow"], [200, { answers: { up: { noul: 0.3 } } }]], calls) });
    expect((await ok.verdict(q)).p).toBe(0.3);
    expect(calls.length).toBe(2);
    const calls2: Call[] = [];
    const bad = jevModel({ apiKey: "k", sleep: noWait, fetchImpl: fakeFetch([[401, "unauthorized"]], calls2) });
    await expect(bad.verdict(q)).rejects.toThrow(/401/);
    expect(calls2.length).toBe(1);
  });

  it("a response without a valid probability is an error, not a fallback 0.5", async () => {
    for (const body of [{ answers: {} }, { answers: { up: { noul: 1.2 } } }, { answers: { up: { noul: "0.7" } } }]) {
      const m = jevModel({ apiKey: "k", fetchImpl: fakeFetch([[200, body]], []) });
      await expect(m.verdict(q)).rejects.toThrow(/probability/);
    }
  });
});
