# Pons v2 / Uniswap v4 addresses — Robinhood Chain

Resolved and verified on-chain on 2026-09-20 with `cast` against `https://rpc.mainnet.chain.robinhood.com`
(chain id confirmed 4663). Recorded here verbatim; do not re-derive.

| Name | Address | How it was obtained |
|---|---|---|
| PonsV2LaunchFactory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | `locker.factory()` |
| **PonsV2FeeEscrow** | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` | `factory.feeEscrow()` |
| PonsV2LaunchLocker | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` | Blockscout label among the OpenJEV holders |
| memeHook (Uniswap v4 hook) | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | `factory.memeHook()` |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | `factory.poolManager()` |
| Uniswap v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | `factory.positionManager()` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `factory.permit2()` |
| Pons BuybackVault | `0x42df2a798f82289E177311362e8f5ccC45c1219c` | `factory.buybackVault()` |
| ~~UniversalRouter (DO NOT use)~~ | ~~`0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af`~~ | **mis-deployed, see below** |
| **Uniswap UniversalRouter** | `0x8876789976dEcBfCbBbe364623C63652db8C0904` | `poolManager()` = this chain's PoolManager; router used by the real swaps on the OpenJEV pool |

## Correction of 2026-09-20 — UniversalRouter (Task 8)

The address `0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af`, first recorded here as the
UniversalRouter, **has the Ethereum mainnet immutables** and is therefore unusable for
v4 swaps on Robinhood Chain:

```bash
cast call 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af 'poolManager()(address)' --rpc-url https://rpc.mainnet.chain.robinhood.com
# 0x000000000004444c5dc75cB358380D2e3dE08A90   <- Ethereum mainnet PoolManager
cast call 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af 'V4_POSITION_MANAGER()(address)' --rpc-url https://rpc.mainnet.chain.robinhood.com
# 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e   <- Ethereum mainnet PositionManager
cast code 0x000000000004444c5dc75cB358380D2e3dE08A90 --rpc-url https://rpc.mainnet.chain.robinhood.com
# 0x   <- no code on chain 4663
```

Every `V4_SWAP` command on this router reverts with `call to non-contract address
0x000000000004444c5dc75cB358380D2e3dE08A90`. The presence of `execute` and `unlockCallback` in the
bytecode (the original check) says nothing about the constructor immutables.

The correct router is **`0x8876789976dEcBfCbBbe364623C63652db8C0904`**, found by reading the
PoolManager's `Swap` events for the OpenJEV PoolId and tracing back to the `sender`:

```bash
cast call 0x8876789976dEcBfCbBbe364623C63652db8C0904 'poolManager()(address)' --rpc-url https://rpc.mainnet.chain.robinhood.com
# 0x8366a39CC670B4001A1121B8F6A443A643e40951   <- matches factory.poolManager()
cast call 0x8876789976dEcBfCbBbe364623C63652db8C0904 'V4_POSITION_MANAGER()(address)' --rpc-url https://rpc.mainnet.chain.robinhood.com
# 0x58daec3116aae6D93017bAAea7749052E8a04fA7   <- matches factory.positionManager()
```

It exposes `execute(bytes,bytes[],uint256)` (`0x3593564c`). Confirmed by
`contracts/test/fork/UniV4SwapAdapter.fork.t.sol`, which with this router runs a real swap
of 0.001 ETH on the OpenJEV pool in a mainnet fork.

## The hook's cut: two legs, and the second one is NOT a constant

`PonsV2MemeHook` takes its cut in `afterSwap`, and it does so in **two legs**, both visible as the two
amounts of the `HookFeeCollected` event:

| Leg | What it is | Value |
|---|---|---|
| 1 | protocol fee | `hook.hookFeeBps()` = `100` bps (1%), **the same for all pools** |
| 2 | creator tax | **chosen per token at launch**, up to `factory.maxCreatorTaxBps()` |

Verified on-chain on 2026-09-20:

```bash
cast call 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044 'hookFeeBps()(uint256)' --rpc-url https://rpc.mainnet.chain.robinhood.com
# 100
cast call 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e 'maxCreatorTaxBps()(uint256)' --rpc-url https://rpc.mainnet.chain.robinhood.com
# 1000
```

