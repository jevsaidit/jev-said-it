import { keccak256, stringToBytes, type Hex } from "viem";

// The questionId is the public commitment to the verdict (spec §4): anyone, given the published
// JSON, must be able to recompute the same hash. So only one form is possible: sorted keys, no
// whitespace, strings only (no floats, whose printing varies from one language to another).
export type Canonical = { [k: string]: string };

export function canonicalJson(obj: Canonical): string {
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    if (typeof obj[k] !== "string") throw new Error(`field ${k} is not a string`);
  }
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`).join(",") + "}";
}

export function questionId(json: string): Hex {
  return keccak256(stringToBytes(json));
}

/** Probability with 4 fixed decimals, as a string: "0.4031". */
export function fmtProb(p: number): string {
  if (!(p >= 0 && p <= 1)) throw new Error(`probability outside [0,1]: ${p}`);
  return p.toFixed(4);
}
