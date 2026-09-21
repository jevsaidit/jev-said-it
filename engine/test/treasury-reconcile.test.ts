// A buyback is sent at most once per epoch, whatever happens to its receipt. Found by an adversarial
// review (21/09): the hash was stored only after the receipt, so a receipt slower than viem's 180s
// timeout, one RPC error or a restart made the next pass send processSwap AGAIN, and a reverted
// swap was re-sent every 15 seconds. No network here: the wallet, the chain and the db are fakes
// that answer only what the code under test asks.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";

const sent: string[] = [];
vi.mock("../src/chain/client.js", () => ({
  USER_AGENT: "test",
  makeClient: () => {
    throw new Error("no network in tests");
  },
  makeWallet: () => ({
    chain: { id: 4663 },
    writeContract: async (p: { functionName: string }) => {
      sent.push(p.functionName);
      return `0x${sent.length.toString(16).padStart(64, "0")}`;
    },
  }),
}));

import { runTreasury } from "../src/treasury/treasury.js";
import { swapTime } from "../src/treasury/schedule.js";

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // anvil #0, public
const KEEPER = privateKeyToAccount(PK).address;
const ROUTER = "0x2000000000000000000000000000000000000002" as const;
const G = 1_790_000_000;
const hex32 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

type Op = { epoch: number | null; kind: string; tx: string | null; detail: string; at: number };
let ops: Op[] = [];
let clock = 0; // seconds since the fake db started
const db = {
  query: async (sql: string, params: unknown[] = []) => {
    const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });
    if (/INSERT INTO treasury_ops/.test(sql)) {
      const [epoch, kind, tx, detail] = params as [number | null, string, string | null, string];
      ops.push({ epoch, kind, tx, detail, at: clock });
      return rows([]);
    }
    if (/FROM treasury_ops p/.test(sql)) {
      const [pending] = params as [string];
      return rows(
        ops
          .filter((o) => o.kind === pending && !ops.some((f) => f.tx === o.tx && f.kind !== pending))
          .map((o) => ({ epoch: o.epoch, tx_hash: o.tx, detail: o.detail, age: String(clock - o.at) })),
      );
    }
    if (/SELECT 1 FROM treasury_ops WHERE epoch = \$1 AND kind = ANY/.test(sql)) {
      const [epoch, kinds] = params as [number, string[]];
      return rows(ops.filter((o) => o.epoch === epoch && kinds.includes(o.kind)).map(() => ({ one: 1 })));
    }
    throw new Error(`unhandled sql: ${sql.slice(0, 80)}`);
  },
} as never;

const SWAP_ABI = parseAbi(["event SwapProcessed(uint256 ethIn, uint256 tokenOut, uint256 burned, uint256 toRewards)"]);
const okReceipt = {
  status: "success",
  logs: [
    {
      address: ROUTER,
      topics: encodeEventTopics({ abi: SWAP_ABI, eventName: "SwapProcessed" }),
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [10n ** 17n, 10n ** 30n, 3n * 10n ** 29n, 7n * 10n ** 29n], // tokenOut above any minOut of the fake pool
      ),
    },
  ],
};

/** The chain as the treasury sees it. `rc` decides what the node says about the sent swap. */
function chain(rc: { wait: () => Promise<unknown>; receipt: () => unknown; inMempool: () => boolean }) {
  let ext = 0;
  return {
    getChainId: async () => 4663,
    getBalance: async () => 0n,
    getBlock: async () => ({ timestamp: BigInt(swapTime(PK, 0, G) + 1) }),
    call: async () => ({ data: `0x${"00".repeat(32 * 8)}${hex32(0n).slice(2)}` as Hex }),
    readContract: async ({ functionName }: { functionName: string }) => {
      const v: Record<string, unknown> = {
        claimable: 0n, keeper: KEEPER, undistributed: 0n, computeBps: 500, opsBps: 1000, teamBps: 2000,
        swapBalance: 10n ** 17n, hookFeeBps: 100n,
      };
      if (functionName === "extsload") return ext++ % 2 === 0 ? hex32(140830553852855971414591633371917n) : hex32(29277002188455995564359n);
      if (functionName in v) return v[functionName];
      throw new Error(`unexpected read ${functionName}`);
    },
    waitForTransactionReceipt: rc.wait,
    getTransactionReceipt: async () => {
      const r = rc.receipt();
      if (!r) throw new TransactionReceiptNotFoundError({ hash: "0x00" });
      return r;
    },
    getTransaction: async () => {
      if (!rc.inMempool()) throw new TransactionNotFoundError({ hash: "0x00" });
      return { hash: "0x" };
    },
  } as never;
}
const cfg = { adapter: KEEPER, router: ROUTER, token: KEEPER, keeperPk: PK, rpcUrl: "http://x", minClaimWei: 10n ** 30n, minSwapWei: 10n ** 15n, slippageBps: 300n };

beforeEach(() => {
  sent.length = 0;
  ops = [];
  clock = 0;
});

describe("treasury: one buyback per epoch, whatever happens to the receipt", () => {
  it("a receipt that times out leaves SWAP_PENDING; later passes wait, then settle, and never resend", async () => {
    let landed = false;
    const c = chain({
      wait: async () => {
        throw new Error("Timed out while waiting for transaction to be confirmed.");
      },
      receipt: () => (landed ? okReceipt : null),
      inMempool: () => !landed,
    });
    expect((await runTreasury(db, c, cfg, G)).state).toBe("WAITING");
    expect(ops.map((o) => o.kind)).toEqual(["SWAP_PENDING"]);
    expect((await runTreasury(db, c, cfg, G)).state).toBe("WAITING"); // still in the mempool: wait, do not send
    landed = true;
    const r = await runTreasury(db, c, cfg, G);
    expect(r, JSON.stringify(r)).toMatchObject({ state: "OK" });
    expect(ops.map((o) => o.kind)).toEqual(["SWAP_PENDING", "SWAP"]);
    await runTreasury(db, c, cfg, G); // the epoch is done
    expect(sent).toEqual(["processSwap"]);
  });

  it("a reverted buyback closes the epoch: it is not re-sent every pass", async () => {
    const c = chain({ wait: async () => ({}), receipt: () => ({ status: "reverted", logs: [] }), inMempool: () => false });
    for (let i = 0; i < 3; i++) await runTreasury(db, c, cfg, G);
    expect(sent).toEqual(["processSwap"]);
    expect(ops.map((o) => o.kind)).toEqual(["SWAP_PENDING", "SWAP_REVERTED"]);
  });

  it("a transaction the node forgot is marked dropped after 10 minutes, and only then may be sent again", async () => {
    const c = chain({ wait: async () => { throw new Error("timeout"); }, receipt: () => null, inMempool: () => false });
    await runTreasury(db, c, cfg, G);
    clock = 300;
    expect((await runTreasury(db, c, cfg, G)).state).toBe("WAITING"); // unknown, but too young to call it dropped
    expect(sent).toEqual(["processSwap"]);
    clock = 700;
    expect((await runTreasury(db, c, cfg, G)).state).toBe("FAILED"); // dropped, recorded
    await runTreasury(db, c, cfg, G); // a new attempt is now allowed
    expect(ops.map((o) => o.kind)).toEqual(["SWAP_PENDING", "SWAP_DROPPED", "SWAP_PENDING"]);
    expect(sent).toEqual(["processSwap", "processSwap"]);
  });
});
