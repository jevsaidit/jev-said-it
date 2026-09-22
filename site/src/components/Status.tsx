"use client";

import { useEffect, useState } from "react";

// What is happening right now, from the engine's own feed: the epoch, how many questions are open and
// how long is left. The countdown runs off the feed's `now`, not the visitor's clock, so a wrong clock
// cannot invent a deadline. While the feed cannot be read this says nothing instead of guessing.

type Feed = { epoch: number; now?: number; questions?: Array<{ status?: string; deadline?: number }> };
type Curve = { graduated: boolean; progressWei: string; thresholdWei: string; progressBps: number };

const left = (sec: number) => {
  if (sec <= 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};
const eth = (wei: string) => (Number(BigInt(wei)) / 1e18).toFixed(2);

export function Status({ ticker }: { ticker: string }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [curve, setCurve] = useState<Curve | null>(null);
  const [skew, setSkew] = useState(0);

  useEffect(() => {
    let stop = false;
    const load = () => {
      fetch("/api/feed/epochs/current", { cache: "no-store", signal: AbortSignal.timeout(8_000) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: Feed | null) => {
          if (stop || !d) return;
          setFeed(d);
          if (d.now) setSkew(d.now - Math.floor(Date.now() / 1000));
        })
        .catch(() => {});
      fetch("/api/feed/curve", { cache: "no-store", signal: AbortSignal.timeout(6_000) })
        .then((r) => (r.ok ? r.json() : null))
        .then((c: Curve | null) => !stop && c && setCurve(c))
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (!feed) return null;
  const open = (feed.questions ?? []).filter((q) => q.status === "OPEN");
  const deadline = open.length > 0 ? Math.min(...open.map((q) => q.deadline ?? 0)) : 0;
  const remaining = deadline ? left(deadline - (Math.floor(Date.now() / 1000) + skew)) : null;
  return (
    <p className="status status--live">
      <strong>epoch {feed.epoch}</strong>
      {open.length > 0 ? (
        <>
          {" "}
          · {open.length} question{open.length === 1 ? "" : "s"} open ·{" "}
          {remaining ? <>calls close in {remaining}</> : <>calls closed, the next batch opens shortly</>}
        </>
      ) : (
        <> · no question open right now</>
      )}
      {curve && !curve.graduated && (
        <>
          {" "}
          ·{" "}
          <span className="status__bar" role="img" aria-label={`Graduation ${(curve.progressBps / 100).toFixed(1)} percent`}>
            <span style={{ width: `${Math.min(100, curve.progressBps / 100)}%` }} />
          </span>{" "}
          {(curve.progressBps / 100).toFixed(1)}% to graduation ({eth(curve.progressWei)}/{eth(curve.thresholdWei)} ETH), when ${ticker}&apos;s
          buyback starts
        </>
      )}
    </p>
  );
}
