import type { VerdictInput, VerdictModel } from "./model.js";

// Jev (TypeSafe) through the direct API. The format comes from the source of the official SDK
// @typesafe-ai/sdk 0.6.0 (15/09/2026): POST /v1/systemone, Bearer, typed questions.
// Our questions are yes/no, so the type is `noul`, and the answer is the probability.
// Plain fetch is used, not the SDK: it is a single call, and the SDK is one week old.

export interface JevOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const INSTRUCTIONS =
  "Will this token's ETH price, averaged over the ten minutes before each instant, be strictly higher six hours after the call deadline than at the call deadline?";

export function jevModel(o: JevOptions): VerdictModel {
  const base = (o.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, "");
  const model = o.model ?? "jev-latest";
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = o.retries ?? 4;
  return {
    id: `typesafe/${model}`,
    async verdict(q: VerdictInput) {
      const body = JSON.stringify({ state: q.state ?? { token: q.token }, questions: { up: { type: "noul", instructions: INSTRUCTIONS } }, model });
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetchImpl(`${base}/v1/systemone`, {
            method: "POST",
            headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
            body,
            signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
          });
        } catch (e) {
          if (attempt < retries) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw new Error(`Jev unreachable: ${(e as Error).message}`);
        }
        // 429 and 5xx are transient: wait. 4xx are not: a wrong key does not get better by retrying.
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const text = await res.text();
        if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 200)}`);
        const data = JSON.parse(text) as { answers?: { up?: { noul?: unknown } }; model?: unknown };
        const p = data.answers?.up?.noul;
        // A response without a valid probability does not become a verdict: no fallback 0.5.
        if (typeof p !== "number" || !(p >= 0 && p <= 1)) throw new Error(`Jev: response without a valid probability: ${text.slice(0, 200)}`);
        return { p, model: typeof data.model === "string" ? `typesafe/${data.model}` : undefined };
      }
    },
  };
}
