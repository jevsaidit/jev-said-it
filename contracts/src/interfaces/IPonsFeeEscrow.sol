// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ABI of PonsV2FeeEscrow on Robinhood Chain (0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e).
///         Verified on robinhoodchain.blockscout.com on 2026-09-20.
///         The balance is per recipient: msg.sender claims its own.
/// @dev Not affiliated with TypeSafe AI.
interface IPonsFeeEscrow {
    function balanceOf(address recipient) external view returns (uint256);
    function claim() external returns (uint256 amount);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
    function claimToken(address token) external returns (uint256 amount);
}
