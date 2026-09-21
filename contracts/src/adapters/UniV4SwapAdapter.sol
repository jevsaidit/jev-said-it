// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title UniV4SwapAdapter
/// @notice ETH -> token on a Uniswap v4 pool (the one Pons graduates the token into), via Universal Router.
/// @dev Not affiliated with TypeSafe AI.
contract UniV4SwapAdapter is ISwapAdapter, Ownable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    IUniversalRouter public immutable universalRouter;
    mapping(address token => PoolKey) internal pools;

    event PoolSet(address indexed token, uint24 fee, int24 tickSpacing, address hooks);

    error PoolNotSet();
    error Slippage();

    constructor(address universalRouter_, address owner_) Ownable(owner_) {
        universalRouter = IUniversalRouter(universalRouter_);
    }

    function setPool(address token, uint24 fee, int24 tickSpacing, address hooks) external onlyOwner {
        pools[token] = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hooks)
        });
        emit PoolSet(token, fee, tickSpacing, hooks);
    }

    function poolOf(address token) external view returns (PoolKey memory) {
        return pools[token];
    }

    function swapExactETHForToken(address tokenOut, uint256 minOut, address recipient)
        external
        payable
        returns (uint256 amountOut)
    {
        PoolKey memory key = pools[tokenOut];
        if (Currency.unwrap(key.currency1) == address(0)) revert PoolNotSet();

        bytes memory commands = abi.encodePacked(uint8(Commands.V4_SWAP));
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: true,
                amountIn: msg.value.toUint128(),
                amountOutMinimum: minOut.toUint128(),
                // Field introduced by the installed v4-periphery version (per-hop price limit).
                // 0 = disabled: slippage protection stays `amountOutMinimum` + the final check below.
                minHopPriceX36: 0,
                hookData: bytes("")
            })
        );
        params[1] = abi.encode(key.currency0, uint256(msg.value));
        params[2] = abi.encode(key.currency1, minOut);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        universalRouter.execute{value: msg.value}(commands, inputs, block.timestamp);
        uint256 received = IERC20(tokenOut).balanceOf(address(this)) - before;
        if (received < minOut) revert Slippage();

        // `amountOut` is what ARRIVED at the recipient, not what was sent to it: the
        // caller (FeeRouter) pays two legs out of it and must be able to cover them. If the token
        // withholds a share on transfer, `received` is a promise the balance does not keep.
        uint256 recipientBefore = IERC20(tokenOut).balanceOf(recipient);
        IERC20(tokenOut).safeTransfer(recipient, received);
        amountOut = IERC20(tokenOut).balanceOf(recipient) - recipientBefore;
        // The slippage floor applies to what arrives, not to what passes through: otherwise the
        // caller would receive less than the minimum it asked for. On a plain ERC-20 the two
        // checks coincide and the behavior does not change by one wei.
        if (amountOut < minOut) revert Slippage();
    }
}
