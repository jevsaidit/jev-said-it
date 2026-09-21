// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {RewardsDistributor} from "../src/RewardsDistributor.sol";
import {CallLedger} from "../src/CallLedger.sol";
import {UniV4SwapAdapter} from "../src/adapters/UniV4SwapAdapter.sol";

/// @title DeployCore — phase 2, to run AFTER the launch, with the token address
/// @notice Deploys timelock, FeeRouter, RewardsDistributor, CallLedger and UniV4SwapAdapter,
///         configures them with the deployer as temporary owner and hands ownership to the timelock.
/// @dev The parameters live in an in-memory struct and not in local variables: with
///      `via_ir = false` (see foundry.toml) fourteen locals in `run()` overflow the stack.
///      Full procedure in `docs/runbook-launch.md`. Not affiliated with TypeSafe AI.
contract DeployCore is Script {
    error AdapterHasNoCode(address adapter);

    struct Cfg {
        uint256 pk;
        address deployer;
        address token;
        address proposer;
        address computeWallet;
        address opsWallet;
        address teamWallet;
        address keeper;
        address scorer;
        address guardian;
        address universalRouter;
        address payable adapter;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function _config() internal view returns (Cfg memory c) {
        c.pk = vm.envUint("DEPLOYER_PK");
        c.deployer = vm.addr(c.pk);
        c.token = vm.envAddress("JEVSAID_TOKEN");
        c.proposer = vm.envAddress("TIMELOCK_PROPOSER");
        c.computeWallet = vm.envAddress("COMPUTE_WALLET");
        c.opsWallet = vm.envAddress("OPS_WALLET");
        c.teamWallet = vm.envAddress("TEAM_WALLET");
        c.keeper = vm.envAddress("KEEPER");
        c.scorer = vm.envAddress("SCORER");
        c.guardian = vm.envAddress("GUARDIAN");
        c.universalRouter = vm.envAddress("UNIVERSAL_ROUTER");
        c.adapter = payable(vm.envAddress("PONS_ESCROW_ADAPTER"));
        c.fee = uint24(vm.envUint("POOL_FEE"));
        c.tickSpacing = int24(int256(vm.envInt("POOL_TICK_SPACING")));
        c.hooks = vm.envAddress("POOL_HOOKS");
    }

    function run() external {
        Cfg memory c = _config();

        // Printed BEFORE the broadcast: they are there to stop a wrong `--rpc-url` while there is
        // still something to stop.
        console2.log("chain id (mainnet = 4663):", block.chainid);
        console2.log("deployer:", c.deployer);
        console2.log("token:", c.token);
        console2.log("wallet compute / ops / team:", c.computeWallet, c.opsWallet, c.teamWallet);
        console2.log("adapter (from .env, target of the final setRouter):", c.adapter);

        // `PONS_ESCROW_ADAPTER` ends up verbatim in the `setRouter` command the operator
        // pastes, and that command can be given only once. A stale `.env` would print
        // a wrong address with the same confidence as a right one: if there is no code there,
        // it is not an adapter and we do not go on.
        if (c.adapter.code.length == 0) revert AdapterHasNoCode(c.adapter);

        vm.startBroadcast(c.pk);

        address[] memory proposers = new address[](1);
        proposers[0] = c.proposer;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController timelock = new TimelockController(24 hours, proposers, executors, address(0));

        // deployer is temporary owner for configuration, then hands over to the timelock
        FeeRouter router = new FeeRouter(c.token, c.deployer, c.computeWallet, c.opsWallet, c.teamWallet, c.keeper);
        // Same genesis for both: the distributor only accepts roots for epochs of the ledger that have ended.
        RewardsDistributor dist = new RewardsDistributor(c.token, c.deployer, c.scorer, c.guardian, block.timestamp);
        CallLedger ledger = new CallLedger(c.token, c.deployer, c.keeper, block.timestamp);
        UniV4SwapAdapter swapAdapter = new UniV4SwapAdapter(c.universalRouter, c.deployer);

        swapAdapter.setPool(c.token, c.fee, c.tickSpacing, c.hooks);
        router.setSwapAdapter(address(swapAdapter));
        router.setRewardsDistributor(address(dist));

        router.transferOwnership(address(timelock));
        dist.transferOwnership(address(timelock));
        ledger.transferOwnership(address(timelock));
        swapAdapter.transferOwnership(address(timelock));

        vm.stopBroadcast();

        console2.log("Timelock:", address(timelock));
        console2.log("FeeRouter:", address(router));
        console2.log("RewardsDistributor:", address(dist));
        console2.log("CallLedger:", address(ledger));
        console2.log("UniV4SwapAdapter:", address(swapAdapter));
        console2.log("CallLedger.genesis (start of epoch 0, align the engine to this):", block.timestamp);
        console2.log("Then, ONLY ONCE, from the TIMELOCK_PROPOSER (setRouter takes ONE argument only):");
        console2.log("  cast send <ADAPTER> 'setRouter(address)' <FEEROUTER>");
        console2.log("  <ADAPTER>   =", c.adapter);
        console2.log("  <FEEROUTER> =", address(router));
        console2.log("Then: the timelock must call acceptOwnership() on router, dist, ledger (Ownable2Step)");
        console2.log("UniV4SwapAdapter is plain Ownable: its transferOwnership is already effective");
    }
}
