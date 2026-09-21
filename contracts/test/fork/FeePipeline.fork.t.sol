// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PonsEscrowAdapter} from "../../src/PonsEscrowAdapter.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {CallLedger} from "../../src/CallLedger.sol";
import {RewardsDistributor} from "../../src/RewardsDistributor.sol";
import {UniV4SwapAdapter} from "../../src/adapters/UniV4SwapAdapter.sol";
import {IPonsFeeEscrow} from "../../src/interfaces/IPonsFeeEscrow.sol";

/// @dev The launch struct of PonsV2LaunchFactory, decoded from a real launch transaction
///      (`launchToken`, selector 0xf35abbcf) and cross-checked against `getLaunchedToken`:
///      `feeRecipient` is word 3 of the record, `creatorTaxBps` is word 8, `pairToken == 0` is ETH.
struct Socials {
    string a;
    string b;
    string c;
    string d;
    string e;
}

struct LaunchParams {
    string name;
    string symbol;
    string image;
    string description;
    Socials socials;
    address feeRecipient;
    uint16 creatorTaxBps;
    bool flag;
    bytes32 extra;
    bytes32 salt;
}

interface IPonsFactory {
    function launchToken(LaunchParams calldata p, uint256 initialBuy, address pairToken) external payable;
    function launchFee() external view returns (uint256);
    function createGraduatedPool(address token) external;
}

/// @dev The curve interface is undocumented: these signatures are the ones found in its bytecode.
/// @dev Fees accrue in the hook and reach the escrow only when Pons' operator sweeps the pool:
///      `sweepPoolFees` reverts with `NotFeeSweepOperator` for anyone else (checked on mainnet).
interface IPonsHook {
    function sweepPoolFees(bytes32 poolId, uint256 a, uint256 b) external;
}

interface IPonsCurve {
    function buy(uint256, uint256, address) external payable returns (uint256);
    function graduated() external view returns (bool);
    function graduationThreshold() external view returns (uint256);
}

