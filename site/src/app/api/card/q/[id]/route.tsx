import { ImageResponse } from "next/og";
import { BLIND, blindResponse, C, callCard, cardAssets } from "@/lib/cards";
import { isJev, said } from "@/lib/say";
import { SITE_HOST } from "@/lib/site";
import { Big, Card, Label, Line, Mid } from "../../Card";

export const runtime = "nodejs";

// The question itself: what the model committed to, and where it stands. No side taken.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const c = await callCard(id);
  if (c === BLIND) return blindResponse();
  if (!c) return new Response("no such question", { status: 404 });
  const { fonts, mascot } = await cardAssets();
  const jev = isJev(c.model);
  const closes = new Date(c.deadline * 1000).toISOString().slice(11, 16);
  const status =
    c.outcome === null
      ? `calls close ${closes} UTC`
      : c.outcome === "0" || c.outcome === "1"
        ? `it went ${c.outcome === "1" ? "up" : "down"}. ${jev ? "jev" : "the model"} said ${said(c.p)}.`
        : "no trade in the window: void";
  return new ImageResponse(
    (
      <Card mascot={mascot} footer={`$JEV  ·  ${SITE_HOST}  ·  #jevsaidit`}>
        <Label>{jev ? "JEV SAID" : `${(c.model || "UNKNOWN MODEL").toUpperCase()} SAID  (FALLBACK)`}</Label>
        <Big color={C.gold}>{said(c.p).toUpperCase()}</Big>
        <Line>{`on ${c.symbol}`}</Line>
        <div style={{ display: "flex", height: 18 }} />
        <Label>YOUR MOVE</Label>
        <Mid color={C.hood}>AGREE OR DISAGREE.</Mid>
        <Line color={c.outcome === null ? C.dim : C.mint}>{status}</Line>
      </Card>
    ),
    { width: 1200, height: 630, fonts, headers: { "cache-control": "public, max-age=300, s-maxage=300" } },
  );
}
