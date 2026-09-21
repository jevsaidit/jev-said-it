import { encodePacked, keccak256, parseAbi, type Address, type Hex } from "viem";
import { makeClient } from "../chain/client.js";
import { writeFileSync } from "node:fs";
import { loadAnnounceEnv, loadConfig, loadLedgerConfig, loadRewardsConfig, loadTreasuryEnv, POOL_MANAGER } from "../config.js";
import { runTreasury, type TreasuryConfig } from "../treasury/treasury.js";
import { announce } from "../announcer/announcer.js";
import { makeSender } from "../announcer/channels.js";
import { resolveDue } from "../resolve/resolve.js";
import { closeEpoch } from "../score/epoch.js";
import { buildTree } from "../score/merkle.js";
import { serve } from "../server/service.js";
import { assertSingleLedger, balanceAt, connect, getCursor, migrate } from "../db/db.js";
import { runCycle } from "../indexer/cycle.js";
import { lastSqrtPriceAt, V4_CURSOR } from "../indexer/v4.js";
import { jevModel } from "../questions/jev.js";
import { stubModel, type VerdictModel } from "../questions/model.js";
import { LEDGER_ABI, openBatch } from "../questions/open.js";
import { transferCursor } from "../indexer/transfers.js";

// Exit codes: 0 = done / verified · 1 = verified and WRONG · 2 = observation failed.
// Run with `node dist/cli/main.js` or `tsx`, not with `pnpm run`: pnpm reduces every non-zero exit to 1.
const EXIT_OK = 0;
const EXIT_WRONG = 1;
const EXIT_BLIND = 2;

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const EXTSLOAD = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
const POOLS_SLOT = 6n; // StateLibrary.POOLS_SLOT from v4-core

