import { ImageResponse } from "next/og";
import { BLIND, blindResponse, C, cardAssets } from "@/lib/cards";
import { epochView } from "@/lib/epoch";
import { SITE_HOST } from "@/lib/site";
import { Big, Card, Label, Line, Mid } from "../../Card";

export const runtime = "nodejs";

// An epoch's scoreboard: what the model got, out of what actually resolved.
export async function GET(_req: Request, ctx: { params: Promise<{ n: string }> }) {
  const { n } = await ctx.params;
  const e = await epochView(n);
  if (e === BLIND) return blindResponse();
  if (!e) return new Response("no such epoch", { status: 404 });
  const { fonts, mascot } = await cardAssets();
  return new ImageResponse(
    (
      <Card mascot={mascot} footer={`$JEV  ·  ${SITE_HOST}  ·  #jevsaidit`}>
        <Label>{`EPOCH ${e.epoch}`}</Label>
        {e.resolved > 0 ? (
          <>
            <Big color={C.gold}>{`${e.hits} OF ${e.resolved}`}</Big>
            <Line>resolved questions jev called right</Line>
          </>
        ) : (
          <>
            <Big color={C.gold}>OPEN</Big>
            <Line>{`${e.open} questions waiting for the price`}</Line>
          </>
        )}
        <div style={{ display: "flex", height: 18 }} />
        <Label>COMMITTED FIRST</Label>
        <Mid color={C.hood}>ON-CHAIN, BEFORE ANY ANSWER.</Mid>
        <Line color={C.dim}>{`${e.voided} void · ${e.unresolvable} unresolvable`}</Line>
      </Card>
    ),
    { width: 1200, height: 630, fonts, headers: { "cache-control": "public, max-age=120, s-maxage=120" } },
  );
}
