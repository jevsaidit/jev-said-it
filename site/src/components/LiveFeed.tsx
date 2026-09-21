"use client";

import { useEffect, useState } from "react";

// Expected shape of GET /epochs/current (spec §9.4). The engine doesn't expose it yet: the site reads
// defensively and shows only the fields it finds.
type Question = {
  id?: string;
  token?: string;
  symbol?: string;
  p?: string | number;
  model?: string;
  deadline?: string | number;
  status?: string;
  outcome?: string | number | null;
};
type Epoch = { epoch?: number | string; questions?: Question[] };

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
        if (res.status === 503) return setState({ kind: "offline" });
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

  return (
    <div className="feed" aria-live="polite" aria-busy={state.kind === "loading"}>
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
          <p>Reading the engine feed.</p>
        </div>
      )}

      {state.kind === "offline" && (
        <div className="feed__empty">
          <h3>No epoch yet.</h3>
          <p>
            ${ticker} hasn&apos;t launched. The first batch of questions opens within 10 minutes of
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
          <p>The engine is up and found no token with enough swaps in the last hour to ask about.</p>
        </div>
      )}

      {state.kind === "ok" &&
        qs.map((q, i) => (
          <div className="feed__row" key={q.id ?? i}>
            {q.id ? (
              <a href={`/api/feed/q/${q.id}.json`} title={q.id}>
                {q.symbol ? `$${q.symbol}` : (q.token ?? q.id)}
              </a>
            ) : (
              <span>{q.symbol ?? q.token ?? "—"}</span>
            )}
            <span className="feed__p">p {q.p ?? "—"}</span>
            <span>{when(q.deadline)}</span>
            <span className="muted">
              {q.outcome !== undefined && q.outcome !== null ? `outcome ${q.outcome}` : (q.status ?? q.model ?? "")}
            </span>
          </div>
        ))}
    </div>
  );
}
