import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex, type PublicClient, type TransactionReceipt } from "viem";

/**
 * What the node says about a transaction we sent. Three answers, and a fourth that is not one:
 * - mined: here is its receipt;
 * - pending: the node knows it and has not mined it;
 * - unknown: the node answered, and it does not know the hash;
 * - any other error (429, timeout, node down) is THROWN: "could not look" must never be read as
 *   "dropped", or the caller resends a transaction that may still land (review of 22/09).
 */
export type TxLookup = { state: "mined"; receipt: TransactionReceipt } | { state: "pending" } | { state: "unknown" };

const notFound = (e: unknown, cls: typeof TransactionNotFoundError | typeof TransactionReceiptNotFoundError) =>
  e instanceof cls || (e as { name?: string })?.name === cls.name;

export async function lookupTx(client: PublicClient, hash: Hex): Promise<TxLookup> {
  try {
    return { state: "mined", receipt: await client.getTransactionReceipt({ hash }) };
  } catch (e) {
    if (!notFound(e, TransactionReceiptNotFoundError)) throw e;
  }
  try {
    await client.getTransaction({ hash });
    return { state: "pending" };
  } catch (e) {
    if (!notFound(e, TransactionNotFoundError)) throw e;
    return { state: "unknown" };
  }
}
