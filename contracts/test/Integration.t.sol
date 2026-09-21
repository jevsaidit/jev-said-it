// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Merkle} from "murky/Merkle.sol";
import {PonsEscrowAdapter} from "../src/PonsEscrowAdapter.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {RewardsDistributor} from "../src/RewardsDistributor.sol";
import {CallLedger} from "../src/CallLedger.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockFeeEscrow} from "./mocks/MockFeeEscrow.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";

contract IntegrationTest is Test {
    MockERC20 token;
    MockFeeEscrow escrow;
    PonsEscrowAdapter adapter;
    FeeRouter router;
    RewardsDistributor dist;
    CallLedger ledger;
    MockSwapAdapter swapAdapter;
    Merkle m;

    address owner = address(0xA11CE);
    address compute = address(0xC0);
    address ops = address(0x0B5);
    address team = address(0x7EA1);
    address keeper = address(0xC0FFEE);
    address scorer = address(0x5C0);
    address guardian = address(0x6A4D);
    address alice = address(0xA);
    address bob = address(0xB);

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockERC20();
        escrow = new MockFeeEscrow();
        // Phase 1: adapter before the "launch"
        adapter = new PonsEscrowAdapter(address(escrow), owner);
        // Phase 2: core after the launch
        router = new FeeRouter(address(token), owner, compute, ops, team, keeper);
        dist = new RewardsDistributor(address(token), owner, scorer, guardian, block.timestamp);
        ledger = new CallLedger(address(token), owner, keeper, block.timestamp);
        swapAdapter = new MockSwapAdapter(address(token), 1000);
        // The fake adapter does not mint: it delivers from its own balance, like the real one.
        token.mint(address(swapAdapter), 1_000_000e18);
        vm.startPrank(owner);
        adapter.setRouter(payable(address(router)));
        router.setSwapAdapter(address(swapAdapter));
        router.setRewardsDistributor(address(dist));
        vm.stopPrank();
        m = new Merkle();
        token.mint(alice, 20_000e18);
        token.mint(bob, 10_000e18);
    }

    function test_full_epoch_flow() public {
        // 1. the engine opens two questions
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = keccak256("rug?");
        ids[1] = keccak256("holds +20%?");
        vm.prank(keeper);
        ledger.openQuestions(0, ids, uint64(block.timestamp + 1 hours));

        // 2. the holders make calls
        bool[] memory a = new bool[](2);
        a[0] = true;
        a[1] = false;
        vm.prank(alice);
        ledger.submit(ids, a);
        bytes32[] memory one = new bytes32[](1);
        one[0] = ids[0];
        bool[] memory b = new bool[](1);
        b[0] = false;
        vm.prank(bob);
        ledger.submit(one, b);

        // 3. 10 ETH of creator fees arrive in the escrow, anyone calls claim
        vm.deal(address(this), 10 ether);
        escrow.credit{value: 10 ether}(address(adapter));
        adapter.claim();
        assertEq(router.undistributed(), 10 ether);

        // 4. the keeper processes the swap
        vm.prank(keeper);
        router.processSwap(1);
        uint256 out = 6.5 ether * 1000;
        uint256 burned = out * 1500 / 6500;
        assertEq(token.balanceOf(router.DEAD()), burned);
        assertEq(token.balanceOf(address(dist)), out - burned);
        assertEq(router.computeBalance(), 0.5 ether);
        assertEq(router.opsBalance(), 1 ether);
        assertEq(router.teamBalance(), 2 ether);

        // 5. the scorer publishes the root (alice wins 3, bob 1)
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = keccak256(bytes.concat(keccak256(abi.encode(alice, 3e18))));
        leaves[1] = keccak256(bytes.concat(keccak256(abi.encode(bob, 1e18))));
        bytes32 root = m.getRoot(leaves);
        // The engine closes an epoch only after it has ended; the distributor now enforces it.
        vm.warp(dist.genesis() + dist.EPOCH_LENGTH());
        vm.prank(scorer);
        dist.setEpochRoot(0, root, 4e18);

        // 6. claim, only after the 12-hour challenge window
        vm.warp(block.timestamp + 12 hours + 1);
        // NB: the proofs must be computed BEFORE the prank. `m.getProof(...)` is itself an
        // external call and, if passed inline as an argument to `dist.claim(...)`, that is the
        // call that consumes the vm.prank (which spoofs only the next call), not `claim()`:
        // `claim()` would end up running with msg.sender = IntegrationTest and the leaf would no
        // longer match the published root (InvalidProof). See task-7-report.md.
        bytes32[] memory proofAlice = m.getProof(leaves, 0);
        bytes32[] memory proofBob = m.getProof(leaves, 1);
        vm.prank(alice);
        dist.claim(0, 3e18, proofAlice);
        vm.prank(bob);
        dist.claim(0, 1e18, proofBob);
        assertEq(token.balanceOf(alice), 20_000e18 + 3e18);
        assertEq(token.balanceOf(bob), 10_000e18 + 1e18);

        // 7. compute, ops and team withdraw
        vm.prank(compute);
        router.withdrawCompute();
        vm.prank(ops);
        router.withdrawOps();
        vm.prank(team);
        router.withdrawTeam();
        assertEq(compute.balance, 0.5 ether);
        assertEq(ops.balance, 1 ether);
        assertEq(team.balance, 2 ether);
        assertEq(address(router).balance, 0);
    }
}
