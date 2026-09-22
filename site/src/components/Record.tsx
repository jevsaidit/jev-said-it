"use client";

import { useEffect, useState } from "react";

// Jev's record against the baseline written into every receipt, including the epochs it loses. Under
// 30 resolved questions the engine refuses to call it a measurement, and so does this block: a number
// published too early is worse than no number, because people would hold us to it.

type Cal = {
  resolved: number;
  brierModel: number | null;
  brierBaseline: number | null;
  modelBeatsBaseline: boolean | null;
  outcomes: Record<string, number>;
  note: string | null;
};

const n3 = (x: number) => x.toFixed(4);

export function Record() {
  const [c, setC] = useState<Cal | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/feed/calibration", { cache: "no-store", signal: AbortSignal.timeout(8_000) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: Cal | null) => !stop && d && setC(d))
        .catch(() => {});
    load();
    const t = setInterval(load, 120_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (!c) return null;
  const up = c.outcomes["1"] ?? 0;
  const down = c.outcomes["0"] ?? 0;
  const void_ = c.outcomes["VOID"] ?? 0;
  const unresolvable = c.outcomes["UNRESOLVABLE"] ?? 0;
  const pending = c.outcomes["pending"] ?? 0;
  return (
    <div className="record">
      <h3>
        Jev&apos;s record <a className="record__link" href="/e/0">see an epoch →</a>
      </h3>
      <p className="muted">
        {c.resolved} resolved · {up} up · {down} down · {void_} void · {unresolvable} unresolvable · {pending} still open
      </p>
      {c.note ? (
        <p className="muted">{c.note}. The number appears here when it means something, win or lose.</p>
      ) : (
        <p>
          Brier score, lower is better: <strong>{n3(c.brierModel ?? 0)}</strong> for the model against{" "}
          <strong>{n3(c.brierBaseline ?? 0)}</strong> for the baseline —{" "}
          {c.modelBeatsBaseline ? "the model is ahead" : "the baseline is ahead, and it stays printed here"}.
        </p>
      )}
    </div>
  );
}
