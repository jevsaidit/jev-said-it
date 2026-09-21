import { decodeEventLog, parseAbi, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeWallet } from "../chain/client.js";
import type { LedgerConfig } from "../config.js";
import { type Db, getCursor, inTx } from "../db/db.js";
import { V4_CURSOR } from "../indexer/v4.js";
import { canonicalJson, fmtProb, questionId } from "./canonical.js";
import { marketState, selectCandidates } from "./candidates.js";
import { epochOf, planBatch } from "./epoch.js";
import type { VerdictModel } from "./model.js";

export const LEDGER_ABI = parseAbi([
  "function genesis() view returns (uint256)",
  "function publisher() view returns (address)",
  "function currentEpoch() view returns (uint256)",
  "function openQuestions(uint256 epoch, bytes32[] ids, uint64 deadline)",
  "event QuestionsOpened(uint256 indexed epoch, bytes32[] ids, uint64 deadline)",
]);

export const KIND_A = "A_PRICE_UP";
// Until 30 questions are resolved the type-A baseline is not measured (spec §3), and the JSON says so.
const BASELINE_A = 0.5;
/** Seconds over which the reference price is averaged, at the deadline and at deadline+horizon. */
export const REFERENCE_WINDOW_SEC = 600;
// v2 (22/09): an average, not the last swap. With the last swap, whoever had called could move the
// price in the very block of the deadline, when no one can call any more; averaging over 10 minutes
// makes that cost ten minutes of holding the price, not one swap.
const RULE_A =
  "1 if the token's ETH price, time-weighted over the `window` seconds ending at deadline+horizon, is strictly higher than time-weighted over the `window` seconds ending at deadline; 0 otherwise; VOID if the pool has no Swap between deadline and deadline+horizon.";

export type OpenResult =
  | { state: "OPENED"; epoch: number; deadline: number; ids: Hex[]; tx: Hex; block: bigint }
  | { state: "SKIPPED"; reason: string }
  | { state: "FAILED"; reason: string };

export interface OpenDeps {
  db: Db;
  ledger: PublicClient; // the CallLedger's chain
  cfg: LedgerConfig;
  model: VerdictModel;
  dataChainId: number; // the chain of the tokens and pools
  excludeTokens: string[];
  /** data-chain client, to read the tokens' symbol() (for the site only) */
  data?: PublicClient;
}

const ERC20_SYMBOL = parseAbi(["function symbol() view returns (string)"]);

/** The ticker, if the token exposes one. A token without symbol() or with an odd symbol() blocks nothing. */
async function symbolOf(data: PublicClient | undefined, token: string): Promise<string | null> {
  if (!data) return null;
  try {
    const s = await data.readContract({ address: token as `0x${string}`, abi: ERC20_SYMBOL, functionName: "symbol" });
    return typeof s === "string" && s.length <= 32 ? s : null;
  } catch {
    return null;
  }
}