So the total cut is `100 + creatorTax` bps and can legitimately reach
**1100 bps = 11%**. It is not 1%, and it is not 2% either.

> **Whoever sizes `minOut` for `FeeRouter.processSwap` must read the real value of the
> $JEVSAID pool, not assume a constant.** It can be derived from the two `HookFeeCollected` amounts of
> a swap on that pool, or from the factory's launch record (see below).

### Evidence (reproducible without redoing the census)

Census of the hook's `HookFeeCollected` events (topic0
`0xc532c43b3423e14ef72748f1c8291238829ca0af8ba9b67975ad1483485a4b4d`, `topics[1]` = PoolId,
`data` = `(currency, leg1, leg2)`) over the 8,000 blocks 68,079,966 → 68,087,966:
**4,338 events on 397 distinct pools**. Ratio leg2/leg1:

| ratio | events |
|---|---|
| 2.0 | 1555 |
| 3.0 | 1176 |
| 0.0 | 845 |
| 1.0 | 372 |
| 4.0 | 156 |
| 3.5 | 64 |
| 6.0 | 41 |
| 2.5 | 34 |
| 1.5 | 28 |
| 0.9 | 22 |
| 0.5 | 10 |
| 5.0 | 7 |

**The ratio is constant within each pool and varies across pools.** How "constant" it is depends
on the tolerance used for grouping, and that must be stated, because the two legs are integer `floor`s on the
gross: on small swaps the ratio fluctuates. Grouping the ratios rounded to N decimals:

| grouping tolerance | pools with a single ratio |
|---|---|
| exact (fraction, no rounding) | 301 / 397 |
| 1e-6 | **390 / 397** |
| 1e-4 | 395 / 397 |
| 1e-2 | 396 / 397 |

The reference figure is **390 out of 397 at 1e-6**. Of the 7 pools that show more than one ratio
at that tolerance, 5 fluctuate by less than 0.01% (`3.000001`…`3.000016`,
`2.499992`…`2.500003`) and 2 by more, but only on dust legs: `3.000000`…`3.002506` with a minimum
leg of `399` units, and `2.000000`…`2.024390` with a minimum leg of `41` units. That is the effect of the integer
floor, already explained above — not a second fee regime. No pool shows two genuinely
different ratios.

Cross-check on a pool with ratio 3.0 — tx
`0xff4bf3ff6cfe68b8a4726abfb3c2e3f258ac5260f6dda102cdb3422afa89562f`, pool
`0xc1ec26318be270b477e1c6b1981507f517c9860e1e1a229e2101f8259ab9661a`:

```
gross (amount0 of the Swap event) = 46212117295681955729305
leg 1                             =   462121172956819557293   = exactly 1.000%
leg 2                             =  1386363518870458671879   = exactly 3.000%
                                                                -> total haircut 4%
```

And the factory's launch record confirms that leg 2 is a token parameter: the word
at index 8 of `getLaunchedToken(token)` is `0x12c` = **300** bps for that pool's token
(`0x4fb96587c41033af477c87f7e745c9d735f4c5b6`) and `0x64` = **100** bps for OpenJEV — exactly the
bps observed in leg 2 of the respective events.

```bash
cast call 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e 'getLaunchedToken(address)' 0x4fb96587c41033af477c87f7e745c9d735f4c5b6 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e 'getLaunchedToken(address)' 0x4d066AB4D924b7b3D01c6EcbFC142efe33AEb7FA --rpc-url https://rpc.mainnet.chain.robinhood.com
```

OpenJEV has a creator tax of `100` bps, equal to the protocol fee: that is the **only reason** why on
the fork test swap the two legs come out identical and the haircut is 2%. It is a coincidence of
OpenJEV, not a property of the hook. `test/fork/UniV4SwapAdapter.fork.t.sol` asserts the
mechanism in executable form: leg 1 `== gross * hookFeeBps / 10000`, leg 2 `== gross *
creatorTaxBps / 10000` with `creatorTaxBps <= maxCreatorTaxBps`, and net `== gross - leg1 - leg2`.

