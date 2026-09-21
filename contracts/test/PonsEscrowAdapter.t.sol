// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PonsEscrowAdapter} from "../src/PonsEscrowAdapter.sol";
import {MockFeeEscrow} from "./mocks/MockFeeEscrow.sol";

contract Sink {
    uint256 public received;

    receive() external payable {
        received += msg.value;
    }
}

contract PonsEscrowAdapterTest is Test {
    MockFeeEscrow escrow;
    PonsEscrowAdapter adapter;
    Sink sink;
    address owner = address(0xA11CE);

    function setUp() public {
        escrow = new MockFeeEscrow();
        adapter = new PonsEscrowAdapter(address(escrow), owner);
        sink = new Sink();
    }

    function test_claim_reverts_before_router_set() public {
        vm.expectRevert(PonsEscrowAdapter.NotSet.selector);
        adapter.claim();
    }

    function test_setRouter_only_owner_and_only_once() public {
        vm.expectRevert();
        adapter.setRouter(payable(address(sink)));
        vm.prank(owner);
        adapter.setRouter(payable(address(sink)));
        vm.prank(owner);
        vm.expectRevert(PonsEscrowAdapter.AlreadySet.selector);
        adapter.setRouter(payable(address(sink)));
    }

    function test_claimable_reads_escrow_balance() public {
        escrow.credit{value: 2 ether}(address(adapter));
        assertEq(adapter.claimable(), 2 ether);
    }

    function test_claim_pulls_from_escrow_and_forwards_everything() public {
        vm.prank(owner);
        adapter.setRouter(payable(address(sink)));
        escrow.credit{value: 1 ether}(address(adapter));
        vm.deal(address(adapter), 0.5 ether); // ETH that arrived passively
        uint256 forwarded = adapter.claim();
        assertEq(forwarded, 1.5 ether);
        assertEq(sink.received(), 1.5 ether);
        assertEq(address(adapter).balance, 0);
        assertEq(escrow.balanceOf(address(adapter)), 0);
    }

    function test_claim_forwards_passive_eth_even_when_escrow_empty() public {
        vm.prank(owner);
        adapter.setRouter(payable(address(sink)));
        vm.deal(address(adapter), 0.25 ether);
        uint256 forwarded = adapter.claim(); // escrow.claim() reverts, the catch absorbs it
        assertEq(forwarded, 0.25 ether);
        assertEq(sink.received(), 0.25 ether);
    }

    function test_setRouter_reverts_on_zero_address() public {
        vm.prank(owner);
        vm.expectRevert(PonsEscrowAdapter.InvalidRouter.selector);
        adapter.setRouter(payable(address(0)));
    }

    function test_setRouter_reverts_on_self_address() public {
        vm.prank(owner);
        vm.expectRevert(PonsEscrowAdapter.InvalidRouter.selector);
        adapter.setRouter(payable(address(adapter)));
    }

    function test_setRouter_valid_router_succeeds_and_emits_RouterSet() public {
        vm.expectEmit(true, false, false, true, address(adapter));
        emit PonsEscrowAdapter.RouterSet(address(sink));
        vm.prank(owner);
        adapter.setRouter(payable(address(sink)));
        assertEq(adapter.router(), address(sink));
    }
}
