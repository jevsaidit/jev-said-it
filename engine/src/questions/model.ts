export interface VerdictInput {
  kind: string;
  token: string;
  baseline: number;
  /** the market state passed to the model (spec §8): what the index knows about this token */
  state?: Record<string, string | number | null>;
}

export interface VerdictModel {
  /** ends up in the committed JSON and in the feed: always says who answered */
  id: string;
  /** `model`, if present, is the version that ACTUALLY answered and takes precedence over `id` in the committed JSON */
  verdict(q: VerdictInput): Promise<{ p: number; model?: string }>;
}

/**
 * Placeholder for trials: it answers with the baseline, i.e. it knows nothing. Its name says so, and
 * on mainnet it refuses to start — a fake verdict must never go out as "Jev said it".
 */
export function stubModel(chainId: number, fixedP?: number): VerdictModel {
  if (chainId === 4663) throw new Error("stubModel refused on Robinhood Chain mainnet (4663)");
  // With p = baseline every skill is zero: the scoring trials pin a different p (STUB_P).
  if (fixedP !== undefined) return { id: `stub-fixed-${fixedP}`, verdict: async () => ({ p: fixedP }) };
  return { id: "stub-baseline", verdict: async (q) => ({ p: q.baseline }) };
}
