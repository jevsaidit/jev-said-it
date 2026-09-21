import type { Db } from "../db/db.js";
import { P_SCALE, parseProb } from "../score/score.js";

// The public feed (spec §9.4). Everything that comes out of here is already public on-chain or
// committed by an on-chain hash: the feed makes it readable, it adds no trust.

interface QRow {
  id: string;
  epoch: number;
  deadline: string;
  horizon: number;
  token: string;
  pool_id: string;
  json: string;
  status: string;
  outcome: string | null;
  symbol: string | null;
}

// The shape is the one the site declares in site/README.md (id, token, symbol, p, model, deadline,
// status, outcome), plus the fields needed to verify. status: OPEN = calls open, CLOSED =
// deadline passed and outcome not yet decided, RESOLVED = outcome decided (VOID/UNRESOLVABLE too).
function publicQuestion(r: QRow, now: number) {
  const j = JSON.parse(r.json) as Record<string, string>;
  const status = r.outcome !== null ? "RESOLVED" : now < Number(r.deadline) ? "OPEN" : "CLOSED";
  return {
    id: r.id,
    epoch: r.epoch,
    kind: j.kind,
    token: r.token,
    symbol: r.symbol,
    status,
    pool: r.pool_id,
    deadline: Number(r.deadline),
    resolvesAt: Number(r.deadline) + r.horizon,
    model: j.model,
    p: j.p,
    baseline: j.baseline,
    baselineSource: j.baselineSource,
    outcome: r.outcome, // null = not yet resolved
    commitment: `/q/${r.id}.json`,
  };
}

export async function questionJson(db: Db, id: string): Promise<string | null> {
  // The EXACT text whose keccak256 is the id: never reformatted, never re-serialized.
  const r = await db.query<{ json: string }>("SELECT json FROM questions WHERE id = $1 AND status = 'OPEN'", [id.toLowerCase()]);
  return r.rows[0]?.json ?? null;
}

/** `now`: the ledger chain's timestamp if known, otherwise the clock (only for the status). */
export async function epochView(db: Db, epoch: number, now = Math.floor(Date.now() / 1000)) {
  const qs = await db.query<QRow>(
    "SELECT id, epoch, deadline, horizon, token, pool_id, json, status, outcome, symbol FROM questions WHERE epoch = $1 AND status = 'OPEN' ORDER BY deadline, id",
    [epoch],
  );
  const e = await db.query<{ state: string; reason: string | null; root: string | null; budget: string | null; tx_hash: string | null }>(
    "SELECT state, reason, root, budget, tx_hash FROM epochs WHERE epoch = $1",
    [epoch],
  );
  return { epoch, questions: qs.rows.map((r) => publicQuestion(r, now)), rewards: e.rows[0] ?? null };
}

export async function leaderboard(db: Db, epoch: number) {
  const r = await db.query<{ state: string; payload: string }>("SELECT state, payload FROM epochs WHERE epoch = $1", [epoch]);
  if (!r.rows[0]) return null;
  const p = JSON.parse(r.rows[0].payload) as { wallets?: unknown[]; reference?: string; claims?: Array<{ account: string; amount: string }> };
  return {
    epoch,
    state: r.rows[0].state,
    reference: p.reference,
    scoreScale: "1e8",
    wallets: p.wallets ?? [],
    rewards: (p.claims ?? []).map((c) => ({ account: c.account, amount: c.amount })),
  };
}

export async function claimFor(db: Db, epoch: number, account: string) {
  const r = await db.query<{ payload: string }>("SELECT payload FROM epochs WHERE epoch = $1 AND state = 'PUBLISHED'", [epoch]);
  if (!r.rows[0]) return null;
  const claims = (JSON.parse(r.rows[0].payload) as { claims?: Array<{ account: string; amount: string; proof: string[] }> }).claims ?? [];
  return claims.find((c) => c.account.toLowerCase() === account.toLowerCase()) ?? null;
}

/**
 * Public calibration (spec §8): the model's Brier against the baseline's Brier, on the same
 * resolved questions. It is published even when the model loses: it is the number that makes
 * everything else credible.
 */
export async function calibration(db: Db) {
  const r = await db.query<{ json: string; outcome: string }>("SELECT json, outcome FROM questions WHERE status = 'OPEN' AND outcome IN ('0','1')");
  let model = 0n;
  let base = 0n;
  const byModel = new Map<string, number>();
  for (const row of r.rows) {
    const j = JSON.parse(row.json) as { p: string; baseline: string; model: string };
    const y = row.outcome === "1" ? P_SCALE : 0n;
    model += (parseProb(j.p) - y) ** 2n;
    base += (parseProb(j.baseline) - y) ** 2n;
    byModel.set(j.model, (byModel.get(j.model) ?? 0) + 1);
  }
  const n = r.rows.length;
  const mean = (s: bigint) => (n === 0 ? null : Number(s) / n / 1e8);
  const counts = await db.query<{ outcome: string | null; n: string }>("SELECT outcome, count(*) n FROM questions WHERE status = 'OPEN' GROUP BY outcome");
  return {
    resolved: n,
    brierModel: mean(model),
    brierBaseline: mean(base),
    modelBeatsBaseline: n === 0 ? null : model < base,
    models: Object.fromEntries(byModel),
    outcomes: Object.fromEntries(counts.rows.map((c) => [c.outcome ?? "pending", Number(c.n)])),
    note: n < 30 ? "fewer than 30 resolved questions: not yet a measurement" : null,
  };
}

/** Every collection from the escrow and every buyback, newest first: the fee path, in public. */
export async function treasuryOps(db: Db) {
  const r = await db.query<{ epoch: number | null; kind: string; tx_hash: string | null; detail: string; at: Date }>(
    "SELECT epoch, kind, tx_hash, detail, at FROM treasury_ops ORDER BY id DESC LIMIT 200",
  );
  return r.rows.map((x) => ({ epoch: x.epoch, kind: x.kind, tx: x.tx_hash, at: x.at.toISOString(), ...JSON.parse(x.detail) }));
}
