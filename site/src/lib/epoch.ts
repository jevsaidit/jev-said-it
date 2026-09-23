import { BLIND, engine, type Blind } from "@/lib/cards";

// One epoch, as the feed tells it: the questions, and how Jev did against the baseline written into
// each receipt. A hit is the side the probability was on, not a rounded opinion.

export type EpochQ = { id: string; symbol: string | null; token?: string; p: string; outcome: string | null; model?: string };
// majority = how many a model that always named the more frequent direction would have got: the
// number "Jev got X of Y" has to be read against (on 23/09, 23 of epoch 0's 30 went down).
export type EpochView = { epoch: number; questions: EpochQ[]; resolved: number; hits: number; majority: number; majoritySide: "up" | "down"; voided: number; unresolvable: number; open: number };

export const isHit = (p: string, outcome: string | null) =>
  outcome === "1" || outcome === "0" ? (Number(p) >= 0.5) === (outcome === "1") : false;

const ups = (qs: EpochQ[]) => qs.filter((q) => q.outcome === "1").length;

export async function epochView(n: string): Promise<EpochView | null | Blind> {
  if (!/^\d{1,6}$/.test(n)) return null;
  const e = await engine<{ epoch: number; questions?: EpochQ[] }>(`/epochs/${Number(n)}`);
  if (e === BLIND || e === null) return e;
  const qs = e.questions ?? [];
  if (qs.length === 0) return null;
  const decided = qs.filter((q) => q.outcome === "0" || q.outcome === "1");
  return {
    epoch: e.epoch,
    questions: qs,
    resolved: decided.length,
    hits: decided.filter((q) => isHit(q.p, q.outcome)).length,
    majority: Math.max(ups(decided), decided.length - ups(decided)),
    majoritySide: ups(decided) * 2 > decided.length ? "up" : "down",
    voided: qs.filter((q) => q.outcome === "VOID").length,
    unresolvable: qs.filter((q) => q.outcome === "UNRESOLVABLE").length,
    open: qs.filter((q) => q.outcome === null).length,
  };
}

// The epoch's scoreboard, as stored by the engine when it closed the epoch (payload.wallets): only
// wallets that are not excluded, scored on their counted calls. null = not closed yet.
export type ScoredWallet = { address: string; callsOnChain: number; callsValid: number; callsResolved: number; score: string; perCall?: string };
// engine/src/score/score.ts RULE_V3_FROM_EPOCH: from epoch 2 wallets are ranked by skill per call, before by the sum.
export const PER_CALL_FROM_EPOCH = 2;
export const perCallOf = (w: ScoredWallet) => (w.perCall != null ? BigInt(w.perCall) : w.callsResolved ? BigInt(w.score) / BigInt(w.callsResolved) : 0n);
export type Scoreboard = { state: string; wallets: ScoredWallet[]; rewards: Array<{ account: string; amount: string }> };

export async function scoreboard(n: number): Promise<Scoreboard | null | Blind> {
  const b = await engine<Scoreboard>(`/leaderboard/${n}`);
  if (b === BLIND || b === null) return b;
  // The engine already stores them in ranking order; sorted again by the same measure so the page never disagrees.
  const m = (w: ScoredWallet) => (n >= PER_CALL_FROM_EPOCH ? perCallOf(w) : BigInt(w.score));
  const wallets = [...(b.wallets ?? [])].sort((x, y) => (m(y) > m(x) ? 1 : m(y) < m(x) ? -1 : 0));
  return { state: b.state, wallets, rewards: b.rewards ?? [] };
}
