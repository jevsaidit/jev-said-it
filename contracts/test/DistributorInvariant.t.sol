// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RewardsDistributor} from "../src/RewardsDistributor.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// Stateful fuzz over setEpochRoot / claim / voidEpoch / sweepExpired / deposits, with a scorer that
/// publishes single-leaf roots (proof = empty). Two invariants:
///   I1  token.balanceOf(dist) >= committed            (freeBalance never underflows)
///   I2  committed == sum over epochs of (epochBudget - epochClaimed)
contract DistHandler is Test {
    RewardsDistributor public dist;
    MockERC20 public token;
    address public scorer;
    address public guardian;
    uint256 public nextEpoch = 1;
    uint256[] public epochs;
    mapping(uint256 => address) public winnerOf;
    mapping(uint256 => uint256) public amountOf;
    // Ghost counters: every handler swallows reverts, so without these a run in which nothing ever
    // succeeded would satisfy every invariant vacuously.
    uint256 public published;
    uint256 public claimed;
    uint256 public voided;
    uint256 public swept;

    constructor(RewardsDistributor d, MockERC20 t, address s, address g) {
        dist = d;
        token = t;
        scorer = s;
        guardian = g;
    }

    function deposit(uint256 amt) external {
        amt = bound(amt, 0, 1_000e18);
        token.mint(address(dist), amt);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 10 days));
    }

    function publish(uint256 amt, uint256 budgetExtra, address winner) external {
        if (winner == address(0)) winner = address(0x1);
        uint256 cap = dist.freeBalance() * dist.maxEpochBudgetBps() / 10_000;
        if (cap == 0) return;
        amt = bound(amt, 1, cap);
        // budget may exceed the leaf (over-committed, swept later) but never the cap
        uint256 budget = bound(budgetExtra, amt, cap);
        bytes32 root = keccak256(bytes.concat(keccak256(abi.encode(winner, amt))));
        uint256 e = nextEpoch++;
        vm.prank(scorer);
        try dist.setEpochRoot(e, root, budget) {
            epochs.push(e);
            winnerOf[e] = winner;
            amountOf[e] = amt;
            published++;
        } catch {
            nextEpoch--;
        }
    }

    function claim(uint256 idx) external {
        if (epochs.length == 0) return;
        uint256 e = epochs[idx % epochs.length];
        // Half the time jump to the opening of the claim window, so that a claim that can succeed
        // is tried in every run and the counter below means something.
        uint256 setAt = dist.epochSetAt(e);
        if (idx % 2 == 1 && setAt != 0 && block.timestamp < setAt + dist.CLAIM_DELAY()) vm.warp(setAt + dist.CLAIM_DELAY());
        vm.prank(winnerOf[e]);
        try dist.claim(e, amountOf[e], new bytes32[](0)) {
            claimed++;
        } catch {}
    }

    function void(uint256 idx) external {
        if (epochs.length == 0) return;
        // Mostly the latest epoch, the only one still inside its 12h void window; sometimes an older one.
        uint256 e = idx % 4 == 0 ? epochs[idx % epochs.length] : epochs[epochs.length - 1];
        vm.prank(guardian);
        try dist.voidEpoch(e) {
            voided++;
        } catch {}
    }

    function sweep(uint256 idx) external {
        if (epochs.length == 0) return;
        uint256 e = epochs[idx % epochs.length];
        // Half the time jump to the end of the claim window: with 10-day warps a 90-day window
        // would need nine of them in a row, and a sweep that never runs proves nothing.
        uint256 setAt = dist.epochSetAt(e);
        if (idx % 2 == 0 && setAt != 0 && block.timestamp < setAt + dist.CLAIM_WINDOW()) vm.warp(setAt + dist.CLAIM_WINDOW());
        try dist.sweepExpired(e) {
            swept++;
        } catch {}
    }

    function epochCount() external view returns (uint256) {
        return epochs.length;
    }
}

contract DistributorInvariantTest is Test {
    RewardsDistributor dist;
    MockERC20 token;
    DistHandler h;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockERC20();
        dist = new RewardsDistributor(address(token), address(this), address(0x5C0), address(0x6A4D), block.timestamp - 1000 days);
        h = new DistHandler(dist, token, address(0x5C0), address(0x6A4D));
        token.mint(address(dist), 10_000e18);
        targetContract(address(h));
    }

    /// After every run: each path must have succeeded at least once, or the invariants above proved
    /// nothing about it.
    function afterInvariant() public view {
        assertGt(h.published(), 0, "no root was ever published");
        assertGt(h.claimed(), 0, "no claim ever went through");
        assertGt(h.voided(), 0, "no void ever went through");
        assertGt(h.swept(), 0, "no sweep ever went through");
    }

    function invariant_I1_balance_covers_committed() public view {
        assertGe(token.balanceOf(address(dist)), dist.committed());
    }

    function invariant_I2_committed_equals_open_budgets() public view {
        uint256 sum;
        for (uint256 i = 0; i < h.epochCount(); i++) {
            uint256 e = h.epochs(i);
            sum += dist.epochBudget(e) - dist.epochClaimed(e);
        }
        assertEq(sum, dist.committed());
    }
}
