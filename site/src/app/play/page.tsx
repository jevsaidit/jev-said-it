// The same page at a second URL. X caches a link card per URL for days, and the root's card was cached
// while it still showed the old ticker: /play is a URL X has never seen, so it reads the current card.
// og:url is this URL (so X does not fold it back onto the root's cached card); the canonical stays the
// root, so search engines see one page.
import type { Metadata } from "next";
import { metadata as root } from "../layout";
import { SITE_URL } from "@/lib/site";
import Home from "../page";

export const metadata: Metadata = {
  alternates: { canonical: SITE_URL },
  openGraph: { ...root.openGraph, url: `${SITE_URL}/play` },
  twitter: root.twitter,
};
export default Home;
