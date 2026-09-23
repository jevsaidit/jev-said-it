import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    // The feed proxy is for the page, not for an index. The card images must stay reachable: X's
    // crawler honours robots.txt for og:image, and /api/card/ under a blanket /api/ disallow meant
    // shared /e, /q, /c and /w links could go out without their picture.
    rules: { userAgent: "*", allow: ["/", "/api/card/"], disallow: ["/api/"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
