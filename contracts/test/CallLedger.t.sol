// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CallLedger} from "../src/CallLedger.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract CallLedgerTest is Test {
    CallLedger ledger;
    MockERC20 token;
    address owner = address(0xA11CE);
    address publisher = address(0x9B);
    address alice = address(0xA);
    bytes32 q1 = keccak256("q1");
    bytes32 q2 = keccak256("q2");

    function setUp() public {
        token = new MockERC20();
        vm.warp(1_800_000_000);
        ledger = new CallLedger(address(token), owner, publisher, block.timestamp);
    }

    function _open(bytes32[] memory ids) internal {
        // NOTE: `ledger.currentEpoch()` must be evaluated BEFORE vm.prank, not inline as an
        // argument to openQuestions(...). Foundry's vm.prank only overrides msg.sender for the
        // very next external call; evaluating the currentEpoch() argument triggers its own
        // staticcall first and consumes the prank, so openQuestions would then run as the test
        // contract instead of `publisher` and revert with NotAuthorized(). Caching the epoch in a
        // local variable keeps the prank targeted at the openQuestions call itself.
        uint256 epoch = ledger.currentEpoch();
        vm.prank(publisher);
        ledger.openQuestions(epoch, ids, uint64(block.timestamp + 1 hours));
    }

    function test_capacity_is_balance_over_10k_capped_at_50() public {
        assertEq(ledger.capacity(alice), 0);
        token.mint(alice, 25_000e18);
        assertEq(ledger.capacity(alice), 2);
        token.mint(alice, 10_000_000e18);
        assertEq(ledger.capacity(alice), 50);
    }

    function test_epoch_advances_every_6_hours() public {
        assertEq(ledger.currentEpoch(), 0);
        vm.warp(block.timestamp + 6 hours);
        assertEq(ledger.currentEpoch(), 1);
    }

    function test_submit_requires_open_question_and_capacity() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = q1;
        bool[] memory ans = new bool[](1);
        ans[0] = true;
        vm.prank(alice);
        vm.expectRevert(CallLedger.QuestionClosed.selector);
        ledger.submit(ids, ans);
        _open(ids);
        vm.prank(alice);
        vm.expectRevert(CallLedger.NoCapacity.selector);
        ledger.submit(ids, ans);
        token.mint(alice, 10_000e18);
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit CallLedger.CallSubmitted(0, alice, q1, true, 10_000e18);
        ledger.submit(ids, ans);
    }

    function test_no_double_answer_and_capacity_consumed() public {
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = q1;
        ids[1] = q2;
        _open(ids);
        token.mint(alice, 10_000e18); // capacity 1
        bytes32[] memory one = new bytes32[](1);
        one[0] = q1;
        bool[] memory ans = new bool[](1);
        ans[0] = false;
        vm.prank(alice);
        ledger.submit(one, ans);
        vm.prank(alice);
        vm.expectRevert(CallLedger.AlreadyAnswered.selector);
        ledger.submit(one, ans);
        one[0] = q2;
        vm.prank(alice);
        vm.expectRevert(CallLedger.NoCapacity.selector);
        ledger.submit(one, ans);
    }

    function test_submit_after_deadline_reverts() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = q1;
        _open(ids);
        token.mint(alice, 10_000e18);
        vm.warp(block.timestamp + 2 hours);
        bool[] memory ans = new bool[](1);
        ans[0] = true;
        vm.prank(alice);
        vm.expectRevert(CallLedger.QuestionClosed.selector);
        ledger.submit(ids, ans);
    }

    function test_openQuestions_only_publisher() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = q1;
        vm.expectRevert(CallLedger.NotAuthorized.selector);
        ledger.openQuestions(0, ids, uint64(block.timestamp + 1 hours));
    }

    function test_submit_reverts_on_length_mismatch() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = q1;
        _open(ids); // question open, so a real defect wouldn't hide behind QuestionClosed
        token.mint(alice, 10_000e18); // capacity 1, so a real defect wouldn't hide behind NoCapacity
        bool[] memory ans = new bool[](2);
        ans[0] = true;
        ans[1] = false;
        vm.prank(alice);
        vm.expectRevert(CallLedger.LengthMismatch.selector);
        ledger.submit(ids, ans);
    }

    function test_openQuestions_reverts_on_bad_deadline() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = q1;
        vm.prank(publisher);
        vm.expectRevert(CallLedger.BadDeadline.selector);
        ledger.openQuestions(0, ids, uint64(block.timestamp));
    }

    function test_setPublisher_only_owner_and_switches_publisher() public {
        address newPublisher = address(0xCAFE);

        vm.prank(alice);
        vm.expectRevert();
        ledger.setPublisher(newPublisher);
        assertEq(ledger.publisher(), publisher);

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit CallLedger.PublisherSet(newPublisher);
        ledger.setPublisher(newPublisher);
        assertEq(ledger.publisher(), newPublisher);

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = q1;

        // Evaluate currentEpoch() before vm.prank, same reasoning as in _open(): an inline
        // ledger.currentEpoch() argument would consume the prank via its own staticcall.
        uint256 epoch = ledger.currentEpoch();
        vm.prank(newPublisher);
        ledger.openQuestions(epoch, ids, uint64(block.timestamp + 1 hours));

        uint256 epoch2 = ledger.currentEpoch();
        vm.prank(publisher);
        vm.expectRevert(CallLedger.NotAuthorized.selector);
        ledger.openQuestions(epoch2, ids, uint64(block.timestamp + 1 hours));
    }
}
