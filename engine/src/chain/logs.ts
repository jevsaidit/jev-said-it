// eth_getLogs on this chain rejects a range in two ways: "logs matched by query exceeds limit
// of 10000" (measured on 21/09), or "log query timed out" on wide ranges of a hot token.
// Neither is transient: retrying the same range fails the same way. The range is split in half.
//
// Rate limiting, instead, is contention, and must be WAITED out, not split: splitting multiplies
// requests exactly when the node is saturated. And here it arrives in a form the transport does
// not see: a JSON-RPC error {"code":429,"message":"Too Many Requests"} inside an HTTP 200 response.
// viem only retries on the HTTP status, so this module does the waiting.

const RANGE_REJECTION = /invalid param|too many|exceed|log query timed out|query returned more than|block range|response size/i;

function describe(e: unknown): { text: string; status?: number; code?: number } {
  const parts: string[] = [];
  let status: number | undefined;
  let code: number | undefined;
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 6; depth++) {
    const o = cur as { message?: string; details?: string; shortMessage?: string; status?: number; code?: number; cause?: unknown };
    parts.push(o.shortMessage ?? "", o.details ?? "", o.message ?? "");
    status ??= typeof o.status === "number" ? o.status : undefined;
    code ??= typeof o.code === "number" ? o.code : undefined;
    cur = o.cause;
  }
  return { text: parts.join(" | "), status, code };
}

export function isRateLimited(e: unknown): boolean {
  const d = describe(e);
  return d.status === 429 || d.code === 429 || /too many requests|rate limit/i.test(d.text);
}

export function isRangeRejection(e: unknown): boolean {
  if (isRateLimited(e)) return false;
  const d = describe(e);
  if (d.code === -32602 || d.code === -32005) return true;
  return RANGE_REJECTION.test(d.text);
}

export type LogFetch<T> = (fromBlock: bigint, toBlock: bigint) => Promise<T[]>;

export interface Backoff {
  attempts: number;
  baseMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_BACKOFF: Backoff = {
  attempts: 8, // 0.5 + 1 + 2 + ... + 64 s: beyond two minutes of rate limiting the cycle is BLIND
  baseMs: 500,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Reads [from, to]. On rate limiting it waits and retries the SAME range; when the node rejects
 * the range, it splits it in half. Any other error propagates, and the cycle ends BLIND.
 */
export async function getLogsBisect<T>(
  fetch: LogFetch<T>,
  from: bigint,
  to: bigint,
  backoff: Backoff = DEFAULT_BACKOFF,
): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(from, to);
    } catch (e) {
      if (isRateLimited(e) && attempt + 1 < backoff.attempts) {
        await backoff.sleep(backoff.baseMs * 2 ** attempt);
        continue;
      }
      if (from >= to || !isRangeRejection(e)) throw e;
      const mid = (from + to) / 2n;
      const left = await getLogsBisect(fetch, from, mid, backoff);
      const right = await getLogsBisect(fetch, mid + 1n, to, backoff);
      return left.concat(right);
    }
  }
}
