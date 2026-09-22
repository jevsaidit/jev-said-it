import { ImageResponse } from "next/og";
import { BLIND, blindResponse, C, callCard, cardAssets, sideWasRight } from "@/lib/cards";
import { isJev, said } from "@/lib/say";
import { SITE_HOST } from "@/lib/site";
import { Big, Card, Label, Line, Mid } from "../../../Card";

export const runtime = "nodejs";

// The receipt of a call: what the model said, the side the sharer took, and the outcome once it exists.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; side: string }> }) {
  const { id, side } = await ctx.params;
  if (side !== "agree" && side !== "disagree") return new Response("unknown side", { status: 404 });
  const c = await callCard(id);
  if (c === BLIND) return blindResponse();
  if (!c) return new Response("no such question", { status: 404 });
  const { fonts, mascot } = await cardAssets();
  const up = c.p >= 0.5;
  const mine = side === "agree" ? (up ? "UP" : "DOWN") : up ? "DOWN" : "UP";
  const right = sideWasRight(side, c);
  const jev = isJev(c.model);
  const status =
    c.outcome === null
      ? `calls close ${new Date(c.deadline * 1000).toISOString().slice(11, 16)} UTC`
      : c.outcome === "0" || c.outcome === "1"
        ? `price went ${c.outcome === "1" ? "up" : "down"}. ${right ? "i was right." : jev ? "jev was right." : "the model was right."}`
        : "no trade in the window: void";
  return new ImageResponse(
    (
      <Card mascot={mascot} footer={`$JEV  ·  ${SITE_HOST}  ·  #jevsaidit`}>
        {/* Commitment: another model's answer is never published as Jev's. The label names who answered. */}
        <Label>{jev ? "JEV SAID" : `${(c.model || "UNKNOWN MODEL").toUpperCase()} SAID  (FALLBACK)`}</Label>
        <Big color={C.gold}>{said(c.p).toUpperCase()}</Big>
        <Line>{`on ${c.symbol}`}</Line>
        <div style={{ display: "flex", height: 18 }} />
        <Label>I SAID</Label>
        <Mid color={side === "agree" ? C.hood : C.coral}>{`${mine}. ${side === "agree" ? "AGREED." : "DISAGREED."}`}</Mid>
        <Line color={right === null ? C.dim : right ? C.hood : C.coral}>{status}</Line>
      </Card>
    ),
    { width: 1200, height: 630, fonts, headers: { "cache-control": "public, max-age=300, s-maxage=300" } },
  );
}
