import { readFileSync } from "node:fs";
import pg from "pg";

export type Db = pg.Pool;

export function connect(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  // Without this, an idle connection that drops (Postgres restarted) emits an 'error' nobody
  // listens to and Node crashes: the cycle must end BLIND, not take the process down.
  pool.on("error", (e) => console.error(`postgres: idle connection lost (${e.message})`));
  return pool;
}

export async function migrate(db: Db): Promise<void> {
  const sql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  await db.query(sql);
}

export async function getCursor(db: Db | pg.PoolClient, name: string): Promise<bigint | null> {
  const r = await db.query<{ block: string }>("SELECT block FROM cursors WHERE name = $1", [name]);
  return r.rows[0] ? BigInt(r.rows[0].block) : null;
}

export async function setCursor(db: pg.PoolClient, name: string, block: bigint): Promise<void> {
  await db.query(
    "INSERT INTO cursors (name, block) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET block = EXCLUDED.block",
    [name, block.toString()],
  );
}

export async function inTx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

/** Balance of `account` at the END of block `block`, rebuilt from Transfers (runbook §5.7). */
export async function balanceAt(db: Db, token: string, account: string, block: bigint): Promise<bigint> {
  const r = await db.query<{ bal: string }>(
    `SELECT COALESCE(SUM(CASE WHEN to_addr = $2 THEN value ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN from_addr = $2 THEN value ELSE 0 END), 0) AS bal
       FROM transfers
      WHERE token = $1 AND block <= $3 AND (to_addr = $2 OR from_addr = $2)`,
    [token.toLowerCase(), account.toLowerCase(), block.toString()],
  );
  return BigInt(r.rows[0]?.bal ?? "0");
}

/**
 * One database = one deploy. Questions carry their ledger and chain in the committed JSON: if the
 * database holds questions from ANOTHER CallLedger, outcomes and rewards of one chain would end up
 * on the other (it happened on 21/09: 20 anvil questions read as testnet epoch 0). It refuses to start.
 */
export async function assertSingleLedger(db: Db, callLedger: string, chainId: number): Promise<void> {
  const r = await db.query<{ ledger: string; chain: string; n: string }>(
    `SELECT json::jsonb->>'ledger' AS ledger, json::jsonb->>'ledgerChainId' AS chain, count(*) n
       FROM questions GROUP BY 1, 2`,
  );
  const alien = r.rows.filter((x) => x.ledger !== callLedger.toLowerCase() || x.chain !== String(chainId));
  if (alien.length) {
    const what = alien.map((x) => `${x.n} questions from ledger ${x.ledger} on chain ${x.chain}`).join("; ");
    throw new Error(`database belongs to another deploy: ${what}. One database per CallLedger`);
  }
}
