import type { CSSProperties } from "react";
import { LiveFeed } from "@/components/LiveFeed";
import { Play } from "@/components/Play";
import { Receipt } from "@/components/Receipt";
import { CHAIN, FEE_SPLIT, LEDGER, LINKS, RULES, SITE_URL, TICKER, TOKEN_ADDRESS } from "@/lib/site";

const T = `$${TICKER}`;

const EPOCH = [
  {
    t: "epoch e",
    h: "Open",
    p: "The engine picks Pons tokens that graduated in the last 48h and still trade. The model states a probability for each, and every question's hash goes on-chain.",
  },
  {
    t: "until calls close",
    h: "Call",
    p: `Agree or disagree. One call per ${LEDGER.tokensPerCall.toLocaleString("en-US")} ${T} held at the start of the epoch, up to ${LEDGER.maxCallsPerEpoch}. Nothing is staked.`,
  },
  {
    t: `close + ${RULES.horizonHours}h`,
    h: "Settle",
    p: "Last swap price before the close against the last swap price six hours later. Strictly higher counts as up.",
  },
  {
    t: "end of epoch e+1",
    h: "Score",
    p: `Brier skill against the committed baseline. The top ${RULES.paidTopPercent}% with a positive score and at least ${RULES.minResolvedCalls} resolved calls get paid.`,
  },
  {
    t: "same block",
    h: "Root",
    p: `A Merkle root of the payouts goes to the rewards distributor. One epoch can spend at most ${RULES.maxEpochBudgetPercent}% of its free balance.`,
  },
  {
    t: `root + ${RULES.claimDelayHours}h`,
    h: "Claim",
    p: `A guardian can veto a bad root for ${RULES.claimDelayHours} hours. After that, winners claim their ${T}.`,
  },
];

const WALLETS = [
  { w: "U1", did: "Right on every call", got: "Paid 64/72 of the budget", paid: true },
  { w: "U2", did: "Capacity 3: two right, one wrong", got: "Paid 8/72. A fourth call reverted on-chain", paid: true },
  { w: "U3", did: "Always agreed with a model that was wrong half the time", got: "Skill −0.16, nothing", paid: false },
  { w: "U4", did: "Bought after the epoch started, made 5 calls", got: "0 valid calls", paid: false },
  { w: "U5", did: "Team wallet, perfect answers", got: "Not in the scores at all", paid: false },
];

const WONT = [
  "Pay for raw volume or airdrop by transaction count",
  "Tax transfers. Fees only happen at the swap",
  "Announce surprise buybacks on X. Buybacks run from the router, on-chain",
  `Hold ${T}. The team is paid ${FEE_SPLIT.find((f) => f.key === "team")!.bps / 100}% of fees in ETH, so its pay stops when volume does`,
  "Publish another model's answer as “Jev said it”. Every verdict names the model that gave it",
  "Turn “couldn't look” into an outcome",
];

// Pump candles for the hero background: [x, open, close, high, low] on a 300x60 grid, rising to the right.
const CANDLES: Array<[number, number, number, number, number]> = [
  [120, 50, 47, 45, 52], [126, 47, 49, 44, 51], [132, 49, 44, 42, 50], [138, 44, 45, 41, 47], [144, 45, 40, 38, 46],
  [150, 40, 41, 37, 43], [156, 41, 36, 33, 42], [162, 36, 38, 34, 40], [168, 38, 31, 29, 39], [174, 31, 33, 29, 35],
  [180, 33, 27, 24, 34], [186, 27, 28, 25, 31], [192, 28, 22, 19, 29], [198, 22, 24, 20, 26], [204, 24, 17, 14, 25],
  [210, 17, 19, 15, 21], [216, 19, 12, 9, 20], [222, 12, 14, 10, 16], [228, 14, 8, 5, 15],
];
// Coins around the mascot, in mascot pixels from its top-left corner.
const COINS: Array<[number, number]> = [[-9, 4], [-4, 11], [43, 2], [47, 12], [-7, 27], [45, 30]];

