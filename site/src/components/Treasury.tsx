"use client";

import { useEffect, useState } from "react";

// The fees' path, from the engine's treasury log: every row carries the transaction that did it, so
// nothing here needs trust. Amounts are the ones the contracts emitted (Forwarded, SwapProcessed).

type Curve = { graduated: boolean; progressWei: string; thresholdWei: string; progressBps: number };
type Op = { kind: string; tx: string | null; at: string; forwarded?: string; ethIn?: string; tokenOut?: string; burned?: string; toRewards?: string };

const eth = (wei: bigint) => (Number(wei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 5 });
const tok = (wei: bigint) => Math.round(Number(wei / 10n ** 18n)).toLocaleString("en-US");
const sum = (ops: Op[], k: keyof Op) => ops.reduce((a, o) => a + BigInt((o[k] as string | undefined) ?? "0"), 0n);
const when = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";

export function Treasury({ ticker, explorer, router }: { ticker: string; explorer: string; router?: string }) {
  const [ops, setOps] = useState<Op[] | null | "blind">(null);
  const [curve, setCurve] = useState<Curve | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/feed/treasury", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: Op[]) => !stop && setOps(d))
        .catch(() => !stop && setOps((cur) => (Array.isArray(cur) ? cur : "blind")));
    const loadCurve = () =>
      // Never let a slow dependency hold the page: the block simply does not show this line.
      fetch("/api/feed/curve", { cache: "no-store", signal: AbortSignal.timeout(6_000) })
        .then((r) => (r.ok ? r.json() : null))
        .then((c: Curve | null) => !stop && c && setCurve(c))
        .catch(() => {});
    load();
    loadCurve();
    const t = setInterval(() => {
      load();
      loadCurve();
    }, 120_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (ops === null) return null;
  if (ops === "blind") return <p className="muted treasury__note">The treasury log could not be read right now.</p>;
  const claims = ops.filter((o) => o.kind === "CLAIM");
  const swaps = ops.filter((o) => o.kind === "SWAP");
  const T = `$${ticker}`;
  const rows = ops.filter((o) => (o.kind === "CLAIM" || o.kind === "SWAP") && o.tx).slice(0, 12);
  return (
    <div className="treasury">
      <h3>On-chain, so far</h3>
      <dl className="treasury__totals">
        <div>
          <dt>Fees collected</dt>
          <dd>{eth(sum(claims, "forwarded"))} ETH</dd>
        </div>
        <div>
          <dt>Spent buying {T}</dt>
          <dd>{eth(sum(swaps, "ethIn"))} ETH</dd>
        </div>
        <div>
          <dt>{T} burned</dt>
          <dd>{tok(sum(swaps, "burned"))}</dd>
        </div>
        <div>
          <dt>{T} to the rewards</dt>
          <dd>{tok(sum(swaps, "toRewards"))}</dd>
        </div>
      </dl>
      {curve && !curve.graduated && (
        <p className="treasury__note">
          The buyback starts when the curve graduates and the pool exists: {(curve.progressBps / 100).toFixed(1)}% of the way there
          ({eth(BigInt(curve.progressWei))} of {eth(BigInt(curve.thresholdWei))} ETH). Until then the fees stay in the router, in ETH,
          and nothing is bought with a price nobody can read.
        </p>
      )}
      {rows.length > 0 ? (
        <ul className="treasury__ops">
          {rows.map((o) => (
            <li key={`${o.kind}${o.tx}`}>
              <span className="muted">{when(o.at)}</span>
              <span>
                {o.kind === "CLAIM"
                  ? `fees in: ${eth(BigInt(o.forwarded ?? "0"))} ETH`
                  : `bought ${tok(BigInt(o.tokenOut ?? "0"))} ${T} for ${eth(BigInt(o.ethIn ?? "0"))} ETH, ${tok(BigInt(o.burned ?? "0"))} burned`}
              </span>
              <a className="addr" href={`${explorer}/tx/${o.tx}`} rel="noopener" target="_blank">
                tx
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted treasury__note">No fee movement yet.</p>
      )}
      <p className="muted treasury__note">
        Every row links its transaction. Totals are sums of the contracts&apos; own events
        {router ? (
          <>
            ; the router&apos;s balances are on{" "}
            <a href={`${explorer}/address/${router}`} rel="noopener" target="_blank">
              the explorer
            </a>
          </>
        ) : null}
        .
      </p>
    </div>
  );
}
