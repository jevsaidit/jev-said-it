// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title RewardsDistributor
/// @notice Per-epoch rewards in $JEVSAID, claimable with a Merkle proof. The scorer (the engine key)
///         can commit at most maxEpochBudgetBps of the free balance per epoch: it cannot drain the pool.
/// @dev Three layers of defense against a compromised scorer key: (1) `epoch` must be
///      strictly increasing, so the scorer cannot publish multiple epochs in the same
///      block; (2) at least EPOCH_LENGTH between one setEpochRoot and the next, which turns a
///      drain from minutes into days; (3) an epoch's claims open only CLAIM_DELAY after
///      the root is published, and during that window a `guardian` can void
///      the epoch (never move funds: it can only block).
///      Not affiliated with TypeSafe AI.
contract RewardsDistributor is Ownable2Step {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    uint256 public constant CLAIM_WINDOW = 90 days;
    uint256 public constant EPOCH_LENGTH = 6 hours;
    uint256 public constant CLAIM_DELAY = 12 hours;

    IERC20 public immutable token;
    /// @notice Start of epoch 0: the same value as `CallLedger.genesis`. A root can only be set for an
    ///         epoch that has already ENDED. Without this bound one transaction from the scorer key,
    ///         `setEpochRoot(type(uint256).max, ...)`, pushes `lastEpoch` out of reach and every later
    ///         root reverts with EpochNotIncreasing: the whole balance locked, with no path out.
    uint256 public immutable genesis;
    address public scorer;
    address public guardian;
    uint16 public maxEpochBudgetBps = 2000;

    uint256 public lastEpoch;
    uint256 public lastRootSetAt;
    bool public hasPublished;

    mapping(uint256 epoch => bytes32) public roots;
    mapping(uint256 epoch => uint256) public epochBudget;
    mapping(uint256 epoch => uint256) public epochClaimed;
    mapping(uint256 epoch => uint256) public epochSetAt;
    mapping(uint256 epoch => bool) public epochSwept;
    mapping(uint256 epoch => bool) public epochVoided;
    mapping(uint256 epoch => mapping(address => bool)) public hasClaimed;
    uint256 public committed;

    event EpochRootSet(uint256 indexed epoch, bytes32 root, uint256 budget);
    event Claimed(uint256 indexed epoch, address indexed account, uint256 amount);
    event EpochSwept(uint256 indexed epoch, uint256 freed);
    event EpochVoided(uint256 indexed epoch, uint256 freed);
    event ScorerSet(address scorer);
    event GuardianSet(address guardian);
    event MaxEpochBudgetSet(uint16 bps);

    error ZeroAddress();
    error NotAuthorized();
    error RootExists();
    error BudgetTooLarge();
    error InvalidProof();
    error AlreadyClaimed();
    error BudgetExceeded();
    error NotExpired();
    error AlreadySwept();
    error NoRoot();
    error EpochNotIncreasing();
    error EpochTooSoon();
    error ClaimsNotOpen();
    error VoidedEpoch();
    error VoidWindowClosed();
    error AlreadyVoided();
    error EpochNotEnded();
    error ClaimWindowClosed();

    /// @dev `guardian_` cannot be zero: after the handover the owner is a 24-hour timelock, and
    ///      an operation scheduled there cannot land inside the CLAIM_DELAY = 12 hour
    ///      window, so the guardian is in practice the only address that can void an epoch. A
    ///      zero guardian would be a distributor with no valve, and we would notice only on the
    ///      day it is needed. `scorer_` instead stays unrestricted: see the note on `setScorer`.
    constructor(address token_, address owner_, address scorer_, address guardian_, uint256 genesis_) Ownable(owner_) {
        if (guardian_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        genesis = genesis_;
        scorer = scorer_;
        guardian = guardian_;
    }

    function freeBalance() public view returns (uint256) {
        return token.balanceOf(address(this)) - committed;
    }

    /// @dev A zero root is rejected because `bytes32(0)` is the value that marks "nonexistent
    ///      epoch" throughout the contract: accepting it would commit `budget` in `committed`
    ///      while leaving `roots[epoch]` at zero, and from there `claim`, `voidEpoch` and `sweepExpired`
    ///      all revert with NoRoot. The budget would stay committed forever - not stolen,
    ///      but unrecoverable - and the guardian would be disarmed in exactly the case it exists for.
    function setEpochRoot(uint256 epoch, bytes32 root, uint256 budget) external {
        if (msg.sender != scorer) revert NotAuthorized();
        if (root == bytes32(0)) revert NoRoot();
        if (roots[epoch] != bytes32(0)) revert RootExists();
        // Overflows (and so reverts) for absurd epochs: that is the point.
        if (block.timestamp < genesis + (epoch + 1) * EPOCH_LENGTH) revert EpochNotEnded();
        if (hasPublished) {
            if (epoch <= lastEpoch) revert EpochNotIncreasing();
            if (block.timestamp < lastRootSetAt + EPOCH_LENGTH) revert EpochTooSoon();
        }
        if (budget > freeBalance() * maxEpochBudgetBps / BPS) revert BudgetTooLarge();
        roots[epoch] = root;
        epochBudget[epoch] = budget;
        epochSetAt[epoch] = block.timestamp;
        committed += budget;
        lastEpoch = epoch;
        lastRootSetAt = block.timestamp;
        hasPublished = true;
        emit EpochRootSet(epoch, root, budget);
    }

    function claim(uint256 epoch, uint256 amount, bytes32[] calldata proof) external {
        bytes32 root = roots[epoch];
        if (root == bytes32(0)) revert NoRoot();
        if (epochVoided[epoch]) revert VoidedEpoch();
        if (block.timestamp < epochSetAt[epoch] + CLAIM_DELAY) revert ClaimsNotOpen();
        // Past the window the budget belongs to sweepExpired: a claim racing a sweep is not a rule.
        if (block.timestamp >= epochSetAt[epoch] + CLAIM_WINDOW) revert ClaimWindowClosed();
        if (hasClaimed[epoch][msg.sender]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        if (!MerkleProof.verify(proof, root, leaf)) revert InvalidProof();
        if (epochClaimed[epoch] + amount > epochBudget[epoch]) revert BudgetExceeded();
        hasClaimed[epoch][msg.sender] = true;
        epochClaimed[epoch] += amount;
        committed -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(epoch, msg.sender, amount);
    }

    /// @notice During the challenge window, the guardian or the owner can void
    ///         an epoch: the budget not yet claimed returns to the free balance and no future
    ///         claim for that epoch can succeed. The guardian can never move
    ///         or receive tokens: it can only block.
    function voidEpoch(uint256 epoch) external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotAuthorized();
        if (roots[epoch] == bytes32(0)) revert NoRoot();
        if (epochVoided[epoch]) revert AlreadyVoided();
        if (block.timestamp >= epochSetAt[epoch] + CLAIM_DELAY) revert VoidWindowClosed();
        uint256 freed = epochBudget[epoch] - epochClaimed[epoch];
        epochVoided[epoch] = true;
        epochBudget[epoch] = epochClaimed[epoch];
        committed -= freed;
        emit EpochVoided(epoch, freed);
    }

    /// @notice After 90 days, frees the unclaimed budget for future epochs.
    function sweepExpired(uint256 epoch) external {
        if (roots[epoch] == bytes32(0)) revert NoRoot();
        if (epochSwept[epoch]) revert AlreadySwept();
        if (block.timestamp < epochSetAt[epoch] + CLAIM_WINDOW) revert NotExpired();
        uint256 freed = epochBudget[epoch] - epochClaimed[epoch];
        epochSwept[epoch] = true;
        epochBudget[epoch] = epochClaimed[epoch];
        committed -= freed;
        emit EpochSwept(epoch, freed);
    }

    /// @dev Here `address(0)` is allowed on purpose, unlike `setGuardian`: it is the only way
    ///      to say "no scorer", and it stops the publication of new roots without exposing a wei.
    ///      A zero scorer freezes rewards; a zero guardian removes the only valve.
    function setScorer(address scorer_) external onlyOwner {
        scorer = scorer_;
        emit ScorerSet(scorer_);
    }

    /// @dev Removing the guardian means removing the only valve that fits inside the 12-hour
    ///      window: it must not be possible by accident. To replace it, switch directly to the
    ///      new address, without going through zero.
    function setGuardian(address guardian_) external onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setMaxEpochBudgetBps(uint16 bps) external onlyOwner {
        if (bps == 0 || bps > BPS) revert BudgetTooLarge();
        maxEpochBudgetBps = bps;
        emit MaxEpochBudgetSet(bps);
    }
}
