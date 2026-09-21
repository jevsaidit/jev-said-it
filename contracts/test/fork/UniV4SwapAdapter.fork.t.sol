// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UniV4SwapAdapter} from "../../src/adapters/UniV4SwapAdapter.sol";

interface IPonsMemeHook {
    function hookFeeBps() external view returns (uint256);
}

interface IPonsLaunchFactory {
    function maxCreatorTaxBps() external view returns (uint256);
}

/// Run with: forge test --match-path 'test/fork/*' --fork-url robinhood -vvv
/// Values from docs/addresses.md
/// @dev Without `--fork-url robinhood` the test skips itself (guard on block.chainid), so
///      `forge test` without flags does not touch the network.
contract UniV4SwapAdapterForkTest is Test {
    /// @dev This is NOT the address in `docs/addresses.md`. That one (0x66a9893c...) is a UniversalRouter
    ///      deployed on Robinhood Chain with the Ethereum mainnet immutables:
    ///      `poolManager()` = 0x000000000004444c5dc75cB358380D2e3dE08A90 and
    ///      `V4_POSITION_MANAGER()` = 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e, both with no
    ///      code on chain 4663 -> every V4_SWAP reverts with "call to non-contract address".
    ///      This one instead is the router that actually executes the swaps on the OpenJEV pool
    ///      (`poolManager()` = 0x8366a39CC670B4001A1121B8F6A443A643e40951,
    ///       `V4_POSITION_MANAGER()` = 0x58daec3116aae6D93017bAAea7749052E8a04fA7).
    address constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant OPENJEV = 0x4d066AB4D924b7b3D01c6EcbFC142efe33AEb7FA;
    uint24 constant FEE = 0;
    int24 constant TICK_SPACING = 200;
    address constant HOOKS = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant LAUNCH_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    /// @dev PoolId of the OpenJEV pool, from `docs/addresses.md`.
    bytes32 constant POOL_ID = 0x671b0a6a58ddd96af8b3927aa3d44d6c8cb074120e0b2a55dbe662b36bf915c6;

    /// @dev `Swap(PoolId,address,int128,int128,uint160,uint128,int24,uint24)` of the v4 PoolManager.
    bytes32 constant SWAP_TOPIC = 0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f;
    /// @dev `HookFeeCollected` of the PonsV2MemeHook: topic[1] = PoolId, data = (currency, leg1, leg2).
    bytes32 constant HOOK_FEE_TOPIC = 0xc532c43b3423e14ef72748f1c8291238829ca0af8ba9b67975ad1483485a4b4d;

    uint256 constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 constant BPS = 10_000;

    /// @dev OpenJEV creator tax: word at index 8 of `factory.getLaunchedToken(OPENJEV)`,
    ///      `0x64` = 100 bps. Equal to the protocol fee, and that is the only reason the two
    ///      hook legs show the same amount on this pool.
    uint256 constant OPENJEV_CREATOR_TAX_BPS = 100;

    /// @dev `amountOut` is not compared with a constant: the public Robinhood Chain node
    ///      keeps state for only ~6-7k blocks (~10 minutes at 0.1 s/block), so a
    ///      `vm.createSelectFork("robinhood", <fixed block>)` committed here would turn red
    ///      within minutes — see the Task 8 report. The exact assert is instead derived from the
    ///      pool's accounting in the same block: the gross of the `Swap` event, minus the two
    ///      legs of the `HookFeeCollected` event, must equal exactly the delivered `amountOut`.
    ///      It is exact, deterministic at any block, and catches an encoding regression that
    ///      still produces "an" output.
    function test_swap_small_amount_on_real_pool() public {
        vm.skip(block.chainid != ROBINHOOD_CHAIN_ID);

        UniV4SwapAdapter adapter = new UniV4SwapAdapter(UNIVERSAL_ROUTER, address(this));
        adapter.setPool(OPENJEV, FEE, TICK_SPACING, HOOKS);
        address recipient = address(0xBEEF);

        vm.recordLogs();
        uint256 out = adapter.swapExactETHForToken{value: 0.001 ether}(OPENJEV, 1, recipient);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (uint256 gross, uint256 ethIn) = _readSwap(logs);
        (uint256 protocolLeg, uint256 creatorLeg) = _readHookFee(logs);

        assertEq(ethIn, 0.001 ether, "the whole msg.value must enter the pool");

        // Leg 1 = the hook's protocol fee, exactly `hookFeeBps` of the gross.
        uint256 hookFeeBps = IPonsMemeHook(HOOKS).hookFeeBps();
        assertEq(protocolLeg, gross * hookFeeBps / BPS, "leg 1 != hookFeeBps of the gross");

        // Leg 2 = creator tax, chosen per token at launch, not a constant of the hook.
        // The bps is derived by rounding to nearest, not truncating: the leg is already a
        // floor on the gross, and a second floor would push it down by one bps (1% -> 99 bps).
        uint256 creatorTaxBps = (creatorLeg * BPS + gross / 2) / gross;
        // Known, constant value of the OpenJEV pool: it is the word at index 8 of its record in
        // `factory.getLaunchedToken` (0x64 = 100). We assert it exactly, not against itself:
        // if the creator changed the tax, this test must turn red and say so.
        assertEq(creatorTaxBps, OPENJEV_CREATOR_TAX_BPS, "OpenJEV creator tax changed");
        assertEq(creatorLeg, gross * OPENJEV_CREATOR_TAX_BPS / BPS, "leg 2 != creator tax of the gross");
        assertLe(
            creatorTaxBps, IPonsLaunchFactory(LAUNCH_FACTORY).maxCreatorTaxBps(), "creator tax above the factory cap"
        );

        // The exact assert: net delivered = gross - the two hook legs.
        assertEq(out, gross - protocolLeg - creatorLeg, "amountOut != gross minus the hook's cut");
        assertEq(IERC20(OPENJEV).balanceOf(recipient), out, "the recipient receives exactly amountOut");
        assertEq(IERC20(OPENJEV).balanceOf(address(adapter)), 0, "the adapter keeps no tokens");
    }

    /// @return gross tokens received from the pool before the hook's cut
    /// @return ethIn wei paid to the pool
    function _readSwap(Vm.Log[] memory logs) internal pure returns (uint256 gross, uint256 ethIn) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == POOL_MANAGER && logs[i].topics.length > 1 && logs[i].topics[0] == SWAP_TOPIC
                    && logs[i].topics[1] == POOL_ID
            ) {
                (int128 amount0, int128 amount1,,,,) =
                    abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                // The Swap event deltas are from the swapper's point of view:
                // negative = paid, positive = received.
                assertLt(amount0, 0, "amount0 must be the ETH paid (zeroForOne)");
                assertGt(amount1, 0, "amount1 must be the token received");
                return (uint256(uint128(amount1)), uint256(uint128(-amount0)));
            }
        }
        revert("Swap event of the OpenJEV pool not found");
    }

    function _readHookFee(Vm.Log[] memory logs) internal pure returns (uint256 leg1, uint256 leg2) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == HOOKS && logs[i].topics.length > 1 && logs[i].topics[0] == HOOK_FEE_TOPIC
                    && logs[i].topics[1] == POOL_ID
            ) {
                (, uint256 a, uint256 b) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                return (a, b);
            }
        }
        revert("HookFeeCollected event of the OpenJEV pool not found");
    }
}
