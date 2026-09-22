import { decodeEventLog, encodeFunctionData, encodePacked, keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeWallet } from "../chain/client.js";
import { NotSentError, sendTx } from "../chain/send.js";
import { lookupTx } from "../chain/tx.js";
import { ponsEthPoolId } from "../chain/pool.js";
import { PONS_HOOK, POOL_MANAGER } from "../config.js";
import type { Db } from "../db/db.js";
import { epochOf } from "../questions/epoch.js";
import { minOutFor, quoteBuyGross } from "./quote.js";
import { swapTime } from "./schedule.js";

const ADAPTER_ABI = parseAbi([
  "function claim() returns (uint256)",
  "function claimable() view returns (uint256)",
  "event Forwarded(uint256 amount)",
]);
const ROUTER_ABI = parseAbi([
  "function undistributed() view returns (uint256)",
  "function swapBalance() view returns (uint256)",
  "function computeBps() view returns (uint16)",
  "function opsBps() view returns (uint16)",
  "function teamBps() view returns (uint16)",
  "function keeper() view returns (address)",
  "function processSwap(uint256 minOut)",
  "event SwapProcessed(uint256 ethIn, uint256 tokenOut, uint256 burned, uint256 toRewards)",
]);
const HOOK_ABI = parseAbi(["function hookFeeBps() view returns (uint256)"]);
// Only the input encoding is needed: the output is read as raw words.
const FACTORY_ABI = parseAbi(["function getLaunchedToken(address token)"]);
const EXTSLOAD = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
export const PONS_FACTORY: Address = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const POOLS_SLOT = 6n; // StateLibrary.POOLS_SLOT
const LIQUIDITY_OFFSET = 3n; // StateLibrary.LIQUIDITY_OFFSET

export interface TreasuryConfig {
  adapter: Address;
  router: Address;
  token: Address;
  keeperPk: Hex;
  rpcUrl: string;
  minClaimWei: bigint;
  minSwapWei: bigint;
  slippageBps: bigint;
}

export type TreasuryOutcome =
  | { state: "IDLE"; detail: string }
  | { state: "WAITING"; detail: string }
  | { state: "OK"; claimed?: string; claimError?: string; swapped?: { epoch: number; ethIn: string; tokenOut: string; minOut: string; tx: Hex } }
  | { state: "FAILED"; reason: string };

/**
 * The events of `abi` among a receipt's logs from `address`. Other events are skipped, not fatal:
 * processSwap also emits Distributed (it calls distribute() first), and an unknown event must not
 * turn a buyback that happened on-chain into one that is not recorded.
 */
function eventsOf(abi: typeof ADAPTER_ABI | typeof ROUTER_ABI, address: Address, logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[]) {
  const out: Array<{ eventName: string; args: Record<string, unknown> }> = [];
  for (const l of logs) {
    if (l.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      const e = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      out.push({ eventName: e.eventName, args: e.args as unknown as Record<string, unknown> });
    } catch {
      // an event this ABI does not describe
    }
  }
  return out;
}

async function record(db: Db, epoch: number | null, kind: string, tx: string | null, detail: unknown) {
  await db.query("INSERT INTO treasury_ops (epoch, kind, tx_hash, detail) VALUES ($1, $2, $3, $4)", [
    epoch,
    kind,
    tx,
    JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ]);
}

/** Price and in-range liquidity of the pool, from the PoolManager's storage at the latest block. */
async function poolState(chain: PublicClient, token: Address): Promise<{ sqrtPriceX96: bigint; liquidity: bigint }> {
  const slot = BigInt(keccak256(encodePacked(["bytes32", "uint256"], [ponsEthPoolId(token), POOLS_SLOT])));
  const read = (s: bigint) =>
    chain.readContract({ address: POOL_MANAGER, abi: EXTSLOAD, functionName: "extsload", args: [`0x${s.toString(16).padStart(64, "0")}` as Hex] });
  const slot0 = BigInt(await read(slot));
  const liquidity = BigInt(await read(slot + LIQUIDITY_OFFSET)) & ((1n << 128n) - 1n);
  return { sqrtPriceX96: slot0 & ((1n << 160n) - 1n), liquidity };
}