export async function openBatch(d: OpenDeps): Promise<OpenResult> {
  const { db, ledger, cfg, model } = d;
  const keeper = privateKeyToAccount(cfg.keeperPk);
  const read = <T>(functionName: "genesis" | "publisher" | "currentEpoch") =>
    ledger.readContract({ address: cfg.callLedger, abi: LEDGER_ABI, functionName }) as Promise<T>;

  const publisher = await read<string>("publisher");
  if (publisher.toLowerCase() !== keeper.address.toLowerCase()) {
    return { state: "FAILED", reason: `key ${keeper.address} is not the CallLedger publisher (${publisher})` };
  }
  const genesis = Number(await read<bigint>("genesis"));
  const now = Number((await ledger.getBlock({ blockTag: "latest" })).timestamp);

  // A batch already sent is settled first, from its receipt: a lost receipt must never leave
  // questions answerable on-chain but PENDING here (not served, not resolved, not scored).
  const pend = await db.query<{ tx_hash: string | null; epoch: number; deadline: string; ids: string[]; age: string }>(
    `SELECT tx_hash, epoch, deadline, array_agg(id) ids, EXTRACT(EPOCH FROM now() - min(created_at))::text age
       FROM questions WHERE status = 'PENDING' GROUP BY tx_hash, epoch, deadline`,
  );
  for (const b of pend.rows) {
    const ids = b.ids as Hex[];
    const failIds = async (reason: string): Promise<OpenResult> => {
      await db.query("UPDATE questions SET status = 'FAILED' WHERE id = ANY($1::text[])", [ids]);
      return { state: "FAILED", reason };
    };
    if (!b.tx_hash) {
      // Inserted but never sent (a crash in between): nothing is on-chain for these ids.
      if (Number(b.age) > PENDING_DROP_SEC) await failIds("never sent");
      else return { state: "SKIPPED", reason: "a batch is being sent" };
      continue;
    }
    const rc = await ledger.getTransactionReceipt({ hash: b.tx_hash as Hex }).catch(() => null);
    if (!rc) {
      if (await ledger.getTransaction({ hash: b.tx_hash as Hex }).catch(() => null)) return { state: "SKIPPED", reason: `openQuestions ${b.tx_hash} not mined yet` };
      if (Number(b.age) <= PENDING_DROP_SEC) return { state: "SKIPPED", reason: `openQuestions ${b.tx_hash} not known to the node yet` };
      await failIds(`openQuestions ${b.tx_hash} dropped`);
      continue;
    }
    const r = await settleOpen(db, ledger, cfg, genesis, { epoch: b.epoch, deadline: Number(b.deadline), ids, tx: b.tx_hash as Hex }, rc);
    if (r.state === "OPENED") return r;
  }

  const plan = planBatch({ now, genesis, ...cfg });
  if (!plan.open) return { state: "SKIPPED", reason: plan.reason };

  // One batch at a time: while one is open, no other is opened on top of it.
  const live = await db.query("SELECT 1 FROM questions WHERE status IN ('PENDING','OPEN') AND deadline > $1 LIMIT 1", [now]);
  if (live.rowCount) return { state: "SKIPPED", reason: "a batch with open calls already exists" };

  const head = await getCursor(db, V4_CURSOR);
  if (head === null) return { state: "FAILED", reason: "v4 index empty: no measurable candidate" };
  const cands = await selectCandidates(db, {
    head,
    minSwapsLastHour: cfg.minSwapsLastHour,
    minSwapsLast6h: cfg.minSwapsLast6h,
    limit: cfg.questionsPerBatch,
    exclude: d.excludeTokens,
  });
  if (cands.length === 0) return { state: "SKIPPED", reason: "no graduated token with enough swaps in the last hour and the last 6h" };

  const ledgerChainId = await ledger.getChainId();
  const rows: Array<{ id: Hex; json: string; token: string; poolId: string; symbol: string | null }> = [];
  const modelErrors: string[] = [];
  for (const c of cands) {
    // A verdict that does not arrive removes THAT question from the batch: it is not opened with a made-up p.
    let v: { p: number; model?: string };
    try {
      v = await model.verdict({ kind: KIND_A, token: c.token, baseline: BASELINE_A, state: await marketState(db, c.poolId, c.token, head) });
    } catch (e) {
      modelErrors.push(`${c.token}: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    const p = v.p;
    const json = canonicalJson({
      v: "2",
      kind: KIND_A,
      dataChainId: String(d.dataChainId),
      ledgerChainId: String(ledgerChainId),
      ledger: cfg.callLedger.toLowerCase(),
      epoch: String(plan.epoch),
      deadline: String(plan.deadline),
      horizon: String(cfg.horizonSec),
      window: String(REFERENCE_WINDOW_SEC),
      token: c.token,
      pool: c.poolId,
      model: v.model ?? model.id,
      p: fmtProb(p),
      baseline: fmtProb(BASELINE_A),
      baselineSource: "unmeasured",
      rule: RULE_A,
    });
    rows.push({ id: questionId(json), json, token: c.token, poolId: c.poolId, symbol: await symbolOf(d.data, c.token) });
  }
  if (rows.length === 0) return { state: "FAILED", reason: `no verdict from model ${model.id}: ${modelErrors.slice(0, 2).join("; ")}` };
  const ids = rows.map((r) => r.id);

  await inTx(db, async (c) => {
    for (const r of rows) {
      await c.query(
        `INSERT INTO questions (id, epoch, deadline, horizon, kind, token, pool_id, json, status, symbol)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9)`,
        [r.id, plan.epoch, plan.deadline, cfg.horizonSec, KIND_A, r.token, r.poolId, r.json, r.symbol],
      );
    }
  });
  const fail = async (reason: string): Promise<OpenResult> => {
    await db.query("UPDATE questions SET status = 'FAILED' WHERE id = ANY($1::text[])", [ids]);
    return { state: "FAILED", reason };
  };

  // Last check before spending gas: is the contract's epoch still the planned one?
  const onchainEpoch = Number(await read<bigint>("currentEpoch"));
  if (onchainEpoch !== plan.epoch) return fail(`epoch changed between plan (${plan.epoch}) and send (${onchainEpoch})`);

  const wallet = makeWallet(cfg.ledgerRpcUrl, ledgerChainId, cfg.keeperPk);
  let tx: Hex;
  try {
    tx = await wallet.writeContract({
      account: keeper,
      chain: wallet.chain,
      address: cfg.callLedger,
      abi: LEDGER_ABI,
      functionName: "openQuestions",
      args: [BigInt(plan.epoch), ids, BigInt(plan.deadline)],
    });
  } catch (e) {
    return fail(`send failed: ${(e as Error).message.split("\n")[0]}`);
  }
  // Stored before waiting: if the receipt never comes back, the next pass settles the batch from it.
  await db.query("UPDATE questions SET tx_hash = $2 WHERE id = ANY($1::text[])", [ids, tx]);
  const receipt = await ledger.waitForTransactionReceipt({ hash: tx }).catch(() => null);
  if (!receipt) return { state: "SKIPPED", reason: `openQuestions ${tx} sent, receipt not read yet` };
  return settleOpen(db, ledger, cfg, genesis, { epoch: plan.epoch, deadline: plan.deadline, ids, tx }, receipt);
}

/** A PENDING row with no hash, or with a hash the node forgot, is given up after this long. */
const PENDING_DROP_SEC = 600;

/**
 * The effect, not the action: from the receipt of openQuestions, the event must say exactly what was
 * asked, and the tx must have been included within the epoch and before the deadline. Only then do
 * the questions become OPEN (served, resolved, scored).
 */
async function settleOpen(
  db: Db,
  ledger: PublicClient,
  cfg: OpenDeps["cfg"],
  genesis: number,
  b: { epoch: number; deadline: number; ids: Hex[]; tx: Hex },
  receipt: TransactionReceipt,
): Promise<OpenResult> {
  const fail = async (reason: string): Promise<OpenResult> => {
    await db.query("UPDATE questions SET status = 'FAILED' WHERE id = ANY($1::text[])", [b.ids]);
    return { state: "FAILED", reason };
  };
  if (receipt.status !== "success") return fail(`tx ${b.tx} reverted`);
  const ev = receipt.logs
    .filter((l) => l.address.toLowerCase() === cfg.callLedger.toLowerCase())
    .map((l) => decodeEventLog({ abi: LEDGER_ABI, data: l.data, topics: l.topics, strict: true }))
    .find((e) => e.eventName === "QuestionsOpened");
  const incl = Number((await ledger.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
  const problems: string[] = [];
  const sorted = (xs: readonly string[]) => [...xs].map((x) => x.toLowerCase()).sort().join();
  if (!ev || ev.eventName !== "QuestionsOpened") problems.push("no QuestionsOpened event");
  else {
    if (Number(ev.args.epoch) !== b.epoch) problems.push(`event epoch ${ev.args.epoch} != ${b.epoch}`);
    if (Number(ev.args.deadline) !== b.deadline) problems.push(`event deadline ${ev.args.deadline} != ${b.deadline}`);
    if (sorted(ev.args.ids) !== sorted(b.ids)) problems.push("event ids differ from the ones sent");
  }
  if (epochOf(incl, genesis) !== b.epoch) problems.push(`tx included in epoch ${epochOf(incl, genesis)}, not ${b.epoch}`);
  if (incl >= b.deadline) problems.push("tx included after the deadline");
  if (problems.length) return fail(`opened on-chain but unusable: ${problems.join("; ")}`);

  await db.query("UPDATE questions SET status = 'OPEN', tx_hash = $2, opened_block = $3 WHERE id = ANY($1::text[])", [
    b.ids,
    b.tx,
    receipt.blockNumber.toString(),
  ]);
  return { state: "OPENED", epoch: b.epoch, deadline: b.deadline, ids: b.ids, tx: b.tx, block: receipt.blockNumber };
}
