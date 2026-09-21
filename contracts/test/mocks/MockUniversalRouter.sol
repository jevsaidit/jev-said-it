// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockUniversalRouter
/// @notice Fake Universal Router for the offline tests of `UniV4SwapAdapter`.
/// @dev It talks to no PoolManager: it takes the ETH and delivers to the caller an amount
///      of tokens chosen by the test, so the case "the router delivers
///      less than minOut" can also be reproduced without a network. It records the last call for the encoding asserts.
/// @dev It does not mint: it transfers from a balance the test must already have given it. When it minted,
///      the recipient always received the nominal amount and a token with a fee on transfer could not be
///      reproduced.
/// @dev Not affiliated with TypeSafe AI.
contract MockUniversalRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;

    /// @notice Tokens delivered to the caller on the next `execute`.
    uint256 public amountToDeliver;

    bytes public lastCommands;
    bytes[] public lastInputs;
    uint256 public lastDeadline;
    uint256 public lastValue;
    uint256 public callCount;

    constructor(address token_) {
        token = IERC20(token_);
    }

    function setAmountToDeliver(uint256 amount) external {
        amountToDeliver = amount;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        lastCommands = commands;
        delete lastInputs;
        for (uint256 i = 0; i < inputs.length; i++) {
            lastInputs.push(inputs[i]);
        }
        lastDeadline = deadline;
        lastValue = msg.value;
        callCount++;
        token.safeTransfer(msg.sender, amountToDeliver);
    }

    function lastInputsLength() external view returns (uint256) {
        return lastInputs.length;
    }
}
