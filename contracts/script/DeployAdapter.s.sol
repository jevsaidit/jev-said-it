// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PonsEscrowAdapter} from "../src/PonsEscrowAdapter.sol";

/// @title DeployAdapter — phase 1, to run BEFORE the launch on Pons
/// @notice Deploys the only address the launch needs: the one to give Pons v2 as the
///         creator fee recipient. The FeeRouter does not exist yet and is not needed: the adapter
///         accepts it later, only once, via `setRouter(address)`.
/// @dev Full procedure in `docs/runbook-launch.md`. Not affiliated with TypeSafe AI.
contract DeployAdapter is Script {
    error ZeroEscrow();
    error NonceMoved(uint256 actual, uint256 expected);

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address escrow = vm.envAddress("PONS_FEE_ESCROW");
        address proposer = vm.envAddress("TIMELOCK_PROPOSER");

        // `escrow` is immutable in the adapter: getting it wrong means redeploying, and if the adapter
        // is already registered on Pons, changing the recipient costs the factory's 3-day
        // timelock (CREATOR_FEE_RECIPIENT_TIMELOCK = 259200). Better to stop here.
        if (escrow == address(0)) revert ZeroEscrow();

        // Printed BEFORE the broadcast: they are there to stop a wrong `--rpc-url` while there is
        // still something to stop. After `stopBroadcast` the contract is already deployed and
        // reading "chain id: 46630" no longer helps.
        console2.log("chain id (mainnet = 4663):", block.chainid);
        console2.log("deployer:", vm.addr(pk));
        console2.log("escrow (immutable, cannot be changed after the deploy):", escrow);

        // The address map published at T-4 days (runbook §2.2) is CREATE(deployer, nonce): one stray
        // transaction from the deploy key makes every address in it false, with nobody noticing.
        // The script refuses to broadcast from any other nonce than the one the map was computed for.
        uint256 expectedNonce = vm.envOr("EXPECTED_NONCE", uint256(0));
        if (vm.getNonce(vm.addr(pk)) != expectedNonce) revert NonceMoved(vm.getNonce(vm.addr(pk)), expectedNonce);

        vm.startBroadcast(pk);
        PonsEscrowAdapter adapter = new PonsEscrowAdapter(escrow, proposer);
        vm.stopBroadcast();

        console2.log("PonsEscrowAdapter (use this as the creator wallet on Pons):", address(adapter));
        console2.log("  owner = TIMELOCK_PROPOSER, the only one who can call setRouter:", proposer);
    }
}
