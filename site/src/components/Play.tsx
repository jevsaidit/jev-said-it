"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { supportedChain } from "@/lib/supported";

// The shell of the play panel: it reads /config and decides which of the four states the panel is in.
// The wallet code (viem, ~85KB gzipped) lives in PlayLive and is downloaded only when there is a
// CallLedger on a chain this site supports: before launch nobody pays for it.

export type Config = { chainId: number | null; token: `0x${string}`; callLedger: `0x${string}` | null; rewardsDistributor: `0x${string}` | null };

const PlayLive = dynamic(() => import("./PlayLive").then((m) => m.PlayLive), {
  ssr: false,
  loading: () => <p className="play__note">Loading the wallet panel.</p>,
});

export function Play({ ticker }: { ticker: string }) {
  // null = loading, "offline" = the site has no engine yet (pre-launch), "blind" = the engine did not answer
  const [cfg, setCfg] = useState<Config | null | "blind" | "offline">(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch("/api/feed/config", { cache: "no-store" });
        if (stop) return;
        if (r.ok) setCfg((await r.json()) as Config);
        else setCfg(r.status === 503 ? "offline" : "blind");
      } catch {
        if (!stop) setCfg("blind");
      }
    };
    load();
    // Blind is a moment, not a verdict: keep asking, so the panel comes back when the engine does.
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const live = cfg && cfg !== "blind" && cfg !== "offline" ? cfg : null;
  const chain = live?.callLedger ? supportedChain(live.chainId) : undefined;

  if (live && live.callLedger && chain) return <PlayLive ticker={ticker} cfg={live} chainId={chain.id} />;

  // Nothing to sign yet: a sentence, not a bordered box around a sentence.
  let note: React.ReactNode;
  if (cfg === null)
    note = (
      <>
        Reading the engine.
        <noscript> Needs JavaScript to read the engine.</noscript>
      </>
    );
  else if (cfg === "blind") note = "The engine didn't answer, so there is nothing to sign right now. This panel retries every minute.";
  else if (live && live.callLedger && !chain) note = `The engine's CallLedger is on chain ${live.chainId}, which this site does not support.`;
  else note = "Calls open at launch, when the CallLedger is deployed. Its address will be printed here and in the footer.";

  return (
    <div className="play play--quiet">
      <p className="play__note">{note}</p>
    </div>
  );
}
