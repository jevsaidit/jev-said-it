import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// One page. Share links (/c/…, /w/…) are receipts, not pages to index.
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE_URL}/`, changeFrequency: "daily", priority: 1 }];
}
