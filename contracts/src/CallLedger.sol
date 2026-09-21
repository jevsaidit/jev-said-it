// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title CallLedger
/// @notice On-chain ledger of holder calls: agreement or disagreement with Jev's verdict.
///         Capacity: 1 call per 10,000 tokens, at most 50 per epoch. Questions are opened by the publisher
///         (the engine key) with a deadline. Scoring is off-chain: the engine reads the events,
///         rechecks the balance at the epoch's start block and publishes the rewards root.
/// @dev Not affiliated with TypeSafe AI.
contract CallLedger is Ownable2Step {
    uint256 public constant TOKENS_PER_CALL = 10_000e18;
    uint256 public constant MAX_CALLS_PER_EPOCH = 50;
    uint256 public constant EPOCH_LENGTH = 6 hours;

    IERC20 public immutable token;
    uint256 public immutable genesis;
    address public publisher;

    mapping(uint256 epoch => mapping(bytes32 questionId => uint64 deadline)) public questionDeadline;
    mapping(uint256 epoch => mapping(address => uint256)) public callsUsed;
    mapping(uint256 epoch => mapping(address => mapping(bytes32 => bool))) public answered;

    event QuestionsOpened(uint256 indexed epoch, bytes32[] ids, uint64 deadline);
    event CallSubmitted(
        uint256 indexed epoch, address indexed caller, bytes32 indexed questionId, bool agree, uint256 balanceAtCall
    );
    event PublisherSet(address publisher);

    error NotAuthorized();
    error LengthMismatch();
    error QuestionClosed();
    error NoCapacity();
    error AlreadyAnswered();
    error BadDeadline();

    constructor(address token_, address owner_, address publisher_, uint256 genesis_) Ownable(owner_) {
        token = IERC20(token_);
        publisher = publisher_;
        genesis = genesis_;
    }

    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - genesis) / EPOCH_LENGTH;
    }

    function capacity(address account) public view returns (uint256) {
        uint256 c = token.balanceOf(account) / TOKENS_PER_CALL;
        return c > MAX_CALLS_PER_EPOCH ? MAX_CALLS_PER_EPOCH : c;
    }

    function openQuestions(uint256 epoch, bytes32[] calldata ids, uint64 deadline) external {
        if (msg.sender != publisher) revert NotAuthorized();
        if (deadline <= block.timestamp) revert BadDeadline();
        for (uint256 i = 0; i < ids.length; i++) {
            questionDeadline[epoch][ids[i]] = deadline;
        }
        emit QuestionsOpened(epoch, ids, deadline);
    }

    function submit(bytes32[] calldata ids, bool[] calldata agree) external {
        if (ids.length != agree.length) revert LengthMismatch();
        uint256 epoch = currentEpoch();
        uint256 balance = token.balanceOf(msg.sender);
        uint256 cap = balance / TOKENS_PER_CALL;
        if (cap > MAX_CALLS_PER_EPOCH) cap = MAX_CALLS_PER_EPOCH;
        uint256 used = callsUsed[epoch][msg.sender];
        for (uint256 i = 0; i < ids.length; i++) {
            bytes32 id = ids[i];
            uint64 deadline = questionDeadline[epoch][id];
            if (deadline == 0 || block.timestamp >= deadline) revert QuestionClosed();
            if (answered[epoch][msg.sender][id]) revert AlreadyAnswered();
            if (used >= cap) revert NoCapacity();
            answered[epoch][msg.sender][id] = true;
            used++;
            emit CallSubmitted(epoch, msg.sender, id, agree[i], balance);
        }
        callsUsed[epoch][msg.sender] = used;
    }

    function setPublisher(address publisher_) external onlyOwner {
        publisher = publisher_;
        emit PublisherSet(publisher_);
    }
}
