import { CHAIN, LEDGER, SITE_URL, TICKER, TOKEN_ADDRESS } from "@/lib/site";

// The step the page was missing: where to buy. Built from the token address, so there is no second
// place to keep in sync, and shown only once the token exists.
export function StartHere() {
  if (!TOKEN_ADDRESS) return null;
  const T = `$${TICKER}`;
  const pons = `https://www.ponsfamily.com/launchpad/${TOKEN_ADDRESS}`;
  return (
    <section className="start" aria-labelledby="start-h">
      <h2 className="h3" id="start-h">
        Start in 60 seconds
      </h2>
      <ol className="start__steps">
        <li>
          <span className="start__n">1</span>
          <span>
            <a className="btn" href={pons} rel="noopener" target="_blank">
              Buy {T} on Pons
            </a>
            <span className="start__note">on {CHAIN.name}, with ETH</span>
          </span>
        </li>
        <li>
          <span className="start__n">2</span>
          <span>
            Hold {LEDGER.minHold.toLocaleString("en-US")} {T} when an epoch starts
            <span className="start__note">
              that is {LEDGER.minHold / LEDGER.tokensPerCall} calls: one per {LEDGER.tokensPerCall.toLocaleString("en-US")}, up to{" "}
              {LEDGER.maxCallsPerEpoch}
            </span>
          </span>
        </li>
        <li>
          <span className="start__n">3</span>
          <span>
            <a className="btn btn--ghost" href={`${SITE_URL}/#play`}>
              Connect and call
            </a>
            <span className="start__note">agree or disagree with Jev. Nothing is staked</span>
          </span>
        </li>
      </ol>
    </section>
  );
}
