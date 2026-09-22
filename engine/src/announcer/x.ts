import { createHmac, randomBytes } from "node:crypto";

// X API v2, POST /2/tweets, signed with OAuth 1.0a user context (the only auth that lets an app post
// as @jevsaidit). No SDK: one request, one signature, and a documented test vector in test/x.test.ts.

export interface XCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The Authorization header for `method url`. `params` = query/form parameters that take part in the
 *  signature (a JSON body does not). `nonce`/`timestamp` are injectable so the signature is testable. */
export function oauthHeader(
  c: XCreds,
  method: string,
  url: string,
  params: Record<string, string> = {},
  o: { nonce?: string; timestamp?: string } = {},
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.apiKey,
    oauth_nonce: o.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: o.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: c.accessToken,
    oauth_version: "1.0",
  };
  const all = { ...params, ...oauth };
  const normalized = Object.keys(all)
    .map((k) => [enc(k), enc(all[k]!)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method.toUpperCase()}&${enc(url)}&${enc(normalized)}`;
  const key = `${enc(c.apiSecret)}&${enc(c.accessSecret)}`;
  oauth.oauth_signature = createHmac("sha1", key).update(base).digest("base64");
  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${enc(k)}="${enc(oauth[k]!)}"`)
    .join(", ")}`;
}

export const X_TWEETS_URL = "https://api.x.com/2/tweets";

/** Posts `text` as the account of the access token. Returns the post id. Throws with X's own
 *  message on any non-2xx, so the failure is recorded verbatim in `announcements.error`. */
export async function postTweet(c: XCreds, text: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(X_TWEETS_URL, {
    method: "POST",
    headers: { authorization: oauthHeader(c, "POST", X_TWEETS_URL), "content-type": "application/json", "user-agent": "jevsaidit-announcer/1" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }; title?: string; detail?: string; errors?: Array<{ message?: string }> };
  if (!res.ok || !body.data?.id) {
    const why = body.detail ?? body.title ?? body.errors?.[0]?.message ?? "no body";
    throw new Error(`x ${res.status}: ${why}`);
  }
  return body.data.id;
}

/** All four variables or none: a half-configured X is a misconfiguration, not a channel. */
export function xCredsFromEnv(env: NodeJS.ProcessEnv): XCreds | null {
  const v = [env.X_API_KEY, env.X_API_SECRET, env.X_ACCESS_TOKEN, env.X_ACCESS_SECRET];
  const set = v.filter((s) => s && s.trim() !== "").length;
  if (set === 0) return null;
  if (set !== 4) throw new Error("X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET must all be set, or none");
  return { apiKey: v[0]!, apiSecret: v[1]!, accessToken: v[2]!, accessSecret: v[3]! };
}

/** Until this moment X's API refuses posts carrying crypto addresses ("prohibited for the first 7 days after
 *  authentication", measured 22/09/2026 on the launch tweet). A post that would be refused is worse than a
 *  post without its hex: the lines carrying 0x… are dropped from the X version and the site is named instead,
 *  where every receipt and transaction is. Telegram and the database keep the full text. */
export const X_NO_HEX_UNTIL = Date.parse(process.env.X_NO_HEX_UNTIL || "2026-09-29T12:00:00Z");
const HEX = /0x[0-9a-fA-F]{2,}/;

export function forX(text: string, now: number = Date.now(), until: number = X_NO_HEX_UNTIL): string {
  if (now >= until || !HEX.test(text)) return text;
  const lines = text.split("\n").filter((l) => !HEX.test(l));
  const sig = lines.lastIndexOf("jev said it.");
  const at = sig > 0 ? sig - (lines[sig - 1] === "" ? 1 : 0) : lines.length;
  lines.splice(at, 0, "receipts: www.jevsaidit.com/play");
  return lines.join("\n");
}
