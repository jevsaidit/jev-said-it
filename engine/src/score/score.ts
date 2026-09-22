// Scores in INTEGER arithmetic: committed probabilities are 4-decimal strings, so in ten-thousandths
// every Brier is an exact integer (scale 10^8). Anyone, in any language, recomputes the same
// numbers from the published JSON and the events. No floats, no surprises.

export const P_SCALE = 10_000n;
export const TOKENS_PER_CALL = 10_000n * 10n ** 18n; // CallLedger.TOKENS_PER_CALL
export const MAX_CALLS_PER_EPOCH = 50n; // CallLedger.MAX_CALLS_PER_EPOCH

// Engine rule, stricter than the contract, decided on 22/09/2026 and in force FROM EPOCH 1: hold at least
// 1,000,000 $JEV at the epoch's start to play, one call per 100,000, up to 50. The contract still accepts
// a call per 10,000 (its constants cannot change); calls beyond this capacity are dropped when scoring,
// exactly like calls beyond the start-of-epoch balance. Epoch 0 keeps the launch rule, so anyone
// recomputing it gets the same result.
export const RULE_V2_FROM_EPOCH = 1;
export const MIN_HOLD_V2 = 1_000_000n * 10n ** 18n;
export const TOKENS_PER_CALL_V2 = 100_000n * 10n ** 18n;

export function rulesFor(epoch: number): { minHold: bigint; tokensPerCall: bigint; maxCalls: bigint } {
  return epoch >= RULE_V2_FROM_EPOCH
    ? { minHold: MIN_HOLD_V2, tokensPerCall: TOKENS_PER_CALL_V2, maxCalls: MAX_CALLS_PER_EPOCH }
    : { minHold: TOKENS_PER_CALL, tokensPerCall: TOKENS_PER_CALL, maxCalls: MAX_CALLS_PER_EPOCH };
}

/** Calls that COUNT for a wallet in `epoch`, from its balance at the epoch's start. */
export function capacityAt(epoch: number, balance: bigint): bigint {
  const r = rulesFor(epoch);
  if (balance < r.minHold) return 0n;
  const c = balance / r.tokensPerCall;
  return c > r.maxCalls ? r.maxCalls : c;
}
export const MIN_RESOLVED_CALLS = 3;
export const MAX_UNRESOLVABLE_SHARE = 0.2; // spec §6: above it, the epoch is not paid

export interface ScoredQuestion {
  id: string;
  p: bigint; // ten-thousandths
  baseline: bigint; // ten-thousandths
  outcome: "1" | "0" | "VOID" | "UNRESOLVABLE";
}

export interface Call {
  caller: string;
  questionId: string;
  agree: boolean;
  block: bigint;
  logIndex: number;
}

export interface WalletScore {
  address: string;
  callsOnChain: number;
  callsValid: number;
  callsResolved: number;
  score: bigint; // sum of skills, scale 10^8
}

export type EpochScore =
  | { state: "PAYABLE"; wallets: WalletScore[]; winners: WalletScore[] }
  | { state: "NOT_PAYABLE"; reason: string; wallets: WalletScore[] };

export function parseProb(s: string): bigint {
  if (!/^(0\.\d{4}|1\.0000)$/.test(s)) throw new Error(`non-canonical probability: ${s}`);
  return BigInt(s.replace(".", ""));
}

/** Skill of a call: how much its implied forecast beats the reference. Positive = better. */
export function callSkill(p: bigint, agree: boolean, y: 0n | 1n, ref: bigint): bigint {
  const f = agree ? p : P_SCALE - p;
  const brier = (f - y * P_SCALE) ** 2n;
  const refBrier = (ref - y * P_SCALE) ** 2n;
  return refBrier - brier;
}

export function scoreEpoch(i: {
  epoch: number;
  questions: ScoredQuestion[];
  calls: Call[]; // all CallSubmitted events of the epoch
  balanceAtStart: Map<string, bigint>;
  excluded: Set<string>;
  reference: "baseline" | "model";
  topFraction: number;
}): EpochScore {
  const qs = new Map(i.questions.map((q) => [q.id.toLowerCase(), q]));
  const unresolvable = i.questions.filter((q) => q.outcome === "UNRESOLVABLE").length;

  // Log order: capacity is consumed in the order the calls arrived.
  const calls = [...i.calls].sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const byWallet = new Map<string, Call[]>();
  for (const c of calls) {
    const a = c.caller.toLowerCase();
    if (i.excluded.has(a)) continue;
    byWallet.set(a, [...(byWallet.get(a) ?? []), c]);
  }

  const wallets: WalletScore[] = [];
  for (const [address, list] of byWallet) {
    // The contract counts capacity on the balance AT THE TIME of the call: buy, answer, sell.
    // Here the balance at epoch start applies (spec §5.4), and calls beyond that capacity are dropped.
    const cap = capacityAt(i.epoch, i.balanceAtStart.get(address) ?? 0n);
    const valid = list.filter((c) => qs.has(c.questionId.toLowerCase())).slice(0, Number(cap));
    let score = 0n;
    let resolved = 0;
    for (const c of valid) {
      const q = qs.get(c.questionId.toLowerCase())!;
      if (q.outcome !== "0" && q.outcome !== "1") continue; // VOID and UNRESOLVABLE don't count
      const ref = i.reference === "baseline" ? q.baseline : q.p;
      score += callSkill(q.p, c.agree, q.outcome === "1" ? 1n : 0n, ref);
      resolved++;
    }
    wallets.push({ address, callsOnChain: list.length, callsValid: valid.length, callsResolved: resolved, score });
  }
  wallets.sort((a, b) => (a.score === b.score ? (a.address < b.address ? -1 : 1) : a.score > b.score ? -1 : 1));

  if (i.questions.length > 0 && unresolvable / i.questions.length > MAX_UNRESOLVABLE_SHARE) {
    return { state: "NOT_PAYABLE", reason: `${unresolvable}/${i.questions.length} questions unresolvable: when in doubt, nothing is paid`, wallets };
  }
  const eligible = wallets.filter((w) => w.callsResolved >= MIN_RESOLVED_CALLS);
  const k = Math.max(1, Math.ceil(eligible.length * i.topFraction));
  const winners = eligible.slice(0, k).filter((w) => w.score > 0n);
  if (winners.length === 0) return { state: "NOT_PAYABLE", reason: "no forecaster with a positive score", wallets };
  return { state: "PAYABLE", wallets, winners };
}

/** Budget split in proportion to score, rounded down: the sum NEVER exceeds the budget. */
export function allocate(winners: WalletScore[], budget: bigint): Array<{ address: string; amount: bigint }> {
  const total = winners.reduce((s, w) => s + w.score, 0n);
  return winners.map((w) => ({ address: w.address, amount: (budget * w.score) / total })).filter((x) => x.amount > 0n);
}
