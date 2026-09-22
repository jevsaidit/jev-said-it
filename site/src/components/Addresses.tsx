"use client";

import { useEffect, useState } from "react";
import type { Config } from "./Play";

// The footer's verification strip: the addresses people check, in mono, each with a copy button.
// The token comes from the build (the page prints it in the hero too); the ledger and the distributor
// come from the engine's /config once it has them. Nothing here is guessed: a missing address is a
// missing row, never a placeholder.

function Row({ label, value, explorer }: { label: string; value: string; explorer: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no clipboard: the address is still selectable */
    }
  };
  return (
    <li className="addr-row">
      <span className="addr-row__label">{label}</span>
      <a className="addr" href={explorer} rel="noopener" target="_blank">
        {value}
      </a>
      <button type="button" className="addr-row__copy" onClick={copy} aria-label={`Copy the ${label} address`}>
        {copied ? "copied" : "copy"}
      </button>
    </li>
  );
}

export function Addresses({ token, dev, chainName, chainId, explorer }: { token?: string; dev?: { wallet?: string; share?: string }; chainName: string; chainId: number; explorer: string }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  useEffect(() => {
    if (!token) return;
    fetch("/api/feed/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((c: Config | null) => c && setCfg(c))
      .catch(() => {});
  }, [token]);

  if (!token) return null;
  return (
    <div className="addresses">
      <p className="addresses__chain">
        {chainName} · chain id {cfg?.chainId ?? chainId}
      </p>
      <ul>
        <Row label="Token" value={token} explorer={`${explorer}/token/${token}`} />
        {cfg?.callLedger && <Row label="CallLedger" value={cfg.callLedger} explorer={`${explorer}/address/${cfg.callLedger}`} />}
        {cfg?.rewardsDistributor && <Row label="RewardsDistributor" value={cfg.rewardsDistributor} explorer={`${explorer}/address/${cfg.rewardsDistributor}`} />}
        {dev?.wallet && (
          <Row label={`Dev wallet${dev.share ? ` · bought ${dev.share} at launch, holds, no rewards` : " · holds, no rewards"}`} value={dev.wallet} explorer={`${explorer}/address/${dev.wallet}`} />
        )}
      </ul>
    </div>
  );
}
