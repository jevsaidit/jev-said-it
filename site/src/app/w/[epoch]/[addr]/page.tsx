import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { tokens, winCard } from "@/lib/cards";
import { SharePage } from "@/components/SharePage";

type P = { params: Promise<{ epoch: string; addr: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { epoch, addr } = await params;
  const w = await winCard(epoch, addr);
  if (!w) return {};
  const title = `I beat Jev: +${tokens(w.amount)} $JEVSAIDIT in epoch ${w.epoch}.`;
  const image = `/api/card/win/${epoch}/${addr}`;
  return {
    title,
    description: "Best-calibrated calls get paid in $JEVSAIDIT, bought on the market with trading fees.",
    openGraph: { title, images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, images: [image] },
  };
}

export default async function Page({ params }: P) {
  const { epoch, addr } = await params;
  const w = await winCard(epoch, addr);
  if (!w) notFound();
  return <SharePage image={`/api/card/win/${epoch}/${addr}`} alt={`Won ${tokens(w.amount)} $JEVSAIDIT in epoch ${w.epoch}`} />;
}
