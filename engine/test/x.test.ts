import { describe, expect, it } from "vitest";
import { oauthHeader, postTweet, X_TWEETS_URL, xCredsFromEnv } from "../src/announcer/x.js";

// The worked example of X's own documentation ("Creating a signature"): same keys, nonce and
// timestamp, so the signature must come out byte for byte. A signer that only agrees with itself
// proves nothing.
const DOC = {
  apiKey: "xvz1evFS4wEEPTGEFPHBog",
  apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
  accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
};

describe("oauthHeader", () => {
  it("reproduces the documented signature", () => {
    const h = oauthHeader(
      DOC,
      "POST",
      "https://api.x.com/1.1/statuses/update.json",
      { include_entities: "true", status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
      { nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp: "1318622958" },
    );
    expect(h).toContain('oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D"');
    expect(h.startsWith("OAuth ")).toBe(true);
    expect(h).toContain('oauth_signature_method="HMAC-SHA1"');
  });
  it("a different secret gives a different signature", () => {
    const a = oauthHeader(DOC, "POST", X_TWEETS_URL, {}, { nonce: "n", timestamp: "1" });
    const b = oauthHeader({ ...DOC, accessSecret: "x" }, "POST", X_TWEETS_URL, {}, { nonce: "n", timestamp: "1" });
    expect(a).not.toBe(b);
  });
});

describe("postTweet", () => {
  it("sends the text as JSON with a signed header and returns the post id", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ data: { id: "1234", text: "hi" } }), { status: 201 });
    }) as unknown as typeof fetch;
    const id = await postTweet(DOC, "hi", fetchImpl);
    expect(id).toBe("1234");
    expect(seen!.url).toBe(X_TWEETS_URL);
    expect(JSON.parse(seen!.init.body as string)).toEqual({ text: "hi" });
    expect(String((seen!.init.headers as Record<string, string>).authorization)).toMatch(/^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog"/);
  });
  it("surfaces X's own reason on a refusal, never a fake id", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ title: "Forbidden", detail: "Your client app is not configured with the appropriate oauth1 app permissions" }), { status: 403 })) as unknown as typeof fetch;
    await expect(postTweet(DOC, "hi", fetchImpl)).rejects.toThrow(/x 403: .*oauth1 app permissions/);
  });
  it("a 2xx without an id is still a failure", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(postTweet(DOC, "hi", fetchImpl)).rejects.toThrow(/x 200/);
  });
});

describe("xCredsFromEnv", () => {
  it("none set = no channel; all set = credentials; some set = refused", () => {
    expect(xCredsFromEnv({})).toBeNull();
    expect(xCredsFromEnv({ X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_SECRET: "d" })).toEqual(DOC && { apiKey: "a", apiSecret: "b", accessToken: "c", accessSecret: "d" });
    expect(() => xCredsFromEnv({ X_API_KEY: "a" })).toThrow(/all be set, or none/);
  });
});
