import { zeroHash, decodeEventLog, parseAbi, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { blockAtOrBefore } from "../chain/blocktime.js";
import { lookupTx } from "../chain/tx.js";
import { makeWallet } from "../chain/client.js";
import { NotSentError, sendTx } from "../chain/send.js";
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
  "function epochVoided(uint256) view returns (bool)",
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

/** A root computed earlier for the same epoch, kept when a later pass recomputes it. */
type Previous = { root: string; budget: string; claims: unknown; tx_hash: string | null };

async function store(db: Db, epoch: number, state: string, reason: string | null, root: string | null, budget: bigint | null, payload: unknown) {
  // A recompute (after a root transaction went unknown for 10 minutes) may produce a different root
  // as soon as freeBalance moved. The old root's claims are kept inside the payload: if the old
  // transaction lands after all, the proofs served must be the ones that match it (review of 22/09).
  const prev = await db.query<{ state: string; root: string | null; budget: string | null; payload: string; tx_hash: string | null }>(
    "SELECT state, root, budget, payload, tx_hash FROM epochs WHERE epoch = $1",
    [epoch],
  );
  const old = prev.rows[0];
  let body = payload as Record<string, unknown>;
  if (old && old.root && root && old.root.toLowerCase() !== root.toLowerCase()) {
    const oldPayload = JSON.parse(old.payload) as { claims?: unknown; previous?: Previous[] };
    const previous: Previous[] = [...(oldPayload.previous ?? []), { root: old.root, budget: old.budget ?? "0", claims: oldPayload.claims ?? [], tx_hash: old.tx_hash }];
    body = { ...body, previous };
  } else if (old) {
    const oldPayload = JSON.parse(old.payload) as { previous?: Previous[] };
    if (oldPayload.previous) body = { ...body, previous: oldPayload.previous };
  }
  await db.query(
    `INSERT INTO epochs (epoch, state, reason, root, budget, payload, closed_at) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (epoch) DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason, root = EXCLUDED.root,
       budget = EXCLUDED.budget, payload = EXCLUDED.payload, closed_at = now() WHERE epochs.state NOT IN ('PUBLISHED','VOIDED')`,
    [epoch, state, reason, root, budget?.toString() ?? null, json(body)],
  );
}

/** How long an empty distributor is waited for before an epoch is declared not payable. The first
 *  epochs end before Pons has swept a single fee: declaring them on the first look would make the
 *  first buyback pay nobody for the epochs it was meant for. */
export const EMPTY_DISTRIBUTOR_GRACE_SEC = 2 * EPOCH_LENGTH;

/**
 * The block whose end state is "the balance at the start of the epoch": the last block with a
 * timestamp STRICTLY before the start. A block stamped exactly at the start already belongs to the
 * epoch (the ledger's currentEpoch() says so there), so its transfers must not count.
 */
const DROP_AFTER_SEC = 600;

export const epochStartBlock = (client: PublicClient, genesis: number, epoch: number) =>
  blockAtOrBefore(client, genesis + epoch * EPOCH_LENGTH - 1);

export async function closeEpoch(d: EpochDeps, epoch: number, publish: boolean): Promise<EpochOutcome> {
  const { db, token, ledger, cfg, lcfg, rcfg } = d;
  const readDist = <T>(functionName: string, args: unknown[] = []) =>
    ledger.readContract({ address: rcfg.rewardsDistributor, abi: DISTRIBUTOR_ABI, functionName: functionName as never, args: args as never }) as Promise<T>;

  const already = await db.query<{ state: string; root: string | null; budget: string | null; tx_hash: string | null; age: string | null }>(
    "SELECT state, root, budget, tx_hash, EXTRACT(EPOCH FROM now() - sent_at)::text age FROM epochs WHERE epoch = $1",
    [epoch],
  );
  const row = already.rows[0];
  if (row?.state === "PUBLISHED") return { state: "WAIT", reason: `epoch ${epoch} already published` };
  if (row?.state === "VOIDED") return { state: "WAIT", reason: `epoch ${epoch} was voided by the guardian` };

  // The chain is the truth about a root, not our table. A root sent in an earlier pass may have
  // landed while its receipt was lost (timeout, RPC error, restart): recognise it instead of
  // recomputing, because a recomputed budget differs as soon as freeBalance moved, and the
  // proofs we serve must match the root that is on-chain.
  const onchain = await readDist<Hex>("roots", [BigInt(epoch)]);
  if (onchain !== zeroHash) {
    if (row?.root?.toLowerCase() === onchain.toLowerCase()) {
      await db.query("UPDATE epochs SET state = 'PUBLISHED', published_at = now() WHERE epoch = $1", [epoch]);
      return { state: "PUBLISHED", root: onchain, budget: BigInt(row.budget ?? 0), tx: (row.tx_hash ?? zeroHash) as Hex };
    }
    // An earlier root of ours that was recomputed, and whose transaction landed after all: restore
    // its claims, they are the proofs that match what is on-chain.
    const payload = row ? (JSON.parse((await db.query<{ payload: string }>("SELECT payload FROM epochs WHERE epoch = $1", [epoch])).rows[0]!.payload) as { previous?: Previous[] }) : null;
    const older = payload?.previous?.find((p) => p.root.toLowerCase() === onchain.toLowerCase());
    if (older && payload) {
      const restored = { ...payload, root: older.root, budget: older.budget, claims: older.claims, previous: payload.previous!.filter((p) => p !== older) };
      await db.query("UPDATE epochs SET state = 'PUBLISHED', root = $2, budget = $3, tx_hash = COALESCE($4, tx_hash), payload = $5, published_at = now() WHERE epoch = $1", [
        epoch, older.root, older.budget, older.tx_hash, json(restored),
      ]);
      return { state: "PUBLISHED", root: onchain, budget: BigInt(older.budget), tx: (older.tx_hash ?? zeroHash) as Hex };
    }
    return { state: "FAILED", reason: `epoch ${epoch} has root ${onchain} on-chain, not the one stored (${row?.root ?? "none"}): check by hand` };
  }
  // A root sent but not on-chain yet: while the node still knows the transaction, wait for it.
  // A node error throws (the task goes BLIND): only a node that ANSWERS "unknown" for 10 minutes
  // lets us conclude the root was dropped and send it again (same gate as the buyback and the batch).
  if (row?.state === "PAYABLE" && row.tx_hash) {
    const t = await lookupTx(ledger, row.tx_hash as Hex);
    if (t.state === "pending") return { state: "WAIT", reason: `setEpochRoot ${row.tx_hash} sent, not mined yet` };
    if (t.state === "unknown" && Number(row.age ?? 0) < DROP_AFTER_SEC) {
      return { state: "WAIT", reason: `setEpochRoot ${row.tx_hash} not known to the node yet` };
    }
    // mined and reverted, or unknown for 10 minutes: the epoch is computed and sent again below
  }

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
  const startBlock = await epochStartBlock(token, genesis, epoch);
  if (startBlock === null) return { state: "FAILED", reason: "no block before the start of the epoch" };
  const tcur = await getCursor(db, transferCursor(cfg.token));
  if (tcur === null || tcur < startBlock) return { state: "WAIT", reason: `Transfer index at ${tcur}, needs ${startBlock}` };
  const balances = new Map<string, bigint>();
  for (const c of new Set(calls.map((x) => x.caller))) balances.set(c, await balanceAt(db, cfg.token, c, startBlock));

  const excluded = new Set(rcfg.excluded);
  const scored = scoreEpoch({ epoch, questions, calls, balanceAtStart: balances, excluded, reference: rcfg.reference, topFraction: rcfg.topFraction });
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
    // Before the first processSwap the distributor is empty. Not declared on the first look: the
    // epoch waits for the buyback for a while, and only then scores stay public and rewards do not.
    if (now < epochEnd(epoch, genesis) + EMPTY_DISTRIBUTOR_GRACE_SEC) {
      return { state: "WAIT", reason: `distributor has no free balance: waiting for the first buyback until ${epochEnd(epoch, genesis) + EMPTY_DISTRIBUTOR_GRACE_SEC}` };
    }
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
    // Hash stored BEFORE the broadcast: if the receipt never comes back, the next pass finds the root on-chain.
    tx = await sendTx(
      { pub: ledger, wallet, account: scorer },
      { address: rcfg.rewardsDistributor, abi: DISTRIBUTOR_ABI, functionName: "setEpochRoot", args: [BigInt(epoch), root, total] },
      async (hash) => {
        await db.query("UPDATE epochs SET tx_hash = $2, sent_at = now() WHERE epoch = $1 AND state = 'PAYABLE'", [epoch, hash]);
      },
    );
  } catch (e) {
    if (e instanceof NotSentError) return { state: "FAILED", reason: `setEpochRoot not sent: ${e.message}` };
    return { state: "WAIT", reason: `setEpochRoot broadcast, outcome unknown (${(e as Error).message}): checked on-chain next pass` };
  }
  const receipt = await ledger.waitForTransactionReceipt({ hash: tx }).catch(() => null);
  if (!receipt) return { state: "WAIT", reason: `setEpochRoot ${tx} sent, receipt not read yet` };
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
  await db.query("UPDATE epochs SET state = 'PUBLISHED', tx_hash = $2, published_at = now() WHERE epoch = $1", [epoch, tx]);
  return { state: "PUBLISHED", root, budget: total, tx };
}
