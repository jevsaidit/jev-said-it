"use client";

import { useEffect, useState } from "react";
import { isJev } from "@/lib/say";

// Shape of GET /epochs/current (engine/src/server/feed.ts, publicQuestion). The site reads it
// defensively and shows only the fields it finds.
type Question = {
  id?: string;
  token?: string;
  symbol?: string | null;
  p?: string | number;
  model?: string;
  deadline?: string | number;
  status?: string;
  outcome?: string | number | null;
};
type Epoch = { epoch?: number | string; questions?: Question[] };

// Four states, kept apart on purpose: "offline" is the engine saying there is no epoch yet (503 from
// the proxy, pre-launch), "blind" is the engine not answering at all. They must never look the same.
type State =
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "blind" }
  | { kind: "ok"; data: Epoch };

function when(v: string | number | undefined) {
  if (v === undefined) return "—";
  const d = new Date(Number(v) * 1000);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(11, 16) + " UTC";
}

export function LiveFeed({ ticker }: { ticker: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch("/api/feed/epochs/current", { cache: "no-store" });
        if (stop) return;
        // 503 = the proxy or the engine said "no epoch yet"; a 404 from the engine is the same
        // answer ("CallLedger not configured"), not an engine that is missing.
        if (res.status === 503 || res.status === 404) return setState({ kind: "offline" });
        if (!res.ok) return setState({ kind: "blind" });
        setState({ kind: "ok", data: (await res.json()) as Epoch });
      } catch {
        if (!stop) setState({ kind: "blind" });
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const qs = state.kind === "ok" ? (state.data.questions ?? []) : [];
  const quiet = state.kind !== "ok" || qs.length === 0;

  return (
    <div className={`feed${quiet ? " feed--quiet" : ""}`} aria-live="polite" aria-busy={state.kind === "loading"}>
      <div className="feed__head">
        <span>GET /epochs/current</span>
        <span>
          {state.kind === "loading" && "reading…"}
          {state.kind === "offline" && "not launched"}
          {state.kind === "blind" && "engine unreachable"}
          {state.kind === "ok" && `epoch ${state.data.epoch ?? "?"} · ${qs.length} questions`}
        </span>
      </div>

      {state.kind === "loading" && (
        <div className="feed__empty">
          <p>
            Reading the engine feed.
            <noscript> Needs JavaScript to read the engine.</noscript>
          </p>
        </div>
      )}

      {state.kind === "offline" && (
        <div className="feed__empty">
          <h3>No epoch yet.</h3>
          <p>
            ${ticker} hasn&apos;t launched. The first batch of questions opens shortly after
            launch, and shows up here with each question&apos;s probability and receipt.
          </p>
        </div>
      )}

      {state.kind === "blind" && (
        <div className="feed__empty">
          <h3>Can&apos;t see the engine.</h3>
          <p>
            The feed didn&apos;t answer. That&apos;s not the same as &ldquo;no questions&rdquo;, so this
            board stays blank instead of pretending. It retries every minute.
          </p>
        </div>
      )}

      {state.kind === "ok" && qs.length === 0 && (
        <div className="feed__empty">
          <h3>Nothing open right now.</h3>
          <p>The engine is up and found no graduated token with enough swaps in the last hour and the last six hours to ask about.</p>
        </div>
      )}

      {state.kind === "ok" &&
        qs.map((q, i) => (
          <div className="feed__row" key={q.id ?? i}>
            {q.id ? (
              // The question's own page: the receipt is one click further, and the link is shareable.
              <a href={`/q/${q.id}`} title="This question, with its receipt">
                {q.symbol ? `$${q.symbol}` : (q.token ?? q.id)}
                <span className="feed__arrow" aria-hidden>
                  {" "}
                  ↗
                </span>
              </a>
            ) : (
              <span>{q.symbol ?? q.token ?? "—"}</span>
            )}
            <span className="feed__p">p {q.p ?? "—"}</span>
            <span className="feed__when">{when(q.deadline)}</span>
            <span className="feed__state muted">
              {q.outcome !== undefined && q.outcome !== null ? `outcome ${q.outcome}` : (q.status ?? "")}
              {q.model && !isJev(q.model) ? ` · ${q.model} (fallback)` : ""}
            </span>
          </div>
        ))}
    </div>
  );
}
