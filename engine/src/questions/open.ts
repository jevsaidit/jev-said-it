import { decodeEventLog, parseAbi, type Hex, type PublicClient } from "viem";
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
const RULE_A =
  "1 if the token's ETH price at the last Swap of the pool at or before deadline+horizon is strictly higher than at the last Swap at or before deadline; 0 otherwise; VOID if the pool has no Swap between the two.";

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
    limit: cfg.questionsPerBatch,
    exclude: d.excludeTokens,
  });
  if (cands.length === 0) return { state: "SKIPPED", reason: "no graduated token with enough swaps in the last hour" };

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
      v: "1",
      kind: KIND_A,
      dataChainId: String(d.dataChainId),
      ledgerChainId: String(ledgerChainId),
      ledger: cfg.callLedger.toLowerCase(),
      epoch: String(plan.epoch),
      deadline: String(plan.deadline),
      horizon: String(cfg.horizonSec),
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
  const receipt = await ledger.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") return fail(`tx ${tx} reverted`);

  // The effect, not the action: the event must say exactly what we asked for, and the tx must
  // have been included within the epoch and before the deadline.
  const ev = receipt.logs
    .filter((l) => l.address.toLowerCase() === cfg.callLedger.toLowerCase())
    .map((l) => decodeEventLog({ abi: LEDGER_ABI, data: l.data, topics: l.topics, strict: true }))
    .find((e) => e.eventName === "QuestionsOpened");
  const incl = Number((await ledger.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
  const problems: string[] = [];
  if (!ev || ev.eventName !== "QuestionsOpened") problems.push("no QuestionsOpened event");
  else {
    if (Number(ev.args.epoch) !== plan.epoch) problems.push(`event epoch ${ev.args.epoch} != ${plan.epoch}`);
    if (Number(ev.args.deadline) !== plan.deadline) problems.push(`event deadline ${ev.args.deadline} != ${plan.deadline}`);
    if (ev.args.ids.join() !== ids.join()) problems.push("event ids differ from the ones sent");
  }
  if (epochOf(incl, genesis) !== plan.epoch) problems.push(`tx included in epoch ${epochOf(incl, genesis)}, not ${plan.epoch}`);
  if (incl >= plan.deadline) problems.push("tx included after the deadline");
  if (problems.length) return fail(`opened on-chain but unusable: ${problems.join("; ")}`);

  await db.query("UPDATE questions SET status = 'OPEN', tx_hash = $2, opened_block = $3 WHERE id = ANY($1::text[])", [
    ids,
    tx,
    receipt.blockNumber.toString(),
  ]);
  return { state: "OPENED", epoch: plan.epoch, deadline: plan.deadline, ids, tx, block: receipt.blockNumber };
}
