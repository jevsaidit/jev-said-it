// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title FeeRouter
/// @notice Receives the creator fees (ETH) and splits them into five shares: compute, ops, team, burn,
///         rewards. ETH leaves only to computeWallet, opsWallet, teamWallet and the swap adapter;
///         tokens only to 0xdead and the RewardsDistributor. Expected owner: 24h TimelockController.
///         The team receives no supply: it is paid with the recurring `teamBps` share of the fees.
/// @dev Not affiliated with TypeSafe AI.
contract FeeRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable token;
    address public computeWallet;
    address public opsWallet;
    address public teamWallet;
    address public keeper;
    address public rewardsDistributor;
    ISwapAdapter public swapAdapter;

    // ---- default split: the ONLY place to change if the bps move. Sum == BPS. ----
    // compute 500 + ops 1000 + team 2000 + burn 1500 + rewards 5000 = 10_000
    uint16 public computeBps = 500;
    uint16 public opsBps = 1000;
    uint16 public teamBps = 2000;
    uint16 public burnBps = 1500;
    uint16 public rewardsBps = 5000;

    uint256 public undistributed;
    uint256 public computeBalance;
    uint256 public opsBalance;
    uint256 public teamBalance;
    uint256 public swapBalance;

    event FeesReceived(address indexed from, uint256 amount);
    event Distributed(uint256 amount, uint256 toCompute, uint256 toOps, uint256 toTeam, uint256 toSwap);
    event ComputeWithdrawn(address indexed to, uint256 amount);
    event OpsWithdrawn(address indexed to, uint256 amount);
    event TeamWithdrawn(address indexed to, uint256 amount);
    event SwapProcessed(uint256 ethIn, uint256 tokenOut, uint256 burned, uint256 toRewards);
    event SplitsSet(uint16 computeBps, uint16 opsBps, uint16 teamBps, uint16 burnBps, uint16 rewardsBps);
    event WalletsSet(address computeWallet, address opsWallet, address teamWallet);
    event KeeperSet(address keeper);
    event SwapAdapterSet(address adapter);
    event RewardsDistributorSet(address distributor);

    error NothingToDo();
    error NotAuthorized();
    error BadSplits();
    error ZeroAddress();
    error NotConfigured();
    error TransferFailed();
    error ZeroMinOut();


    constructor(
        address token_,
        address owner_,
        address computeWallet_,
        address opsWallet_,
        address teamWallet_,
        address keeper_
    ) Ownable(owner_) {
        if (
            token_ == address(0) || computeWallet_ == address(0) || opsWallet_ == address(0)
                || teamWallet_ == address(0)
        ) revert ZeroAddress();
        token = IERC20(token_);
        computeWallet = computeWallet_;
        opsWallet = opsWallet_;
        teamWallet = teamWallet_;
        keeper = keeper_;
    }

    receive() external payable {
        undistributed += msg.value;
        emit FeesReceived(msg.sender, msg.value);
    }

    /// @notice Anyone can call: moves the received ETH into the buckets according to the current splits.
    function distribute() public {
        uint256 amount = undistributed;
        if (amount == 0) revert NothingToDo();
        undistributed = 0;
        uint256 toCompute = amount * computeBps / BPS;
        uint256 toOps = amount * opsBps / BPS;
        uint256 toTeam = amount * teamBps / BPS;
        // the rounding remainder stays here: no wei is lost (Task 4 invariant)
        uint256 toSwap = amount - toCompute - toOps - toTeam;
        computeBalance += toCompute;
        opsBalance += toOps;
        teamBalance += toTeam;
        swapBalance += toSwap;
        emit Distributed(amount, toCompute, toOps, toTeam, toSwap);
    }

    function withdrawCompute() external nonReentrant {
        if (msg.sender != computeWallet) revert NotAuthorized();
        uint256 amount = computeBalance;
        if (amount == 0) revert NothingToDo();
        computeBalance = 0;
        _send(computeWallet, amount);
        emit ComputeWithdrawn(computeWallet, amount);
    }

    function withdrawOps() external nonReentrant {
        if (msg.sender != opsWallet) revert NotAuthorized();
        uint256 amount = opsBalance;
        if (amount == 0) revert NothingToDo();
        opsBalance = 0;
        _send(opsWallet, amount);
        emit OpsWithdrawn(opsWallet, amount);
    }

    function withdrawTeam() external nonReentrant {
        if (msg.sender != teamWallet) revert NotAuthorized();
        uint256 amount = teamBalance;
        if (amount == 0) revert NothingToDo();
        teamBalance = 0;
        _send(teamWallet, amount);
        emit TeamWithdrawn(teamWallet, amount);
    }

    /// @notice Keeper only: converts the swap bucket into tokens, burns the burn share and sends the rest to rewards.
    ///         The keeper picks the block (random window) and computes minOut off-chain.
    function processSwap(uint256 minOut) external nonReentrant {
        if (msg.sender != keeper) revert NotAuthorized();
        // A zero floor would hand the whole bucket to whoever sandwiches the swap, the keeper included.
        if (minOut == 0) revert ZeroMinOut();
        if (address(swapAdapter) == address(0) || rewardsDistributor == address(0)) revert NotConfigured();
        if (undistributed > 0) distribute();
        uint256 ethIn = swapBalance;
        if (ethIn == 0) revert NothingToDo();
        swapBalance = 0;
        // Measure what ARRIVED, not what the adapter claims to have sent: the two legs
        // below sum to exactly `out` and must fit within the real balance. If the token
        // withheld something on transfer, trusting the declared figure would make the
        // second leg revert on insufficient balance, and `processSwap` would stay broken forever.
        // Count the delta, not the balance: tokens sent to the router by mistake stay out
        // (they remain unrecoverable dust, as already documented, but do not mix with the fees).
        uint256 balanceBefore = token.balanceOf(address(this));
        swapAdapter.swapExactETHForToken{value: ethIn}(address(token), minOut, address(this));
        uint256 out = token.balanceOf(address(this)) - balanceBefore;
        // Any shortfall is split with the same burn/(burn+rewards) ratio: neither leg
        // absorbs it alone, and the rounding remainder goes to rewards as always.
        uint256 burned = out * burnBps / (burnBps + rewardsBps);
        uint256 toRewards = out - burned;
        if (burned > 0) token.safeTransfer(DEAD, burned);
        token.safeTransfer(rewardsDistributor, toRewards);
        emit SwapProcessed(ethIn, out, burned, toRewards);
    }

    // ---- admin (owner = timelock) ----

    function setSplits(uint16 computeBps_, uint16 opsBps_, uint16 teamBps_, uint16 burnBps_, uint16 rewardsBps_)
        external
        onlyOwner
    {
        if (uint256(computeBps_) + opsBps_ + teamBps_ + burnBps_ + rewardsBps_ != BPS) revert BadSplits();
        // without this guard processSwap would divide by zero
        if (burnBps_ + rewardsBps_ == 0) revert BadSplits();
        if (undistributed > 0) distribute(); // closes the period with the old splits
        computeBps = computeBps_;
        opsBps = opsBps_;
        teamBps = teamBps_;
        burnBps = burnBps_;
        rewardsBps = rewardsBps_;
        emit SplitsSet(computeBps_, opsBps_, teamBps_, burnBps_, rewardsBps_);
    }

    function setWallets(address computeWallet_, address opsWallet_, address teamWallet_) external onlyOwner {
        if (computeWallet_ == address(0) || opsWallet_ == address(0) || teamWallet_ == address(0)) {
            revert ZeroAddress();
        }
        computeWallet = computeWallet_;
        opsWallet = opsWallet_;
        teamWallet = teamWallet_;
        emit WalletsSet(computeWallet_, opsWallet_, teamWallet_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setSwapAdapter(address adapter_) external onlyOwner {
        swapAdapter = ISwapAdapter(adapter_);
        emit SwapAdapterSet(adapter_);
    }

    function setRewardsDistributor(address distributor_) external onlyOwner {
        if (distributor_ == address(0)) revert ZeroAddress();
        rewardsDistributor = distributor_;
        emit RewardsDistributorSet(distributor_);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
