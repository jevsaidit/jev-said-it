// Regression test from the adversarial review (21/09), rewritten to assert the fixed behaviour. Nothing here touches a network: makeWallet is mocked, the "chain" and
// the "db" are in-memory fakes that answer only the SQL / RPC the code under test actually issues.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";

const sent: Array<{ functionName: string; args?: unknown[] }> = [];
vi.mock("../src/chain/client.js", () => ({
  USER_AGENT: "test",
  makeClient: () => { throw new Error("no network in tests"); },
  makeWallet: () => ({
    chain: { id: 4663 },
    writeContract: async (p: { functionName: string; args?: unknown[] }) => {
      sent.push({ functionName: p.functionName, args: p.args });
      return `0x${sent.length.toString(16).padStart(64, "0")}`;
    },
  }),
}));

// The two-halves sender of 22/09: the hash is handed to the caller before the "broadcast".
vi.mock("../src/chain/send.js", async () => {
  const real = await vi.importActual<typeof import("../src/chain/send.js")>("../src/chain/send.js");
  return {
    ...real,
    sendTx: async (_d: unknown, req: { functionName: string; args?: unknown[] }, onHash: (h: string) => Promise<void>) => {
      sent.push({ functionName: req.functionName, args: req.args });
      const hash = `0x${sent.length.toString(16).padStart(64, "0")}`;
      await onHash(hash);
      return hash;
    },
  };
});

import { openBatch } from "../src/questions/open.js";
import { questionJson } from "../src/server/feed.js";

// anvil's public test key #0: not a secret
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const KEEPER = privateKeyToAccount(PK).address;
const G = 1_790_000_000;
const hex32 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

type Handler = [RegExp, (params: unknown[]) => { rows: unknown[]; rowCount: number } | Promise<{ rows: unknown[]; rowCount: number }>];
function fakeDb(handlers: Handler[]) {
  const query = async (sql: string, params: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return ok();
    const h = handlers.find(([re]) => re.test(sql));
    if (!h) throw new Error(`unhandled sql: ${sql.slice(0, 80)}`);
    return h[1](params);
  };
  return { query, connect: async () => ({ query, release() {} }) } as never;
}
const ok = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });

beforeEach(() => { sent.length = 0; });

describe("openBatch: a batch whose receipt was lost is settled from the chain, not left PENDING", () => {
  const A = "0x2000000000000000000000000000000000000002";
  const rows: Array<{ id: string; status: string; deadline: number; json: string; tx?: string }> = [];
  let receiptOnChain: unknown = null;
  const db = fakeDb([
    [/FROM questions WHERE status = 'PENDING' GROUP BY/, () => {
      const p = rows.filter((r) => r.status === "PENDING");
      return ok(p.length ? [{ tx_hash: p[0]!.tx ?? null, epoch: 0, deadline: String(p[0]!.deadline), ids: p.map((r) => r.id), age: "5" }] : []);
    }],
    [/UPDATE questions SET tx_hash/, ([ids, tx]) => { for (const r of rows) if ((ids as string[]).includes(r.id)) r.tx = tx as string; return ok(); }],
    [/SELECT 1 FROM questions WHERE status IN \('PENDING','OPEN'\) AND deadline > \$1/, ([now]) => ok(rows.filter((r) => (r.status === "PENDING" || r.status === "OPEN") && r.deadline > (now as number)).slice(0, 1))],
    [/SELECT block FROM cursors/, () => ok([{ block: "5000000" }])],
    [/SELECT p\.pool_id, p\.token, count/, () => ok([{ pool_id: "0x" + "11".repeat(32), token: A, n: "42" }])],
    [/SELECT sqrt_price_x96 s FROM swaps/, () => ok([{ s: "1000" }])],
    [/SELECT p\.start_block/, () => ok([{ start_block: "100", n1: "10", n6: "50" }])],
    [/SELECT id, status FROM questions WHERE id = ANY/, ([ids]) => ok(rows.filter((r) => (ids as string[]).includes(r.id)).map((r) => ({ id: r.id, status: r.status })))],
    [/INSERT INTO questions/, ([id, , deadline, , , , , json]) => { rows.push({ id: id as string, status: "PENDING", deadline: deadline as number, json: json as string }); return ok(); }],
    [/UPDATE questions SET status = 'FAILED'/, ([ids]) => { for (const r of rows) if ((ids as string[]).includes(r.id)) r.status = "FAILED"; return ok(); }],
    [/UPDATE questions SET status = 'OPEN'/, ([ids]) => { for (const r of rows) if ((ids as string[]).includes(r.id)) r.status = "OPEN"; return ok(); }],
    [/SELECT json FROM questions WHERE id = \$1 AND status = 'OPEN'/, ([id]) => ok(rows.filter((r) => r.id === id && r.status === "OPEN").map((r) => ({ json: r.json })))],
  ]);
  const ledger = (receipt: () => Promise<unknown>) => ({
    getChainId: async () => 4663,
    getBlock: async () => ({ timestamp: BigInt(G + 100) }),
    getBlockNumber: async () => 1n,
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "publisher": return KEEPER;
        case "genesis": return BigInt(G);
        case "currentEpoch": return 0n;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    waitForTransactionReceipt: receipt,
    getTransactionReceipt: async () => { if (!receiptOnChain) throw new TransactionReceiptNotFoundError({ hash: "0x00" }); return receiptOnChain; },
    getTransaction: async () => ({}),
  }) as never;
  const cfg = { ledgerRpcUrl: "http://x", callLedger: A, keeperPk: PK, callWindowSec: 7200, minCallWindowSec: 1800, epochMarginSec: 300, horizonSec: 21600, questionsPerBatch: 10, minSwapsLastHour: 10 };
  const model = { id: "m", verdict: async () => ({ p: 0.6 }) };

  it("receipt lost -> SKIPPED with the hash stored; the next pass settles it OPEN from the receipt, one send only", async () => {
    rows.length = 0;
    receiptOnChain = null;
    const deps = (l: unknown) => ({ db, ledger: l as never, cfg, model, dataChainId: 4663, excludeTokens: [] });
    const lost = ledger(async () => { throw new Error("Timed out while waiting for transaction"); });
    const r1 = await openBatch(deps(lost));
    expect(r1.state).toBe("SKIPPED");
    expect(rows.map((r) => r.status)).toEqual(["PENDING"]);
    expect(rows[0]!.tx).toBeTruthy();
    expect((await openBatch(deps(lost))).state).toBe("SKIPPED"); // in the mempool: wait
    const [epoch, ids, deadline] = (sent[0]!.args as [bigint, `0x${string}`[], bigint]);
    const abi = parseAbi(["event QuestionsOpened(uint256 indexed epoch, bytes32[] ids, uint64 deadline)"]);
    receiptOnChain = {
      status: "success",
      blockNumber: 1n,
      logs: [{ address: A, topics: encodeEventTopics({ abi, eventName: "QuestionsOpened", args: { epoch } }), data: encodeAbiParameters([{ type: "bytes32[]" }, { type: "uint64" }], [ids, deadline]) }],
    };
    const r3 = await openBatch(deps(lost));
    expect(r3.state).toBe("OPENED");
    expect(rows.map((r) => r.status)).toEqual(["OPEN"]);
    expect(sent.map((s) => s.functionName)).toEqual(["openQuestions"]);
    expect(await questionJson(db, rows[0]!.id)).not.toBeNull(); // the commitment is served again
  });
});

