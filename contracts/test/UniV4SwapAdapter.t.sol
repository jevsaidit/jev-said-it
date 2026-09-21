// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";
import {UniV4SwapAdapter} from "../src/adapters/UniV4SwapAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockUniversalRouter} from "./mocks/MockUniversalRouter.sol";
import {MockFeeOnTransferERC20} from "./mocks/MockFeeOnTransferERC20.sol";

/// @notice Offline coverage of `UniV4SwapAdapter` against a fake Universal Router.
/// @dev The fork test covers the real swap but skips itself without a network: these tests run
///      in the default suite and are the ones that must turn red if a guard
///      or the calldata encoding breaks.
contract UniV4SwapAdapterTest is Test {
    uint24 constant FEE = 0;
    int24 constant TICK_SPACING = 200;
    address constant HOOKS = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    /// @dev Real OpenJEV pool, from `docs/addresses.md`. It is used only for the pure check on the PoolKey:
    ///      nothing talks to the network, a keccak is compared.
    address constant OPENJEV = 0x4d066AB4D924b7b3D01c6EcbFC142efe33AEb7FA;
    bytes32 constant OPENJEV_POOL_ID = 0x671b0a6a58ddd96af8b3927aa3d44d6c8cb074120e0b2a55dbe662b36bf915c6;

    MockERC20 token;
    MockUniversalRouter router;
    UniV4SwapAdapter adapter;

    address owner = address(0xA11CE);
    address recipient = address(0xBEEF);

    event PoolSet(address indexed token, uint24 fee, int24 tickSpacing, address hooks);

    function setUp() public {
        token = new MockERC20();
        router = new MockUniversalRouter(address(token));
        adapter = new UniV4SwapAdapter(address(router), owner);
        // The fake router does not mint: it delivers from its own balance, like the real one.
        token.mint(address(router), 1_000_000 ether);
    }

    function _setPool() internal {
        vm.prank(owner);
        adapter.setPool(address(token), FEE, TICK_SPACING, HOOKS);
    }

    // --- setPool -----------------------------------------------------------------

    function test_setPool_only_owner() public {
        address stranger = address(0xDEAD);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        adapter.setPool(address(token), FEE, TICK_SPACING, HOOKS);
    }

    function test_setPool_emits_event_and_stores_key() public {
        vm.expectEmit(true, true, true, true, address(adapter));
        emit PoolSet(address(token), FEE, TICK_SPACING, HOOKS);
        _setPool();

        PoolKey memory key = adapter.poolOf(address(token));
        assertEq(Currency.unwrap(key.currency0), address(0), "currency0 must be native ETH");
        assertEq(Currency.unwrap(key.currency1), address(token), "currency1 must be the token");
        assertEq(key.fee, FEE);
        assertEq(key.tickSpacing, TICK_SPACING);
        assertEq(address(key.hooks), HOOKS);
    }

    // --- guards -------------------------------------------------------------------

    function test_swap_reverts_when_pool_not_set() public {
        vm.expectRevert(UniV4SwapAdapter.PoolNotSet.selector);
        adapter.swapExactETHForToken{value: 1 ether}(address(token), 1, recipient);
    }

    function test_swap_reverts_when_router_delivers_less_than_minOut() public {
        _setPool();
        router.setAmountToDeliver(99);
        vm.expectRevert(UniV4SwapAdapter.Slippage.selector);
        adapter.swapExactETHForToken{value: 1 ether}(address(token), 100, recipient);
    }

    function test_swap_succeeds_on_exact_minOut_boundary() public {
        _setPool();
        router.setAmountToDeliver(100);
        uint256 out = adapter.swapExactETHForToken{value: 1 ether}(address(token), 100, recipient);
        assertEq(out, 100);
    }

    // --- happy path ---------------------------------------------------------------

    function test_swap_delivers_tokens_to_recipient_and_forwards_eth() public {
        _setPool();
        router.setAmountToDeliver(1234 ether);

        uint256 out = adapter.swapExactETHForToken{value: 0.5 ether}(address(token), 1000 ether, recipient);

        assertEq(out, 1234 ether, "amountOut returned");
        assertEq(token.balanceOf(recipient), 1234 ether, "the recipient receives the tokens");
        assertEq(token.balanceOf(address(adapter)), 0, "the adapter keeps no tokens");
        assertEq(address(router).balance, 0.5 ether, "the whole msg.value goes to the router");
        assertEq(address(adapter).balance, 0, "the adapter keeps no ETH");
        assertEq(router.callCount(), 1);
    }

    /// @dev The adapter counts the balance delta, not the router's return value: if it already
    ///      held some tokens, `amountOut` must not inflate.
    function test_amountOut_is_the_delta_not_the_balance() public {
        _setPool();
        token.mint(address(adapter), 7 ether);
        router.setAmountToDeliver(3 ether);

        uint256 out = adapter.swapExactETHForToken{value: 1 ether}(address(token), 1, recipient);

        assertEq(out, 3 ether, "only the new tokens count");
        assertEq(token.balanceOf(recipient), 3 ether);
    }

    // --- calldata encoding ---------------------------------------------------------

    /// @dev Pins the encoding: command, Actions sequence, swap direction, amount and
    ///      PoolKey. Without this, flipping `zeroForOne` to `false` or changing an Action would stay
    ///      green in the offline suite.
    function test_encodes_v4_swap_command_and_actions() public {
        _setPool();
        router.setAmountToDeliver(1 ether);
        adapter.swapExactETHForToken{value: 0.25 ether}(address(token), 1, recipient);

        assertEq(router.lastCommands(), abi.encodePacked(uint8(Commands.V4_SWAP)), "V4_SWAP command");
        assertEq(router.lastInputsLength(), 1, "a single input");
        assertEq(router.lastDeadline(), block.timestamp, "deadline");

        (bytes memory actions, bytes[] memory params) = abi.decode(router.lastInputs(0), (bytes, bytes[]));
        assertEq(
            actions,
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL)),
            "SWAP_EXACT_IN_SINGLE / SETTLE_ALL / TAKE_ALL sequence"
        );
        assertEq(params.length, 3, "one parameter per action");

        IV4Router.ExactInputSingleParams memory p = abi.decode(params[0], (IV4Router.ExactInputSingleParams));
        assertTrue(p.zeroForOne, "ETH is currency0: the swap must be zeroForOne");
        assertEq(p.amountIn, 0.25 ether, "amountIn = msg.value");
        assertEq(p.amountOutMinimum, 1, "amountOutMinimum = minOut");
        assertEq(p.minHopPriceX36, 0, "per-hop price limit disabled");
        assertEq(p.hookData.length, 0, "empty hookData");
        assertEq(Currency.unwrap(p.poolKey.currency0), address(0));
        assertEq(Currency.unwrap(p.poolKey.currency1), address(token));
        assertEq(p.poolKey.tickSpacing, TICK_SPACING);
        assertEq(address(p.poolKey.hooks), HOOKS);

        (Currency settleCurrency, uint256 settleAmount) = abi.decode(params[1], (Currency, uint256));
        assertEq(Currency.unwrap(settleCurrency), address(0), "ETH is settled");
        assertEq(settleAmount, 0.25 ether, "SETTLE_ALL covers the whole msg.value");

        (Currency takeCurrency, uint256 takeAmount) = abi.decode(params[2], (Currency, uint256));
        assertEq(Currency.unwrap(takeCurrency), address(token), "the token is taken");
        assertEq(takeAmount, 1, "TAKE_ALL uses minOut as the minimum");
    }

    /// @dev Narrowing to uint128 must revert, not truncate silently: a `minOut` that
    ///      truncates would become a very weak slippage bound instead of an error.
    function test_minOut_above_uint128_max_reverts_through_safecast() public {
        _setPool();
        uint256 minOut = uint256(type(uint128).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 128, minOut));
        adapter.swapExactETHForToken{value: 1 ether}(address(token), minOut, recipient);
    }

    /// @dev Pure check on the PoolKey: the key built by `setPool` with the Pons v2 parameters
    ///      must produce the real PoolId of the OpenJEV pool. It makes no network calls — that is why it lives here and
    ///      not in `test/fork/`, where the chain id guard would always have skipped it.
    function test_poolKey_hashes_to_the_real_openjev_pool_id() public {
        vm.prank(owner);
        adapter.setPool(OPENJEV, FEE, TICK_SPACING, HOOKS);
        PoolKey memory key = adapter.poolOf(OPENJEV);
        assertEq(keccak256(abi.encode(key)), OPENJEV_POOL_ID, "the PoolKey does not produce the OpenJEV PoolId");
    }

    /// @dev The adapter must not be able to accumulate ETH: `receive()` was removed on purpose,
    ///      because there is no way out for ETH that ended up here.
    function test_plain_eth_transfer_is_rejected() public {
        (bool ok,) = address(adapter).call{value: 1 ether}("");
        assertFalse(ok, "the adapter must not accept ETH outside a swap");
        assertEq(address(adapter).balance, 0);
    }

    /// @dev The gap that made the bug impossible to notice: if the token withholds a share on
    ///      transfer, the adapter delivers less than it measured on its side. `amountOut` must say
    ///      what ARRIVED at the recipient, because the caller pays two legs out of it.
    function test_amountOut_is_what_the_recipient_received_not_what_was_sent() public {
        MockFeeOnTransferERC20 fot = new MockFeeOnTransferERC20(100); // 1% on every transfer
        MockUniversalRouter fotRouter = new MockUniversalRouter(address(fot));
        UniV4SwapAdapter fotAdapter = new UniV4SwapAdapter(address(fotRouter), owner);
        vm.prank(owner);
        fotAdapter.setPool(address(fot), FEE, TICK_SPACING, HOOKS);
        fot.mint(address(fotRouter), 1000 ether);
        fotRouter.setAmountToDeliver(1000 ether);

        uint256 out = fotAdapter.swapExactETHForToken{value: 1 ether}(address(fot), 0, recipient);

        // router -> adapter: 1000 - 1% = 990. adapter -> recipient: 990 - 1% = 980.1.
        assertEq(fot.balanceOf(address(fotAdapter)), 0, "the adapter keeps no tokens");
        assertEq(fot.balanceOf(recipient), 980.1 ether, "what actually arrived");
        assertEq(out, fot.balanceOf(recipient), "amountOut must be what was received, not what was sent");
    }

    /// @dev With a token like this, `minOut` must apply to what reaches the recipient: if
    ///      it applied to what the adapter received, the caller would get less than its floor.
    function test_minOut_is_enforced_on_what_the_recipient_receives() public {
        MockFeeOnTransferERC20 fot = new MockFeeOnTransferERC20(100);
        MockUniversalRouter fotRouter = new MockUniversalRouter(address(fot));
        UniV4SwapAdapter fotAdapter = new UniV4SwapAdapter(address(fotRouter), owner);
        vm.prank(owner);
        fotAdapter.setPool(address(fot), FEE, TICK_SPACING, HOOKS);
        fot.mint(address(fotRouter), 1000 ether);
        fotRouter.setAmountToDeliver(1000 ether);

        // 990 enter the adapter, 980.1 arrive: a floor at 990 is not met.
        vm.expectRevert(UniV4SwapAdapter.Slippage.selector);
        fotAdapter.swapExactETHForToken{value: 1 ether}(address(fot), 990 ether, recipient);
    }
}