/** Hook cut on our pool = protocol fee (hookFeeBps) + creator tax (word 8 of the launch record). */
async function haircutBps(chain: PublicClient, token: Address): Promise<bigint> {
  const hookFee = await chain.readContract({ address: PONS_HOOK, abi: HOOK_ABI, functionName: "hookFeeBps" });
  // The launch record is a raw tuple; word 8 is the creator tax (contracts/docs/addresses.md).
  const { data } = await chain.call({ to: PONS_FACTORY, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] }) });
  if (!data || data.length < 2 + 9 * 64) throw new Error("getLaunchedToken returned no record");
  const creatorTax = BigInt(`0x${data.slice(2 + 8 * 64, 2 + 9 * 64)}`);
  return BigInt(hookFee) + creatorTax;
}

/** A buyback whose transaction left but whose outcome is not recorded yet. */
const SWAP_PENDING = "SWAP_PENDING";
/** Kinds that close an epoch's buyback: never send another processSwap for that epoch. A reverted
 *  swap closes it too: resending the same minOut into the same pool every 15s only burns gas. */
const SWAP_FINAL = ["SWAP", "SWAP_SKIPPED", "SWAP_REVERTED"];
/** A pending transaction the node no longer knows is dropped after this long, and may be resent. */
const DROP_AFTER_SEC = 600;

type Pending = { epoch: number; tx: Hex; detail: { minOut: string; gross: string; haircutBps: string; slippageBps: string }; ageSec: number };

async function pendingSwaps(db: Db): Promise<Pending[]> {
  const r = await db.query<{ epoch: number; tx_hash: string; detail: string; age: string }>(
    `SELECT p.epoch, p.tx_hash, p.detail, EXTRACT(EPOCH FROM now() - p.at)::text age
       FROM treasury_ops p
      WHERE p.kind = $1 AND p.tx_hash IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM treasury_ops f WHERE f.tx_hash = p.tx_hash AND f.kind <> $1)
      ORDER BY p.id`,
    [SWAP_PENDING],
  );
  return r.rows.map((x) => ({ epoch: x.epoch, tx: x.tx_hash as Hex, detail: JSON.parse(x.detail), ageSec: Number(x.age) }));
}

/**
 * Turns a sent processSwap into its final record, reading the receipt. Returns null while the
 * outcome is not knowable yet (still in the mempool, or the node does not answer).
 */
async function settleSwap(db: Db, chain: PublicClient, cfg: TreasuryConfig, p: Pending): Promise<TreasuryOutcome | null> {
  const t = await lookupTx(chain, p.tx); // a node error throws: never read as "dropped"
  const rc = t.state === "mined" ? t.receipt : null;
  if (!rc) {
    if (t.state === "pending" || p.ageSec < DROP_AFTER_SEC) return null;
    await record(db, p.epoch, "SWAP_DROPPED", p.tx, { ...p.detail, note: `unknown to the node after ${Math.round(p.ageSec)}s` });
    return { state: "FAILED", reason: `processSwap ${p.tx} dropped: the next pass may send a new one` };
  }
  const minOut = BigInt(p.detail.minOut);
  const ev = eventsOf(ROUTER_ABI, cfg.router, rc.logs).find((e) => e.eventName === "SwapProcessed");
  // The effect, not the send: the event must show at least minOut, split exactly into burn + rewards.
  if (rc.status !== "success" || !ev) {
    await record(db, p.epoch, rc.status === "success" ? "SWAP" : "SWAP_REVERTED", p.tx, { ...p.detail, note: "no SwapProcessed event read" });
    return { state: "FAILED", reason: `processSwap ${p.tx}: no SwapProcessed event (status ${rc.status})` };
  }
  const a = ev.args as { ethIn: bigint; tokenOut: bigint; burned: bigint; toRewards: bigint };
  if (a.tokenOut < minOut || a.burned + a.toRewards !== a.tokenOut) {
    await record(db, p.epoch, "SWAP", p.tx, { ...a, ...p.detail, note: "event does not add up" });
    return { state: "FAILED", reason: `processSwap ${p.tx}: event does not add up` };
  }
  await record(db, p.epoch, "SWAP", p.tx, { ...a, ...p.detail });
  return { state: "OK", swapped: { epoch: p.epoch, ethIn: a.ethIn.toString(), tokenOut: a.tokenOut.toString(), minOut: p.detail.minOut, tx: p.tx } };
}

