// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Simulates PonsV2FeeEscrow: credits ETH to a recipient, who collects it with claim().
///      Not affiliated with TypeSafe AI.
contract MockFeeEscrow {
    mapping(address recipient => uint256) public balanceOf;

    error NothingToClaim();

    function credit(address recipient) external payable {
        balanceOf[recipient] += msg.value;
    }

    function claim() external returns (uint256 amount) {
        amount = balanceOf[msg.sender];
        if (amount == 0) revert NothingToClaim();
        balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "pay");
    }
}
