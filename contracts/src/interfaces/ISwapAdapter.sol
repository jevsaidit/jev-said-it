// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISwapAdapter {
    /// @notice Sells the whole msg.value for tokenOut and delivers it to recipient. Reverts if out < minOut.
    function swapExactETHForToken(address tokenOut, uint256 minOut, address recipient)
        external
        payable
        returns (uint256 amountOut);
}
