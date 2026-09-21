import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Hex } from "viem";

// The RewardsDistributor leaf is keccak256(bytes.concat(keccak256(abi.encode(account, amount)))),
// i.e. exactly OpenZeppelin's StandardMerkleTree with types [address, uint256]. The library is used,
// not a copy: the Foundry test `MerkleFixture.t.sol` proves the two sides agree.
export interface Claim {
  account: string;
  amount: string;
  proof: Hex[];
}

export function buildTree(amounts: Array<{ address: string; amount: bigint }>): { root: Hex; claims: Claim[] } {
  if (amounts.length === 0) throw new Error("empty tree: a null root is not a root");
  const tree = StandardMerkleTree.of(
    amounts.map((a) => [a.address, a.amount.toString()]),
    ["address", "uint256"],
  );
  const claims: Claim[] = [];
  for (const [i, [account, amount]] of tree.entries()) {
    claims.push({ account: account as string, amount: amount as string, proof: tree.getProof(i) as Hex[] });
  }
  return { root: tree.root as Hex, claims };
}