const cfg = loadConfig();
const client = makeClient(cfg.rpcUrl);
// The token chain: the same as the data chain in production, a different one in testnet trials.
const tokenClient = cfg.tokenRpcUrl === cfg.rpcUrl ? client : makeClient(cfg.tokenRpcUrl);
const db = connect(cfg.databaseUrl);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function index(loop: boolean): Promise<number> {
  const pollMs = Number(process.env.POLL_MS ?? 5000);
  for (;;) {
    const out = await runCycle(client, db, cfg, tokenClient);
    console.log(JSON.stringify({ at: new Date().toISOString(), ...out }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    if (!loop) return out.state === "BLIND" ? EXIT_BLIND : EXIT_OK;
    await sleep(pollMs);
  }
}

async function verifyBalances(n: number): Promise<number> {
  const block = await getCursor(db, transferCursor(cfg.token));
  if (block === null) {
    console.log("NOT MEASURABLE: the Transfer index is empty");
    return EXIT_BLIND;
  }
  // Only NON-zero balances: the most active addresses are routers and bots that hold no tokens,
  // and a sample of "0 = 0" passes even with a broken sum. Half the largest holders, half random.
  const q = await db.query<{ a: string }>(
    `WITH m AS (SELECT to_addr a, value v FROM transfers WHERE token = $1 AND block <= $3
                UNION ALL SELECT from_addr, -value FROM transfers WHERE token = $1 AND block <= $3),
          b AS (SELECT a, SUM(v) bal FROM m WHERE a <> '0x0000000000000000000000000000000000000000' GROUP BY a HAVING SUM(v) > 0)
     (SELECT a FROM b ORDER BY bal DESC LIMIT $2) UNION (SELECT a FROM b ORDER BY random() LIMIT $2)`,
    [cfg.token.toLowerCase(), Math.ceil(n / 2), block.toString()],
  );
  let wrong = 0;
  for (const { a } of q.rows) {
    let chain: bigint;
    try {
      chain = await tokenClient.readContract({ address: cfg.token, abi: ERC20, functionName: "balanceOf", args: [a as Address], blockNumber: block });
    } catch (e) {
      console.log(`NOT MEASURABLE: the node does not serve state at block ${block} (${(e as Error).message.split("\n")[0]})`);
      return EXIT_BLIND;
    }
    const mine = await balanceAt(db, cfg.token, a, block);
    const ok = mine === chain;
    if (!ok) wrong++;
    console.log(`${ok ? "ok " : "ERR"} ${a} index=${mine} chain=${chain}`);
  }
  const minted = await db.query<{ s: string }>(
    `SELECT COALESCE(SUM(CASE WHEN from_addr = $2 THEN value ELSE 0 END),0) - COALESCE(SUM(CASE WHEN to_addr = $2 THEN value ELSE 0 END),0) s
       FROM transfers WHERE token = $1 AND block <= $3`,
    [cfg.token.toLowerCase(), "0x0000000000000000000000000000000000000000", block.toString()],
  );
  const supply = await tokenClient.readContract({ address: cfg.token, abi: ERC20, functionName: "totalSupply", blockNumber: block });
  const supplyOk = BigInt(minted.rows[0]!.s) === supply;
  if (!supplyOk) wrong++;
  console.log(`${supplyOk ? "ok " : "ERR"} totalSupply index=${minted.rows[0]!.s} chain=${supply}`);
  console.log(`${q.rows.length} addresses + supply at block ${block}: ${wrong === 0 ? "ALL MATCH" : `${wrong} MISMATCHES`}`);
  return wrong === 0 ? EXIT_OK : EXIT_WRONG;
}

async function verifyPrice(arg: string | undefined): Promise<number> {
  const block = await getCursor(db, V4_CURSOR);
  if (block === null) {
    console.log("NOT MEASURABLE: the v4 index is empty");
    return EXIT_BLIND;
  }
  // Without an argument: the Pons pool with the most recent swap, i.e. the one moving right now.
  const poolId = (arg ??
    (await db.query<{ pool_id: string }>("SELECT pool_id FROM swaps ORDER BY block DESC, log_index DESC LIMIT 1")).rows[0]
      ?.pool_id) as Hex | undefined;
  if (!poolId) {
    console.log("NOT MEASURABLE: no swap indexed");
    return EXIT_BLIND;
  }
  const mine = await lastSqrtPriceAt(db, poolId, block);
  if (!mine) {
    console.log(`NOT MEASURABLE: no swap indexed on the pool up to block ${block}`);
    return EXIT_BLIND;
  }
  const slot = keccak256(encodePacked(["bytes32", "uint256"], [poolId, POOLS_SLOT]));
  let raw: Hex;
  try {
    raw = await client.readContract({ address: POOL_MANAGER, abi: EXTSLOAD, functionName: "extsload", args: [slot], blockNumber: block });
  } catch (e) {
    console.log(`NOT MEASURABLE: the node does not serve state at block ${block} (${(e as Error).message.split("\n")[0]})`);
    return EXIT_BLIND;
  }
  const chain = BigInt(raw) & ((1n << 160n) - 1n);
  const ok = chain === mine.sqrtPriceX96;
  console.log(`${ok ? "MATCH" : "MISMATCH"} sqrtPriceX96 index=${mine.sqrtPriceX96} (swap at block ${mine.block}) chain=${chain} (slot0 at block ${block})`);
  return ok ? EXIT_OK : EXIT_WRONG;
}

/** MODEL = none | jev | stub. `stub` refuses on mainnet (inside stubModel). */
async function modelFromEnv(ledgerChainId: number): Promise<VerdictModel | null> {
  const name = process.env.MODEL ?? "none";
  if (name === "none") return null;
  if (name === "stub") return stubModel(ledgerChainId, process.env.STUB_P ? Number(process.env.STUB_P) : undefined);
  if (name === "jev") {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error("MODEL=jev requires TYPESAFE_API_KEY");
    return jevModel({ apiKey, model: process.env.JEV_MODEL || "jev-latest", baseUrl: process.env.TYPESAFE_BASE_URL || undefined });
  }
  throw new Error(`unknown MODEL: ${name} (none | jev | stub)`);
}

function treasuryFromEnv(): TreasuryConfig | null {
  const t = loadTreasuryEnv();
  if (!t) return null;
  const l = loadLedgerConfig();
  return { ...t, token: cfg.token, keeperPk: l.keeperPk, rpcUrl: l.ledgerRpcUrl };
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "migrate":
      await migrate(db);
      return EXIT_OK;
    case "index":
      return index(args.includes("--loop"));
    case "open-questions": {
      const lcfg = loadLedgerConfig();
      const ledger = makeClient(lcfg.ledgerRpcUrl);
      // --stub stays as a shortcut for trials; otherwise MODEL decides, as for `serve`.
      // The model is chosen BEFORE the ledger guard: refusing the stub on mainnet is the most
      // basic constraint, and it must be the one that speaks when it fires.
      if (args.includes("--stub")) process.env.MODEL = "stub";
      const model = await modelFromEnv(await ledger.getChainId());
      if (!model) throw new Error("MODEL=none: no model, no questions");
      await assertSingleLedger(db, lcfg.callLedger, await ledger.getChainId());
      const out = await openBatch({
        db,
        ledger,
        cfg: lcfg,
        model,
        dataChainId: await client.getChainId(),
        excludeTokens: [cfg.token],
        data: client,
      });
      console.log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
      return out.state === "FAILED" ? EXIT_WRONG : EXIT_OK;
    }
    case "serve": {
      // The Railway service. The CallLedger and rewards are optional: without them, it only indexes.
      await migrate(db); // on Railway the database starts empty
      const lcfg = process.env.CALL_LEDGER ? loadLedgerConfig() : null;
      const rcfg = lcfg && process.env.REWARDS_DISTRIBUTOR ? loadRewardsConfig() : null;
      if (lcfg) await assertSingleLedger(db, lcfg.callLedger, await makeClient(lcfg.ledgerRpcUrl).getChainId());
      const model = await modelFromEnv(await makeClient(lcfg?.ledgerRpcUrl ?? cfg.rpcUrl).getChainId());
      await serve({
        db,
        data: client,
        token: tokenClient,
        cfg,
        lcfg,
        rcfg,
        model,
        treasury: lcfg ? treasuryFromEnv() : null,
        announcer: loadAnnounceEnv(),
        port: Number(process.env.PORT ?? 8080),
        // Railway wants listening on all interfaces; locally, pass HOST=127.0.0.1.
        host: process.env.HOST ?? "0.0.0.0",
        pollMs: Number(process.env.POLL_MS ?? 15000),
        healthMaxAgeSec: Number(process.env.HEALTH_MAX_AGE_SEC ?? 600),
        maxLagBlocks: BigInt(process.env.MAX_LAG_BLOCKS ?? 2000), // ~3.5 minutes at 0.105 s/block
      });
      return EXIT_OK;
    }
    case "treasury": {
      const t = treasuryFromEnv();
      if (!t) throw new Error("FEE_ROUTER not configured");
      const lcfg = loadLedgerConfig();
      const ledger = makeClient(lcfg.ledgerRpcUrl);
      const genesis = Number(await ledger.readContract({ address: lcfg.callLedger, abi: LEDGER_ABI, functionName: "genesis" }));
      const out = await runTreasury(db, ledger, t, genesis);
      console.log(JSON.stringify(out));
      return out.state === "FAILED" ? EXIT_WRONG : EXIT_OK;
    }
    case "announce":
    case "announce-pin": {
      const an = loadAnnounceEnv();
      if (!an) throw new Error("ANNOUNCE_MODE is off");
      await migrate(db);
      const now = Math.floor(Date.now() / 1000);
      const events =
        cmd === "announce-pin"
          ? [{ event: { kind: "pin" as const, key: "pin:v1" }, channels: ["telegram", "x"] as Array<"telegram" | "x"> }]
          : undefined;
      const r = await announce(db, makeSender(an.mode, an), { site: an.site, xDailyCap: an.xDailyCap, now, events });
      console.log(JSON.stringify(r));
      return r.failed || r.refused ? EXIT_WRONG : EXIT_OK;
    }
    case "resolve": {
      const out = await resolveDue(db, client, cfg.v4StartBlock);
      console.log(JSON.stringify(out));
      return EXIT_OK;
    }
    case "close-epoch": {
      const epoch = Number(args[0]);
      if (!Number.isInteger(epoch) || epoch < 0) throw new Error("usage: close-epoch <epoch> [--publish]");
      const lcfg = loadLedgerConfig();
      await assertSingleLedger(db, lcfg.callLedger, await makeClient(lcfg.ledgerRpcUrl).getChainId());
      const out = await closeEpoch(
        { db, token: tokenClient, ledger: makeClient(lcfg.ledgerRpcUrl), cfg, lcfg, rcfg: loadRewardsConfig() },
        epoch,
        args.includes("--publish"),
      );
      console.log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
      return out.state === "FAILED" ? EXIT_WRONG : EXIT_OK;
    }
    case "merkle-fixture": {
      // Fixed tree for the Foundry compatibility test (contracts/test/MerkleFixture.t.sol).
      const out = args[0];
      if (!out) throw new Error("usage: merkle-fixture <file.json>");
      const amounts = [
        { address: "0x1000000000000000000000000000000000000001", amount: 177_777_777_777_777_777_777n },
        { address: "0x2000000000000000000000000000000000000002", amount: 22_222_222_222_222_222_222n },
        { address: "0x3000000000000000000000000000000000000003", amount: 1n },
      ];
      const { root, claims } = buildTree(amounts);
      const budget = amounts.reduce((s, a) => s + a.amount, 0n).toString();
      writeFileSync(out, JSON.stringify({ root, budget, claims }, null, 2) + "\n");
      console.log(root);
      return EXIT_OK;
    }
    case "verify-balances":
      return verifyBalances(Number(args[0] ?? 20));
    case "verify-price":
      return verifyPrice(args[0]);
    default:
      console.log("commands: migrate | serve | treasury | announce | announce-pin | index [--loop] | open-questions --stub | resolve | close-epoch <n> [--publish] | merkle-fixture <out> | verify-balances [n] | verify-price [poolId]");
      return EXIT_BLIND;
  }
}

main()
  .then(async (code) => {
    await db.end();
    process.exit(code);
  })
  .catch(async (e) => {
    // First line only: a full viem error embeds the request URL, and an RPC URL may carry a key.
    console.error(JSON.stringify({ fatal: (e as Error).message?.split("\n")[0] ?? String(e) }));
    await db.end();
    process.exit(EXIT_BLIND);
  });
