import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// Same shape as engine/src/questions/canonical.ts: sorted keys, no whitespace, strings only.
// If the two diverge, the receipt on the site stops proving what it says.
export type Canonical = Record<string, string>;

export function canonicalJson(obj: Canonical): string {
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`).join(",") + "}";
}

export function questionId(json: string): string {
  return "0x" + bytesToHex(keccak_256(utf8ToBytes(json)));
}

// Type A rule, verbatim from engine/src/questions/open.ts (RULE_A).
const RULE_A =
  "1 if the token's ETH price at the last Swap of the pool at or before deadline+horizon is strictly higher than at the last Swap at or before deadline; 0 otherwise; VOID if the pool has no Swap between the two.";

// Sample question: the fields are the engine's real ones, the addresses are not. The site says so.
export const SAMPLE: Canonical = {
  v: "1",
  kind: "A_PRICE_UP",
  dataChainId: "4663",
  ledgerChainId: "4663",
  ledger: "0x0000000000000000000000000000000000c0ffee",
  epoch: "12",
  deadline: "1790604000",
  horizon: "21600",
  token: "0x00000000000000000000000000000000005a1d17",
  pool: "0x00000000000000000000000000000000000000000000000000000000000beef0",
  model: "jev",
  p: "0.6412",
  baseline: "0.5000",
  baselineSource: "unmeasured",
  rule: RULE_A,
};
