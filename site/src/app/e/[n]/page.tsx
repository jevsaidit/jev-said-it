import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BLIND } from "@/lib/cards";
import { epochView, isHit } from "@/lib/epoch";
import { said, whoSaid } from "@/lib/say";
import { SITE_URL, TICKER } from "@/lib/site";

type P = { params: Promise<{ n: string }> };
export const dynamic = "force-dynamic";

const BRAND_IMAGE = "/brand/og-jev-1200x630.png";
const describe = (e: { epoch: number; hits: number; resolved: number }) =>
  e.resolved > 0 ? `Epoch ${e.epoch}: Jev got ${e.hits} of ${e.resolved}.` : `Epoch ${e.epoch}: still open.`;

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { n } = await params;
  const e = await epochView(n);
  if (e === BLIND || !e) return { title: "Jev said it." , openGraph: { images: [BRAND_IMAGE] } };
  const title = describe(e);
  const image = `/api/card/epoch/${n}`;
  return { title, openGraph: { title, images: [{ url: image, width: 1200, height: 630 }] }, twitter: { card: "summary_large_image", title, images: [image] } };
}

export default async function Page({ params }: P) {
  const { n } = await params;
  const e = await epochView(n);
  if (e === BLIND)
    return (
      <main id="main" className="wrap section">
        <h1 className="h2">Epoch {n}</h1>
        <p className="muted">The engine didn&apos;t answer, so this epoch can&apos;t be drawn right now. What was committed on-chain doesn&apos;t change while you wait.</p>
      </main>
    );
  if (!e) notFound();
  const T = `$${TICKER}`;
  const text = e.resolved > 0 ? `${describe(e)} every probability was on-chain before anyone answered. ${T} @jevsaidit #jevsaidit` : `Epoch ${e.epoch} is open. ${T} @jevsaidit #jevsaidit`;
  return (
    <main id="main" className="wrap section epoch">
      <h1 className="h2">Epoch {e.epoch}</h1>
      <p className="lede">
        {e.resolved > 0 ? (
          <>
            Jev got <strong>{e.hits}</strong> of <strong>{e.resolved}</strong> resolved questions.
          </>
        ) : (
          <>No question of this epoch has resolved yet.</>
        )}
        {e.voided > 0 ? ` ${e.voided} void.` : ""}
        {e.unresolvable > 0 ? ` ${e.unresolvable} unresolvable.` : ""}
        {e.open > 0 ? ` ${e.open} still waiting.` : ""}
      </p>
      <ul className="epoch__qs">
        {e.questions.map((q) => (
          <li key={q.id}>
            <a href={`/q/${q.id}`}>{q.symbol ? `$${q.symbol}` : (q.token ?? q.id).slice(0, 10)}</a>
            <span className="epoch__p">
              {whoSaid(q.model)}: {said(Number(q.p))}
            </span>
            <span className={q.outcome === null ? "muted" : isHit(q.p, q.outcome) ? "paid" : "unpaid"}>
              {q.outcome === null ? "open" : q.outcome === "1" ? "went up" : q.outcome === "0" ? "went down" : q.outcome.toLowerCase()}
            </span>
          </li>
        ))}
      </ul>
      <div className="share__actions">
        <a className="btn" href={`https://x.com/intent/post?${new URLSearchParams({ text, url: `${SITE_URL}/e/${e.epoch}` })}`} rel="noopener" target="_blank">
          Post it on X
        </a>
        <a className="btn btn--ghost" href="/#play">
          Make your own call
        </a>
      </div>
    </main>
  );
}
