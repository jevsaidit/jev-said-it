import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { callCard, pct } from "@/lib/cards";
import { SharePage } from "@/components/SharePage";

type P = { params: Promise<{ id: string; side: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { id, side } = await params;
  const c = await callCard(id);
  if (!c || (side !== "agree" && side !== "disagree")) return {};
  const title = `Jev said ${pct(c.p)} up on ${c.symbol}. I ${side === "agree" ? "agreed" : "disagreed"}.`;
  const image = `/api/card/call/${id}/${side}`;
  return {
    title,
    description: "A model commits to a probability on-chain before anyone answers. Holders agree or disagree.",
    openGraph: { title, images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, images: [image] },
  };
}

export default async function Page({ params }: P) {
  const { id, side } = await params;
  if (side !== "agree" && side !== "disagree") notFound();
  const c = await callCard(id);
  if (!c) notFound();
  return <SharePage image={`/api/card/call/${id}/${side}`} alt={`Jev said ${pct(c.p)} up on ${c.symbol}`} commitment={`/api/feed/q/${id}.json`} />;
}
