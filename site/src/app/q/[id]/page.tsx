import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BLIND, callCard } from "@/lib/cards";
import { said, whoSaid } from "@/lib/say";
import { SharePage } from "@/components/SharePage";

type P = { params: Promise<{ id: string }> };

// One question, with its own page and card: the receipt is the share surface, before anyone has called it.
export const dynamic = "force-dynamic";

const BRAND_IMAGE = "/brand/og-jev-1200x630.png";
const description = "A model commits to a probability on-chain before anyone answers. Holders agree or disagree.";

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { id } = await params;
  const c = await callCard(id);
  if (c === BLIND) {
    const title = "Jev said it.";
    return { title, description, openGraph: { title, images: [{ url: BRAND_IMAGE, width: 1200, height: 630 }] }, twitter: { card: "summary_large_image", title, images: [BRAND_IMAGE] } };
  }
  if (!c) return {};
  const title = `${whoSaid(c.model)} said ${said(c.p)} on ${c.symbol}.`;
  const image = `/api/card/q/${id}`;
  return {
    title,
    description,
    openGraph: { title, images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, images: [image] },
  };
}

export default async function Page({ params }: P) {
  const { id } = await params;
  const c = await callCard(id);
  if (c === BLIND) return <SharePage image={BRAND_IMAGE} alt="Jev Said It" commitment={`/api/feed/q/${id}.json`} blind />;
  if (!c) notFound();
  return <SharePage image={`/api/card/q/${id}`} alt={`${whoSaid(c.model)} said ${said(c.p)} on ${c.symbol}`} commitment={`/api/feed/q/${id}.json`} />;
}
