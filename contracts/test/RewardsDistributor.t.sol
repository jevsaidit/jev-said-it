// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Merkle} from "murky/Merkle.sol";
import {RewardsDistributor} from "../src/RewardsDistributor.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract RewardsDistributorTest is Test {
    RewardsDistributor dist;
    MockERC20 token;
    Merkle m;
    address owner = address(0xA11CE);
    address scorer = address(0x5C0);
    address guardian = address(0xD00D);
    address alice = address(0xA);
    address bob = address(0xB);
    bytes32[] leaves;

    function setUp() public {
        token = new MockERC20();
        dist = new RewardsDistributor(address(token), owner, scorer, guardian);
        m = new Merkle();
        token.mint(address(dist), 1_000e18);
        leaves.push(_leaf(alice, 60e18));
        leaves.push(_leaf(bob, 40e18));
        leaves.push(_leaf(address(0xC), 1e18)); // murky needs >= 2 leaves; 3 for non-trivial proofs
    }

    function _leaf(address a, uint256 amt) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, amt))));
    }

    function test_setEpochRoot_only_scorer_and_within_budget_cap() public {
        bytes32 root = m.getRoot(leaves);
        vm.expectRevert(RewardsDistributor.NotAuthorized.selector);
        dist.setEpochRoot(1, root, 101e18);
        vm.prank(scorer);
        vm.expectRevert(RewardsDistributor.BudgetTooLarge.selector); // default cap 20% of 1000 = 200
        dist.setEpochRoot(1, root, 201e18);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 101e18);
        assertEq(dist.epochBudget(1), 101e18);
        assertEq(dist.committed(), 101e18);
    }

    function test_claim_with_valid_proof_once() public {
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 101e18);
        bytes32[] memory proof = m.getProof(leaves, 0);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(alice);
        dist.claim(1, 60e18, proof);
        assertEq(token.balanceOf(alice), 60e18);
        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.AlreadyClaimed.selector);
        dist.claim(1, 60e18, proof);
    }

    function test_claim_rejects_wrong_amount() public {
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 101e18);
        bytes32[] memory proof = m.getProof(leaves, 0);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.InvalidProof.selector);
        dist.claim(1, 61e18, proof);
    }

    function test_root_cannot_be_overwritten() public {
        bytes32 root = m.getRoot(leaves);
        vm.startPrank(scorer);
        dist.setEpochRoot(1, root, 101e18);
        vm.expectRevert(RewardsDistributor.RootExists.selector);
        dist.setEpochRoot(1, root, 101e18);
        vm.stopPrank();
    }

    function test_sweepExpired_frees_unclaimed_after_90_days() public {
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 101e18);
        vm.expectRevert(RewardsDistributor.NotExpired.selector);
        dist.sweepExpired(1);
        vm.warp(block.timestamp + 90 days + 1);
        dist.sweepExpired(1);
        assertEq(dist.committed(), 0);
        assertEq(dist.freeBalance(), 1_000e18);
    }

    // --- Fix round 1: defenses against a compromised scorer key ---

    function test_setEpochRoot_rate_limited_to_6_hours() public {
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 50e18);

        vm.prank(scorer);
        vm.expectRevert(RewardsDistributor.EpochTooSoon.selector);
        dist.setEpochRoot(2, root, 50e18);

        vm.warp(block.timestamp + 6 hours);
        vm.prank(scorer);
        dist.setEpochRoot(2, root, 50e18);
        assertEq(dist.epochBudget(2), 50e18);
    }

    function test_setEpochRoot_epoch_must_increase() public {
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(5, root, 50e18);

        vm.warp(block.timestamp + 6 hours);
        vm.prank(scorer);
        vm.expectRevert(RewardsDistributor.EpochNotIncreasing.selector);
        dist.setEpochRoot(3, root, 50e18);
    }

    function test_claim_before_delay_reverts_then_opens() public {
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 101e18);
        bytes32[] memory proof = m.getProof(leaves, 0);

        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.ClaimsNotOpen.selector);
        dist.claim(1, 60e18, proof);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(alice);
        dist.claim(1, 60e18, proof);
        assertEq(token.balanceOf(alice), 60e18);
    }

    function test_guardian_can_void_epoch_before_delay() public {
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 101e18);
        assertEq(dist.committed(), 101e18);

        vm.prank(guardian);
        dist.voidEpoch(1);
        assertEq(dist.committed(), 0);
        assertEq(dist.freeBalance(), 1_000e18);

        bytes32[] memory proof = m.getProof(leaves, 0);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.VoidedEpoch.selector);
        dist.claim(1, 60e18, proof);
    }

    function test_voidEpoch_after_window_reverts() public {
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 101e18);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(guardian);
        vm.expectRevert(RewardsDistributor.VoidWindowClosed.selector);
        dist.voidEpoch(1);
    }

    function test_voidEpoch_only_guardian_or_owner() public {
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 101e18);

        vm.expectRevert(RewardsDistributor.NotAuthorized.selector);
        dist.voidEpoch(1);
    }

    /// @dev The guardian is the only address that fits inside the CLAIM_DELAY = 12 hour window
    ///      (after the handover the owner is a 24-hour timelock). A constructor that accepts zero produces
    ///      a distributor with no valve and does not say so.
    function test_constructor_rejects_zero_guardian() public {
        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        new RewardsDistributor(address(token), owner, scorer, address(0));
    }

    function test_setGuardian_rejects_zero() public {
        vm.prank(owner);
        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        dist.setGuardian(address(0));
        assertEq(dist.guardian(), guardian);
    }

    function test_setGuardian_replaces_guardian_and_emits() public {
        address newGuardian = address(0x6044);
        vm.expectEmit(false, false, false, true, address(dist));
        emit RewardsDistributor.GuardianSet(newGuardian);
        vm.prank(owner);
        dist.setGuardian(newGuardian);
        assertEq(dist.guardian(), newGuardian);

        // and the new guardian really voids: the setter is not just a storage write
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 101e18);
        vm.prank(newGuardian);
        dist.voidEpoch(1);
        assertTrue(dist.epochVoided(1));
    }

    /// @dev Deliberate asymmetry: a zero scorer freezes root publication and does not
    ///      expose a wei, so `address(0)` stays the way to say "no scorer". If we
    ///      ever close that off, this test turns red and must be rewritten on purpose.
    function test_setScorer_accepts_zero_as_a_freeze() public {
        vm.prank(owner);
        dist.setScorer(address(0));
        assertEq(dist.scorer(), address(0));
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        vm.expectRevert(RewardsDistributor.NotAuthorized.selector);
        dist.setEpochRoot(1, root, 101e18);
    }

    /// @dev A zero root is not a root: `setEpochRoot` would accept it (the guard on line 93
    ///      only checks that nothing is overwritten), would commit the budget in `committed`, and then
    ///      NONE of the three exits would ever open again: `claim`, `voidEpoch` and `sweepExpired`
    ///      all start from `roots[epoch] == 0 -> NoRoot`. The budget would stay committed
    ///      forever, and the guardian - the valve - would be disarmed in exactly the case where it is needed.
    ///      Reachable by a compromised scorer key and also by an engine that, for an empty
    ///      tree, emits 0x0 without noticing.
    function test_setEpochRoot_rejects_the_null_root() public {
        vm.prank(scorer);
        vm.expectRevert(RewardsDistributor.NoRoot.selector);
        dist.setEpochRoot(1, bytes32(0), 200e18);

        // nothing committed, nothing frozen: the pool stays whole
        assertEq(dist.committed(), 0);
        assertEq(dist.freeBalance(), 1_000e18);
        assertEq(dist.epochBudget(1), 0);

        // and the publication was not consumed: epoch 1 stays available for a real root
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 101e18);
        assertEq(dist.roots(1), root);
        assertEq(dist.committed(), 101e18);
    }

    // --- Task 10: coverage of the exits and the cap, which were uncovered ---

    /// @dev `setMaxEpochBudgetBps` was the only function in the contract without a single test: it covers the
    ///      cap that stops the scorer from committing the whole pool in one epoch. This checks
    ///      that the two guards bite and that raising the cap really changes how much the scorer can commit.
    function test_setMaxEpochBudgetBps_guards_and_changes_the_cap() public {
        assertEq(dist.maxEpochBudgetBps(), 2000);

        vm.prank(owner);
        vm.expectRevert(RewardsDistributor.BudgetTooLarge.selector);
        dist.setMaxEpochBudgetBps(0); // zero would freeze every publication

        vm.prank(owner);
        vm.expectRevert(RewardsDistributor.BudgetTooLarge.selector);
        dist.setMaxEpochBudgetBps(10_001); // above 100%

        vm.expectRevert(); // not owner
        dist.setMaxEpochBudgetBps(5000);
        assertEq(dist.maxEpochBudgetBps(), 2000);

        vm.expectEmit(false, false, false, true, address(dist));
        emit RewardsDistributor.MaxEpochBudgetSet(10_000);
        vm.prank(owner);
        dist.setMaxEpochBudgetBps(10_000);
        assertEq(dist.maxEpochBudgetBps(), 10_000);

        // the cap is really the one applied: now the scorer can commit the whole free balance
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 1_000e18);
        assertEq(dist.committed(), 1_000e18);
        assertEq(dist.freeBalance(), 0);
    }

    /// @dev The three exits all start from the same guard `roots[epoch] == 0`. An epoch never
    ///      published must not look like an empty epoch.
    function test_unknown_epoch_has_no_entry_points() public {
        bytes32[] memory proof = new bytes32[](0);

        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.NoRoot.selector);
        dist.claim(42, 1e18, proof);

        vm.prank(guardian);
        vm.expectRevert(RewardsDistributor.NoRoot.selector);
        dist.voidEpoch(42);

        vm.expectRevert(RewardsDistributor.NoRoot.selector);
        dist.sweepExpired(42);
    }

    /// @dev Voiding twice would free `committed` twice if the flag did not stop the second one.
    function test_voidEpoch_is_not_idempotent_on_committed() public {
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 101e18);

        vm.prank(guardian);
        dist.voidEpoch(1);
        assertEq(dist.committed(), 0);

        vm.prank(guardian);
        vm.expectRevert(RewardsDistributor.AlreadyVoided.selector);
        dist.voidEpoch(1);
        assertEq(dist.committed(), 0);
    }

    /// @dev Same reasoning for the sweep: the second pass must not free again.
    function test_sweepExpired_cannot_run_twice() public {
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 101e18);
        vm.warp(block.timestamp + 90 days + 1);

        dist.sweepExpired(1);
        assertEq(dist.committed(), 0);

        vm.expectRevert(RewardsDistributor.AlreadySwept.selector);
        dist.sweepExpired(1);
        assertEq(dist.committed(), 0);
    }

    function test_claim_reverts_when_epoch_budget_exceeded() public {
        bytes32 root = m.getRoot(leaves);
        vm.prank(scorer);
        dist.setEpochRoot(1, root, 90e18); // alice(60) + bob(40) = 100 > 90
        vm.warp(block.timestamp + 12 hours);

        bytes32[] memory proofAlice = m.getProof(leaves, 0);
        bytes32[] memory proofBob = m.getProof(leaves, 1);

        vm.prank(alice);
        dist.claim(1, 60e18, proofAlice);

        vm.prank(bob);
        vm.expectRevert(RewardsDistributor.BudgetExceeded.selector);
        dist.claim(1, 40e18, proofBob);
    }
}
