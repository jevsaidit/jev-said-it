// Read-only proxy to the Verdict Engine's public feed (spec §9.4).
// The browser only talks to this domain: no CORS to open on the engine, and the engine's
// URL changes with an environment variable, without rebuilding.

const ALLOWED = /^(epochs\/(current|\d+)|q\/0x[0-9a-fA-F]{64}\.json|leaderboard\/\d+|calibration|config|holder\/0x[0-9a-fA-F]{40})$/;

const offline = (reason: string) => Response.json({ state: "offline", reason }, { status: 503, headers: { "cache-control": "no-store" } });

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const base = process.env.ENGINE_FEED_URL?.trim().replace(/\/+$/, "");
  const launched = !!process.env.NEXT_PUBLIC_TOKEN_ADDRESS?.trim();
  const { path } = await ctx.params;
  const rel = path.join("/");

  if (!ALLOWED.test(rel)) {
    return Response.json({ error: "unknown feed path" }, { status: 404 });
  }
  // Before launch the hero says the address is not public yet. /config carries the token address, so
  // it stays closed until the page itself prints the address: the site never leaks it through a side door.
  if (rel === "config" && !launched) {
    return offline("not launched");
  }
  if (!base) {
    return offline("feed not configured");
  }

  try {
    const res = await fetch(`${base}/${rel}`, {
      headers: { accept: "application/json", "user-agent": "jevsaidit-site" },
      // A wallet's own view must be fresh right after it answers or claims; the rest can be 30s old.
      next: { revalidate: rel.startsWith("holder/") ? 0 : 30 },
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.text();
    // The engine is up but has no CallLedger yet (pre-launch): that is "offline", not "unreachable".
    // It answered; there is just no epoch to show.
    if (res.status === 404 && (rel === "epochs/current" || rel.startsWith("holder/")) && /CallLedger not configured/.test(body)) {
      return offline("CallLedger not configured");
    }
    return new Response(body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
        // One wallet's view, or an error, must never sit in a shared cache and be served to someone else.
        "cache-control": rel.startsWith("holder/") || !res.ok ? "no-store" : "public, s-maxage=30, stale-while-revalidate=60",
      },
    });
  } catch {
    // Not being able to look is not "no questions": we say so (spec §6, §9.3).
    return Response.json({ state: "blind", reason: "engine unreachable" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
