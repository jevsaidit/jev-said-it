import type { Address, Hex } from "viem";
import { xCredsFromEnv, type XCreds } from "./announcer/x.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} is not an integer >= 0: ${v}`);
  return n;
}

// Robinhood Chain 4663 addresses, from contracts/docs/addresses.md.
export const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
export const PONS_HOOK: Address = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
export const PONS_POOL_FEE = 0;
export const PONS_TICK_SPACING = 200;

export interface Config {
  databaseUrl: string;
  rpcUrl: string;
  /** the chain of the token and its Transfers. In production it is the same as RPC_URL; in testnet
   *  trials the test token lives on 46630 while the Pons pools stay on mainnet */
  tokenRpcUrl: string;
  /** the token whose balances are rebuilt: $JEV in production */
  token: Address;
  /** block the Transfer indexer starts from (runbook §4.4, LAUNCH_BLOCK) */
  launchBlock: bigint;
  /** where the PoolManager index (Pons pools + swaps) starts: covering the candidate window is enough */
  v4StartBlock: bigint;
  /** blocks behind the head before a log is considered final */
  confirmations: bigint;
  /** maximum width of an eth_getLogs request, before any bisection */
  logChunk: bigint;
  /** maximum blocks per cycle and per indexer: a long catch-up becomes many short cycles */
  maxBlocksPerCycle: bigint;
  /** same for the PoolManager: ~2.6 swaps/block against a 10,000-log cap = ~3,800 blocks */
  v4LogChunk: bigint;
}

export function loadConfig(): Config {
  return {
    databaseUrl: need("DATABASE_URL"),
    rpcUrl: need("RPC_URL"),
    tokenRpcUrl: process.env.TOKEN_RPC_URL || need("RPC_URL"),
    token: need("TOKEN") as Address,
    launchBlock: BigInt(need("LAUNCH_BLOCK")),
    v4StartBlock: BigInt(process.env.V4_START_BLOCK || need("LAUNCH_BLOCK")),
    confirmations: BigInt(num("CONFIRMATIONS", 20)),
    logChunk: BigInt(num("LOG_CHUNK", 20_000)),
    v4LogChunk: BigInt(num("V4_LOG_CHUNK", 3_000)),
    maxBlocksPerCycle: BigInt(num("MAX_BLOCKS_PER_CYCLE", 30_000)),
  };
}

export type { Address, Hex };

export interface LedgerConfig {
  /** the chain the CallLedger lives on: mainnet in production, testnet or anvil in trials */
  ledgerRpcUrl: string;
  callLedger: Address;
  keeperPk: Hex;
  /** how long a batch's calls stay open, in seconds */
  callWindowSec: number;
  /** below this window nothing is opened: better to wait for the next epoch */
  minCallWindowSec: number;
  /** minimum gap between the deadline and the end of the epoch (a tx can be included late) */
  epochMarginSec: number;
  horizonSec: number;
  questionsPerBatch: number;
  minSwapsLastHour: number;
  minSwapsLast6h: number;
}

export function loadLedgerConfig(): LedgerConfig {
  return {
    ledgerRpcUrl: process.env.LEDGER_RPC_URL || need("RPC_URL"),
    callLedger: need("CALL_LEDGER") as Address,
    keeperPk: need("KEEPER_PK") as Hex,
    callWindowSec: num("CALL_WINDOW_SEC", 2 * 3600),
    minCallWindowSec: num("MIN_CALL_WINDOW_SEC", 30 * 60),
    epochMarginSec: num("EPOCH_MARGIN_SEC", 5 * 60),
    horizonSec: num("HORIZON_SEC", 6 * 3600),
    questionsPerBatch: num("QUESTIONS_PER_BATCH", 10),
    minSwapsLastHour: num("MIN_SWAPS_LAST_HOUR", 10),
    minSwapsLast6h: num("MIN_SWAPS_LAST_6H", 60),
  };
}

export interface RewardsConfig {
  rewardsDistributor: Address;
  scorerPk: Hex;
  /** CallLedger deploy block: the call index starts there */
  ledgerStartBlock: bigint;
  /** team, contracts, pools: never among the beneficiaries (spec §7.2, runbook §5.4) */
  excluded: string[];
  reference: "baseline" | "model";
  topFraction: number;
  /** absolute cap per epoch in wei; empty = the maximum the contract allows */
  epochBudget: bigint | null;
}

