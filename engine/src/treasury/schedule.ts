import { keccak256, encodePacked, type Hex } from "viem";
import { EPOCH_LENGTH } from "../questions/epoch.js";

/**
 * When, inside epoch `epoch`, the buyback goes out. It must be unpredictable to the outside (a
 * known time invites front-running) and stable for us (a restart must not move it, or a crash loop
 * could buy twice or never). So it is derived from a secret only the engine knows and the epoch
 * number: hash(secret, epoch), mapped into [start + margin, end - margin].
 */
export function swapTime(secret: Hex, epoch: number, genesis: number, marginSec = 3600): number {
  const start = genesis + epoch * EPOCH_LENGTH;
  const span = EPOCH_LENGTH - 2 * marginSec;
  if (span <= 0) throw new Error("margin leaves no window");
  const h = BigInt(keccak256(encodePacked(["bytes32", "uint256"], [keccak256(secret), BigInt(epoch)])));
  return start + marginSec + Number(h % BigInt(span));
}
