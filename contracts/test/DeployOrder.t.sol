// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployAdapter} from "../script/DeployAdapter.s.sol";
import {DeployCore} from "../script/DeployCore.s.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title DeployOrderTest — the deploy order is a public commitment
/// @notice At T-4 days the social channel publishes the table that maps each contract to the deployer's
///         nonce, because a CREATE address depends only on deployer and nonce: whoever reads
///         that table can compute the addresses before they exist, and recognize an
///         impostor on launch day. Reordering two `new` inside `DeployCore` breaks
///         nothing in the code and would make an already published post false.
/// @dev The expected map below is written by hand, not derived from the script: it is the copy of
///      what gets published. The test really runs the two deploy scripts, from a deployer at
///      nonce zero, and asks each expected address to behave as the right contract. If
///      someone swaps two `new`, the identity calls land on the wrong contract and
///      the suite turns red. Not affiliated with TypeSafe AI.
contract DeployOrderTest is Test {
    // ---- THE PUBLISHED MAP. Changing a line here means something wrong has already been
    //      published, not that the test needs updating. ----
    uint64 internal constant NONCE_PONS_ESCROW_ADAPTER = 0; // separate script, DeployAdapter
    uint64 internal constant NONCE_TIMELOCK = 1;
    uint64 internal constant NONCE_FEE_ROUTER = 2;
    uint64 internal constant NONCE_REWARDS_DISTRIBUTOR = 3;
    uint64 internal constant NONCE_CALL_LEDGER = 4;
    uint64 internal constant NONCE_UNIV4_SWAP_ADAPTER = 5;
    uint64 internal constant NONCE_AFTER_DEPLOYS = 6; // no sixth contract

    uint256 internal constant DEPLOYER_PK = 0xD3910E;

    address internal deployer = vm.addr(DEPLOYER_PK);
    address internal escrow = address(0xE5C0);
    address internal token = address(0x70CE);
    address internal proposer = address(0x9505E2);
    address internal computeWallet = address(0xC0FFEE);
    address internal opsWallet = address(0x0B5);
    address internal teamWallet = address(0x7EA1);
    address internal keeper = address(0xCEE9E2);
    address internal scorer = address(0x5C02E2);
    address internal guardian = address(0x6044D);
    address internal universalRouter = address(0x40073);
    address internal hooks = address(0x400C5);

    function setUp() public {
        vm.setEnv("DEPLOYER_PK", vm.toString(DEPLOYER_PK));
        vm.setEnv("PONS_FEE_ESCROW", vm.toString(escrow));
        vm.setEnv("JEVSAID_TOKEN", vm.toString(token));
        vm.setEnv("TIMELOCK_PROPOSER", vm.toString(proposer));
        vm.setEnv("COMPUTE_WALLET", vm.toString(computeWallet));
        vm.setEnv("OPS_WALLET", vm.toString(opsWallet));
        vm.setEnv("TEAM_WALLET", vm.toString(teamWallet));
        vm.setEnv("KEEPER", vm.toString(keeper));
        vm.setEnv("SCORER", vm.toString(scorer));
        vm.setEnv("GUARDIAN", vm.toString(guardian));
        vm.setEnv("UNIVERSAL_ROUTER", vm.toString(universalRouter));
        vm.setEnv("POOL_FEE", "0");
        vm.setEnv("POOL_TICK_SPACING", "200");
        vm.setEnv("POOL_HOOKS", vm.toString(hooks));
    }

    function test_published_nonce_map_matches_what_the_scripts_deploy() public {
        assertEq(vm.getNonce(deployer), 0, "the launch deployer starts from an unused nonce");

        // ---- phase 1: DeployAdapter, the only address the launch on Pons needs ----
        address expectedAdapter = vm.computeCreateAddress(deployer, NONCE_PONS_ESCROW_ADAPTER);
        new DeployAdapter().run();
        _expectAddress(expectedAdapter, "escrow()", escrow, "nonce 0 = PonsEscrowAdapter");
        vm.setEnv("PONS_ESCROW_ADAPTER", vm.toString(expectedAdapter));

        // ---- phase 2: DeployCore, five `new` before any setter ----
        address expectedTimelock = vm.computeCreateAddress(deployer, NONCE_TIMELOCK);
        address expectedRouter = vm.computeCreateAddress(deployer, NONCE_FEE_ROUTER);
        address expectedDist = vm.computeCreateAddress(deployer, NONCE_REWARDS_DISTRIBUTOR);
        address expectedLedger = vm.computeCreateAddress(deployer, NONCE_CALL_LEDGER);
        address expectedSwapAdapter = vm.computeCreateAddress(deployer, NONCE_UNIV4_SWAP_ADAPTER);

        new DeployCore().run();

        // Each assertion asks the expected address for something only that contract can do:
        // a selector missing on a different type does not answer, and one present but on another
        // contract returns a value that does not match. The calls are raw on purpose,
        // so a reorder says at which nonce it happened instead of an `EvmError: Revert`.
        _expectUint(expectedTimelock, "getMinDelay()", 0, "nonce 1 = TimelockController, born with delay 0");
        _expectAddress(expectedRouter, "computeWallet()", computeWallet, "nonce 2 = FeeRouter");
        _expectAddress(expectedDist, "scorer()", scorer, "nonce 3 = RewardsDistributor");
        _expectAddress(expectedDist, "guardian()", guardian, "nonce 3 = RewardsDistributor");
        _expectAddress(expectedLedger, "publisher()", keeper, "nonce 4 = CallLedger");
        _expectAddress(expectedSwapAdapter, "universalRouter()", universalRouter, "nonce 5 = UniV4SwapAdapter");

        // The published table stops at 5: at nonce 6 there must be no sixth contract.
        // (The deployer's nonce goes well past 6, because the setters and the transferOwnership calls
        // are transactions too: that is exactly why all five `new` must come before
        // any setter, otherwise the map would not be 1..5.)
        assertEq(
            vm.computeCreateAddress(deployer, NONCE_AFTER_DEPLOYS).code.length,
            0,
            "someone added a sixth deploy: the published table does not contain it"
        );

        // The published FeeRouter is the one the script actually wired into the rest of the system.
        assertEq(
            FeeRouter(payable(expectedRouter)).rewardsDistributor(),
            expectedDist,
            "the router points to the expected dist"
        );
        assertEq(
            address(FeeRouter(payable(expectedRouter)).swapAdapter()),
            expectedSwapAdapter,
            "the router points to the expected swap adapter"
        );
    }

    // ---- helper: "at this nonce there is the right contract, and it answers as it should" ----

    function _staticcall(address target, string memory sig, string memory what) internal view returns (bytes32) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature(sig));
        require(ok && ret.length == 32, string.concat(what, ": no answer to ", sig, " (deploy order changed?)"));
        return abi.decode(ret, (bytes32));
    }

    function _expectAddress(address target, string memory sig, address expected, string memory what) internal view {
        require(
            address(uint160(uint256(_staticcall(target, sig, what)))) == expected,
            string.concat(what, ": ", sig, " does not match (deploy order changed?)")
        );
    }

    function _expectUint(address target, string memory sig, uint256 expected, string memory what) internal view {
        require(
            uint256(_staticcall(target, sig, what)) == expected,
            string.concat(what, ": ", sig, " does not match (deploy order changed?)")
        );
    }

    /// The handover batch of runbook §4.7: one scheduleBatch + executeBatch from the proposer takes
    /// ownership of the three Ownable2Step contracts AND sets the 24h delay. After it, the deploy key
    /// owns nothing and no change can skip the 24 hours.
    function test_handover_batch_takes_ownership_and_sets_24h() public {
        // A real clock: at Foundry's default timestamp 1, an operation scheduled with delay 0 gets
        // timestamp 1, which OpenZeppelin reads as DONE (_DONE_TIMESTAMP = 1). Never the case on-chain.
        vm.warp(1_790_000_000);
        new DeployAdapter().run();
        vm.setEnv("PONS_ESCROW_ADAPTER", vm.toString(vm.computeCreateAddress(deployer, NONCE_PONS_ESCROW_ADAPTER)));
        new DeployCore().run();
        TimelockController tl = TimelockController(payable(vm.computeCreateAddress(deployer, NONCE_TIMELOCK)));
        address[] memory t = new address[](4);
        t[0] = vm.computeCreateAddress(deployer, NONCE_FEE_ROUTER);
        t[1] = vm.computeCreateAddress(deployer, NONCE_REWARDS_DISTRIBUTOR);
        t[2] = vm.computeCreateAddress(deployer, NONCE_CALL_LEDGER);
        t[3] = address(tl);
        uint256[] memory v = new uint256[](4);
        bytes[] memory d = new bytes[](4);
        for (uint256 i = 0; i < 3; i++) d[i] = abi.encodeWithSignature("acceptOwnership()");
        d[3] = abi.encodeWithSignature("updateDelay(uint256)", 24 hours);
        vm.prank(proposer);
        tl.scheduleBatch(t, v, d, bytes32(0), bytes32(0), 0);
        tl.executeBatch(t, v, d, bytes32(0), bytes32(0)); // open executor: anyone
        assertEq(tl.getMinDelay(), 24 hours, "the delay is 24h after the batch");
        for (uint256 i = 0; i < 3; i++) {
            (, bytes memory o) = t[i].staticcall(abi.encodeWithSignature("owner()"));
            assertEq(abi.decode(o, (address)), address(tl), "owned by the timelock");
        }
        // and from now on nothing can be scheduled under 24h
        vm.prank(proposer);
        vm.expectRevert();
        tl.schedule(t[0], 0, abi.encodeWithSignature("setKeeper(address)", address(1)), bytes32(0), bytes32(uint256(1)), 1 hours);
    }
}
