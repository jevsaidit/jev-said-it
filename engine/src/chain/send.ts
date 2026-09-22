import { encodeFunctionData, keccak256, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

// Sending a transaction in two halves, so that the hash exists BEFORE the network is touched.
//
// The review of 22/09 found that `writeContract` could throw after the transaction had left: a
// slow `eth_sendRawTransaction` is retried by viem, the node answers "already known", the call
// throws, and the caller recorded the batch as FAILED while it was mining. Here the transaction is
// signed locally, its hash is handed to the caller to persist, and only then is it broadcast. Any
// error after that point is "sent, outcome unknown", never "not sent": the reconciliation that
// every sender already runs (lookupTx, then a 10-minute grace before a hash is called dropped)
// decides from the chain.

export type SendRequest = { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] };

/** Thrown before anything was broadcast: the simulation (gas estimate) or the signing failed. */
export class NotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSentError";
  }
}

/** Thrown after the broadcast was attempted: the transaction may or may not be in the mempool. */
export class SendUnknownError extends Error {
  readonly hash: Hex;
  constructor(message: string, hash: Hex) {
    super(message);
    this.name = "SendUnknownError";
    this.hash = hash;
  }
}

/** Errors that mean the node already has this exact transaction: an earlier attempt got through. */
const ALREADY = /already known|already imported|alreadyknown|known transaction|nonce too low|replacement transaction underpriced/i;

export interface SendDeps {
  pub: PublicClient;
  wallet: WalletClient;
  account: PrivateKeyAccount;
}

/**
 * Simulates, signs, calls `onHash(hash)` (persist it there), then broadcasts. Returns the hash.
 * - NotSentError: nothing left this process; the caller may record a failure.
 * - SendUnknownError: the raw transaction was handed to the network and the answer was not a clean
 *   acceptance; the hash was already persisted, and only the chain can say what happened.
 */
export async function sendTx(d: SendDeps, req: SendRequest, onHash: (hash: Hex) => Promise<void>): Promise<Hex> {
  let signed: Hex;
  try {
    const prepared = await d.pub.prepareTransactionRequest({
      account: d.account,
      to: req.address,
      data: encodeFunctionData({ abi: req.abi as Abi, functionName: req.functionName, args: req.args as never }),
      chain: d.wallet.chain,
    } as never);
    signed = await d.wallet.signTransaction(prepared as never);
  } catch (e) {
    throw new NotSentError((e as Error).message.split("\n")[0]!);
  }
  const hash = keccak256(signed);
  await onHash(hash);
  try {
    const got = await d.pub.sendRawTransaction({ serializedTransaction: signed });
    if (got.toLowerCase() !== hash.toLowerCase()) throw new SendUnknownError(`node returned hash ${got}, expected ${hash}`, hash);
    return hash;
  } catch (e) {
    if (e instanceof SendUnknownError) throw e;
    const msg = (e as Error).message.split("\n")[0]!;
    if (ALREADY.test(msg)) return hash; // broadcast by an earlier attempt: same transaction, same hash
    throw new SendUnknownError(msg, hash);
  }
}
