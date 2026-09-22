"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { canonicalJson, questionId, SAMPLE } from "@/lib/verdict";

const COMMITTED = questionId(canonicalJson(SAMPLE));

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function utc(ts: string) {
  const d = new Date(Number(ts) * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function Receipt() {
  const [p, setP] = useState(SAMPLE.p);
  // "static" until JS runs: without JS the receipt is still visible.
  const [print, setPrint] = useState<"static" | "waiting" | "printed">("static");
  const ref = useRef<HTMLDivElement>(null);

  const json = useMemo(() => canonicalJson({ ...SAMPLE, p }), [p]);
  const now = useMemo(() => questionId(json), [json]);
  const match = now === COMMITTED;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    setPrint("waiting");
    const done = () => {
      setPrint("printed");
      io.disconnect();
      clearTimeout(fallback);
    };
    const io = new IntersectionObserver(([e]) => e.isIntersecting && done(), { threshold: 0.25 });
    io.observe(el);
    // The receipt is the page's one light object: if the observer never fires (a full-page capture,
    // print, a browser that skips it), it prints anyway rather than staying a blank.
    const fallback = setTimeout(done, 2500);
    return () => {
      io.disconnect();
      clearTimeout(fallback);
    };
  }, []);

  return (
    <div className="receipt__col">
      <div className="receipt__wrap" ref={ref} data-print={print}>
        <article className="receipt" aria-labelledby="receipt-title">
          <header className="receipt__head">
            <span className="receipt__brand" id="receipt-title">
              JEV SAID IT
            </span>
            <span>verdict receipt · epoch {SAMPLE.epoch}</span>
            <br />
            <span className="receipt__sample">SAMPLE · NOT A LIVE QUESTION</span>
          </header>

          <dl>
            <dt>question</dt>
            <dd>price up after 6h?</dd>
            <dt>token</dt>
            <dd>{short(SAMPLE.token)}</dd>
            <dt>calls close</dt>
            <dd>{utc(SAMPLE.deadline)}</dd>
            <dt>settles</dt>
            <dd>{utc(String(Number(SAMPLE.deadline) + Number(SAMPLE.horizon)))}</dd>
            <dt>model</dt>
            <dd>{SAMPLE.model}</dd>
            <dt>
              <label htmlFor="p-input">p (up)</label>
            </dt>
            <dd className="receipt__p">
              <input
                id="p-input"
                inputMode="decimal"
                value={p}
                onChange={(e) => setP(e.target.value)}
                aria-describedby="p-help"
                spellCheck={false}
              />
            </dd>
            <dt>baseline</dt>
            <dd>
              {SAMPLE.baseline} <span aria-hidden>·</span> unmeasured
            </dd>
          </dl>

          <hr className="receipt__rule" />

          <span className="receipt__label">id stored by the CallLedger before calls opened</span>
          <code className="hash">{COMMITTED}</code>

          <span className="receipt__label">keccak256 of this receipt, right now</span>
          {/* Not live-announced: 66 hex characters per keystroke is noise. The stamp below says what matters. */}
          <code className="hash">
            {now.split("").map((c, i) =>
              c === COMMITTED[i] ? (
                c
              ) : (
                <span key={i} className="diff">
                  {c}
                </span>
              ),
            )}
          </code>

          <details>
            <summary>show the exact bytes being hashed</summary>
            <pre>{json}</pre>
          </details>

          <span className={`stamp ${match ? "stamp--ok" : "stamp--bad"}`} role="status">
            {match ? "MATCH" : "EDITED"}
            <span className="sr-only">{match ? ": the hash matches the one on the ledger" : ": the hash changed"}</span>
          </span>
        </article>
      </div>
      {/* Outside the rotated wrap: the hint is the page talking, not the paper. */}
      <p className="receipt__hint" id="p-help">
        {match
          ? "Change Jev's probability. Try 0.9000."
          : `One edit, a different hash. The ledger still holds ${COMMITTED.slice(0, 10)}…`}
      </p>
    </div>
  );
}
