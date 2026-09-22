import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { CHAINS, LEDGER_ABI } from "@/lib/chains";
import { BLIND, engine } from "@/lib/cards";

// How many wallets have called this epoch, counted from the ledger's own events: social proof nobody
// can fake, since it is the log the scoring reads. Three states — a chain we cannot read answers 502,
// never "0 callers", because zero is a claim and silence is not.

export const dynamic = "force-dynamic";
const CALL_SUBMITTED = parseAbiItem("event CallSubmitted(uint256 indexed epoch, address indexed caller, bytes32 indexed questionId, bool agree, uint256 balanceAtCall)");
// ~8h of blocks at 0.1s: an epoch is 6h, and asking this RPC for the whole chain gets the query refused.
const WINDOW = 300_000n;

export async function GET() {
  const cfg = await engine<{ chainId: number | null; callLedger: Address | null }>("/config");
  if (cfg === BLIND || !cfg?.callLedger || !cfg.chainId) return Response.json({ error: "no ledger" }, { status: 503 });
  const chain = CHAINS[cfg.chainId];
  if (!chain) return Response.json({ error: "unsupported chain" }, { status: 503 });
  const client = createPublicClient({ chain, transport: http(undefined, { timeout: 8000 }) });
  try {
    const [epoch, head] = await Promise.all([
      client.readContract({ address: cfg.callLedger, abi: LEDGER_ABI, functionName: "currentEpoch" }),
      client.getBlockNumber(),
    ]);
    const logs = await client.getLogs({
      address: cfg.callLedger,
      event: CALL_SUBMITTED,
      args: { epoch },
      fromBlock: head > WINDOW ? head - WINDOW : 0n,
      toBlock: head,
    });
    const callers = new Set(logs.map((l) => (l.args.caller ?? "").toLowerCase()).filter(Boolean));
    return Response.json(
      { epoch: Number(epoch), callers: callers.size, calls: logs.length },
      { headers: { "cache-control": "public, max-age=60, s-maxage=60" } },
    );
  } catch {
    return Response.json({ error: "chain not readable" }, { status: 502 });
  }
}
