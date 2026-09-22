import { describe, expect, it } from "vitest";
import { keccak256, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NotSentError, SendUnknownError, sendTx } from "../src/chain/send.js";

// anvil's public test key #0: not a secret
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ABI = parseAbi(["function ping(uint256 n)"]);
const REQ = { address: "0x1000000000000000000000000000000000000001" as const, abi: ABI, functionName: "ping", args: [1n] };
const SIGNED = "0x02f86e" as Hex;

function deps(o: { prepare?: () => Promise<unknown>; send?: (raw: Hex) => Promise<Hex> } = {}) {
  const pub = {
    prepareTransactionRequest: o.prepare ?? (async () => ({ to: REQ.address, nonce: 1 })),
    sendRawTransaction: o.send ?? (async () => keccak256(SIGNED)),
  };
  const wallet = { chain: { id: 4663 }, signTransaction: async () => SIGNED };
  return { pub: pub as never, wallet: wallet as never, account };
}

describe("sendTx", () => {
  it("persists the hash BEFORE broadcasting, and the hash is the one the node echoes", async () => {
    const order: string[] = [];
    const hash = await sendTx(
      deps({
        send: async () => {
          order.push("broadcast");
          return keccak256(SIGNED);
        },
      }),
      REQ,
      async (h) => {
        order.push(`persist ${h}`);
      },
    );
    expect(hash).toBe(keccak256(SIGNED));
    expect(order).toEqual([`persist ${hash}`, "broadcast"]);
  });
  it("a failed simulation is NotSent: nothing was persisted, nothing left", async () => {
    let persisted = 0;
    await expect(
      sendTx(deps({ prepare: async () => { throw new Error("execution reverted: AlreadyOpen()"); } }), REQ, async () => { persisted++; }),
    ).rejects.toBeInstanceOf(NotSentError);
    expect(persisted).toBe(0);
  });
  it("a broadcast error after the hash was persisted is Unknown, and carries the hash", async () => {
    let persisted: Hex | null = null;
    const err = await sendTx(deps({ send: async () => { throw new Error("HTTP request timed out"); } }), REQ, async (h) => { persisted = h; }).catch((e) => e);
    expect(err).toBeInstanceOf(SendUnknownError);
    expect((err as SendUnknownError).hash).toBe(persisted);
  });
  it("'already known' is a success: the earlier attempt got through", async () => {
    const hash = await sendTx(deps({ send: async () => { throw new Error("already known"); } }), REQ, async () => {});
    expect(hash).toBe(keccak256(SIGNED));
  });
  it("a node that echoes a different hash is not trusted", async () => {
    await expect(sendTx(deps({ send: async () => "0x" + "ab".repeat(32) as Hex }), REQ, async () => {})).rejects.toBeInstanceOf(SendUnknownError);
  });
});
