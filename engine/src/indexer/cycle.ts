import type { PublicClient } from "viem";
import { errText } from "../chain/client.js";
import type { Config } from "../config.js";
import { type Db, getCursor } from "../db/db.js";
import { indexTransfers, transferCursor } from "./transfers.js";
import { indexV4, V4_CURSOR } from "./v4.js";

// Three outcomes, not two: "I looked and there was nothing" is not "the observation failed".
export type Outcome =
  | { state: "OK"; target: bigint; written: number; lag: bigint }
  | { state: "IDLE"; target: bigint; lag: bigint }
  | { state: "BLIND"; error: string };

/** `client` = data chain (PoolManager), `tokenClient` = token chain (Transfer). */
export async function runCycle(client: PublicClient, db: Db, cfg: Config, tokenClient: PublicClient = client): Promise<Outcome> {
  try {
    const target = (await client.getBlockNumber({ cacheTime: 0 })) - cfg.confirmations;
    const tokenTarget = tokenClient === client ? target : (await tokenClient.getBlockNumber({ cacheTime: 0 })) - cfg.confirmations;
    const written =
      (await indexTransfers(tokenClient, db, cfg.token, cfg.launchBlock, tokenTarget, cfg.logChunk, cfg.maxBlocksPerCycle)) +
      (await indexV4(client, db, cfg.v4StartBlock, target, cfg.v4LogChunk, cfg.maxBlocksPerCycle));
    // How far the most-behind index is from the head of ITS chain: while it is large, the data is stale.
    const tLag = tokenTarget - ((await getCursor(db, transferCursor(cfg.token))) ?? 0n);
    const vLag = target - ((await getCursor(db, V4_CURSOR)) ?? 0n);
    const lag = tLag > vLag ? tLag : vLag;
    return written > 0 ? { state: "OK", target, written, lag } : { state: "IDLE", target, lag };
  } catch (e) {
    return { state: "BLIND", error: errText(e) };
  }
}