export default function Home() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>

      <header className="nav">
        <div className="wrap nav__row">
          <a className="brand" href="#top" aria-label="Jev Said It, top of page">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="brand__pfp" src="/pfp-laser.png" alt="" width={40} height={40} />
            <span>jev said it</span>
          </a>
          <nav aria-label="Sections">
            <ul className="nav__links">
              <li>
                <a href="#receipts">Receipts</a>
              </li>
              <li>
                <a href="#epoch">How an epoch runs</a>
              </li>
              <li>
                <a href="#scoring">Scoring</a>
              </li>
              <li>
                <a href="#fees">Fees</a>
              </li>
              <li>
                <a href="#feed">Live feed</a>
              </li>
              <li>
                <a href="#play">Play</a>
              </li>
            </ul>
          </nav>
          <a className="btn" href={LINKS.x} rel="noopener" target="_blank">
            Follow on X
          </a>
        </div>
      </header>

      <main id="main">
        <section className="hero" id="top">
          <div className="hero__rays" aria-hidden />
          <svg className="hero__candles" viewBox="0 0 300 60" shapeRendering="crispEdges" aria-hidden>
            {CANDLES.map(([x, o, c, hi, lo], i) => (
              <g key={i} className={c < o ? "up" : "down"}>
                <rect x={x + 1} y={hi} width="1" height={lo - hi} />
                <rect x={x} y={Math.min(o, c)} width="3" height={Math.max(1, Math.abs(o - c))} />
              </g>
            ))}
          </svg>
          <div className="wrap hero__grid">
            <div className="hero__copy">
              <p className="hero__where">
                <span className="plate">{T}</span> on {CHAIN.name}. New questions every {LEDGER.epochHours} hours.
              </p>
              <h1 className="hero__title">
                Jev
                <span className="said">said</span>
                <span className="it">it.</span>
              </h1>
              <p className="lede">
                A model commits to a probability on-chain before anyone answers. You agree or disagree.
                When the price settles, the best-calibrated calls get paid in {T} from trading fees.
              </p>

              <div className="hero__actions">
                <a className="btn" href="#receipts">
                  Check a receipt
                </a>
                <a className="btn btn--ghost" href={LINKS.github} rel="noopener" target="_blank">
                  Read the code
                </a>
              </div>

              {TOKEN_ADDRESS ? (
                <div className="status">
                  <span className="dot dot--live" aria-hidden />
                  <span>
                    <strong>Contract</strong>{" "}
                    <a className="addr" href={`${LINKS.explorer}/token/${TOKEN_ADDRESS}`} rel="noopener" target="_blank">
                      {TOKEN_ADDRESS}
                    </a>
                    <br />
                    This address and the one on @jevsaidit are the only ones.
                  </span>
                </div>
              ) : (
                <div className="status">
                  <span className="dot" aria-hidden />
                  <span>
                    <strong>Not launched.</strong> The contract address goes up here and on @jevsaidit
                    before launch. An address you see anywhere else first isn&apos;t ours.
                  </span>
                </div>
              )}
            </div>

            <div className="hero__mascot">
              <p className="bubble">So I aped.</p>
              {/* 40x40 native sprite, scaled by whole numbers in CSS: every pixel stays one size */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="sprite"
                src="/mascot-laser.png"
                width={40}
                height={40}
                alt={`The ${T} mascot: a pixel-art character with laser eyes, a backwards cap, a huge grin and a gold chain with a dollar coin`}
              />
              {COINS.map(([x, y], i) => (
                <span key={i} className="coin" style={{ "--cx": x, "--cy": y } as CSSProperties} aria-hidden />
              ))}
            </div>
          </div>
        </section>

        <section className="section section--felt" id="receipts" aria-labelledby="receipts-h">
          <div className="wrap split">
            <div className="prose">
              <p className="eyebrow">Receipts, not promises</p>
              <h2 className="h2" id="receipts-h">
                The verdict is on-chain before your call is.
              </h2>
              <p>
                Every question is written as a small JSON receipt: the token, the deadline, the model,
                and the model&apos;s probability. Its keccak256 hash is the question&apos;s id, and the
                CallLedger stores that id before anyone can answer.
              </p>
              <p>
                So the engine can&apos;t move the number after seeing the result. Edit the probability on
                the receipt and watch the hash stop matching.
              </p>
              <p className="muted">Check any live question yourself, no trust in us needed:</p>
              <code className="cmd" tabIndex={0} aria-label="Command to verify a question's commitment">{`curl -s \\
  ${SITE_URL}/api/feed/q/<id>.json \\
  | tr -d '\\n' | cast keccak`}</code>
            </div>
            <Receipt />
          </div>
        </section>

        <section className="section" id="epoch" aria-labelledby="epoch-h">
          <div className="wrap">
            <p className="eyebrow">Question · call · settle · score · pay</p>
            <h2 className="h2" id="epoch-h">
              One epoch, start to claim.
            </h2>
            <p className="lede muted">
              Questions ask about the price of tokens that already graduated, measured when calls close.
              Nobody can answer after seeing the outcome.
            </p>
            <ol className="timeline">
              {EPOCH.map((s) => (
                <li key={s.h}>
                  <span className="t">{s.t}</span>
                  <h3>{s.h}</h3>
                  <p>{s.p}</p>
                </li>
              ))}
            </ol>

            <div className="outcomes" role="list" aria-label="Question outcomes">
              <div role="listitem">
                <span className="tag tone-hood">RESOLVED 0 / 1</span>
                <p>
                  <strong>Both prices were read.</strong> The question counts toward scores.
                </p>
              </div>
              <div role="listitem">
                <span className="tag tone-gold">VOID</span>
                <p>
                  <strong>No swap in the window.</strong> Out of the scores, and listed as void in the
                  feed.
                </p>
              </div>
              <div role="listitem">
                <span className="tag tone-coral">UNRESOLVABLE</span>
                <p>
                  <strong>The engine couldn&apos;t read the chain.</strong> Out of the scores. Past{" "}
                  {RULES.unresolvableCapPercent}% of an epoch&apos;s questions, that epoch pays nobody.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="section section--felt" id="scoring" aria-labelledby="scoring-h">
          <div className="wrap split">
            <div className="prose">
              <p className="eyebrow">Scoring</p>
              <h2 className="h2" id="scoring-h">
                Calibration pays. Volume of calls doesn&apos;t.
              </h2>
              <p>
                Each call becomes a forecast: agreeing takes the model&apos;s probability, disagreeing
                takes the opposite. It&apos;s scored against the baseline written into the receipt.
              </p>
              <div className="formula" aria-label="Scoring formula">{`f     = agree ? p : 1 − p
brier = (f − y)²
skill = (b − y)² − brier`}</div>
              <p className="muted">
                y is the outcome, b the baseline. Probabilities are 4-decimal strings, so every score is
                exact integer math anyone can redo from the published receipts and events.
              </p>
            </div>
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Test wallets and what each was paid">
              <table className="wallets">
                <caption>Five test wallets, one rule each. A full epoch on a local chain, 21 Sep 2026.</caption>
                <thead>
                  <tr>
                    <th scope="col">Wallet</th>
                    <th scope="col">What it did</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {WALLETS.map((r) => (
                    <tr key={r.w}>
                      <td>{r.w}</td>
                      <td>{r.did}</td>
                      <td className={r.paid ? "paid" : "unpaid"}>{r.got}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="section" id="fees" aria-labelledby="fees-h">
          <div className="wrap split">
            <div className="prose">
              <p className="eyebrow">Where the fees go</p>
              <h2 className="h2" id="fees-h">
                Every split is a line of Solidity.
              </h2>
              <p>
                Creator fees from Pons arrive at the FeeRouter in ETH. Anyone can call{" "}
                <code>distribute()</code>. The keeper then buys {T} with the swap share, burns part of
                it and sends the rest to the rewards distributor.
              </p>
              <p>
                Winners are paid in {T}, never in ETH. Once per epoch, at a time derived from a secret
                so it is hard to front-run, {(FEE_SPLIT.find((f) => f.key === "rewards")!.bps + FEE_SPLIT.find((f) => f.key === "burn")!.bps) / 100}% of the fees
                buy {T} on the open market. No wallet sits in between: the router buys and the
                distributor holds.
              </p>
              <p>
                Your calls are counted from the {T} you hold, so a prize is also next epoch&apos;s
                capacity. Sell it and you play less.
              </p>
              <p className="muted">
                The buy is only as big as the volume. Quiet weeks mean small buys and small prizes.
                Nothing here promises a price.
              </p>
              <p className="muted">
                No transfer tax. Splits change only through a 24-hour timelock, and each change is an
                on-chain event.
              </p>
            </div>
            <div>
              <div
                className="bar"
                role="img"
                aria-label={FEE_SPLIT.map((f) => `${f.label} ${f.bps / 100}%`).join(", ")}
              >
                {FEE_SPLIT.map((f) => (
                  <span key={f.key} className={`tone-${f.tone}`} style={{ flexGrow: f.bps }} />
                ))}
              </div>
              <ul className="legend">
                {FEE_SPLIT.map((f) => (
                  <li key={f.key}>
                    <span className={`sw tone-${f.tone}`} aria-hidden />
                    <span className="pct">{f.bps / 100}%</span>
                    <span className="name">{f.label}</span>
                    <span className="note">{f.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="section section--felt" id="feed" aria-labelledby="feed-h">
          <div className="wrap">
            <p className="eyebrow">This epoch</p>
            <h2 className="h2" id="feed-h">
              Live questions.
            </h2>
            <p className="lede muted">
              Straight from the engine&apos;s public feed. The model&apos;s accuracy against the baseline
              is published every epoch, including the epochs it loses.
            </p>
            <LiveFeed ticker={TICKER} />
          </div>
        </section>

        <section className="section" id="play" aria-labelledby="play-h">
          <div className="wrap split">
            <div className="prose">
              <p className="eyebrow">Play</p>
              <h2 className="h2" id="play-h">
                Agree or disagree with Jev.
              </h2>
              <p>
                Connect a browser wallet on {CHAIN.name}. Every {LEDGER.tokensPerCall.toLocaleString("en-US")} {T} you
                held when the epoch started is one call, up to {LEDGER.maxCallsPerEpoch}. All your calls go out in one
                transaction: you pay gas, you stake nothing.
              </p>
              <p className="muted">
                The contract refuses a call beyond your balance, and the engine drops any call beyond what you held at
                the epoch&apos;s start. Buying, calling and selling in the same epoch does not count.
              </p>
            </div>
            <Play ticker={TICKER} />
          </div>
        </section>

        <section className="section" aria-labelledby="wont-h">
          <div className="wrap">
            <p className="eyebrow">Commitments</p>
            <h2 className="h2" id="wont-h">
              Things this project won&apos;t do.
            </h2>
            <ul className="nots">
              {WONT.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap footer__row">
          <div>
            <p>
              Not affiliated with TypeSafe AI. &ldquo;Jev&rdquo; is TypeSafe&apos;s model; this project
              uses it as a component.
            </p>
            <p>
              Calls don&apos;t stake tokens and users never bet against each other. Nothing here is
              investment advice.
            </p>
          </div>
          <ul>
            <li>
              <a href={LINKS.x} rel="noopener" target="_blank">
                X @jevsaidit
              </a>
            </li>
            <li>
              <a href={LINKS.xBot} rel="noopener" target="_blank">
                Bot @jevsaidit_bot
              </a>
            </li>
            {LINKS.telegram && (
              <li>
                <a href={LINKS.telegram} rel="noopener" target="_blank">
                  Telegram
                </a>
              </li>
            )}
            <li>
              <a href={LINKS.github} rel="noopener" target="_blank">
                GitHub
              </a>
            </li>
          </ul>
        </div>
      </footer>
    </>
  );
}
