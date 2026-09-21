import { parseAbiItem, type Address, type PublicClient } from "viem";
import { getLogsBisect } from "../chain/logs.js";
import { type Db, getCursor, inTx, setCursor } from "../db/db.js";

const CALL_SUBMITTED = parseAbiItem(
  "event CallSubmitted(uint256 indexed epoch, address indexed caller, bytes32 indexed questionId, bool agree, uint256 balanceAtCall)",
);

export async function indexCalls(ledger: PublicClient, db: Db, callLedger: Address, startBlock: bigint, target: bigint, chunk: bigint): Promise<number> {
  const name = `calls:${callLedger.toLowerCase()}`;
  let from = ((await getCursor(db, name)) ?? startBlock - 1n) + 1n;
  let written = 0;
  while (from <= target) {
    const to = from + chunk - 1n < target ? from + chunk - 1n : target;
    const logs = await getLogsBisect(
      (a, b) => ledger.getLogs({ address: callLedger, event: CALL_SUBMITTED, fromBlock: a, toBlock: b, strict: true }),
      from,
      to,
    );
    await inTx(db, async (c) => {
      for (const l of logs) {
        await c.query(
          `INSERT INTO calls (epoch, caller, question_id, agree, balance_at_call, block, log_index)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [
            Number(l.args.epoch),
            l.args.caller.toLowerCase(),
            l.args.questionId.toLowerCase(),
            l.args.agree,
            l.args.balanceAtCall.toString(),
            l.blockNumber.toString(),
            l.logIndex,
          ],
        );
      }
      await setCursor(c, name, to);
    });
    written += logs.length;
    from = to + 1n;
  }
  return written;
}
