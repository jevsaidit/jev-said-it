import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PublicClient } from "viem";
import type pg from "pg";
import { errText, makeClient } from "../chain/client.js";
import { CURVE_TIMEOUT_MS, curveView } from "./curve.js";
import { type Config, type LedgerConfig, type RewardsConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { runCycle } from "../indexer/cycle.js";
import { EPOCH_LENGTH, epochOf } from "../questions/epoch.js";
import type { VerdictModel } from "../questions/model.js";
import { LEDGER_ABI, openBatch } from "../questions/open.js";
import { resolveDue } from "../resolve/resolve.js";
import { closeEpoch, DISTRIBUTOR_ABI, epochStartBlock } from "../score/epoch.js";
import { calibration, claimFor, epochView, holderView, leaderboard, questionJson, treasuryOps } from "./feed.js";
import { getCursor } from "../db/db.js";
import { transferCursor } from "../indexer/transfers.js";
import { runTreasury, type TreasuryConfig } from "../treasury/treasury.js";
import { announce } from "../announcer/announcer.js";
import { makeSender } from "../announcer/channels.js";
import type { AnnounceEnv } from "../config.js";

type TaskState = { state: string; at: string; detail?: unknown };

export interface ServiceDeps {
  db: Db;
  data: PublicClient;
  token: PublicClient; // token chain: in production it is `data`
  cfg: Config;
  lcfg: LedgerConfig | null; // null = no CallLedger: index only
  rcfg: RewardsConfig | null; // null = no rewards
  model: VerdictModel | null; // null = no model: no questions are opened, and this is declared
  treasury: TreasuryConfig | null; // null = the engine leaves the fees alone
  announcer: AnnounceEnv | null; // null = silent
  port: number;
  host: string;
  pollMs: number;
  healthMaxAgeSec: number;
  maxLagBlocks: bigint;
}

/** Swaps older than this many blocks behind the newest indexed one are dropped: ~7 days at 0.105s. */
const PRUNE_KEEP_BLOCKS = BigInt(process.env.PRUNE_KEEP_BLOCKS ?? 5_800_000);

const jsonOut = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

/** One writer at a time. Railway keeps the old container alive until the new one is healthy, so for
 *  a minute every deploy runs two engines on the same database and the same keeper key: two batches
 *  in one epoch, or a nonce clash. The lock lives on one dedicated Postgres session (advisory locks
 *  are per session, and a pool hands out any); the loser keeps indexing and serving, sends nothing. */
const WRITER_LOCK_KEY = 0x4a45_5653; // "JEVS"

export async function serve(d: ServiceDeps): Promise<void> {
  const ledger = d.lcfg ? makeClient(d.lcfg.ledgerRpcUrl) : null;
  const chainClient = makeClient(d.cfg.rpcUrl);
  const tasks: Record<string, TaskState> = {};
  let lastSeenAt = 0; // last index cycle in which the engine LOOKED at the chain (OK or IDLE)
  let lag: bigint | null = null; // blocks between the most-behind index and the head
  const startedAt = Date.now();
  let lockClient: pg.PoolClient | null = null;
  let writer = false;
  const takeWriterLock = async (): Promise<boolean> => {
    if (writer) return true;
    try {
      lockClient ??= await d.db.connect();
      const r = await lockClient.query<{ got: boolean }>("SELECT pg_try_advisory_lock($1) got", [WRITER_LOCK_KEY]);
      writer = r.rows[0]?.got === true;
    } catch (e) {
      // The session that held the lock may be gone with the connection: start again from a new one.
      lockClient?.release(true);
      lockClient = null;
      writer = false;
      mark("writer", "BLIND", errText(e));
    }
    return writer;
  };
  const mark = (name: string, state: string, detail?: unknown) => {
    // A task is logged only when its state CHANGES: a cycle every 15s with five identical lines
    // drowns the one line that matters. /health exposes the current state anyway.
    const changed = tasks[name]?.state !== state || (state !== "IDLE" && state !== "OK" && jsonOut(tasks[name]?.detail) !== jsonOut(detail));
    tasks[name] = { state, at: new Date().toISOString(), detail };
    if (changed) console.log(jsonOut({ at: tasks[name].at, task: name, state, detail }));
  };
  // Each task is isolated: an error in one closes THAT task as BLIND, not the service.
  const task = async (name: string, fn: () => Promise<{ state: string; detail?: unknown }>) => {
    try {
      const r = await fn();
      mark(name, r.state, r.detail);
    } catch (e) {
      mark(name, "BLIND", errText(e));
    }
  };

  let stopping = false;
  const loop = async () => {
    while (!stopping) {
      await task("index", async () => {
        const out = await runCycle(d.data, d.db, d.cfg, d.token);
        if (out.state !== "BLIND") {
          lastSeenAt = Date.now();
          lag = out.lag;
        } else lag = null; // a lag measured before going blind is not a lag: nobody knows where the head is now
        return { state: out.state, detail: out };
      });
      // Old swaps are never read again: candidates look back 48h, resolution 6h + the window.
      // Without this the table grew by ~2.6 rows per block for the life of the database.
      await task("prune", async () => {
        const r = await d.db.query("DELETE FROM swaps WHERE block < (SELECT COALESCE(MAX(block), 0) - $1 FROM swaps)", [PRUNE_KEEP_BLOCKS.toString()]);
        return { state: r.rowCount ? "OK" : "IDLE", detail: r.rowCount ? { deleted: r.rowCount } : undefined };
      });
      const isWriter = await takeWriterLock();
      if (!isWriter) {
        mark("writer", "STANDBY", "another engine holds the writer lock: indexing and serving only");
        await new Promise((r) => setTimeout(r, d.pollMs));
        continue;
      }
      mark("writer", "OK");
      if (!d.lcfg || !ledger) mark("questions", "DISABLED", "CALL_LEDGER not configured");
      else if (!d.model) mark("questions", "DISABLED", "no model configured: no questions are opened");
      else {
        const lcfg = d.lcfg;
        const model = d.model;
        // With the index behind, candidates would be chosen on stale swaps: nothing new is opened,
        // but a batch already sent is still settled from its receipt (or it stays PENDING for hours).
        const behind = lag === null || lag > d.maxLagBlocks;
        await task("questions", async () => {
          const out = await openBatch({ db: d.db, ledger, cfg: lcfg, model, dataChainId: await d.data.getChainId(), excludeTokens: [d.cfg.token], data: d.data, reconcileOnly: behind });
          if (behind && out.state === "SKIPPED") return { state: "WAITING", detail: `index ${lag ?? "?"} blocks behind (maximum ${d.maxLagBlocks})` };
          return { state: out.state, detail: out.state === "OPENED" ? { epoch: out.epoch, n: out.ids.length, tx: out.tx } : out.reason };
        });
      }
      await task("resolve", async () => {
        const out = await resolveDue(d.db, d.data, d.cfg.v4StartBlock);
        return { state: out.waiting ? "WAITING" : out.resolved ? "OK" : "IDLE", detail: out };
      });
      if (d.treasury && d.lcfg && ledger) {
        // Before the rewards: the buyback funds the distributor, then an epoch root can pay from it.
        const tcfg = d.treasury;
        const lcfg = d.lcfg;
        await task("treasury", async () => {
          const genesis = Number(await ledger.readContract({ address: lcfg.callLedger, abi: LEDGER_ABI, functionName: "genesis" }));
          const out = await runTreasury(d.db, ledger, tcfg, genesis);
          return { state: out.state, detail: out };
        });
      } else mark("treasury", "DISABLED", "FEE_ROUTER not configured");
      if (d.lcfg && d.rcfg && ledger) {
        const lcfg = d.lcfg;
        const rcfg = d.rcfg;
        await task("rewards", async () => {
          // The first finished epoch that is neither published nor declared not payable.
          const genesis = Number(await ledger.readContract({ address: lcfg.callLedger, abi: LEDGER_ABI, functionName: "genesis" }));
          const now = Number((await ledger.getBlock({ blockTag: "latest" })).timestamp);
          const current = epochOf(now, genesis);
          // A guardian void is an on-chain fact the table must learn: a voided epoch's claims are
          // not served (/claim, /holder) and not announced. Checked while the void window is open,
          // plus a margin (the void can land at the last second and this loop runs every 15s).
          const recent = await d.db.query<{ epoch: number }>("SELECT epoch FROM epochs WHERE state = 'PUBLISHED' AND published_at > now() - interval '13 hours'");
          for (const r of recent.rows) {
            const voided = await ledger.readContract({ address: rcfg.rewardsDistributor, abi: DISTRIBUTOR_ABI, functionName: "epochVoided", args: [BigInt(r.epoch)] });
            if (voided) await d.db.query("UPDATE epochs SET state = 'VOIDED', reason = 'voided by the guardian on-chain' WHERE epoch = $1 AND state = 'PUBLISHED'", [r.epoch]);
          }
          const done = await d.db.query<{ epoch: number }>("SELECT epoch FROM epochs WHERE state IN ('PUBLISHED','NOT_PAYABLE','VOIDED')");
          const closed = new Set(done.rows.map((r) => r.epoch));
          for (let e = 0; e < current; e++) {
            if (closed.has(e)) continue;
            const out = await closeEpoch({ db: d.db, token: d.token, ledger, cfg: d.cfg, lcfg, rcfg }, e, true);
            if (out.state === "NOT_PAYABLE") continue; // declared: move on to the next one
            return { state: out.state, detail: { epoch: e, ...out } };
          }
          return { state: "IDLE" };
        });
      }
      if (d.announcer) {
        const an = d.announcer;
        const seenAgo = lastSeenAt ? (Date.now() - lastSeenAt) / 1000 : Infinity;
        // A blind engine stays silent: announcing from stale data would be announcing something false.
        if (seenAgo > 120) mark("announce", "WAITING", "engine not seeing the chain: silent");
        else
          await task("announce", async () => {
            const r = await announce(d.db, makeSender(an.mode, an), { site: an.site, xDailyCap: an.xDailyCap, now: Math.floor(Date.now() / 1000) });
            return { state: r.failed || r.refused ? "PARTIAL" : r.sent ? "OK" : "IDLE", detail: r };
          });
      } else mark("announce", "DISABLED", "ANNOUNCE_MODE off");
      // Railway's healthcheck only applies at deploy: afterwards, nobody restarts a blind engine.
      // So it exits on its own, and the restart policy brings it back up; if it keeps falling, Railway
      // marks the deploy as crashed, which is a visible signal. A live, blind process would not be.
      const blindFor = (Date.now() - (lastSeenAt || startedAt)) / 1000;
      if (blindFor > d.healthMaxAgeSec) {
        console.error(jsonOut({ fatal: `blind for ${Math.round(blindFor)}s: exiting, to be restarted`, tasks }));
        process.exit(3);
      }
      await new Promise((r) => setTimeout(r, d.pollMs));
    }
  };

  const health = () => {
    const age = lastSeenAt ? Math.round((Date.now() - lastSeenAt) / 1000) : null;
    const ok = age !== null && age <= d.healthMaxAgeSec;
    return { ok, lastSeenAgeSec: age, maxAgeSec: d.healthMaxAgeSec, indexLagBlocks: lag, model: d.model?.id ?? null, tasks };
  };

  const send = (res: ServerResponse & { cacheKey?: string }, code: number, body: string, type = "application/json") => {
    if (res.cacheKey && code === 200) {
      if (cached.size > 5000) cached.clear();
      cached.set(res.cacheKey, { at: Date.now(), code, body });
    }
    res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*", "cache-control": "public, max-age=15" });
    res.end(body);
  };
  // The public feed must not turn visitors into RPC calls: the RPC's rate limit is shared with the
  // indexer, and a blind indexer makes the engine exit. Chain id and genesis never change; the head
  // timestamp is reused for 5s; start blocks are cached per epoch; responses for 15s (= cache-control).
  let meta: { chainId: number; genesis: number } | null = null;
  const ledgerMeta = async () => {
    if (!meta) {
      meta = {
        chainId: await ledger!.getChainId(),
        genesis: Number(await ledger!.readContract({ address: d.lcfg!.callLedger, abi: LEDGER_ABI, functionName: "genesis" })),
      };
    }
    return meta;
  };
  let head: { at: number; ts: number } | null = null;
  const chainNow = async () => {
    if (!head || Date.now() - head.at > 5000) head = { at: Date.now(), ts: Number((await ledger!.getBlock({ blockTag: "latest" })).timestamp) };
    return head.ts;
  };
  const startBlocks = new Map<number, bigint>();
  const cached = new Map<string, { at: number; code: number; body: string }>();
  // 15s = the cache-control the feed already declares. FEED_CACHE_SEC=0 for tests that move fast.
  const FEED_CACHE_MS = Number(process.env.FEED_CACHE_SEC ?? 15) * 1000;

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") return send(res, 405, jsonOut({ error: "GET only" }));
    const path = new URL(req.url ?? "/", "http://x").pathname;
    let m: RegExpMatchArray | null;
    if (path === "/health") {
      const h = health();
      // 503 when the engine has not looked at the chain for too long: Railway restarts it. Never 200 while blind.
      return send(res, h.ok ? 200 : 503, jsonOut(h));
    }
    if ((m = path.match(/^\/q\/(0x[0-9a-fA-F]{64})\.json$/))) {
      const j = await questionJson(d.db, m[1]!);
      return j ? send(res, 200, j) : send(res, 404, jsonOut({ error: "no such question" }));
    }
    if (path === "/epochs/current") {
      if (!d.lcfg || !ledger) return send(res, 404, jsonOut({ error: "CallLedger not configured" }));
      // A chain read that fails is "could not look", not "nothing": 502, which the site shows as blind.
      let genesis: number;
      let now: number;
      try {
        genesis = (await ledgerMeta()).genesis;
        now = await chainNow();
      } catch (e) {
        return send(res, 502, jsonOut({ state: "blind", error: errText(e) }));
      }
      const e = epochOf(now, genesis);
      return send(res, 200, jsonOut({ ...(await epochView(d.db, e, now)), genesis, now }));
    }
    if (path === "/curve") {
      // Three states, like everything else that reads the chain: a failed read is 502, never "graduated: false".
      try {
        const view = await Promise.race([
          curveView(chainClient, d.cfg.token as `0x${string}`),
          new Promise((_, no) => setTimeout(() => no(new Error(`curve read did not answer in ${CURVE_TIMEOUT_MS}ms`)), CURVE_TIMEOUT_MS)),
        ]);
        return send(res, 200, jsonOut(view));
      } catch (e) {
        return send(res, 502, jsonOut({ state: "blind", error: errText(e) }));
      }
    }
    if (path === "/config") {
      // What a wallet needs to play: the ledger's chain and the three addresses. Read from the
      // engine's own configuration, so the site cannot point at a different contract than the one scored.
      return send(res, 200, jsonOut({
        chainId: ledger ? (await ledgerMeta()).chainId : null,
        token: d.cfg.token,
        callLedger: d.lcfg?.callLedger ?? null,
        rewardsDistributor: d.rcfg?.rewardsDistributor ?? null,
      }));
    }
    if ((m = path.match(/^\/holder\/(0x[0-9a-fA-F]{40})$/))) {
      if (!d.lcfg || !ledger) return send(res, 404, jsonOut({ error: "CallLedger not configured" }));
      const { genesis } = await ledgerMeta();
      const epoch = epochOf(await chainNow(), genesis);
      // The start block of an epoch never changes once found: one binary search per epoch, not per request.
      let startBlock = startBlocks.get(epoch) ?? null;
      if (startBlock === null) {
        startBlock = await epochStartBlock(d.token, genesis, epoch);
        // Cached only once the epoch is 2 minutes old: right at the boundary a lagging token node
        // would answer with its own head, and that wrong block would be kept for the whole epoch.
        if (startBlock !== null && (await chainNow()) - (genesis + epoch * EPOCH_LENGTH) > 120) startBlocks.set(epoch, startBlock);
      }
      const indexedBlock = await getCursor(d.db, transferCursor(d.cfg.token));
      return send(res, 200, jsonOut(await holderView(d.db, { token: d.cfg.token, account: m[1]!, epoch, startBlock, indexedBlock })));
    }
    if ((m = path.match(/^\/epochs\/(\d{1,6})$/))) return send(res, 200, jsonOut(await epochView(d.db, Number(m[1]))));
    if ((m = path.match(/^\/leaderboard\/(\d{1,6})$/))) {
      const l = await leaderboard(d.db, Number(m[1]));
      return l ? send(res, 200, jsonOut(l)) : send(res, 404, jsonOut({ error: "epoch not closed yet" }));
    }
    if ((m = path.match(/^\/claim\/(\d{1,6})\/(0x[0-9a-fA-F]{40})$/))) {
      const c = await claimFor(d.db, Number(m[1]), m[2]!);
      return c ? send(res, 200, jsonOut(c)) : send(res, 404, jsonOut({ error: "no reward for this address in this epoch" }));
    }
    if (path === "/calibration") return send(res, 200, jsonOut(await calibration(d.db)));
    if (path === "/treasury") return send(res, 200, jsonOut(await treasuryOps(d.db)));
    return send(res, 404, jsonOut({ error: "not found", routes: ["/health", "/config", "/curve", "/holder/:address", "/epochs/current", "/epochs/:n", "/q/:id.json", "/leaderboard/:n", "/claim/:n/:address", "/calibration", "/treasury"] }));
  };

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const cacheable = req.method === "GET" && /^\/(epochs\/current|holder\/0x[0-9a-fA-F]{40}|calibration)$/.test(path);
    const hit = cacheable ? cached.get(path) : undefined;
    if (hit && Date.now() - hit.at < FEED_CACHE_MS) return send(res, hit.code, hit.body);
    if (cacheable) (res as ServerResponse & { cacheKey?: string }).cacheKey = path;
    route(req, res).catch((e) => send(res, 500, jsonOut({ error: errText(e) })));
  });
  await new Promise<void>((r) => server.listen(d.port, d.host, r));
  console.log(jsonOut({ serving: d.port, model: d.model?.id ?? null, ledger: d.lcfg?.callLedger ?? null }));

  const stop = () => {
    stopping = true;
    server.close();
    // The loop can be stuck in retries against a chain that does not answer: wait for the end of
    // the cycle, but no longer than 10s. All state is in Postgres, an exit mid-cycle loses nothing
    // (each cursor advances in the same transaction as its data).
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await loop();
}
