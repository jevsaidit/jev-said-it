// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Not affiliated with TypeSafe AI.
interface IFeeSource {
    /// @notice Withdraws the accrued fees and forwards them to the router. Returns the ETH forwarded.
    function claim() external returns (uint256 forwarded);
}