/**
 * One treasury pass: collect what the Pons escrow owes the adapter, and once per epoch, at a
 * time only we can predict, run the buyback. Fees reach the escrow only when Pons' operator sweeps
 * our pool (contracts/docs/addresses.md): this pass can only collect what has been swept.
 */
export async function runTreasury(db: Db, chain: PublicClient, cfg: TreasuryConfig, genesis: number): Promise<TreasuryOutcome> {
  const keeper = privateKeyToAccount(cfg.keeperPk);
  const wallet = makeWallet(cfg.rpcUrl, await chain.getChainId(), cfg.keeperPk);
  const out: { claimed?: string; claimError?: string; swapped?: { epoch: number; ethIn: string; tokenOut: string; minOut: string; tx: Hex } } = {};

  // 1. Collect: escrow -> adapter -> router. Anyone may call claim(); the keeper pays the gas.
  //    A collection that fails does not stop the buyback of what was collected earlier, and it is
  //    not retried with gas every 15 seconds: the simulation refuses it first, for free.
  const owed = (await chain.readContract({ address: cfg.adapter, abi: ADAPTER_ABI, functionName: "claimable" })) +
    (await chain.getBalance({ address: cfg.adapter }));
  if (owed >= cfg.minClaimWei) {
    try {
      const tx = await sendTx(
        { pub: chain, wallet, account: keeper },
        { address: cfg.adapter, abi: ADAPTER_ABI, functionName: "claim" },
        async (hash) => record(db, null, "CLAIM_SENT", hash, { owed }),
      );
      const rc = await chain.waitForTransactionReceipt({ hash: tx }).catch(() => null);
      if (!rc) out.claimError = `claim ${tx}: receipt not read yet`;
      else {
        const ev = eventsOf(ADAPTER_ABI, cfg.adapter, rc.logs).find((e) => e.eventName === "Forwarded");
        if (rc.status !== "success" || !ev) {
          await record(db, null, "CLAIM_UNCONFIRMED", tx, { status: rc.status });
          out.claimError = `claim ${tx}: no Forwarded event`;
        } else {
          out.claimed = String(ev.args.amount);
          await record(db, null, "CLAIM", tx, { forwarded: ev.args.amount });
        }
      }
    } catch (e) {
      const why = (e as Error).message.split("\n")[0]!;
      if (e instanceof NotSentError) await record(db, null, "CLAIM_REFUSED", null, { owed, reason: why });
      out.claimError = `claim ${e instanceof NotSentError ? "not sent" : "broadcast, outcome unknown"}: ${why}`;
    }
  }

  // 2. A buyback already sent is settled before anything else: its hash was stored the moment it
  //    left, so a slow receipt, a node error or a restart can never make us send a second one.
  for (const p of await pendingSwaps(db)) {
    const settled = await settleSwap(db, chain, cfg, p);
    if (settled === null) return { state: "WAITING", detail: `processSwap ${p.tx} sent, outcome not known yet` };
    if (settled.state === "FAILED") return settled;
    out.swapped = (settled as { swapped?: typeof out.swapped }).swapped;
  }

  // 3. Buyback: once per epoch, not before its secret time.
  const now = Number((await chain.getBlock({ blockTag: "latest" })).timestamp);
  const epoch = epochOf(now, genesis);
  const due = swapTime(cfg.keeperPk, epoch, genesis);
  const done = await db.query("SELECT 1 FROM treasury_ops WHERE epoch = $1 AND kind = ANY($2::text[]) LIMIT 1", [epoch, SWAP_FINAL]);
  if (now >= due && !done.rowCount && !out.swapped) {
    if ((await chain.readContract({ address: cfg.router, abi: ROUTER_ABI, functionName: "keeper" })).toLowerCase() !== keeper.address.toLowerCase()) {
      return { state: "FAILED", reason: `${keeper.address} is not the router's keeper` };
    }
    // processSwap distributes first: the swap bucket it will spend is swapBalance + the swap share of undistributed.
    const r = (fn: "undistributed" | "swapBalance" | "computeBps" | "opsBps" | "teamBps") =>
      chain.readContract({ address: cfg.router, abi: ROUTER_ABI, functionName: fn }) as Promise<bigint | number>;
    const und = BigInt(await r("undistributed"));
    const others = BigInt(await r("computeBps")) + BigInt(await r("opsBps")) + BigInt(await r("teamBps"));
    const ethIn = BigInt(await r("swapBalance")) + (und - (und * others) / 10_000n); // exactly as distribute() rounds
    if (ethIn < cfg.minSwapWei) {
      await record(db, epoch, "SWAP_SKIPPED", null, { ethIn, reason: "below MIN_SWAP_WEI, carried to the next epoch" });
    } else {
      const { sqrtPriceX96, liquidity } = await poolState(chain, cfg.token);
      const gross = quoteBuyGross(sqrtPriceX96, liquidity, ethIn);
      const cut = await haircutBps(chain, cfg.token);
      const minOut = minOutFor(gross, cut, cfg.slippageBps);
      if (minOut === 0n) return { state: "FAILED", reason: "minOut is 0: pool not readable, refusing an unprotected swap" };
      const detail = { minOut: minOut.toString(), gross: gross.toString(), haircutBps: cut.toString(), slippageBps: cfg.slippageBps.toString() };
      let tx: Hex;
      try {
        // The pending row is written BEFORE the broadcast: whatever the network answers, the next
        // pass settles this buyback from the chain and never sends a second one for the epoch.
        tx = await sendTx(
          { pub: chain, wallet, account: keeper },
          { address: cfg.router, abi: ROUTER_ABI, functionName: "processSwap", args: [minOut] },
          async (hash) => record(db, epoch, SWAP_PENDING, hash, detail),
        );
      } catch (e) {
        if (e instanceof NotSentError) {
          // Refused by the simulation: nothing left, and the epoch's buyback is closed like a revert
          // would close it (resending the same minOut into the same pool every 15s only burns gas).
          await record(db, epoch, "SWAP_REVERTED", null, { ...detail, note: `not sent: ${e.message}` });
          return { state: "FAILED", reason: `processSwap not sent: ${e.message}` };
        }
        return { state: "WAITING", detail: `processSwap broadcast, outcome unknown (${(e as Error).message}): settled next pass` };
      }
      const p: Pending = { epoch, tx, detail, ageSec: 0 };
      // A receipt that does not come in time is not a failure: the pending row settles it next pass.
      await chain.waitForTransactionReceipt({ hash: tx }).catch(() => null);
      const settled = await settleSwap(db, chain, cfg, p);
      if (settled === null) return { state: "WAITING", detail: `processSwap ${tx} sent, outcome not known yet` };
      if (settled.state === "FAILED") return settled;
      out.swapped = (settled as { swapped?: typeof out.swapped }).swapped;
    }
  }
  if (out.claimed || out.swapped) return { state: "OK", ...out };
  if (out.claimError) return { state: "FAILED", reason: out.claimError };
  return { state: "IDLE", detail: `next buyback not before ${due}` };
}
