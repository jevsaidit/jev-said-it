import type { Db } from "../db/db.js";
import type { AnnounceEvent, Q } from "./soul.js";

type QRow = { id: string; epoch: number; deadline: string; tx_hash: string; token: string; symbol: string | null; json: string; outcome: string | null };

const toQ = (r: QRow): Q => ({ id: r.id, token: r.token, symbol: r.symbol, p: (JSON.parse(r.json) as { p: string }).p, outcome: r.outcome });

export function batchesFrom(rows: QRow[]): Array<{ tx: string; epoch: number; deadline: number; questions: QRow[] }> {
  const m = new Map<string, { tx: string; epoch: number; deadline: number; questions: QRow[] }>();
  for (const r of rows) {
    const b = m.get(r.tx_hash) ?? { tx: r.tx_hash, epoch: r.epoch, deadline: Number(r.deadline), questions: [] };
    b.questions.push(r);
    m.set(r.tx_hash, b);
  }
  return [...m.values()];
}

/** For X: one outcome per batch, the one where jev was most confident, right or wrong. */
export function strikingOutcome(rows: QRow[]): QRow | null {
  const resolved = rows.filter((r) => r.outcome === "0" || r.outcome === "1");
  if (!resolved.length) return null;
  return resolved.sort((a, b) => Math.abs(Number(toQ(b).p) - 0.5) - Math.abs(Number(toQ(a).p) - 0.5))[0]!;
}

export const CLAIM_DELAY_SEC = 12 * 3600; // RewardsDistributor.CLAIM_DELAY
const CLOSING_WINDOW_SEC = 30 * 60;
/** Only what happened in the last two days is announceable: every cycle used to re-read every
 *  question, epoch and swap ever, one SELECT per (event, channel), growing without bound. */
const RECENT_SEC = 2 * 24 * 3600;

/** Everything announceable right now, each with a stable key and the channels it is meant for. */
export async function collectEvents(db: Db, now: number): Promise<Array<{ event: AnnounceEvent; channels: Array<"telegram" | "x"> }>> {
  const out: Array<{ event: AnnounceEvent; channels: Array<"telegram" | "x"> }> = [];
  const qs = (await db.query<QRow>("SELECT id, epoch, deadline, tx_hash, token, symbol, json, outcome FROM questions WHERE status = 'OPEN' AND deadline > $1 ORDER BY deadline, id", [now - RECENT_SEC])).rows;
  for (const b of batchesFrom(qs)) {
    out.push({ event: { kind: "batch_opened", key: `open:${b.tx}`, epoch: b.epoch, deadline: b.deadline, questions: b.questions.map(toQ) }, channels: ["telegram", "x"] });
    if (now < b.deadline && now >= b.deadline - CLOSING_WINDOW_SEC) {
      out.push({ event: { kind: "closing_soon", key: `closing:${b.tx}`, epoch: b.epoch, deadline: b.deadline, count: b.questions.length }, channels: ["telegram"] });
    }
    for (const r of b.questions) {
      if (r.outcome === "0" || r.outcome === "1") out.push({ event: { kind: "outcome", key: `outcome:${r.id}`, question: toQ(r) }, channels: ["telegram"] });
    }
    // X gets one outcome per batch, and only once the whole batch is resolved.
    const s = b.questions.every((r) => r.outcome !== null) ? strikingOutcome(b.questions) : null;
    if (s) out.push({ event: { kind: "outcome", key: `outcome:${s.id}`, question: toQ(s) }, channels: ["x"] });
  }
  const eps = (await db.query<{ epoch: number; payload: string; published_at: Date | null }>(
    "SELECT epoch, payload, published_at FROM epochs WHERE state = 'PUBLISHED' AND published_at > now() - interval '2 days' ORDER BY epoch",
  )).rows;
  for (const e of eps) {
    const p = JSON.parse(e.payload) as { claims?: Array<{ account: string; amount: string }> };
    const claims = [...(p.claims ?? [])].sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
    const claimsAt = e.published_at ? Math.floor(e.published_at.getTime() / 1000) + CLAIM_DELAY_SEC : null;
    out.push({ event: { kind: "epoch_settled", key: `settled:${e.epoch}`, epoch: e.epoch, winners: claims.length, top: claims[0]?.account ?? null, claimsAt }, channels: ["telegram", "x"] });
    if (claimsAt && now >= claimsAt) out.push({ event: { kind: "claims_open", key: `claims:${e.epoch}`, epoch: e.epoch }, channels: ["telegram"] });
  }
  const swaps = (await db.query<{ tx_hash: string; detail: string }>("SELECT tx_hash, detail FROM treasury_ops WHERE kind = 'SWAP' AND tx_hash IS NOT NULL AND at > now() - interval '2 days' ORDER BY id")).rows;
  for (const s of swaps) {
    const d = JSON.parse(s.detail) as { ethIn?: string; burned?: string };
    if (d.ethIn && d.burned) out.push({ event: { kind: "swap", key: `swap:${s.tx_hash}`, ethIn: d.ethIn, burned: d.burned, tx: s.tx_hash }, channels: ["telegram", "x"] });
  }
  return out;
}
