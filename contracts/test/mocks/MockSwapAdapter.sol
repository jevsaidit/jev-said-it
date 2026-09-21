// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";

/// @title MockSwapAdapter
/// @notice Test adapter: converts ETH into tokens at a fixed rate (tokens per wei).
/// @dev It does not mint: it passes on tokens from a balance the test must already have given it, as
///      a real adapter does. It used to mint, and by construction it could not deliver less than the nominal amount:
///      no test could notice that `FeeRouter` trusted the declared figure.
/// @dev It returns the NOMINAL figure on purpose, the one measured before the transfer — that is the
///      behavior of an adapter that counts its own delta and then passes the tokens on. The caller must not
///      trust it: if the token withholds something, less arrives than is declared here.
/// @dev Not affiliated with TypeSafe AI.
contract MockSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    uint256 public immutable rate; // token per wei

    constructor(address token_, uint256 rate_) {
        token = IERC20(token_);
        rate = rate_;
    }

    function swapExactETHForToken(address tokenOut, uint256 minOut, address recipient)
        external
        payable
        returns (uint256 amountOut)
    {
        require(tokenOut == address(token), "token");
        amountOut = msg.value * rate;
        require(amountOut >= minOut, "slippage");
        token.safeTransfer(recipient, amountOut);
    }
}
