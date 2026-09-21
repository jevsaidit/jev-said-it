// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {MockFeeOnTransferERC20} from "./mocks/MockFeeOnTransferERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract FeeRouterTest is Test {
    FeeRouter router;
    MockERC20 token;
    address owner = address(0xA11CE);
    address compute = address(0xC0);
    address ops = address(0x0B5);
    address team = address(0x7EA1);
    address keeper = address(0xC0FFEE);

    function setUp() public {
        token = new MockERC20();
        router = new FeeRouter(address(token), owner, compute, ops, team, keeper);
    }

    function test_receive_tracks_undistributed() public {
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(router.undistributed(), 1 ether);
    }

    function test_constructor_rejects_zero_team_wallet() public {
        vm.expectRevert(FeeRouter.ZeroAddress.selector);
        new FeeRouter(address(token), owner, compute, ops, address(0), keeper);
    }

    function test_distribute_splits_500_1000_2000_6500() public {
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(router).call{value: 10 ether}("");
        assertTrue(ok);
        router.distribute();
        assertEq(router.undistributed(), 0);
        assertEq(router.computeBalance(), 0.5 ether);
        assertEq(router.opsBalance(), 1 ether);
        assertEq(router.teamBalance(), 2 ether);
        assertEq(router.swapBalance(), 6.5 ether); // burn 15% + rewards 50%
    }

    /// @dev Prime amount: none of the bps divides it exactly, so there really is a remainder to
    ///      lose. The remainder must end up in the swap and the sum of the buckets must match to the wei.
    function test_distribute_loses_no_wei_on_prime_amount() public {
        uint256 amount = 1_000_003; // wei, prime
        vm.deal(address(this), amount);
        (bool ok,) = address(router).call{value: amount}("");
        assertTrue(ok);
        router.distribute();

        assertEq(router.computeBalance(), 50_000);
        assertEq(router.opsBalance(), 100_000);
        assertEq(router.teamBalance(), 200_000);
        assertEq(router.swapBalance(), 650_003);
        assertEq(
            router.computeBalance() + router.opsBalance() + router.teamBalance() + router.swapBalance(),
            amount,
            "a wei was lost"
        );
        // the remainder ended up in the swap: it takes more than its nominal share
        uint256 nominalSwap = amount * (uint256(router.burnBps()) + router.rewardsBps()) / router.BPS();
        assertEq(nominalSwap, 650_001);
        assertGt(router.swapBalance(), nominalSwap);
    }

    function test_distribute_reverts_when_nothing() public {
        vm.expectRevert(FeeRouter.NothingToDo.selector);
        router.distribute();
    }

    function test_withdrawCompute_only_compute_wallet() public {
        vm.deal(address(router), 0);
        (bool ok,) = address(router).call{value: 10 ether}("");
        assertTrue(ok);
        router.distribute();
        vm.prank(ops);
        vm.expectRevert(FeeRouter.NotAuthorized.selector);
        router.withdrawCompute();
        uint256 before = compute.balance;
        vm.prank(compute);
        router.withdrawCompute();
        assertEq(compute.balance - before, 0.5 ether);
        assertEq(router.computeBalance(), 0);
    }

    function test_withdrawOps_pays_ops_wallet() public {
        (bool ok,) = address(router).call{value: 10 ether}("");
        assertTrue(ok);
        router.distribute();
        vm.prank(compute);
        vm.expectRevert(FeeRouter.NotAuthorized.selector);
        router.withdrawOps();
        uint256 before = ops.balance;
        vm.prank(ops);
        router.withdrawOps();
        assertEq(ops.balance - before, 1 ether);
        assertEq(router.opsBalance(), 0);
    }

    function test_withdrawTeam_only_team_wallet() public {
        (bool ok,) = address(router).call{value: 10 ether}("");
        assertTrue(ok);
        router.distribute();
        vm.prank(ops);
        vm.expectRevert(FeeRouter.NotAuthorized.selector);
        router.withdrawTeam();
        vm.prank(compute);
        vm.expectRevert(FeeRouter.NotAuthorized.selector);
        router.withdrawTeam();
        vm.prank(owner); // not even the owner: the team bucket belongs to teamWallet alone
        vm.expectRevert(FeeRouter.NotAuthorized.selector);
        router.withdrawTeam();
        assertEq(router.teamBalance(), 2 ether); // nobody touched it
    }

    function test_withdrawTeam_reverts_when_bucket_empty() public {
        vm.prank(team);
        vm.expectRevert(FeeRouter.NothingToDo.selector);
        router.withdrawTeam();
    }

    function test_withdrawTeam_pays_team_wallet_and_emits() public {
        (bool ok,) = address(router).call{value: 10 ether}("");
        assertTrue(ok);
        router.distribute();
        uint256 before = team.balance;
        vm.prank(team);
        vm.expectEmit(true, false, false, true, address(router));
        emit FeeRouter.TeamWithdrawn(team, 2 ether);
        router.withdrawTeam();
        assertEq(team.balance - before, 2 ether);
        assertEq(router.teamBalance(), 0);
    }

    function test_setSplits_requires_sum_10000_and_owner() public {
        vm.prank(owner);
        vm.expectRevert(FeeRouter.BadSplits.selector);
        router.setSplits(1000, 1000, 1000, 1000, 1000); // sum 5000
        vm.prank(owner);
        vm.expectRevert(FeeRouter.BadSplits.selector);
        router.setSplits(1000, 1000, 1000, 1500, 5000); // sum 9500: one point missing
        vm.expectRevert(); // not owner
        router.setSplits(1000, 1000, 1000, 2000, 5000);
        vm.prank(owner);
        router.setSplits(1000, 1000, 1000, 2000, 5000);
        assertEq(router.computeBps(), 1000);
        assertEq(router.opsBps(), 1000);
        assertEq(router.teamBps(), 1000);
        assertEq(router.burnBps(), 2000);
        assertEq(router.rewardsBps(), 5000);
    }

    /// @dev The sum is exact: what must stop the call is the second guard, without
    ///      which `processSwap` would divide by `burnBps + rewardsBps == 0`.
    ///      The team at 5000 is a choice, not a constraint: the move to five buckets did not
    ///      force a change to the values of this case, because `(5000, 5000, 0, 0, 0)` also
    ///      sums to 10_000 and would isolate the same guard. Here the team is non-zero only because
    ///      it is a more realistic split; if someone rewrites it, the constraint to respect is
    ///      the sum to `BPS` with `burn + rewards == 0`, nothing else.
    function test_setSplits_reverts_when_burn_and_rewards_both_zero() public {
        vm.prank(owner);
        vm.expectRevert(FeeRouter.BadSplits.selector);
        router.setSplits(2500, 2500, 5000, 0, 0);
    }

    function test_setWallets_sets_three_and_rejects_zero_team() public {
        vm.prank(owner);
        vm.expectRevert(FeeRouter.ZeroAddress.selector);
        router.setWallets(compute, ops, address(0));
        address newTeam = address(0x7EA2);
        vm.prank(owner);
        router.setWallets(compute, ops, newTeam);
        assertEq(router.teamWallet(), newTeam);
    }

    function _configureSwap() internal returns (MockSwapAdapter adapter, address distributor) {
        adapter = new MockSwapAdapter(address(token), 1000); // 1 wei -> 1000 token-wei
        // The fake adapter does not mint: it delivers from its own balance, like the real one.
        token.mint(address(adapter), 1_000_000 ether);
        distributor = address(0xD15);
        vm.startPrank(owner);
        router.setSwapAdapter(address(adapter));
        router.setRewardsDistributor(distributor);
        vm.stopPrank();
    }

    function test_processSwap_burns_15_of_65_and_sends_rest_to_rewards() public {
        (, address distributor) = _configureSwap();
        (bool ok,) = address(router).call{value: 10 ether}("");
        assertTrue(ok);
        vm.prank(keeper);
        router.processSwap(0);
        // 10 ether in -> swap bucket 6.5 ether -> mock rate 1000 -> out = 6500 ether-equivalent
        // burn share 1500/6500 of 6500 = 1500 ether; rewards share = 5000 ether.
        assertEq(token.balanceOf(router.DEAD()), 1500 ether);
        assertEq(token.balanceOf(distributor), 5000 ether);
        assertEq(router.swapBalance(), 0);
        assertEq(router.computeBalance(), 0.5 ether); // untouched
        assertEq(router.teamBalance(), 2 ether); // untouched
    }

    function test_processSwap_only_keeper_and_respects_minOut() public {
        _configureSwap();
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertTrue(ok);
        vm.expectRevert(FeeRouter.NotAuthorized.selector);
        router.processSwap(0);
        vm.prank(keeper);
        vm.expectRevert("slippage");
        router.processSwap(type(uint256).max);
    }

    function test_processSwap_reverts_if_not_configured() public {
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertTrue(ok);
        vm.prank(keeper);
        vm.expectRevert(FeeRouter.NotConfigured.selector);
        router.processSwap(0);
    }

    function test_timelock_as_owner_enforces_24h_delay() public {
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // anyone can execute after the delay
        TimelockController tl = new TimelockController(24 hours, proposers, executors, address(0));
        vm.prank(owner);
        router.transferOwnership(address(tl));
        vm.prank(address(tl));
        router.acceptOwnership();
        assertEq(router.owner(), address(tl));

        bytes memory data = abi.encodeCall(FeeRouter.setKeeper, (address(0x1234)));
        vm.prank(owner);
        tl.schedule(address(router), 0, data, bytes32(0), bytes32(0), 24 hours);
        vm.expectRevert(); // too early
        tl.execute(address(router), 0, data, bytes32(0), bytes32(0));
        vm.warp(block.timestamp + 24 hours);
        tl.execute(address(router), 0, data, bytes32(0), bytes32(0));
        assertEq(router.keeper(), address(0x1234));
    }

    /// @dev The case that previously could not even be expressed. The adapter declares 6500 tokens but the
    ///      token withholds 1% in transit, so 6435 reach the router. Paying the two
    ///      legs on the declared figure made the second one revert on insufficient balance, and
    ///      `processSwap` stayed broken forever with 65% of the fees inside.
    ///      Here the router is required to spend what arrived, all of it and only that,
    ///      and the shortfall must be split with the same burn/rewards ratio.
    function test_processSwap_pays_out_what_arrived_with_a_fee_on_transfer_token() public {
        MockFeeOnTransferERC20 fot = new MockFeeOnTransferERC20(100); // 1% on every transfer
        FeeRouter r = new FeeRouter(address(fot), owner, compute, ops, team, keeper);
        MockSwapAdapter a = new MockSwapAdapter(address(fot), 1000);
        fot.mint(address(a), 1_000_000 ether);
        address distributor = address(0xD15);
        vm.startPrank(owner);
        r.setSwapAdapter(address(a));
        r.setRewardsDistributor(distributor);
        vm.stopPrank();

        vm.deal(address(this), 10 ether);
        (bool ok,) = address(r).call{value: 10 ether}("");
        assertTrue(ok);

        // out in the event is what was received (6435), not what the adapter declared (6500).
        vm.expectEmit(false, false, false, true, address(r));
        emit FeeRouter.SwapProcessed(6.5 ether, 6435 ether, 1485 ether, 4950 ether);
        vm.prank(keeper);
        r.processSwap(0);

        assertEq(fot.balanceOf(address(r)), 0, "the router keeps nothing of what arrived");
        // the two outgoing legs also lose 1%: 1485 -> 1470.15 and 4950 -> 4900.5
        assertEq(fot.balanceOf(r.DEAD()), 1470.15 ether, "burn share actually burned");
        assertEq(fot.balanceOf(distributor), 4900.5 ether, "rewards share actually delivered");
        // the shortfall is not pushed onto a single leg: the 1500/6500 ratio holds.
        assertEq(
            fot.balanceOf(r.DEAD()) * (uint256(r.burnBps()) + r.rewardsBps()),
            (fot.balanceOf(r.DEAD()) + fot.balanceOf(distributor)) * r.burnBps(),
            "the burn/rewards ratio must not change"
        );
        // the ETH buckets stay as always
        assertEq(r.swapBalance(), 0);
        assertEq(r.computeBalance(), 0.5 ether);
        assertEq(r.opsBalance(), 1 ether);
        assertEq(r.teamBalance(), 2 ether);
    }
}