## Who the escrow actually pays: the word at index 3

The `getLaunchedToken(token)` record contains **two** words that both look like a creator-side
address: the one at **index 2** and the one at **index 3** (rows 3 and 4 of the output, with the
1-based numbering used by the runbook §4.5 command). On the first samples — OpenJEV and a second
token — they were **equal**, so it was not possible to tell which of the two was the
creator fee recipient, and this document left the question open.

**It is now closed: the recipient paid by the escrow is the word at index 3, not the one at
index 2.** Proven on tokens where the two words **diverge**: the escrow balance
(`balanceOf`) is credited to the address at **index 3**, while the one at index 2 has a
balance of **zero**.

### The samples, with the command to redo them

```bash
export PATH="$HOME/.foundry/bin:$PATH"
R=https://rpc.mainnet.chain.robinhood.com
F=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
E=0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e
for T in 0xd15bb4219b8b597cfc999e70910a7b58f953a4b9 \
         0xe20359d3e4cb4540c3383452116c90f27cd92e34 \
         0xcd4279448d2e5f8b17cb0d9e948bd11f4bacddff; do
  W=$(cast call $F 'getLaunchedToken(address)' "$T" --rpc-url $R | sed 's/^0x//' | fold -w64)
  W2=0x$(echo "$W" | sed -n '3p' | cut -c25-)
  W3=0x$(echo "$W" | sed -n '4p' | cut -c25-)
  echo "token $T"
  B2=$(cast call $E 'balanceOf(address)(uint256)' $W2 --rpc-url $R)
  B3=$(cast call $E 'balanceOf(address)(uint256)' $W3 --rpc-url $R)
  echo "  index 2 = $W2  escrow balance = $B2"
  echo "  index 3 = $W3  escrow balance = $B3"
done
```

Result on 2026-09-20:

| token | index 2 | balance | index 3 | balance |
|---|---|---|---|---|
| `0xd15bb421…a4b9` | `0xac301c88…955b` | **0** | `0x4cb42c17…4042` | `1.376e16` |
| `0xe20359d3…2e34` | `0x85a64b88…f391` | **0** | `0xa336c290…8c98` | `5.376e17` |
| `0xcd427944…ddff` | `0x6db72676…cb86` (**has code**) | **0** | `0xb0234651…064d` (EOA) | `1.188e16` |

The index 3 balances are **live and growing**: rerunning the command gives larger numbers.
What does not change is the direction — index 3 collects, index 2 stays at zero.

### What index 2 really contains: **the factory caller**

It is not a mysterious field. Decoding the real launch transactions and comparing them with the
record, on a sample of **80 launches** taken from the factory's events (topic0
`0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607`, `topics[1]` = token):

| launch path | launches | index 2 = tx signer |
|---|---|---|
| **direct** (`tx.to` = factory) | 18 | **18 / 18** |
| through a UI / a router (`tx.to` = another contract) | 62 | 61 / 62 (in 1 case it is the called contract) |

So: **index 2 = who called the factory, index 3 = who collects the creator fees.** The two
words diverge when the fee recipient is not the signer — and the "contracts that
reappear on different tokens" are UI intermediaries, not mysterious platform addresses.

```bash
# the check, on any launch: factory tx -> words 3 and 4 of the record
export PATH="$HOME/.foundry/bin:$PATH"
R=https://rpc.mainnet.chain.robinhood.com
F=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
T=0xca0fae2cf65e5bfb98c6a432bca2048233dbb8b2
TX=0x96997deb774ddddcf58c7550e0ba56d2dc4378fd85372aa8d2f322680042d185
# These four values feed the runbook §4.5 gate. Careful with the word "row": in the runbook's
# table index 2 is row 3 and index 3 is row 4 (rows are numbered from 1, index = row - 1); here the
# script just prints four lines, index 2, index 3, from, to. A value never measured, printed here, reads as a measurement
# — and the gate is crossed at T0+30s on an already launched token. Rule: runbook §4.
W=$(cast call $F 'getLaunchedToken(address)' "$T" --rpc-url $R | sed 's/^0x//' | fold -w64)
W2=$(echo "$W" | sed -n '3p' | cut -c25-)
W3=$(echo "$W" | sed -n '4p' | cut -c25-)
FROM=$(cast tx "$TX" from --rpc-url $R)
TO=$(cast tx "$TX" to   --rpc-url $R)
if [ -z "$W2" ] || [ -z "$W3" ] || [ -z "$FROM" ] || [ -z "$TO" ]; then
  echo "!! read failed: retry. An empty field here is NOT a zero address."
else
  echo "index 2 = 0x$W2"
  echo "index 3 = 0x$W3"
  echo "tx from  = $FROM"
  echo "tx to    = $TO   # = factory -> direct launch"
fi
```

