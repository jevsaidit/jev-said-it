import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BLIND, callCard } from "@/lib/cards";
import { said, whoSaid } from "@/lib/say";
import { SharePage } from "@/components/SharePage";

type P = { params: Promise<{ id: string; side: string }> };

// Rendered per request, never stored: a page drawn while the engine was blind must not outlive the hiccup.
export const dynamic = "force-dynamic";

const BRAND_IMAGE = "/brand/og-jev-1200x630.png";
const description = "A model commits to a probability on-chain before anyone answers. Holders agree or disagree.";

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { id, side } = await params;
  if (side !== "agree" && side !== "disagree") return {};
  const c = await callCard(id);
  if (c === BLIND) {
    // The engine could not be asked: the brand card, so a scraper caching this moment shows something true.
    const title = "Jev said it.";
    return { title, description, openGraph: { title, images: [{ url: BRAND_IMAGE, width: 1200, height: 630 }] }, twitter: { card: "summary_large_image", title, images: [BRAND_IMAGE] } };
  }
  if (!c) return {};
  const title = `${whoSaid(c.model)} said ${said(c.p)} on ${c.symbol}. I ${side === "agree" ? "agreed" : "disagreed"}.`;
  const image = `/api/card/call/${id}/${side}`;
  return {
    title,
    description,
    openGraph: { title, images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, images: [image] },
  };
}

export default async function Page({ params }: P) {
  const { id, side } = await params;
  if (side !== "agree" && side !== "disagree") notFound();
  const c = await callCard(id);
  if (c === BLIND) return <SharePage image={BRAND_IMAGE} alt="Jev Said It" commitment={`/api/feed/q/${id}.json`} blind />;
  if (!c) notFound();
  return <SharePage image={`/api/card/call/${id}/${side}`} alt={`${whoSaid(c.model)} said ${said(c.p)} on ${c.symbol}`} commitment={`/api/feed/q/${id}.json`} />;
}
