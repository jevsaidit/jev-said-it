import { encodeAbiParameters, keccak256, zeroAddress, type Address, type Hex } from "viem";
import { PONS_HOOK, PONS_POOL_FEE, PONS_TICK_SPACING } from "../config.js";

/** PoolId Uniswap v4 = keccak256(abi.encode(PoolKey)). */
export function poolId(currency0: Address, currency1: Address, fee: number, tickSpacing: number, hooks: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, fee, tickSpacing, hooks],
    ),
  );
}

/** The pool a Pons token paired with ETH graduates into: native ETH as currency0, Pons hook. */
export function ponsEthPoolId(token: Address): Hex {
  return poolId(zeroAddress, token, PONS_POOL_FEE, PONS_TICK_SPACING, PONS_HOOK);
}