**That sample is our own configuration**: direct launch to the factory, fee recipient
**different** from the signer. Index 2 is the signer, index 3 is the recipient.

**No divergence rate over the population, on purpose.** It serves no decision:
in *our* launch the two words **always** diverge, because we sign from an EOA and pay to a
contract. A previous version of this section reported a 5% that does not reproduce in
any section of the declared window, next to a sentence that "reconciled" that number with
a higher measurement by inventing a gradient in the wrong direction. It was a disputed number without a
command to regenerate it, in a file where every other claim has one.

Practical consequences, in order of importance:

1. **The runbook gate (§4.5) has four branches, not two.** Index 3 different from the adapter →
   **STOP** in the runbook's vocabulary (the team is convened; see runbook §4 for the definition):
   the fees will not arrive. Index 2 different from index 3 → **expected**; for us it always
   happens. Index 2 different from the **launch EOA** with a **direct** launch → we **pause and
   republish** the address map, then continue: it is the signal that the six addresses
   published at T-4 may be skipped. The same mismatch with a launch that is **not** direct (via a UI)
   → **is not an outcome**: index 2 may be the intermediary.
   Requiring instead that index 2 also equal the adapter — as the first version did —
   would produce a **guaranteed** false alarm at T0+30s, with everything correct.
2. **An indexer that reads the record to know who collects must read index 3.**
3. The definitive proof, for our token, remains the first non-zero `claimable()` on the adapter.

## Creator revenue with the creator tax at zero: 0.70% of volume

**Verified fact, and it changes the project's P&L:** the hook's leg 1 — the 1%
protocol fee, the same for all pools — **does not all stay with Pons**. It is split **70/30 between
creator and Pons**, exact to the wei.

```
creator revenue = 0.70% of volume  +  creator tax chosen at launch
```

With our creator tax at **zero** (runbook §1.1) we still collect **0.70% of volume**.
Setting the tax to zero is therefore not giving up all revenue: it is giving up
leg 2 only.

**Evidence:**

- **394 per-interval reconciliations** over 19,763 `HookFeeCollected` events and 3,542 settlements in
  a window of 40,000 blocks. The coefficient `s` is **0.7 in every case**, computed twice
  independently: once from the protocol side, once from the creator side.
- **421 pools out of 428** imply exactly `0.700`.
- Three tokens with a creator tax of **zero** have an escrow balance that is **strictly positive and growing**,
  without any claim event: if leg 1 went entirely to Pons, those balances would stay at zero.

> **Do not confuse revenue with haircut.** The cut the pool applies to the swap stays
> the **full 1%** (leg 1) plus the creator tax: that is what is missing from the output, and that is what
> `minOut` in `FeeRouter.processSwap` is sized on (runbook §1.2). The 0.70% is how much of
> that 1% comes back to us **afterwards**, by another route — the escrow — and at another time. Discounting
> `minOut` by 0.70% instead of by 1% would make every `processSwap` revert with
> `Slippage()`.

## Launch parameters

Read from the factory:

- `launchFee` = `5e14` wei (0.0005 ETH)
- `maxCreatorTaxBps` = `1000` (10%)
- `snipeTaxSeconds` = `3`
- `snipeTaxStartBps` = `9900` (99%, decaying over 3 seconds)
- `CREATOR_FEE_RECIPIENT_TIMELOCK` = `259200` (3 days)
- `CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW` = `259200`

