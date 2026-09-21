// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockFeeOnTransferERC20
/// @notice Token that withholds a share on every `transfer`/`transferFrom`: the receiver gets
///         less than the nominal amount. It exists to break the "plain ERC-20" assumption the system makes about the
///         Pons token, which nobody has verified on the real token yet.
/// @dev The share is burned. Mint and burn stay exempt, otherwise the tests could not
///      even fund a starting balance. Not affiliated with TypeSafe AI.
contract MockFeeOnTransferERC20 is ERC20 {
    uint16 public constant BPS = 10_000;

    /// @notice Share withheld on every transfer, in bps.
    uint16 public immutable feeBps;

    constructor(uint16 feeBps_) ERC20("Fee On Transfer", "FOT") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = value * feeBps / BPS;
        super._update(from, to, value - fee);
        if (fee != 0) super._update(from, address(0), fee);
    }
}