/// The whole fee path, on mainnet contracts, from a Pons launch to a winner's claim:
///
///   launch (feeRecipient = PonsEscrowAdapter, creator tax 0, ETH pair)
///   -> buys on the curve until graduation -> trading on the real v4 pool
///   -> the Pons escrow credits the adapter -> adapter.claim() -> FeeRouter
///   -> distribute() -> processSwap() buys the token, burns, funds the RewardsDistributor
///   -> an epoch root with a winner -> the winner claims.
///
/// Run with: forge test --match-path test/fork/FeePipeline.fork.t.sol --fork-url robinhood -vv
/// Without `--fork-url robinhood` it skips itself, like the other fork test.
contract FeePipelineForkTest is Test {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant HOOKS = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @dev The only caller of `sweepPoolFees` seen on mainnet (12 of 12 sweeps sampled on 2026-09-21).
    address constant PONS_SWEEP_OPERATOR = 0x49BbF2b70955Fb3a106e084D4BFDa92d334573d2;
    uint256 constant ROBINHOOD_CHAIN_ID = 4663;
    /// @dev `TokenLaunched` of the factory: topics[1] = token.
    bytes32 constant LAUNCH_TOPIC = 0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607;

    address launcher = makeAddr("launcher");
    address buyer = makeAddr("curve-buyer");
    address trader = makeAddr("trader");
    address winner = makeAddr("winner");
    address keeper = makeAddr("keeper");
    address scorer = makeAddr("scorer");
    address guardian = makeAddr("guardian");
    address computeWallet = makeAddr("compute");
    address opsWallet = makeAddr("ops");
    address teamWallet = makeAddr("team");

    function _word(bytes memory data, uint256 i) internal pure returns (uint256 w) {
        assembly {
            w := mload(add(add(data, 32), mul(i, 32)))
        }
    }

    function _record(address t) internal view returns (bytes memory r) {
        bool ok;
        (ok, r) = FACTORY.staticcall(abi.encodeWithSignature("getLaunchedToken(address)", t));
        require(ok, "getLaunchedToken failed");
    }

    // The state of the path, one stage after another.
    PonsEscrowAdapter feeAdapter;
    UniV4SwapAdapter swapAdapter;
    FeeRouter router;
    RewardsDistributor dist;
    address token;
    address curve;
    uint256 credited;
    uint256 forwarded;
    uint256 toRewards;

    function test_fees_reach_the_winner_on_real_pons() public {
        vm.skip(block.chainid != ROBINHOOD_CHAIN_ID);
        _launch();
        _graduate();
        _trade();
        _wire();
        _claimAndSplit();
        _buyback();
        _reward();
        _payTeam();
    }

    /// 1-2. The adapter exists before the launch; the launch names it as fee recipient.
    function _launch() internal {
        feeAdapter = new PonsEscrowAdapter(ESCROW, address(this));
        LaunchParams memory p = LaunchParams({
            name: "Jev Said It Fork Test",
            symbol: "JSIFORK",
            image: "",
            description: "fork test",
            socials: Socials("", "", "", "", ""),
            feeRecipient: address(feeAdapter),
            creatorTaxBps: 0,
            flag: false,
            extra: bytes32(0),
            salt: keccak256("jsi-fork")
        });
        uint256 fee = IPonsFactory(FACTORY).launchFee();
        vm.deal(launcher, 1 ether);
        vm.recordLogs();
        vm.prank(launcher);
        IPonsFactory(FACTORY).launchToken{value: fee}(p, 0, address(0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == FACTORY && logs[i].topics[0] == LAUNCH_TOPIC) {
                token = address(uint160(uint256(logs[i].topics[1])));
            }
        }
        assertTrue(token != address(0), "no TokenLaunched event");
        // What the runbook's gate (§4.5) checks: fee recipient = adapter, creator tax 0, ETH pair.
        bytes memory rec = _record(token);
        curve = address(uint160(_word(rec, 1)));
        assertEq(address(uint160(_word(rec, 2))), launcher, "word 2 must be the launcher");
        assertEq(address(uint160(_word(rec, 3))), address(feeAdapter), "word 3 must be the adapter");
        assertEq(_word(rec, 4), 0, "pair must be ETH");
        assertEq(_word(rec, 8), 0, "creator tax must be 0");
        console2.log("token", token);
        console2.log("curve", curve);
        console2.log("graduation threshold (wei)", _word(rec, 5));
    }

    /// 3. Buys on the curve until it graduates, a few minutes after the launch (early buys can
    ///    carry an anti-snipe tax). The winner buys early enough to hold call capacity.
    function _graduate() internal {
        vm.warp(block.timestamp + 600);
        vm.roll(block.number + 6000);
        vm.deal(buyer, 100 ether);
        vm.deal(winner, 10 ether);
        vm.prank(winner);
        IPonsCurve(curve).buy{value: 0.2 ether}(0.2 ether, 0, winner);
        uint256 rounds;
        vm.recordLogs();
        while (!IPonsCurve(curve).graduated() && rounds < 40) {
            vm.prank(buyer);
            IPonsCurve(curve).buy{value: 0.5 ether}(0.5 ether, 0, buyer);
            rounds++;
        }
        assertTrue(IPonsCurve(curve).graduated(), "curve did not graduate");
        // Reaching the threshold does NOT create the v4 pool: the migration is a separate call,
        // graduate(token) on the factory (seen as a batch of two calls in real graduations).
        // Reaching the threshold does NOT create the v4 pool. The migration is a separate call,
        // createGraduatedPool(token) on the factory, open to anyone: on mainnet a bot batches it
        // with a buy of the fresh pool (a real graduation, decoded as an ERC-7579 batch).
        vm.prank(buyer);
        IPonsFactory(FACTORY).createGraduatedPool(token);
        Vm.Log[] memory glogs = vm.getRecordedLogs();
        bytes32 initTopic = keccak256("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
        for (uint256 i = 0; i < glogs.length; i++) {
            if (glogs[i].topics.length > 0 && glogs[i].topics[0] == initTopic) {
                (uint24 f, int24 ts, address h,,) = abi.decode(glogs[i].data, (uint24, int24, address, uint160, int24));
                console2.log("Initialize: currency0", address(uint160(uint256(glogs[i].topics[2]))));
                console2.log("  currency1", address(uint160(uint256(glogs[i].topics[3]))));
                console2.log("  fee", uint256(f));
                console2.log("  tickSpacing", uint256(int256(ts)));
                console2.log("  hooks", h);
            }
        }
        console2.log("logs during graduation", glogs.length);
        console2.log("graduated after buys of 0.5 ETH:", rounds);
        console2.log("winner token balance", IERC20(token).balanceOf(winner));
    }

    /// 4. Trading on the real v4 pool, through the swap adapter the router will use.
    function _trade() internal {
        swapAdapter = new UniV4SwapAdapter(UNIVERSAL_ROUTER, address(this));
        swapAdapter.setPool(token, 0, 200, HOOKS);
        uint256 before = IPonsFeeEscrow(ESCROW).balanceOf(address(feeAdapter));
        console2.log("escrow owes the adapter BEFORE trading on the pool (curve phase)", before);
        vm.deal(trader, 100 ether);
        vm.recordLogs();
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(trader);
            swapAdapter.swapExactETHForToken{value: 1 ether}(token, 1, trader);
        }
        _logHookFees(vm.getRecordedLogs());
        assertEq(IPonsFeeEscrow(ESCROW).balanceOf(address(feeAdapter)), before, "credited before any sweep?");
        // Pons' operator settles the pool: this is the step we do not control.
        bytes32 poolId = keccak256(abi.encode(address(0), token, uint24(0), int24(200), HOOKS));
        vm.prank(PONS_SWEEP_OPERATOR);
        IPonsHook(HOOKS).sweepPoolFees(poolId, 1, 0); // first arg: minimum ETH out of converting token-side fees
        credited = IPonsFeeEscrow(ESCROW).balanceOf(address(feeAdapter)) - before;
        console2.log("escrow credit to the adapter after the sweep (wei), on 10 ETH of buys", credited);
        assertGt(credited, 0, "the escrow credited nothing to the adapter");
    }

    /// Sums the two hook legs of the trades, split by the currency they were taken in.
    function _logHookFees(Vm.Log[] memory logs) internal pure {
        bytes32 t = 0xc532c43b3423e14ef72748f1c8291238829ca0af8ba9b67975ad1483485a4b4d;
        uint256 ethLeg1;
        uint256 tokLeg1;
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == HOOKS && logs[i].topics[0] == t) {
                (address cur, uint256 l1,) = abi.decode(logs[i].data, (address, uint256, uint256));
                if (cur == address(0)) ethLeg1 += l1;
                else tokLeg1 += l1;
                n++;
            }
        }
        console2.log("HookFeeCollected events", n);
        console2.log("  leg1 taken in ETH (wei)", ethLeg1);
        console2.log("  leg1 taken in the token (units)", tokLeg1);
    }

    /// 5. The project contracts, wired as DeployCore does (owner = this test, not a timelock).
    function _wire() internal {
        router = new FeeRouter(token, address(this), computeWallet, opsWallet, teamWallet, keeper);
        dist = new RewardsDistributor(token, address(this), scorer, guardian);
        router.setSwapAdapter(address(swapAdapter));
        router.setRewardsDistributor(address(dist));
        feeAdapter.setRouter(payable(address(router)));
    }

    /// 6-7. claim(): escrow -> adapter -> router, all of it; then the split, to the wei.
    function _claimAndSplit() internal {
        uint256 owed = IPonsFeeEscrow(ESCROW).balanceOf(address(feeAdapter));
        forwarded = feeAdapter.claim();
        assertEq(forwarded, owed, "the adapter forwarded something else than what the escrow owed");
        assertEq(router.undistributed(), forwarded, "router did not account the fees");
        assertEq(IPonsFeeEscrow(ESCROW).balanceOf(address(feeAdapter)), 0, "escrow still owes the adapter");
        router.distribute();
        assertEq(router.computeBalance(), forwarded * 500 / 10_000, "compute bucket");
        assertEq(router.opsBalance(), forwarded * 1000 / 10_000, "ops bucket");
        assertEq(router.teamBalance(), forwarded * 2000 / 10_000, "team bucket");
        assertEq(
            router.computeBalance() + router.opsBalance() + router.teamBalance() + router.swapBalance(),
            forwarded,
            "a wei was lost in the split"
        );
    }

    /// 8. processSwap(): buy the token on the real pool, burn, fund the distributor.
    function _buyback() internal {
        uint256 swapIn = router.swapBalance();
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        vm.prank(keeper);
        router.processSwap(1);
        uint256 burned = IERC20(token).balanceOf(DEAD) - deadBefore;
        toRewards = IERC20(token).balanceOf(address(dist));
        assertGt(toRewards, 0, "the distributor received nothing");
        assertEq(burned, (burned + toRewards) * 1500 / 6500, "burn/rewards ratio");
        console2.log("buyback ETH in", swapIn);
        console2.log("burned", burned);
        console2.log("to rewards", toRewards);
    }

    /// 9. A question, a holder's call, an epoch root with the winner, the claim.
    function _reward() internal {
        CallLedger ledger = new CallLedger(token, address(this), keeper, block.timestamp);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = keccak256("q");
        vm.prank(keeper);
        ledger.openQuestions(0, ids, uint64(block.timestamp + 1 hours));
        bool[] memory agree = new bool[](1);
        agree[0] = true;
        vm.prank(winner);
        ledger.submit(ids, agree);
        assertEq(ledger.callsUsed(0, winner), 1, "the winner's call was not recorded");

        uint256 amount = toRewards / 10; // under the 20% cap of the free balance
        bytes32 root = keccak256(bytes.concat(keccak256(abi.encode(winner, amount)))); // one-leaf tree
        vm.prank(scorer);
        dist.setEpochRoot(0, root, amount);
        vm.warp(block.timestamp + dist.CLAIM_DELAY());
        uint256 before = IERC20(token).balanceOf(winner);
        vm.prank(winner);
        dist.claim(0, amount, new bytes32[](0));
        assertEq(IERC20(token).balanceOf(winner) - before, amount, "the winner did not get the reward");
    }

    /// 10. The team is paid in ETH from its bucket, and only the team wallet can take it.
    function _payTeam() internal {
        uint256 teamOwed = router.teamBalance();
        vm.prank(trader);
        vm.expectRevert(FeeRouter.NotAuthorized.selector);
        router.withdrawTeam();
        uint256 teamBefore = teamWallet.balance;
        vm.prank(teamWallet);
        router.withdrawTeam();
        assertEq(teamWallet.balance - teamBefore, teamOwed, "team withdrawal");
    }
}
