import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BLIND } from "@/lib/cards";
import { epochView, isHit, PER_CALL_FROM_EPOCH, perCallOf, scoreboard } from "@/lib/epoch";
import { said, whoSaid } from "@/lib/say";
import { LINKS, SITE_URL, TICKER } from "@/lib/site";

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
  const board = await scoreboard(e.epoch);
  const T = `$${TICKER}`;
  const pts = (x: bigint) => (Number(x) / 1e8).toFixed(3);
  const text = e.resolved > 0 ? `${describe(e)} every probability was on-chain before anyone answered. ${T} @jevsaidit #jevsaidit` : `Epoch ${e.epoch} is open. ${T} @jevsaidit #jevsaidit`;
  return (
    <main id="main" className="wrap section epoch">
      <h1 className="h2">Epoch {e.epoch}</h1>
      <p className="lede">
        {e.resolved > 0 ? (
          <>
            Jev got <strong>{e.hits}</strong> of <strong>{e.resolved}</strong> resolved questions. Always saying &ldquo;{e.majoritySide}&rdquo;
            would have got {e.majority}.
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
      <h2>Scoreboard</h2>
      {board === BLIND ? (
        <p className="muted">The engine didn&apos;t answer, so the scores can&apos;t be read right now.</p>
      ) : board === null ? (
        <p className="muted">Scored once every question of the epoch has settled.</p>
      ) : board.wallets.length === 0 ? (
        <p className="muted">No holder called this epoch.</p>
      ) : (
        <>
          <p className="muted">
            {e.epoch >= PER_CALL_FROM_EPOCH
              ? "Brier skill against the baseline, per resolved call: ranked by the average, not by how many calls."
              : "Brier skill against the baseline, summed over each wallet's counted calls (the rule until epoch 1)."}
            {board.state === "PUBLISHED" ? "" : " Nothing was paid for this epoch."}
          </p>
          <ol className="epoch__qs">
            {board.wallets.map((w) => (
              <li key={w.address}>
                <a href={`${LINKS.explorer}/address/${w.address}`} rel="noopener" target="_blank">
                  {w.address.slice(0, 6)}…{w.address.slice(-4)}
                </a>
                <span className="epoch__p">
                  {e.epoch >= PER_CALL_FROM_EPOCH ? `${pts(perCallOf(w))} per call` : pts(BigInt(w.score))} over {w.callsResolved} call
                  {w.callsResolved === 1 ? "" : "s"}
                </span>
                <span className={BigInt(w.score) > 0n ? "paid" : "unpaid"}>{BigInt(w.score) > 0n ? "beat it" : "didn't"}</span>
              </li>
            ))}
          </ol>
        </>
      )}
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
