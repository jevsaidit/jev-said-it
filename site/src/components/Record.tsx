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
  // the best constant forecast, known only afterwards (always the observed share of ups): the harder bar
  brierHindsight?: number | null;
  modelBeatsHindsight?: boolean | null;
  byEpoch?: Array<{ epoch: number; resolved: number; brierModel: number | null; brierBaseline: number | null; brierHindsight: number | null }>;
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
          {c.brierHindsight != null && (
            <>
              {" "}
              The harder bar: always guessing the share of ups that actually happened ({up} of {up + down}), which
              nobody knew in advance, scores <strong>{n3(c.brierHindsight)}</strong> —{" "}
              {c.modelBeatsHindsight ? "the model beats that too" : "and that one is ahead of the model"}.
            </>
          )}
        </p>
      )}
      {c.byEpoch && c.byEpoch.length > 0 && (
        <>
          <table className="record__table">
            <thead>
              <tr>
                <th>epoch</th>
                <th>n</th>
                <th>Jev</th>
                <th>0.5</th>
                <th>hindsight</th>
              </tr>
            </thead>
            <tbody>
              {c.byEpoch.map((e) => (
                <tr key={e.epoch}>
                  <td>
                    <a href={`/e/${e.epoch}`}>{e.epoch}</a>
                  </td>
                  <td>{e.resolved}</td>
                  <td className={e.brierModel != null && e.brierHindsight != null && e.brierModel > e.brierHindsight ? "unpaid" : ""}>
                    {e.brierModel == null ? "—" : n3(e.brierModel)}
                  </td>
                  <td>{e.brierBaseline == null ? "—" : n3(e.brierBaseline)}</td>
                  <td>{e.brierHindsight == null ? "—" : n3(e.brierHindsight)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Brier per epoch, lower is better. One epoch is too few questions to mean much on its own; the losing ones stay in
            the table.
          </p>
        </>
      )}
    </div>
  );
}