export function loadRewardsConfig(): RewardsConfig {
  const ref = process.env.SCORE_REFERENCE || "baseline";
  if (ref !== "baseline" && ref !== "model") throw new Error(`invalid SCORE_REFERENCE: ${ref}`);
  const top = Number(process.env.TOP_FRACTION || "0.1");
  if (!(top > 0 && top <= 1)) throw new Error(`TOP_FRACTION outside (0,1]: ${top}`);
  return {
    rewardsDistributor: need("REWARDS_DISTRIBUTOR") as Address,
    scorerPk: need("SCORER_PK") as Hex,
    // Required: a default of 0 made the first closeEpoch scan the ledger from genesis in thousands of
    // getLogs on the shared RPC, starving the indexer. It is the block of the DeployCore transaction.
    ledgerStartBlock: BigInt(need("LEDGER_START_BLOCK")),
    excluded: need("EXCLUDE").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean),
    reference: ref,
    topFraction: top,
    epochBudget: process.env.EPOCH_BUDGET ? BigInt(process.env.EPOCH_BUDGET) : null,
  };
}

export interface TreasuryEnv {
  adapter: Address;
  router: Address;
  minClaimWei: bigint;
  minSwapWei: bigint;
  slippageBps: bigint;
}

/** Null when FEE_ROUTER is unset: the engine then leaves the fees alone. */
export function loadTreasuryEnv(): TreasuryEnv | null {
  if (!process.env.FEE_ROUTER) return null;
  const slippage = BigInt(num("SWAP_SLIPPAGE_BPS", 300));
  if (slippage >= 10_000n) throw new Error(`SWAP_SLIPPAGE_BPS out of range: ${slippage}`);
  return {
    adapter: need("PONS_ESCROW_ADAPTER") as Address,
    router: need("FEE_ROUTER") as Address,
    // Gas on Robinhood Chain is ~0.01 gwei: collecting 0.0005 ETH costs a tiny fraction of it.
    minClaimWei: BigInt(process.env.MIN_CLAIM_WEI || "500000000000000"),
    // Below this the buyback waits for the next epoch: a dust swap is all slippage and gas.
    minSwapWei: BigInt(process.env.MIN_SWAP_WEI || "5000000000000000"),
    slippageBps: slippage,
  };
}

export interface AnnounceEnv {
  mode: "test" | "live";
  tgToken: string;
  tgChannel?: string;
  tgTestChat?: string;
  /** OAuth 1.0a user context of @jevsaidit (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET).
   *  Null = X is not a channel: its posts are recorded as `unconfigured`, never sent later. */
  x: XCreds | null;
  site: string;
  xDailyCap: number;
  /** B4 dev posts: draft (default) = to the private chat, to be posted by hand · x = on X, weakest kind · off.
   *  excluded = EXCLUDE (the team): without it no milestone is counted, since "outside the team" would be false. */
  dev: { mode: "off" | "draft" | "x"; excluded: string[] | null };
}

function devMode(): "off" | "draft" | "x" {
  const m = process.env.DEV_POSTS || "draft";
  if (m !== "off" && m !== "draft" && m !== "x") throw new Error(`DEV_POSTS must be off, draft or x: ${m}`);
  return m;
}

/** Null when ANNOUNCE_MODE is off (the default): the engine stays silent. */
export function loadAnnounceEnv(): AnnounceEnv | null {
  const mode = process.env.ANNOUNCE_MODE || "off";
  if (!["off", "test", "live"].includes(mode)) throw new Error(`ANNOUNCE_MODE must be off, test or live: ${mode}`);
  if (mode === "off") return null;
  return {
    mode: mode as "test" | "live",
    tgToken: need("TELEGRAM_BOT_TOKEN"),
    tgChannel: process.env.TELEGRAM_CHANNEL_ID || undefined,
    tgTestChat: process.env.TELEGRAM_TEST_CHAT_ID || undefined,
    x: xCredsFromEnv(process.env),
    site: process.env.PUBLIC_SITE_URL || "https://www.jevsaidit.com",
    xDailyCap: num("X_DAILY_CAP", 6),
    dev: { mode: devMode(), excluded: process.env.EXCLUDE ? process.env.EXCLUDE.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean) : null },
  };
}
