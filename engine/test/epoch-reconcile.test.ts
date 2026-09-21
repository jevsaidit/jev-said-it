// Regression tests from the adversarial review (21/09), rewritten to assert the fixed behaviour. Nothing here touches a network: makeWallet is mocked, the "chain" and
// the "db" are in-memory fakes that answer only the SQL / RPC the code under test actually issues.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

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

import { closeEpoch } from "../src/score/epoch.js";
import { claimFor } from "../src/server/feed.js";
import { EPOCH_LENGTH } from "../src/questions/epoch.js";

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

describe("closeEpoch: a root that landed on-chain while its receipt was lost is recognised, not recomputed", () => {
  const SCORER = KEEPER;
  const A = "0x1000000000000000000000000000000000000001";
  const epochs = new Map<number, { state: string; root: string | null; payload: string }>();
  let onchain = { hasPublished: false, lastEpoch: 0n, lastRootSetAt: 0n, free: 10n ** 21n, root: "0x" + "00".repeat(32) };
  let mempool = true;
  const questions = ["ab", "cd", "ef"].map((h) => ({ id: "0x" + h.repeat(32), json: JSON.stringify({ p: "0.7000", baseline: "0.5000" }), outcome: "1" }));
  const calls = questions.map((q, i) => ({ caller: A, question_id: q.id, agree: true, block: "5", log_index: i }));
  const db = fakeDb([
    [/SELECT state, root, budget, tx_hash FROM epochs/, ([e]) => ok(epochs.has(e as number) ? [{ ...epochs.get(e as number)!, budget: "0" }] : [])],
    [/UPDATE epochs SET tx_hash/, ([e, tx]) => { (epochs.get(e as number) as { tx_hash?: string }).tx_hash = tx as string; return ok(); }],
    [/FROM questions WHERE epoch = \$1 AND status = 'OPEN'/, () => ok(questions)],
    [/SELECT block FROM cursors/, ([name]) => ok((name as string).startsWith("transfers:") ? [{ block: "100" }] : [])],
    [/INSERT INTO cursors/, () => ok()],
    [/FROM calls WHERE epoch/, () => ok(calls)],
    [/FROM transfers/, () => ok([{ bal: (50_000n * 10n ** 18n).toString() }])],
    [/INSERT INTO epochs/, ([e, state, , root, , payload]) => {
      const cur = epochs.get(e as number);
      if (!cur || cur.state !== "PUBLISHED") epochs.set(e as number, { state: state as string, root: root as string | null, payload: payload as string });
      return ok();
    }],
    [/UPDATE epochs SET state = 'PUBLISHED'/, ([e]) => { epochs.get(e as number)!.state = "PUBLISHED"; return ok(); }],
    [/SELECT payload FROM epochs WHERE epoch = \$1 AND state = 'PUBLISHED'/, ([e]) => ok(epochs.get(e as number)?.state === "PUBLISHED" ? [{ payload: epochs.get(e as number)!.payload }] : [])],
  ]);
  const ledger = (receipt: () => Promise<unknown>) => ({
    getChainId: async () => 4663,
    getBlockNumber: async () => 1000n,
    getBlock: async () => ({ timestamp: BigInt(G + 3 * EPOCH_LENGTH) }),
    getLogs: async () => [],
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "genesis": return BigInt(G);
        case "freeBalance": return onchain.free;
        case "maxEpochBudgetBps": return 2000;
        case "scorer": return SCORER;
        case "hasPublished": return onchain.hasPublished;
        case "lastEpoch": return onchain.lastEpoch;
        case "lastRootSetAt": return onchain.lastRootSetAt;
        case "roots": return onchain.root;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    waitForTransactionReceipt: receipt,
    getTransactionReceipt: async () => { throw new Error("not found"); },
    getTransaction: async () => { if (!mempool) throw new Error("not found"); return {}; },
  }) as never;
  const token = { getBlockNumber: async () => 100n, getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(G - 1000 + Number(blockNumber) * 10) }) } as never;
  const cfg = { token: A, confirmations: 20n, logChunk: 1000n } as never;
  const lcfg = { callLedger: A } as never;
  const rcfg = { rewardsDistributor: A, scorerPk: PK, ledgerStartBlock: 0n, excluded: [], reference: "baseline", topFraction: 1, epochBudget: null } as never;

  it("receipt lost -> WAIT with the hash stored; root lands -> PUBLISHED from the chain, no second send, proofs served", async () => {
    epochs.clear();
    onchain = { hasPublished: false, lastEpoch: 0n, lastRootSetAt: 0n, free: 10n ** 21n, root: "0x" + "00".repeat(32) };
    mempool = true;
    const deps = (l: unknown) => ({ db, token, ledger: l as never, cfg, lcfg, rcfg });
    const lost = ledger(async () => { throw new Error("Timed out while waiting for transaction"); });
    const r1 = await closeEpoch(deps(lost), 0, true);
    expect(r1.state).toBe("WAIT");
    expect(sent.map((s) => s.functionName)).toEqual(["setEpochRoot"]);
    const sentRoot = (sent[0]!.args as unknown[])[1] as string;
    expect((epochs.get(0) as { tx_hash?: string }).tx_hash).toBeTruthy();
    // still in the mempool: the next pass waits, it does not recompute and resend
    expect((await closeEpoch(deps(lost), 0, true)).state).toBe("WAIT");
    expect(sent.length).toBe(1);
    // mined; meanwhile a buyback moved freeBalance, so a recomputed budget would differ
    onchain = { hasPublished: true, lastEpoch: 0n, lastRootSetAt: BigInt(G + 3 * EPOCH_LENGTH - 10), free: 2n * 10n ** 21n, root: sentRoot };
    const r3 = await closeEpoch(deps(lost), 0, true);
    expect(r3.state).toBe("PUBLISHED");
    expect(sent.length).toBe(1);
    expect(epochs.get(0)!.root).toBe(sentRoot);
    expect(await claimFor(db, 0, A)).not.toBeNull();
  });

  it("a root on-chain that is not the one stored stops the epoch loudly", async () => {
    epochs.clear();
    onchain = { hasPublished: true, lastEpoch: 0n, lastRootSetAt: 0n, free: 10n ** 21n, root: "0x" + "ab".repeat(32) };
    const r = await closeEpoch({ db, token, ledger: ledger(async () => ({})), cfg, lcfg, rcfg } as never, 0, true);
    expect(r.state).toBe("FAILED");
    expect(sent.length).toBe(0);
  });
});