Verified fact: `getLaunchedToken(OpenJEV)` has `pairToken = address(0)`, i.e. native ETH, and
the escrow holds 1.543 ETH with 8.34 ETH claimable by the OpenJEV creator. The creator fees are
therefore in **native ETH**, as the plan assumes.

## Step 1 — Escrow interface

The verified ABI of `PonsV2FeeEscrow` is indexed **by recipient**, not by token: whoever
calls `claim()` collects their own balance. See `contracts/src/interfaces/IPonsFeeEscrow.sol`.

Check run on 2026-09-20:

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cast call 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e 'balanceOf(address)(uint256)' 0x2197fcb8850be02bbeeb1277a8edaa18a801989b --rpc-url https://rpc.mainnet.chain.robinhood.com
```

Actual output obtained:

```
8412543529128600147 [8.412e18]
```

A large number (~8.41 ETH), consistent with the ~8.34 ETH claimable cited above — no
revert, the interface matches the chain.

## Step 2 — PoolKey and PoolId

The `PoolKey` of every ETH-paired Pons v2 pool:

| Field | Value |
|---|---|
| `currency0` | `address(0)` (native ETH) |
| `currency1` | the token address |
| `fee` | `0` |
| `tickSpacing` | `200` |
| `hooks` | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` (PonsV2MemeHook) |

The pool fee is zero because the whole cut is taken by the hook in `afterSwap`: the flags
of the hook address have AFTER_SWAP and AFTER_SWAP_RETURNS_DELTA on and BEFORE_SWAP off.
**Warning: the cut is not 1%.** The hook takes two legs — protocol fee
`hook.hookFeeBps()` = `100` bps (1%, the same for all pools) **plus** a creator tax chosen
per token at launch, up to `factory.maxCreatorTaxBps()` = `1000` bps. The total can therefore reach
11%. On OpenJEV the creator tax is 100 bps and the total is 2%, but that is a value of that token:
for $JEVSAID it must be read, not assumed. Details, evidence and commands in the section
"The hook's cut: two legs, and the second one is NOT a constant" above.

Reconfirmed on 2026-09-20 with:

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cast keccak $(cast abi-encode 'f((address,address,uint24,int24,address))' \
  '(0x0000000000000000000000000000000000000000,0x4d066AB4D924b7b3D01c6EcbFC142efe33AEb7FA,0,200,0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044)')
```

Actual output obtained:

```
0x671b0a6a58ddd96af8b3927aa3d44d6c8cb074120e0b2a55dbe662b36bf915c6
```

It matches exactly the OpenJEV pool PoolId reported by Dexscreener. Positive
confirmation: `fee = 0`, `tickSpacing = 200` are correct.

## Testnet (chain id 46630)

Verified on 2026-09-20 with `cast code <addr> --rpc-url https://rpc.testnet.chain.robinhood.com/rpc`:

| Contract | Present on testnet? | Evidence |
|---|---|---|
| PonsV2LaunchFactory (`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`) | **No** | `cast code` returns `0x` |
| PonsV2FeeEscrow (`0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`) | **No** | `cast code` returns `0x` |
| ~~Mis-deployed UniversalRouter~~ (`0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af`) | **No** | `cast code` returns `0x` |
| **Good Uniswap UniversalRouter** (`0x8876789976dEcBfCbBbe364623C63652db8C0904`) | **Yes** | `cast code` returns bytecode; `poolManager()` = `0x8366a39C…`, which has code on testnet |
| Uniswap v4 PoolManager (`0x8366a39CC670B4001A1121B8F6A443A643e40951`) | **Yes** | `cast code` returns bytecode, same address as mainnet |

**Correction of 2026-09-20 (Task 12).** The UniversalRouter row said "does not exist on testnet", but
only the **wrong** address, the mis-deployed one, had been checked. Rechecked on
chain id 46630 (`cast chain-id` = `46630`): **the good UniversalRouter
`0x8876789976dEcBfCbBbe364623C63652db8C0904` is also present on testnet**, at the same address
as on mainnet, and its `poolManager()` points to the PoolManager that has code on testnet.

