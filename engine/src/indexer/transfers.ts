import { parseAbiItem, type Address, type PublicClient } from "viem";
import { getLogsBisect } from "../chain/logs.js";
import { type Db, getCursor, inTx, setCursor } from "../db/db.js";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export const transferCursor = (token: Address) => `transfers:${token.toLowerCase()}`;

/** Brings the Transfer index of `token` up to `target`, in chunks of `chunk`. Returns the logs written. */
export async function indexTransfers(
  client: PublicClient,
  db: Db,
  token: Address,
  launchBlock: bigint,
  target: bigint,
  chunk: bigint,
  maxSpan: bigint = 0n,
): Promise<number> {
  const name = transferCursor(token);
  let from = ((await getCursor(db, name)) ?? launchBlock - 1n) + 1n;
  let written = 0;
  // A cycle covers at most maxSpan blocks: a long catch-up becomes many short cycles, and /health
  // stays current instead of going silent for a quarter of an hour on first start.
  if (maxSpan > 0n && target > from + maxSpan - 1n) target = from + maxSpan - 1n;
  while (from <= target) {
    const to = from + chunk - 1n < target ? from + chunk - 1n : target;
    const logs = await getLogsBisect(
      (a, b) => client.getLogs({ address: token, event: TRANSFER, fromBlock: a, toBlock: b, strict: true }),
      from,
      to,
    );
    await inTx(db, async (c) => {
      if (logs.length > 0) {
        await c.query(
          `INSERT INTO transfers (token, block, log_index, tx_hash, from_addr, to_addr, value)
           SELECT $1, * FROM unnest($2::bigint[], $3::int[], $4::text[], $5::text[], $6::text[], $7::numeric[])
           ON CONFLICT DO NOTHING`,
          [
            token.toLowerCase(),
            logs.map((l) => l.blockNumber.toString()),
            logs.map((l) => l.logIndex),
            logs.map((l) => l.transactionHash),
            logs.map((l) => l.args.from.toLowerCase()),
            logs.map((l) => l.args.to.toLowerCase()),
            logs.map((l) => l.args.value.toString()),
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
