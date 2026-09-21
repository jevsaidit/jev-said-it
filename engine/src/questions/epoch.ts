// The CallLedger checks none of this (spec §5), and a mistake here raises no error at opening:
// it produces questions nobody can answer. That is why this is pure, tested code.

export const EPOCH_LENGTH = 6 * 3600; // CallLedger.EPOCH_LENGTH

export function epochOf(ts: number, genesis: number): number {
  if (ts < genesis) throw new Error(`timestamp ${ts} before genesis ${genesis}`);
  return Math.floor((ts - genesis) / EPOCH_LENGTH);
}

export function epochEnd(epoch: number, genesis: number): number {
  return genesis + (epoch + 1) * EPOCH_LENGTH;
}

export type BatchPlan =
  | { open: true; epoch: number; deadline: number }
  | { open: false; reason: string; retryAt: number };

/**
 * Deadline of a batch opened now. `now` is the timestamp of the latest block, not the local
 * clock: it is what the contract will compare against.
 */
export function planBatch(p: {
  now: number;
  genesis: number;
  callWindowSec: number;
  minCallWindowSec: number;
  epochMarginSec: number;
}): BatchPlan {
  const epoch = epochOf(p.now, p.genesis);
  const end = epochEnd(epoch, p.genesis);
  // A deadline past the end of the epoch is a false promise: from the epoch change on, the question
  // reads as closed (submit looks it up under currentEpoch()).
  const deadline = Math.min(p.now + p.callWindowSec, end - p.epochMarginSec);
  if (deadline - p.now < p.minCallWindowSec) {
    return { open: false, reason: `only ${deadline - p.now}s usable left in epoch ${epoch}, below the minimum of ${p.minCallWindowSec}s`, retryAt: end };
  }
  return { open: true, epoch, deadline };
}
