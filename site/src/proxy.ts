import { NextResponse, type NextRequest } from "next/server";

// One line per page view, to stdout, so "did that post bring anyone?" is a number instead of an
// opinion. No cookies, no third party, no storage: only the path and the referring SITE (its host,
// never the full URL), which is what tells apart X from a search engine from a direct visit.

export function proxy(req: NextRequest) {
  const ref = req.headers.get("referer");
  let from = "direct";
  if (ref) {
    try {
      const h = new URL(ref).host;
      from = h === req.nextUrl.host ? "internal" : h;
    } catch {
      from = "unknown";
    }
  }
  // One flat line, easy to count in the platform's log search.
  console.log(JSON.stringify({ view: req.nextUrl.pathname, from, at: new Date().toISOString() }));
  return NextResponse.next();
}

// Pages only: not the feed proxy (polled every minute), not cards, not static files.
export const config = { matcher: ["/", "/play", "/q/:id", "/c/:id/:side", "/w/:epoch/:addr"] };