The operational conclusion **does not change**: without `PonsV2LaunchFactory` a token cannot be launched
on Pons on testnet, so there is no $JEVSAID pool to swap on. The swap
path stays verified only by the mainnet fork test. Only one detail of the dress
rehearsal changes: in the testnet `.env` it is better to put **the real address**
(`0x8876…`) in `UNIVERSAL_ROUTER` instead of any non-zero address — it costs nothing and makes the
testnet `UniV4SwapAdapter` try the same value it will have on mainnet.

As a consequence, the integration tests on testnet will use `MockFeeEscrow`
(`contracts/test/mocks/MockFeeEscrow.sol`) instead of the real `PonsV2FeeEscrow`.

## Testnet addresses (46630): deliberately not recorded

The plan was to record here the addresses of the contracts deployed on testnet 46630
during the dress rehearsal. **This was not done, and it is a choice.**

The dress rehearsal (`docs/runbook-launch.md` §3) has never been run: it requires funded testnet
keys, which do not exist at the moment. Recording here the addresses of a deploy nobody
ran would be worse than the empty cell — they would be invented numbers in a document that runbook
§0 names as the authoritative source of addresses, and that is read in a
hurry on launch day.

What matters is that the **procedure** is repeatable, and it is written out in full in runbook
§3, with the testnet commands kept separate from the mainnet ones precisely so it can be run without
risk of hitting 4663.

Whoever runs the dress rehearsal should fill in this table then, with the real addresses:

| Contract | Address on testnet 46630 | Deploy date |
|---|---|---|
| MockERC20 (stands in for $JEVSAID) | | |
| MockFeeEscrow (stands in for PonsV2FeeEscrow) | | |
| PonsEscrowAdapter | | |
| TimelockController | | |
| FeeRouter | | |
| RewardsDistributor | | |
| CallLedger | | |
| UniV4SwapAdapter | | |

## How fees actually reach the fee recipient (verified on a mainnet fork, 2026-09-21)

`test/fork/FeePipeline.fork.t.sol` runs the whole path on the real Pons contracts: launch with
`feeRecipient = PonsEscrowAdapter`, curve, graduation, trading, escrow, adapter, router, buyback,
epoch root, a winner's claim. What it established, beyond what this file already said:

1. **Reaching the threshold does not create the v4 pool.** `graduated()` turns true, but the pool is
   created by a separate call, `factory.createGraduatedPool(token)` (selector `0x2f53ef2f`), open to
   anyone. On mainnet a bot calls it in an ERC-7579 batch together with the first buy of the fresh
   pool. Calling `graduate(address)` instead reverts with `WrongGraduationPhase()`.
2. **Fees do not reach the escrow at swap time.** They accrue in the hook and are settled by
   `hook.sweepPoolFees(poolId, minOut, 0)`, which only Pons' operator can call
   (`NotFeeSweepOperator` for anyone else; 12 of 12 sweeps sampled came from
   `0x49BbF2b70955Fb3a106e084D4BFDa92d334573d2`). Our reward cadence therefore follows their sweep
   cadence, not ours. A sweep with `minOut = 0` reverts with `MinimumOutputRequired()` when there
   are token-side fees to convert.
3. **On buys the hook takes its fee in the token** (10 of 10 buys in the fork test), and the sweep
   **converts it to ETH at the price of the moment of the sweep**, then credits the recipient in ETH.
   So the credit is 0.70% of volume only on average: a sweep after a pump credits more ETH, one after
   a dump less. The conversion is a small sell of fee tokens on the pool.
4. **The curve phase pays the recipient too**: before any trading on the pool, the escrow already
   owed the adapter ~0.63% of the ETH bought on the curve.
5. The escrow only credits in the pair's quote currency (ETH for an ETH pair): of 28 distinct tokens
   credited on mainnet over ~3,000 blocks, 28 were quote currencies and 0 launched tokens. With an
   ETH pair, `PonsEscrowAdapter.claim()` (ETH only) collects everything.
