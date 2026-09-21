// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IFeeSource} from "./interfaces/IFeeSource.sol";
import {IPonsFeeEscrow} from "./interfaces/IPonsFeeEscrow.sol";

/// @title PonsEscrowAdapter
/// @notice Address to set as the creator fee recipient at launch on Pons v2.
///         The escrow credits this contract; claim() collects and forwards everything to the FeeRouter.
///         The router is set only once, because it does not exist yet at launch time.
/// @dev Not affiliated with TypeSafe AI.
contract PonsEscrowAdapter is IFeeSource, Ownable {
    IPonsFeeEscrow public immutable escrow;
    address payable public router;

    event RouterSet(address indexed router);
    event Forwarded(uint256 amount);

    error AlreadySet();
    error NotSet();
    error InvalidRouter();
    error ForwardFailed();

    constructor(address escrow_, address owner_) Ownable(owner_) {
        escrow = IPonsFeeEscrow(escrow_);
    }

    /// @notice Passive receive: no logic, so the escrow can pay even with little gas.
    receive() external payable {}

    function setRouter(address payable router_) external onlyOwner {
        if (router != address(0)) revert AlreadySet();
        if (router_ == address(0) || router_ == address(this)) revert InvalidRouter();
        router = router_;
        emit RouterSet(router_);
    }

    /// @notice How much the escrow still owes this adapter.
    function claimable() external view returns (uint256) {
        return escrow.balanceOf(address(this));
    }

    /// @notice Anyone can call: collects from the escrow and forwards the whole balance to the router.
    ///         The claim is in try/catch because the escrow reverts when the balance is zero, but there
    ///         may be ETH that arrived passively and must be forwarded anyway.
    function claim() external returns (uint256 forwarded) {
        if (router == address(0)) revert NotSet();
        try escrow.claim() {} catch {}
        forwarded = address(this).balance;
        if (forwarded > 0) {
            (bool ok,) = router.call{value: forwarded}("");
            if (!ok) revert ForwardFailed();
            emit Forwarded(forwarded);
        }
    }
}
