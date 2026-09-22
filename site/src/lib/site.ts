// Everything the site states about the project goes through here, with its source next to it.
// If a number changes in the contracts or in the spec, it changes in one place only.

const env = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);

export const TICKER = env(process.env.NEXT_PUBLIC_TICKER) ?? "JEVSAIDIT";
export const TOKEN_ADDRESS = env(process.env.NEXT_PUBLIC_TOKEN_ADDRESS);
// Always the www host: the apex has no certificate, so a printed apex URL is a dead link in a browser.
export const SITE_URL = env(process.env.NEXT_PUBLIC_SITE_URL) ?? "https://www.jevsaidit.com";
export const SITE_HOST = new URL(SITE_URL).host;
// Optional, printed only when set: the timelock that owns the router and the distributor after the
// handover. Nothing is guessed: without it the page states the design, not an address.
export const TIMELOCK_ADDRESS = env(process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS);

export const LINKS = {
  x: "https://x.com/jevsaidit",
  xBot: "https://x.com/jevsaidit_bot",
  github: "https://github.com/jevsaidit",
  telegram: env(process.env.NEXT_PUBLIC_TELEGRAM_URL),
  explorer: "https://robinhoodchain.blockscout.com",
} as const;

export const CHAIN = { name: "Robinhood Chain", id: 4663, testnetId: 46630 } as const;

// contracts/src/CallLedger.sol
export const LEDGER = {
  epochHours: 6,
  tokensPerCall: 10_000,
  maxCallsPerEpoch: 50,
} as const;

// docs/2026-09-21-verdict-engine-spec.md §3, §6, §7; contracts/src/RewardsDistributor.sol
export const RULES = {
  horizonHours: 6,
  referenceWindowMinutes: 10, // engine/src/questions/open.ts REFERENCE_WINDOW_SEC = 600
  minResolvedCalls: 3,
  paidTopPercent: 10,
  unresolvableCapPercent: 20,
  claimDelayHours: 12, // CLAIM_DELAY
  claimWindowDays: 90, // CLAIM_WINDOW, then sweepExpired
  maxEpochBudgetPercent: 20, // maxEpochBudgetBps today; the owner can change it
  timelockHours: 24, // the owner of FeeRouter and RewardsDistributor after the handover
} as const;

// contracts/src/FeeRouter.sol: default split of the ETH that enters the router.
// computeBps 500, opsBps 1000, teamBps 2000, burnBps 1500, rewardsBps 5000.
export const FEE_SPLIT = [
  { key: "rewards", bps: 5000, label: "Rewards", note: `buys $${TICKER}, sent to the rewards distributor`, tone: "hood" },
  { key: "burn", bps: 1500, label: "Burn", note: `buys $${TICKER}, sent to 0x…dEaD`, tone: "gold" },
  { key: "team", bps: 2000, label: "Team", note: "paid in ETH, withdrawable only by the published team wallet", tone: "mint" },
  { key: "ops", bps: 1000, label: "Ops", note: "RPC, indexer, hosting", tone: "felt" },
  { key: "compute", bps: 500, label: "Compute", note: "model calls", tone: "coral" },
] as const;
