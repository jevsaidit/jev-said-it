import { ImageResponse } from "next/og";
import { BLIND, blindResponse, C, cardAssets, short, tokens, winCard } from "@/lib/cards";
import { SITE_HOST } from "@/lib/site";
import { Big, Card, Label, Line, Mid } from "../../../Card";

export const runtime = "nodejs";

// The receipt of a win. The amount is read from the engine's published epoch, never from the URL:
// a link cannot print a reward that does not exist.
export async function GET(_req: Request, ctx: { params: Promise<{ epoch: string; addr: string }> }) {
  const { epoch, addr } = await ctx.params;
  const w = await winCard(epoch, addr);
  if (w === BLIND) return blindResponse();
  if (!w) return new Response("no reward for this address in this epoch", { status: 404 });
  const { fonts, mascot } = await cardAssets();
  return new ImageResponse(
    (
      <Card mascot={mascot} footer={`$JEVSAIDIT  ·  ${SITE_HOST}  ·  #jevsaidit`}>
        <Label>{`EPOCH ${w.epoch}  ·  ${short(w.account)}`}</Label>
        {/* "Jev" only when Jev answered the whole epoch; a fallback model is named, never dressed as Jev. */}
        <Big color={C.hood}>{w.jev ? "I BEAT JEV." : "I BEAT THE MODEL."}</Big>
        {!w.jev && w.models.length > 0 && <Label>{`answered by ${w.models.join(", ")} (fallback)`}</Label>}
        <div style={{ display: "flex", height: 18 }} />
        <Mid color={C.gold}>{`+${tokens(w.amount)}`}</Mid>
        <Mid color={C.gold}>$JEVSAIDIT</Mid>
        <Line color={C.dim}>bought on the market with trading fees.</Line>
      </Card>
    ),
    { width: 1200, height: 630, fonts, headers: { "cache-control": "public, max-age=3600" } },
  );
}
