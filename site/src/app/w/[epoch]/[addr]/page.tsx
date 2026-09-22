import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BLIND, tokens, winCard } from "@/lib/cards";
import { SharePage } from "@/components/SharePage";

type P = { params: Promise<{ epoch: string; addr: string }> };

// Rendered per request, never stored: a page drawn while the engine was blind must not outlive the hiccup.
export const dynamic = "force-dynamic";

const BRAND_IMAGE = "/brand/og-jev-1200x630.png";
const description = "Best-calibrated calls get paid in $JEV, bought on the market with trading fees.";

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { epoch, addr } = await params;
  const w = await winCard(epoch, addr);
  if (w === BLIND) {
    const title = "Jev said it.";
    return { title, description, openGraph: { title, images: [{ url: BRAND_IMAGE, width: 1200, height: 630 }] }, twitter: { card: "summary_large_image", title, images: [BRAND_IMAGE] } };
  }
  if (!w) return {};
  const title = `I beat ${w.jev ? "Jev" : "the model"}: +${tokens(w.amount)} $JEV in epoch ${w.epoch}.`;
  const image = `/api/card/win/${epoch}/${addr}`;
  return {
    title,
    description,
    openGraph: { title, images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, images: [image] },
  };
}

export default async function Page({ params }: P) {
  const { epoch, addr } = await params;
  const w = await winCard(epoch, addr);
  if (w === BLIND) return <SharePage image={BRAND_IMAGE} alt="Jev Said It" blind />;
  if (!w) notFound();
  return <SharePage image={`/api/card/win/${epoch}/${addr}`} alt={`Won ${tokens(w.amount)} $JEV in epoch ${w.epoch}`} />;
}
