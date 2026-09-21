import { decodeEventLog, parseAbi, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { blockAtOrBefore } from "../chain/blocktime.js";
import { makeWallet } from "../chain/client.js";
import type { Config, LedgerConfig, RewardsConfig } from "../config.js";
import { balanceAt, type Db, getCursor } from "../db/db.js";
import { indexCalls } from "../indexer/calls.js";
import { transferCursor } from "../indexer/transfers.js";
import { EPOCH_LENGTH, epochEnd } from "../questions/epoch.js";
import { LEDGER_ABI } from "../questions/open.js";
import { buildTree } from "./merkle.js";
import { allocate, parseProb, scoreEpoch, type Call, type ScoredQuestion } from "./score.js";

export const DISTRIBUTOR_ABI = parseAbi([
  "function freeBalance() view returns (uint256)",
  "function maxEpochBudgetBps() view returns (uint16)",
  "function lastEpoch() view returns (uint256)",
  "function lastRootSetAt() view returns (uint256)",
  "function hasPublished() view returns (bool)",
  "function roots(uint256) view returns (bytes32)",
  "function scorer() view returns (address)",
  "function setEpochRoot(uint256 epoch, bytes32 root, uint256 budget)",
  "event EpochRootSet(uint256 indexed epoch, bytes32 root, uint256 budget)",
]);

export type EpochOutcome =
  | { state: "WAIT"; reason: string }
  | { state: "NOT_PAYABLE"; reason: string }
  | { state: "PAYABLE"; root: Hex; budget: bigint; winners: number }
  | { state: "PUBLISHED"; root: Hex; budget: bigint; tx: Hex }
  | { state: "FAILED"; reason: string };

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export interface EpochDeps {
  db: Db;
  token: PublicClient; // the chain of the token and its Transfers (in production = the data chain)
  ledger: PublicClient; // the chain of CallLedger and RewardsDistributor
  cfg: Config;
  lcfg: LedgerConfig;
  rcfg: RewardsConfig;
}

async function store(db: Db, epoch: number, state: string, reason: string | null, root: string | null, budget: bigint | null, payload: unknown) {
  await db.query(
    `INSERT INTO epochs (epoch, state, reason, root, budget, payload) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (epoch) DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason, root = EXCLUDED.root,
       budget = EXCLUDED.budget, payload = EXCLUDED.payload WHERE epochs.state <> 'PUBLISHED'`,
    [epoch, state, reason, root, budget?.toString() ?? null, json(payload)],
  );
}

export async function closeEpoch(d: EpochDeps, epoch: number, publish: boolean): Promise<EpochOutcome> {
  const { db, token, ledger, cfg, lcfg, rcfg } = d;
  const readDist = <T>(functionName: string, args: unknown[] = []) =>
    ledger.readContract({ address: rcfg.rewardsDistributor, abi: DISTRIBUTOR_ABI, functionName: functionName as never, args: args as never }) as Promise<T>;

  const already = await db.query<{ state: string }>("SELECT state FROM epochs WHERE epoch = $1", [epoch]);
  if (already.rows[0]?.state === "PUBLISHED") return { state: "WAIT", reason: `epoch ${epoch} already published` };

  const genesis = Number(await ledger.readContract({ address: lcfg.callLedger, abi: LEDGER_ABI, functionName: "genesis" }));
  const now = Number((await ledger.getBlock({ blockTag: "latest" })).timestamp);
  if (now < epochEnd(epoch, genesis)) return { state: "WAIT", reason: `epoch ${epoch} ends at ${epochEnd(epoch, genesis)}, now ${now}` };

  const qrows = await db.query<{ id: string; json: string; outcome: string | null }>(
    "SELECT id, json, outcome FROM questions WHERE epoch = $1 AND status = 'OPEN' ORDER BY id",
    [epoch],
  );
  const pending = qrows.rows.filter((r) => r.outcome === null).length;
  if (pending) return { state: "WAIT", reason: `${pending} questions of epoch ${epoch} not yet resolved` };
  if (qrows.rows.length === 0) {
    await store(db, epoch, "NOT_PAYABLE", "no question opened in the epoch", null, null, { epoch });
    return { state: "NOT_PAYABLE", reason: "no question opened in the epoch" };
  }
  const questions: ScoredQuestion[] = qrows.rows.map((r) => {
    const j = JSON.parse(r.json) as { p: string; baseline: string };
    return { id: r.id, p: parseProb(j.p), baseline: parseProb(j.baseline), outcome: r.outcome as ScoredQuestion["outcome"] };
  });

  // Calls: up to the head of the ledger chain (the last ones arrive before the deadline).
  const lhead = (await ledger.getBlockNumber({ cacheTime: 0 })) - cfg.confirmations;
  await indexCalls(ledger, db, lcfg.callLedger, rcfg.ledgerStartBlock, lhead, cfg.logChunk);
  const crows = await db.query<{ caller: string; question_id: string; agree: boolean; block: string; log_index: number }>(
    "SELECT caller, question_id, agree, block, log_index FROM calls WHERE epoch = $1",
    [epoch],
  );
  const calls: Call[] = crows.rows.map((r) => ({ caller: r.caller, questionId: r.question_id, agree: r.agree, block: BigInt(r.block), logIndex: r.log_index }));

  // Balance at epoch start = balance at the end of the last block with timestamp <= epoch start.
  const startBlock = await blockAtOrBefore(token, genesis + epoch * EPOCH_LENGTH);
  if (startBlock === null) return { state: "FAILED", reason: "no block before the start of the epoch" };
  const tcur = await getCursor(db, transferCursor(cfg.token));
  if (tcur === null || tcur < startBlock) return { state: "WAIT", reason: `Transfer index at ${tcur}, needs ${startBlock}` };
  const balances = new Map<string, bigint>();
  for (const c of new Set(calls.map((x) => x.caller))) balances.set(c, await balanceAt(db, cfg.token, c, startBlock));

  const excluded = new Set(rcfg.excluded);
  const scored = scoreEpoch({ questions, calls, balanceAtStart: balances, excluded, reference: rcfg.reference, topFraction: rcfg.topFraction });
  const base = { epoch, reference: rcfg.reference, startBlock, questions: questions.map((q) => ({ id: q.id, outcome: q.outcome })), wallets: scored.wallets };
  if (scored.state === "NOT_PAYABLE") {
    await store(db, epoch, "NOT_PAYABLE", scored.reason, null, null, base);
    return { state: "NOT_PAYABLE", reason: scored.reason };
  }

  const free = await readDist<bigint>("freeBalance");
  const bps = BigInt(await readDist<number>("maxEpochBudgetBps"));
  const cap = (free * bps) / 10_000n;
  const budget = rcfg.epochBudget !== null && rcfg.epochBudget < cap ? rcfg.epochBudget : cap;
  if (budget === 0n) {
    // Before the first processSwap the distributor is empty: scores stay public, rewards do not.
    await store(db, epoch, "NOT_PAYABLE", "distributor has no free balance", null, null, base);
    return { state: "NOT_PAYABLE", reason: "distributor has no free balance" };
  }
  const amounts = allocate(scored.winners, budget);
  const leak = amounts.find((a) => excluded.has(a.address.toLowerCase()));
  if (leak) return { state: "FAILED", reason: `excluded address among the beneficiaries: ${leak.address}. The root is not published` };
  const total = amounts.reduce((s, a) => s + a.amount, 0n);
  const { root, claims } = buildTree(amounts);
  // Budget = exact sum of the rewards: the rounding remainder does not stay committed for nothing.
  await store(db, epoch, "PAYABLE", null, root, total, { ...base, root, budget: total, claims });
  if (!publish) return { state: "PAYABLE", root, budget: total, winners: amounts.length };

  const scorer = privateKeyToAccount(rcfg.scorerPk);
  if ((await readDist<string>("scorer")).toLowerCase() !== scorer.address.toLowerCase()) {
    return { state: "FAILED", reason: `key ${scorer.address} is not the distributor's scorer` };
  }
  if (await readDist<boolean>("hasPublished")) {
    const last = Number(await readDist<bigint>("lastEpoch"));
    const lastAt = Number(await readDist<bigint>("lastRootSetAt"));
    if (epoch <= last) return { state: "FAILED", reason: `the contract already has epoch ${last}: epochs must increase` };
    if (now < lastAt + EPOCH_LENGTH) return { state: "WAIT", reason: `last root at ${lastAt}: the next one not before ${lastAt + EPOCH_LENGTH}` };
  }
  const wallet = makeWallet(lcfg.ledgerRpcUrl, await ledger.getChainId(), rcfg.scorerPk);
  let tx: Hex;
  try {
    tx = await wallet.writeContract({
      account: scorer,
      chain: wallet.chain,
      address: rcfg.rewardsDistributor,
      abi: DISTRIBUTOR_ABI,
      functionName: "setEpochRoot",
      args: [BigInt(epoch), root, total],
    });
  } catch (e) {
    return { state: "FAILED", reason: `setEpochRoot failed: ${(e as Error).message.split("\n")[0]}` };
  }
  const receipt = await ledger.waitForTransactionReceipt({ hash: tx });
  const ev = receipt.logs
    .filter((l) => l.address.toLowerCase() === rcfg.rewardsDistributor.toLowerCase())
    .map((l) => decodeEventLog({ abi: DISTRIBUTOR_ABI, data: l.data, topics: l.topics, strict: true }))
    .find((e) => e.eventName === "EpochRootSet");
  if (
    receipt.status !== "success" ||
    !ev ||
    ev.eventName !== "EpochRootSet" ||
    Number(ev.args.epoch) !== epoch ||
    ev.args.root !== root ||
    ev.args.budget !== total
  ) {
    return { state: "FAILED", reason: `tx ${tx}: EpochRootSet missing or different from what was sent` };
  }
  await db.query("UPDATE epochs SET state = 'PUBLISHED', tx_hash = $2 WHERE epoch = $1", [epoch, tx]);
  return { state: "PUBLISHED", root, budget: total, tx };
}
