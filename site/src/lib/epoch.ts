import { BLIND, engine, type Blind } from "@/lib/cards";

// One epoch, as the feed tells it: the questions, and how Jev did against the baseline written into
// each receipt. A hit is the side the probability was on, not a rounded opinion.

export type EpochQ = { id: string; symbol: string | null; token?: string; p: string; outcome: string | null; model?: string };
export type EpochView = { epoch: number; questions: EpochQ[]; resolved: number; hits: number; voided: number; unresolvable: number; open: number };

export const isHit = (p: string, outcome: string | null) =>
  outcome === "1" || outcome === "0" ? (Number(p) >= 0.5) === (outcome === "1") : false;

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
    voided: qs.filter((q) => q.outcome === "VOID").length,
    unresolvable: qs.filter((q) => q.outcome === "UNRESOLVABLE").length,
    open: qs.filter((q) => q.outcome === null).length,
  };
}
