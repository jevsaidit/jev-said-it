# Security checklist — $JEVSAID contracts

> **Internal** audit. No external review has been done. This document does not say
> "the code is secure": it says **what was verified, how, and what is left out**. The section
> that matters most is the last one, [What this audit does NOT cover](#what-this-audit-does-not-cover).
>
> Every item ticked below carries its proof: the command run or the `file:line` reference.
> An item without proof is not ticked. Where an item is true **only under an assumption**,
> the assumption is written next to it.
>
> - Date: 2026-09-20
> - Commit of the code examined: see `git log -1` at the time of reading; the fix described in
>   [F-01](#f-01--zero-root-accepted-by-setepochroot-medium--fixed) is part of this work.
> - Toolchain: Foundry 1.8.3, solc 0.8.26, `optimizer = true` / `runs = 200`, `via_ir = false`,
>   `evm_version = cancun` (`foundry.toml`).
> - Target chain: Robinhood Chain, chain id **4663**.
> - Not affiliated with TypeSafe AI.

## Scope

Five contracts under `contracts/src/`:

| Contract | File | Holds funds? | Expected owner |
|---|---|---|---|
| `PonsEscrowAdapter` | `src/PonsEscrowAdapter.sol` | ETH in transit | `TIMELOCK_PROPOSER` (EOA), plain `Ownable` |
| `FeeRouter` | `src/FeeRouter.sol` | ETH (buckets) | `TimelockController` 24 h, `Ownable2Step` |
| `RewardsDistributor` | `src/RewardsDistributor.sol` | $JEVSAID | `TimelockController` 24 h, `Ownable2Step` |
| `CallLedger` | `src/CallLedger.sol` | **no** | `TimelockController` 24 h, `Ownable2Step` |
| `UniV4SwapAdapter` | `src/adapters/UniV4SwapAdapter.sol` | nothing between one tx and the next | `TimelockController` 24 h, plain `Ownable` |

Out of scope: `lib/` (OpenZeppelin, Uniswap v4, murky), `test/`, `script/`, the
$JEVSAID token (created by the Pons factory, not by us), the off-chain engine.

---

## Step 0 — the RewardsDistributor's three defenses, in numbers

The constants are read from the contract, not from planning documents:

| Constant | Value | Reference |
|---|---|---|
| `EPOCH_LENGTH` | 6 hours | `src/RewardsDistributor.sol:24` |
| `CLAIM_DELAY` | 12 hours | `src/RewardsDistributor.sol:25` |
| `CLAIM_WINDOW` | 90 days | `src/RewardsDistributor.sol:23` |
| `maxEpochBudgetBps` | 2000 (= 20%) | `src/RewardsDistributor.sol:30` |
| timelock `minDelay` | 24 hours | `script/DeployCore.s.sol:79` |

- [x] **Strictly increasing epochs** — `if (epoch <= lastEpoch) revert EpochNotIncreasing;`
      `src/RewardsDistributor.sol:96`. Tested: `test_setEpochRoot_epoch_must_increase`.
- [x] **Minimum interval of `EPOCH_LENGTH` between two `setEpochRoot`** —
      `if (block.timestamp < lastRootSetAt + EPOCH_LENGTH) revert EpochTooSoon;`
      `src/RewardsDistributor.sol:97`. Tested: `test_setEpochRoot_rate_limited_to_6_hours`.
- [x] **`CLAIM_DELAY` window with `voidEpoch`** — claims open at
      `epochSetAt + CLAIM_DELAY` (`:114`); `voidEpoch` is allowed only **before** that
      moment (`:134`). Tested: `test_claim_before_delay_reverts_then_opens`,
      `test_guardian_can_void_epoch_before_delay`, `test_voidEpoch_after_window_reverts`.

### What it costs a compromised scorer key to drain 90% of the pool

The cap is on the **free balance** at publication time
(`budget > freeBalance() * maxEpochBudgetBps / BPS` → revert, `:99`). A claim reduces both
`committed` and the token balance by the same amount, so `freeBalance()` after *n* commitments is
`pool · 0.8^n` **regardless of when the claims happen**. So it takes *n* epochs with
`1 − 0.8^n ≥ 0.90`, i.e. `n ≥ ln(0.10)/ln(0.80) = 10.32` → **11 epochs**.

| Epoch | Budget (% of pool) | Cumulative | Root at | Claims open at |
|---:|---:|---:|---:|---:|
| 1 | 20.000% | 20.000% | 0 h | 12 h |
| 2 | 16.000% | 36.000% | 6 h | 18 h |
| 3 | 12.800% | 48.800% | 12 h | **24 h** |
| 4 | 10.240% | 59.040% | 18 h | 30 h |
| … | … | … | … | … |
| 11 | 2.147% | **91.410%** | 60 h | **72 h** |

- **Transactions**: 11 `setEpochRoot` + at least 11 `claim` = **22 transactions** (lower bound:
  a single claim per epoch that takes the whole budget).
- **Hours**: the first wei can be extracted at **12 h**; 90% is complete at **72 h ≈ 3 days**.
- **Comparison with rotation via the timelock (24 h)**: within the 24 hours the timelock needs to
  execute `setScorer`, the open claims are those of 3 epochs, i.e. **48.80% of the pool**
  extractable; **59.04%** is already *committed*. Rotation alone **is not enough**: it arrives
  after about half the pool has left.

> Reproducible derivation: `docs/security-checklist.md` → the two formulas above use only
> `maxEpochBudgetBps`, `EPOCH_LENGTH` and `CLAIM_DELAY` as they are in the contract.

### Why the guardian is indispensable — and why it is safe on a hot key

**Indispensable.** `voidEpoch` accepts `guardian` **or** `owner()`
(`src/RewardsDistributor.sol:131`), but the window closes at `epochSetAt + CLAIM_DELAY` = **12
hours** (`:134`). After the handover the owner is the `TimelockController` with `minDelay` = **24 hours**
(`script/DeployCore.s.sol:79`): an operation scheduled there becomes executable **no earlier than 24
hours**, so it **can never** land in a 12-hour window. Arithmetically `24 h > 12 h`, and
there is no way to shorten the delay without itself going through the timelock. **The guardian is
therefore the only actor that can void an epoch **in reaction to what it sees**.**
With one caveat that must be stated, because the flat claim would be false: OpenZeppelin's
`TimelockController` does not expire operations, so an owner that
scheduled `voidEpoch(N)` at least 24 hours in advance would find it executable
inside the window. But that requires guessing in advance the epoch number the
scorer will choose, which makes it a theoretical route and not a defense to rely on. The constructor rejects
a zero guardian (`:76`) and so does `setGuardian` (`:166`), precisely for this reason.

**Safe on a hot key — verified by reading the contract.** The guardian **has no path
to move or receive funds**:

```bash
grep -n 'guardian' src/RewardsDistributor.sol
```

`guardian` appears as: declaration (`:29`), event (`:50`), parameter and assignment in the
constructor (`:75,76,79`), the comparison in `voidEpoch` (`:131`), and the `setGuardian` setter
(`:165-168`). **Never** in a line that moves value. The only function it authorizes,
`voidEpoch` (`:130-140`), contains neither `safeTransfer` nor `call{value:}`: it only touches
`epochVoided`, `epochBudget` and `committed`. Cross-checked against the full list of transfers:

```bash
grep -rn 'safeTransfer\|call{value' src/
```

→ `FeeRouter.sol:153,154,203`, `PonsEscrowAdapter.sol:52`, `RewardsDistributor.sol:122`,
`UniV4SwapAdapter.sol:92`. `guardian` appears in none of these six lines. **The guardian can
only block.** A compromise of its key costs a suspension of rewards (DoS), not a token.

- [x] Verified. No guardian → funds path was found.

---

## Findings

### F-01 — zero root accepted by `setEpochRoot` (Medium) — **FIXED**

**Found in this audit.** `setEpochRoot` checked that a root was not *overwritten*
(`if (roots[epoch] != bytes32(0)) revert RootExists;`) but **not** that the root passed was
non-zero. Publishing `root = bytes32(0)` with a budget:

- `committed += budget` (the budget is recorded as committed);
- `roots[epoch]` stays `bytes32(0)`;
- and **all three exits start from the same guard** `roots[epoch] == 0 → NoRoot`:
  `claim` (`:112`), `voidEpoch` (`:132`), `sweepExpired` (`:144`).

The budget therefore stayed committed **forever**: not stolen, but unrecoverable, with no
rescue function in the contract. The epoch could not even be republished with a real root
(`EpochNotIncreasing`). **The guardian — the valve — was disarmed in exactly the case it
exists for**, because `voidEpoch` also reverts with `NoRoot`.

Measured with a temporary test before the fix:

```
committed after zero root:  200e18 of 1000e18 (20%)
committed after 90 days:    200e18   (sweepExpired reverts: NoRoot)
frozen after 4 epochs (24 h): 590.4e18 = 59.04% of the pool
```

That is: **within the 24 hours of rotation via the timelock, 59.04% of the pool is frozen
permanently and irreversibly.**

**Reachability.** A compromised scorer key. But also a correct off-chain engine that,
on an epoch with no winners or with a degenerate tree, emits `0x0` without noticing: the zero
root is not an exotic input, it is the default value of `bytes32`.

**Severity: Medium.** No theft (zero impact on confidentiality/integrity), but a
**permanent and unremediable** loss of availability on a majority share of the rewards pool,
reachable even by mistake.

**Fix** — a guard on the argument, `src/RewardsDistributor.sol:93`, first line of
`setEpochRoot` after the caller check:

```solidity
if (root == bytes32(0)) revert NoRoot();
```

> Note for whoever checks this proof: line `:112` contains **identical** text,
> but it is the `NoRoot` gate inside `claim()` and it existed before. Searching for the line by
> text, instead of opening `setEpochRoot`, gives a false confirmation. The fix is `:93`.

**Regression test**: `test_setEpochRoot_rejects_the_null_root`
(`test/RewardsDistributor.t.sol`), which checks the revert, that nothing was committed, and that
the epoch stays available for a real root. Verified red before the fix
(`FAIL: next call did not revert as expected`) and green after.

### Findings examined and **rejected**, with the reason

They are worth as much as the confirmed ones: they tell the external reviewer where I looked.

- **`claim` is not `nonReentrant`** (`src/RewardsDistributor.sol:110-124`). **Rejected.** It follows
  checks-effects-interactions strictly: `hasClaimed[epoch][msg.sender] = true` (`:119`),
  `epochClaimed += amount` (`:120`) and `committed -= amount` (`:121`) all precede
  `token.safeTransfer` (`:122`). A reentrant call finds `hasClaimed` already `true` and reverts with
  `AlreadyClaimed`. *Assumption*: $JEVSAID is an ERC-20 with no hook on the recipient; even with a
  hook CEI holds, but the assumption is written down because the token is not ours (see
  [out of scope](#what-this-audit-does-not-cover)).
- **`voidEpoch` / `sweepExpired` could free `committed` twice.** **Rejected.**
  Both set `epochBudget[epoch] = epochClaimed[epoch]` (`:137`, `:150`) and raise a flag
  (`:136`, `:149`), so a second pass frees `freed = 0` or reverts. The two windows are
  also disjoint (`< 12 h` versus `≥ 90 days`). Now covered by
  `test_voidEpoch_is_not_idempotent_on_committed` and `test_sweepExpired_cannot_run_twice`.
- **`freeBalance()` can underflow** (`balanceOf − committed`, `:82-83`). **Rejected.**
  The invariant `committed ≤ balanceOf(this)` is maintained: `committed` grows only within
  `freeBalance()` (`:99`) and drops by exactly what leaves the contract (`:121` against `:122`).
  `voidEpoch`/`sweepExpired` lower `committed` without moving tokens, which widens the margin.
- **The keeper can pay itself the swap bucket.** **Rejected**: see the matching item
  in the checklist — the keeper chooses only *when* and with which `minOut`; `recipient` is
  hard-wired to `address(this)` (`FeeRouter.sol:147`) and the tokens' destination is `DEAD` +
  `rewardsDistributor` (`:153,154`).
- **`PonsEscrowAdapter.claim()` is reentrant.** **Rejected.** The router can reenter, but
  `forwarded = address(this).balance` (`:50`) is read *after* any claim, and the balance has already
  been deducted while the `call` is in progress: the reentrant call sees `balance == 0` and does nothing.
  The router is also a fixed, one-shot address (see checklist item).

---

## Checklist

### Value flows

- [x] **No function sends ETH to an arbitrary address.**
      `grep -rn 'call{value' src/` → exactly two lines:
      `src/FeeRouter.sol:203` (inside `_send`) and `src/PonsEscrowAdapter.sol:52`.
      `_send` is `internal` and has **four** reachable destinations, all hard-wired:
      `computeWallet` (`:109`), `opsWallet` (`:118`), `teamWallet` (`:127`) and — not via `_send` but
      as the fourth ETH exit — the **swap adapter**, through
      `swapAdapter.swapExactETHForToken{value: ethIn}` (`:147`). The three wallets change only through
      `setWallets` (`:176`, `onlyOwner`, rejects zero) and the adapter only through `setSwapAdapter`
      (`:191`, `onlyOwner`). No caller parameter ever reaches a destination.
      The line in `PonsEscrowAdapter` sends only to `router`, one-shot (see below).
- [x] **No function transfers tokens to an arbitrary address.**
      `grep -rn 'safeTransfer' src/` → four lines:
      `FeeRouter.sol:153` → `DEAD` (constant, `:20`);
      `FeeRouter.sol:154` → `rewardsDistributor` (only `setRewardsDistributor`, `onlyOwner`,
      rejects zero, `:196-200`);
      `RewardsDistributor.sol:122` → `msg.sender`, and only for the amount proven by the Merkle leaf;
      `UniV4SwapAdapter.sol:92` → `recipient`, a parameter **of the caller**. *Explicit assumption*:
      the adapter is a pass-through with no balance between one tx and the next, so `recipient` can
      be arbitrary without exposing anything — the caller pays with its own `msg.value` and receives
      its own tokens. In the production path the caller is the `FeeRouter`, which passes
      `address(this)` (`FeeRouter.sol:147`).
- [x] **The scorer cannot commit more than `maxEpochBudgetBps` of the free balance per epoch.**
      `if (budget > freeBalance() * maxEpochBudgetBps / BPS) revert BudgetTooLarge;`
      `src/RewardsDistributor.sol:99`. Default 2000 bps (`:30`). Tested:
      `test_setEpochRoot_only_scorer_and_within_budget_cap` and, for the cap itself,
      `test_setMaxEpochBudgetBps_guards_and_changes_the_cap`.
- [x] **The keeper chooses only when and with which `minOut`; the money ends up in burn +
      distributor regardless.** `processSwap(uint256 minOut)` (`src/FeeRouter.sol:133`) has **a single**
      parameter. The amount is the whole `swapBalance` (`:137`), the swap `recipient` is
      hard-wired to `address(this)` (`:147`), and the two exits are `DEAD` and `rewardsDistributor`
      (`:153,154`). The keeper names no address. Tested:
      `test_processSwap_only_keeper_and_respects_minOut`,
      `test_processSwap_burns_15_of_65_and_sends_rest_to_rewards`.
      *Assumption*: a deliberately low `minOut` remains an MEV/sandwich vector against the
      pool; it is mitigated off-chain (random window, computed `minOut`) and is **not** enforced
      on-chain. See [out of scope](#what-this-audit-does-not-cover).
- [x] **No wei is lost in `distribute()`: the rounding remainder ends up in the swap bucket.**
      `uint256 toSwap = amount - toCompute - toOps - toTeam;` `src/FeeRouter.sol:96` — a subtraction,
      not a fourth multiplication, so the three round-downs flow into `toSwap`.
      Tested on a prime amount: `test_distribute_loses_no_wei_on_prime_amount`.
      Same reasoning in `processSwap`: `toRewards = out - burned` (`:152`).
- [x] **`CallLedger` holds no funds.** No `payable`, no `receive`, no
      `safeTransfer`, no `call{value:}` in the file (`grep` above: `CallLedger.sol` appears in
      neither list). The only token read is `token.balanceOf` (`:50`, `:66`).
      Worst case: **event spam**, bounded by capacity — 1 call per `TOKENS_PER_CALL` =
      10,000 tokens, at most `MAX_CALLS_PER_EPOCH` = 50 per epoch (`:14,15`), enforced in `submit`
      (`:67,68,75`) and reset per epoch by the key `callsUsed[epoch][account]` (`:23`).

### Configuration and powers

- [x] **Splits: the sum is always 10,000 and `burn + rewards` is never zero — two independent
      guards.** `src/FeeRouter.sol:164` checks the sum;
      `src/FeeRouter.sol:166` separately checks `burnBps_ + rewardsBps_ != 0`.
      They are independent: `setSplits(10000, 0, 0, 0, 0)` passes the first and is stopped by the
      second — without which `processSwap` would divide by zero at `:151`. Tested by two
      separate tests: `test_setSplits_requires_sum_10000_and_owner` and
      `test_setSplits_reverts_when_burn_and_rewards_both_zero`.
      Default values: **compute 500 / ops 1000 / team 2000 / burn 1500 / rewards 5000**
      (`src/FeeRouter.sol:32-36`), sum 10,000. Verified by
      `test_distribute_splits_500_1000_2000_6500`.
- [x] **No `selfdestruct`, no proxy, no upgrade function, no `assembly`.**
      `grep -rni 'selfdestruct\|delegatecall\|upgrade\|proxy\|implementation' src/` → no
      results. `grep -rn 'assembly' src/` → no results. The five contracts are
      not upgradeable: **the bytecode that goes on-chain is final.**
- [x] **`PonsEscrowAdapter` HAS `receive()` and must have it.** `src/PonsEscrowAdapter.sol:30`,
      empty body on purpose: the Pons escrow credits ETH to this address and must be able to pay
      even with little gas. The ETH does not get stuck: `claim()` (`:47`) forwards **the contract's
      whole balance** (`address(this).balance`, `:50`), not only what arrives from the escrow, and it is
      **permissionless** — anyone can call it. Tested in `test/PonsEscrowAdapter.t.sol`.
- [x] **`UniV4SwapAdapter` does NOT have `receive()`, and that is correct.**
      `grep -n 'receive()\|fallback()' src/adapters/UniV4SwapAdapter.sol` → no results. The
      contract has no function to extract ETH: a `receive()` would make it a sink
      with no exit, and that is why it was removed. *Assumption verified by reading*:
      the Universal Router does not refund ETH on `SWAP_EXACT_IN` with `SETTLE_ALL` of the whole
      `msg.value` (`:78`); if it ever did refund, `swapExactETHForToken` would revert —
      a loud failure, not a silent loss.
- [x] **`setRouter` is one-shot.** `if (router != address(0)) revert AlreadySet();`
      `src/PonsEscrowAdapter.sol:33`, plus the rejection of zero and of `address(this)` (`:34`). After
      the call the adapter's owner **has no power left**: `setRouter` is its only
      `onlyOwner` function.
- [x] **Reentrancy: `processSwap`, `withdrawCompute`, `withdrawOps`, `withdrawTeam` are
      `nonReentrant`; `claim` follows checks-effects-interactions.**
      `grep -n 'nonReentrant' src/FeeRouter.sol` → `:104`, `:113`, `:122`, `:133` — the four.
      `FeeRouter is Ownable2Step, ReentrancyGuard` (`:16`). The three `withdraw*` zero
      the bucket before `_send` anyway (`:108-109`, `:117-118`, `:126-127`), so they would hold even
      without the guard. For `claim` see [rejected findings](#findings-examined-and-rejected-with-the-reason).

### Ownership and handover — **the 24-hour window**

- [ ] **All owners are the 24-hour timelock and the deployer has no roles left.**
      **NOT verifiable now**: the contracts are not deployed. This item is ticked **on deploy
      day**, by reading the chain. What is verified here is the *script*, and the important
      point is that **the handover is not atomic**:

  `script/DeployCore.s.sol:79` creates `new TimelockController(24 hours, proposers, executors, address(0))`
  → `minDelay` = 24 hours, admin `address(0)` (no separate admin: roles change only
  by going through the timelock itself), `executors[0] = address(0)` → **execution open to anyone**,
  which is intended: the protection is the delay, not the executor's identity.

  The contracts are born with the **deployer** as owner (`:82-85`), are configured (`:87-89`) and
  only then pass to the timelock (`:91-94`). But the two groups behave **differently**:

  | Contract | Type | `transferOwnership` to the timelock is… | Who is in control right after the script |
  |---|---|---|---|
  | `FeeRouter` | `Ownable2Step` (`src/FeeRouter.sol:16`) | **only a proposal** | **the deployer** |
  | `RewardsDistributor` | `Ownable2Step` (`src/RewardsDistributor.sol:19`) | **only a proposal** | **the deployer** |
  | `CallLedger` | `Ownable2Step` (`src/CallLedger.sol:13`) | **only a proposal** | **the deployer** |
  | `UniV4SwapAdapter` | plain `Ownable` (`src/adapters/UniV4SwapAdapter.sol:23`) | **immediate** | the timelock |
  | `PonsEscrowAdapter` | plain `Ownable` (`src/PonsEscrowAdapter.sol:13`) | n/a — owner = `TIMELOCK_PROPOSER` from the constructor (`script/DeployAdapter.s.sol:33`) | the proposer (only `setRouter`, one-shot) |

  **Three contracts out of five stay with the deployer** until the timelock calls
  `acceptOwnership()` — which in turn requires schedule + 24 hours. The script says so
  (`script/DeployCore.s.sol:108-109`). **This is exactly the window in which the deployer can
  still do everything**: change splits, wallets, keeper, scorer, swap adapter, distributor and publisher.
  Whoever verifies the launch from outside must check `owner()` **and** `pendingOwner()` on
  `FeeRouter`, `RewardsDistributor` and `CallLedger`, and consider the launch not delivered until
  `owner()` is the timelock on all three.

  Check to run on-chain on deploy day (replace the placeholders):

  ```bash
  RPC='https://rpc.mainnet.chain.robinhood.com'
  for c in "$FEE_ROUTER" "$REWARDS_DISTRIBUTOR" "$CALL_LEDGER"; do
    echo "$c owner=$(cast call "$c" 'owner()(address)' --rpc-url "$RPC")" \
         "pending=$(cast call "$c" 'pendingOwner()(address)' --rpc-url "$RPC")"
  done
  cast call "$UNIV4_SWAP_ADAPTER" 'owner()(address)' --rpc-url "$RPC"
  cast call "$TIMELOCK" 'getMinDelay()(uint256)' --rpc-url "$RPC"   # expected: 86400
  ```

- [ ] **Addresses in `addresses.md` reverified on-chain on deploy day.**
      **To do at launch.** The addresses in `contracts/docs/addresses.md` were resolved on
      2026-09-20 and recorded verbatim; the document already contains the `cast` commands that
      produced them. They must be rerun, in particular for the `UniversalRouter`, where a
      plausible but wrong address (`0x66a9893c…`, with the Ethereum mainnet immutables) has already been
      found and discarded once.
- [x] **The deploy order is a public commitment and a reorder turns the suite red.** The addresses
      are CREATE-derived — `address = f(deployer, nonce)`, the constructor arguments do **not**
      enter the calculation — so the nonce→contract map published before launch lets
      anyone compute the six addresses in advance and recognize an impostor.
      `test/DeployOrder.t.sol` really runs the two scripts from a deployer at nonce zero and checks
      the map: adapter 0, timelock 1, FeeRouter 2, RewardsDistributor 3, CallLedger 4,
      UniV4SwapAdapter 5, and no sixth contract. Swapping two `new` in `DeployCore` turns
      the suite red. **Only if someone runs it**: see the box below.
      Tested: `test_published_nonce_map_matches_what_the_scripts_deploy`.

**Correction of 2026-09-20, on the third draft, and it must be read because it concerns trust in this
document.** The box was wrong twice in a row, in two opposite directions, and the
second time it was I who got it wrong while correcting the first.

- **First draft (audit):** "CI is red at the `forge fmt --check` step", with
  `.github/workflows/` cited as proof. False as described: nothing automatic was
  flagging anything.
- **Second draft (mine):** "that directory does not exist, there is no CI". Also false.
  I had looked at the repository root and concluded from a single `ls`. The file **exists and has been
  tracked since the bootstrap commit**: `contracts/.github/workflows/test.yml`, with the steps
  `forge fmt --check`, `forge build` and `forge test`.
- **Third draft, verified:** the workflow is there but **does not run, and cannot run from there**. GitHub
  Actions reads only `<repo-root>/.github/workflows/`, and the root of this repository is the
  folder that contains `contracts/`, not `contracts/` itself. When this draft was
  written there was not even a remote. Since 2026-09-21 the repository is on GitHub, private
  (this repository), but this changes nothing: the file is still in the path that
  Actions does not read, so **even with the remote it does not run**. It has never run, not even once.

Why I write this out in full instead of trimming it: the operational conclusion stayed the same in
all three drafts — **no automatic check is watching this code** — but the evidence
offered was wrong two times out of three, and a security document is worth as much as its
evidence. The reader must be able to see how many times this line changed before trusting it.

What remains true: the three files **were** really out of format and **were** really a problem, and
they have been fixed (`forge fmt`, commit on the branch). What was false: that there was an automatic
signal flagging it.

**Consequence for the guarantee above.** `DeployOrder.t.sol` turns red on a real reorder,
but nobody runs it automatically. Today the only place where that protection is realized is one
line of the runbook — `runbook-launch.md:207`, `forge test` with **`0 failed`** required before
phase 1 — that is, a person following a procedure, not a machine. It is a procedural defense
and must be counted as such:

```bash
cd contracts && forge test   # 0 failed, before phase 1. Nobody does it for you.
```

**What it would take for it to become a real CI.** The remote now exists. Two things are missing,
neither done here: move `contracts/.github/workflows/test.yml` to the repository root, and
give it `working-directory: contracts`, because `foundry.toml` is not at the root and the steps
as they are would fail. Until they are done, writing "CI will catch it" means promising
a sentinel that is not there.

### Quality of the verification

- [x] **Offline suite green.** `forge test --no-match-path 'test/fork/*'` → what matters is
      **`0 failed`**. At commit `d37327a` it was 72 passed across 9 suites; a higher total in
      the future is not a regression, a `failed` is. (A fixed expected number written in a
      document becomes a false alarm at the first test added: this line said 69 three
      commits after they had become 72.)
- [x] **Line coverage on `src/` ≥ 90%** — **it is 100%**.
      `forge coverage --report summary --no-match-path 'test/fork/*'`:

  | File | Lines | Statements | Branches | Functions |
  |---|---|---|---|---|
  | `src/CallLedger.sol` | 100.00% (35/35) | 97.92% (47/48) | 85.71% (6/7) | 100.00% (6/6) |
  | `src/FeeRouter.sol` | 100.00% (90/90) | 95.08% (116/122) | 66.67% (12/18) | 100.00% (13/13) |
  | `src/PonsEscrowAdapter.sol` | 100.00% (18/18) | 95.24% (20/21) | 83.33% (5/6) | 100.00% (5/5) |
  | `src/RewardsDistributor.sol` | 100.00% (67/67) | 100.00% (93/93) | 100.00% (23/23) | 100.00% (9/9) |
  | `src/adapters/UniV4SwapAdapter.sol` | 100.00% (24/24) | 100.00% (27/27) | 100.00% (2/2) | 100.00% (4/4) |
  | **`src/` total** | **100.00% (234/234)** | 97.43% (303/311) | 85.71% (48/56) | 100.00% (37/37) |

  `setMaxEpochBudgetBps` was **the only function in the project without a single test** (4 lines
  uncovered, `src/RewardsDistributor.sol:171-174` before the fix). It was covered, not excluded.

- [x] **Uncovered lines are zero; uncovered branches are listed here, not hidden.**
      Eight `revert` sides of conditions remain unexercised. They are **all reachable** by a
      test — it is not dead code, it is simply code not yet tested:

  | Reference | Unexercised branch |
  |---|---|
  | `src/FeeRouter.sol:107` | `withdrawCompute` with an empty bucket |
  | `src/FeeRouter.sol:116` | `withdrawOps` with an empty bucket |
  | `src/FeeRouter.sol:138` | `processSwap` with `swapBalance == 0` |
  | `src/FeeRouter.sol:167` | `setSplits` with `undistributed > 0` (closing the old period) |
  | `src/FeeRouter.sol:197` | `setRewardsDistributor(address(0))` |
  | `src/FeeRouter.sol:204` | `_send` to a recipient that rejects ETH → `TransferFailed` |
  | `src/CallLedger.sol:68` | balance above `MAX_CALLS_PER_EPOCH · TOKENS_PER_CALL` (cap at 50) |
  | `src/PonsEscrowAdapter.sol:53` | router that rejects ETH → `ForwardFailed` |

  The most interesting one for an external reviewer is `FeeRouter.sol:204`: **if one of the three wallets
  were a contract that rejects ETH, its bucket would be stuck** until the timelock
  changes the wallet with `setWallets` (24 hours). It is not a bug — it is a consequence of the design — but
  it is a concrete reason to use EOAs, or contracts with `receive()`, as wallets.

- [x] **Fork test green** — run on 2026-09-20 against `robinhood` (chain id 4663):
      `test_swap_small_amount_on_real_pool` **1 passed, 0 failed** in 4.40 s. The real swap on the
      OpenJEV pool happened and the delivered `amountOut` matches the pool's accounting
      in the same block (gross of the `Swap` event minus the two `HookFeeCollected` legs).
      **This tick has a short expiry.** The test skips itself without `--fork-url` and depends
      on a public node that keeps state for only ~6-7k blocks (~10 minutes at 0.1 s/block):
      a result recorded here goes stale in minutes. **It must be rerun immediately before
      launch**, not taken as good from this document:

  ```bash
  forge test --match-path 'test/fork/*' --fork-url robinhood -vvv
  ```

### Static analysis (Slither)

Slither **0.11.6**, installed in a throwaway venv in the session scratchpad (never in the system
Python), Python 3.11.2:

```bash
slither . --filter-paths "lib/|test/|script/" --exclude-informational
```

**Run on 2026-09-21 on commit `e0d1011`.** This is the version of the code the
results below refer to, and no other. It replaces a first run done
**before** `62e44b8`, the commit that changed `FeeRouter.processSwap` and
`UniV4SwapAdapter.swapExactETHForToken` — that is, exactly the two functions most involved in the
results. If `git log -1` on those two files says something other than `e0d1011`, **this
section has expired**: it must be rerun, not reread.

**17 results: 2 High, 2 Medium, 13 Low, 0 informational** (excluded by the flag).
**None of these is a vulnerability.** Below, for each one, the argument — not the label.

> What changed compared with the previous run (16 results: 2 High, 1 Medium, 13 Low):
>
> - **New**: `unused-return` on `FeeRouter.processSwap` (`:147`), Medium impact. It is the direct
>   effect of `62e44b8` and it is deliberate; the argument is in point 4. **It is not suppressed**: a
>   `grep -rn 'slither-disable' src/` gives no results, neither on this line nor elsewhere.
> - **Changed**: the `reentrancy-balance` on the swap adapter has the same range (`:83-86`)
>   but not the same code underneath. The variable Slither calls "stale" is now `received`
>   (`:85`), and the condition flagged at `:86` is `received < minOut`: it is **not**
>   `amountOut < minOut`, which still exists but is a second check, at `:97`, on a different
>   quantity. Point 2.
> - **Unchanged**, same files and same lines: the `arbitrary-send-eth`, the `unused-return`
>   on the escrow, the six `missing-zero-check`, the `reentrancy-events`, the six `timestamp`.
> - **Gone**: none.
>
> Note against expectations, confirmed again in this run: the `arbitrary-send-eth` does **not**
> fall on `FeeRouter._send` as expected, but on `PonsEscrowAdapter.claim()`.

| Detector | Slither impact | No. | Where |
|---|---|---:|---|
| `arbitrary-send-eth` | High | 1 | `PonsEscrowAdapter.claim()` `:52` |
| `reentrancy-balance` | High | 1 | `UniV4SwapAdapter.swapExactETHForToken()` `:83-86` |
| `unused-return` | Medium | 2 | `PonsEscrowAdapter.claim()` `:49`; `FeeRouter.processSwap()` `:147` |
| `missing-zero-check` | Low | 6 | `CallLedger` `:39,83`; `FeeRouter` `:69,186`; `RewardsDistributor` `:75,157` |
| `reentrancy-events` | Low | 1 | `PonsEscrowAdapter.claim()` `:54` |
| `timestamp` | Low | 6 | `CallLedger` `:56,73`; `RewardsDistributor` `:97,114,134,146` |

1. **`arbitrary-send-eth` on `PonsEscrowAdapter.claim()` (`:52`).** *Acceptable.* `router` is not
   a parameter: it is storage writable **only once** (`:33`, `revert AlreadySet`), by
   `onlyOwner`, and it can be neither zero nor the adapter itself (`:34`). Slither flags it because
   it is not `immutable` — it cannot be, the FeeRouter does not exist yet at launch time, and
   that is exactly the reason the contract exists. After the single `setRouter` the destination is
   as fixed as an `immutable`, and it can be verified on-chain with
   `cast call <ADAPTER> 'router()(address)'`.
2. **`reentrancy-balance` on `UniV4SwapAdapter` (`:83-86`).** *Acceptable.* Slither flags
   `received` (`:85`) as a "stale" balance used in the condition `received < minOut` (`:86`),
   because it derives from a read taken **before** the external call (`before`, `:83`). But the
   second read is taken **after** the `execute` (`:85`): the difference is the whole effect of the
   call, **reentrant calls included**. There is no value a reentrant call could make
   stale, because the effect of the reentrant call is exactly what the delta measures. And it is the only
   correct way to measure the outcome of a swap with a variable-fee token without trusting a figure
   declared by others.
   On the real risk: the adapter **holds nothing between one transaction and the next** and has no
   privileged state to corrupt — no balance, no bucket, no mapping of credits. If
   a malicious hook donated tokens during the `execute`, `received` would be inflated and those
   tokens would be forwarded to the `recipient` (`:92`), which in the production path is the
   `FeeRouter`: an outcome **in favor of** the pool, not against it. In the opposite direction `received` cannot
   overstate what the adapter owns, because it is the delta of its own balance: the
   `safeTransfer` at `:92` is covered by construction, not by trust.
   **Since `62e44b8` there are two local slippage floors, and they do not say the same thing.** `:86` bounds
   what the adapter received from the router; `:97` bounds `amountOut`, which is the delta of the
   **recipient's** balance, measured between `:91` and `:93`. On a plain ERC-20 they coincide and not one
   wei changes; with a token that withholds a share on transfer the second is the one that binds, and it is
   the one that protects the caller. Both sit **on top of** the `amountOutMinimum` passed to the
   router (`:71`).
   *Assumption*: `universalRouter` is `immutable` (`:27`) and the pool's `hooks` is chosen by
   `setPool`, `onlyOwner` (`:39`) — that is, by the timelock. A hostile hook would require an action
   by the owner, which is the 24-hour timelock.
3. **`unused-return` on `escrow.claim()` (`PonsEscrowAdapter:49`).** *Acceptable, and
   deliberate.* The escrow's return value **is not the right quantity**: the adapter forwards
   `address(this).balance` (`:50`), which also includes ETH that arrived passively through the
   `receive()` and that the escrow's return value would not count. The call is in `try/catch` precisely
   because the escrow reverts at zero balance while there may still be ETH to forward (`:45-46`).
   Using the return value **would make the contract worse**.
4. **`unused-return` on `FeeRouter.processSwap()` (`:147`) — new in this run.**
   *Acceptable: here the finding is not the bug, it is the fix.* `processSwap` ignores the value
   returned by `swapExactETHForToken` because that value is a **declaration by the adapter**
   of how much should have arrived, while the two legs that follow (`:153`, `:154`) must fit within
   the FeeRouter's **real** balance: they sum to exactly `out` (`:151-152`). If the declared
   figure exceeded the actual balance by even one wei, the first leg would pass and the second
   would revert on insufficient balance — and `processSwap` would stay broken **forever**, with the
   swap bucket inside and no way out: there is not, and must not be, an arbitrary
   withdrawal function. That is why `out` is the delta of the FeeRouter's own balance, measured between
   `:146` and `:148`: it is covered by construction. Ignoring the return value is not an oversight, it is what
   makes the two legs payable.
   The adapter's return value is not useless — it is in turn checked against `minOut`
   (`UniV4SwapAdapter:97`) — but it is the measurement made by **the adapter**, and the FeeRouter's solvency
   must not depend on the honesty of a contract the owner can replace with
   `setSwapAdapter` (`FeeRouter:191`). *Why argued and not suppressed*: the branch is
   closed and no `.sol` is to be touched; but even if one could, a `slither-disable` would silence the
   detector for the whole line — including calls someone might add tomorrow — while
   this paragraph stays readable by whoever reviews the code.
5. **`missing-zero-check` ×6 (Low).** *Acceptable, and in two cases a documented choice.*
   - `scorer` (`RewardsDistributor:75,157`): zero is **the intended way** to say "no
     scorer". It freezes the publication of new roots without exposing a wei — `msg.sender` cannot
     be `address(0)`, so `setEpochRoot` always reverts. Intended asymmetry, documented
     at `:154-156`, locked in by `test_setScorer_accepts_zero_as_a_freeze`. The **guardian**, which is
     the only valve, does have the zero check (`:76`, `:166`).
   - `keeper` (`FeeRouter:69,186`): same shape. A zero keeper disables `processSwap` and
     exposes nothing.
   - `publisher` (`CallLedger:39,83`): a zero publisher prevents opening questions. `CallLedger`
     holds no funds: the worst case is a stalled ledger.
   In all three cases zero **narrows** powers, it does not widen them, and it is reversible
   by the owner. Not adding the guard is preferable to adding it: it would remove the only way to
   freeze.
6. **`reentrancy-events` on `Forwarded` (`PonsEscrowAdapter:54`).** *Acceptable.* The event is
   emitted after the `call` to the router and in theory can arrive out of order relative to events emitted
   by a reentrant call. No on-chain decision depends on this order, and the consumer
   (off-chain indexing) reads amounts, not sequences. The balance, as argued above, is
   already zero when the reentrant call starts.
7. **`timestamp` ×6 (Low).** *Acceptable.* All the windows involved are **hours or days** —
   6 h, 12 h, 90 days, the question deadlines. The drift a validator can induce on the
   timestamp is seconds: irrelevant at these scales. None of the six comparisons distributes
   value based on a tight threshold.

- [x] **No *real* High or Medium from Slither.** The four High/Medium results — 2 High and
      2 Medium, after the addition of the point 4 `unused-return` — are analyzed above and none
      is an exploitable vulnerability. **The only real finding of this audit is
      [F-01](#f-01--zero-root-accepted-by-setepochroot-medium--fixed), which Slither did not
      find** — and it is a good reminder of the value of static analysis on its own. The reminder
      also works the other way: the bug fixed by `62e44b8`, which would have blocked `processSwap`
      forever, was not flagged by Slither either before or after. The only trace it leaves is
      an `unused-return` that is the remedy, not the defect.

---

## What this audit does NOT cover

**This is the most important section of the document.** Everything ticked above holds
only within these limits. Whoever trusts the checklist without reading this list trusts
something that was not said.

1. **No external review has been done.** This is an internal audit, written by those who
   worked on the code. It does not replace an independent review: it is meant to **give an
   external reviewer a starting point**, not to replace them.
2. **The launch on Pons at T0 has never been run by anyone, not even in simulation.**
   The whole sequence — registering `PonsEscrowAdapter` as the creator fee recipient, the token's
   graduation, the escrow's first credit — is **not tested end-to-end**. The fork test covers
   a swap on an *already existing* pool (OpenJEV), not the launch.
3. **The off-chain engine (Plan 2) is out of scope, and the defense against flash-buys lives there,
   not on-chain.** `CallLedger` records the balance **at the time of the call**
   (`balanceAtCall` in the `CallSubmitted` event, `src/CallLedger.sol:28,78`). Nothing on-chain
   prevents someone from buying tokens, calling and selling back in the same block: the
   **recheck of the balance at the epoch's start block is a requirement of the engine**, not a
   property of the contract. If the engine does not do it, capacity can be bought for one block.
   Likewise, the **correctness of the Merkle root** published by the scorer is entirely
   off-chain: the contract checks that a leaf belongs to the root, **not** that the root is
   right. An engine that gets the scores wrong produces perfectly valid roots.
4. **The creator tax is a parameter chosen at launch and treated as final.** We have not
   verified **any path to change it afterwards**. If it turned out to be modifiable, the whole
   fee sizing would have to be redone. (The Pons factory also applies a
   3-day `CREATOR_FEE_RECIPIENT_TIMELOCK` to change the *recipient* — see
   `script/DeployAdapter.s.sol:20-22` — which makes a wrong adapter very costly to
   correct.)
5. **The Pons v2 and Uniswap v4 contracts have not been audited.** `IPonsFeeEscrow`
   (`src/interfaces/IPonsFeeEscrow.sol`) is an **ABI reconstructed** from Blockscout on 2026-09-20, not
   an interface provided by the project. We assume that `escrow.claim()` pays the caller and that
   the Universal Router behaves as documented. An upstream behavior change is not
   covered by any test here.
6. **The $JEVSAID token is not ours and has not been audited.** It is created by the Pons factory.
   We assume a standard ERC-20 with no fee-on-transfer and no hook on the recipient. The assumption must be
   reverified on the real token before launch: this item only says what happens if it is
   wrong.

   Updated on 2026-09-20 after the final review of the branch. Before, `FeeRouter.processSwap` paid
   burn and rewards on the figure *declared* by the swap adapter: with a fee-on-transfer token the
   second leg would have reverted and `processSwap` would have stayed **stuck forever**, with
   65% of the fees frozen and no recovery path. Now the router uses the **delta of its
   own balance** around the call (`src/FeeRouter.sol`), the two legs sum to that delta
   by construction and a shortfall splits itself in the `burn/(burn+rewards)` ratio; the adapter
   applies `minOut` to what the recipient actually received. With a normal ERC-20 not one
   wei changes. Covered by `test_processSwap_pays_out_what_arrived_with_a_fee_on_transfer_token`.

   **What remains uncovered even after the fix**, and it is why the pre-launch check
   is still needed: (a) `RewardsDistributor` makes the same assumption on `claim` — the
   accounting stays consistent, because `committed` drops by exactly what leaves the contract,
   but the claimant receives **less than their Merkle leaf says**, silently; (b) with a
   fee-on-transfer token `processSwap` now reverts instead of paying below the keeper's
   `minOut` — recoverable with one keeper transaction, without the timelock, but it must be known in advance;
   (c) no test covers a token with a hook on the recipient.
7. **MEV on `processSwap` is not mitigated on-chain.** `minOut` is chosen by the keeper off-chain.
   A compromised keeper, or simply a careless one, can pass a `minOut` that allows
   a sandwich: the contract accepts it. The defense is procedural (random window, `minOut`
   computed at the moment), not structural.
8. **ETH forced into `FeeRouter` stays stuck.** Only `receive()` (`src/FeeRouter.sol:82`)
   increments `undistributed`. ETH that arrives any other way — `SELFDESTRUCT` (which under EIP-6780
   still transfers the balance) or a block reward — **is never accounted for and has no
   exit**: there is no sweep function. It corrupts nothing, but it is unrecoverable dust.
9. **Key generation, custody and rotation are out of scope.** Deployer,
   `TIMELOCK_PROPOSER`, keeper, scorer, guardian: the checklist describes what each
   key **can do**, not how they are stored. The guardian's security model — a hot key that can
   only block — holds only if that key is really separate from the others.
10. **The handover window is not tested on-chain.** The table in
    [Ownership and handover](#ownership-and-handover--the-24-hour-window) is derived from the script,
    not from a real deploy. The fact that three contracts stay with the deployer until the timelock
    calls `acceptOwnership` is **the largest risk window of the whole launch**, and it must be
    verified on-chain, not here.
11. **No formal verification, no extended fuzzing, no invariant testing.** The suite is
    made of unit tests and one integration test. The invariants stated in this document
    (`committed ≤ balanceOf`, "no wei is lost", "the guardian does not move funds") are
    argued and tested on chosen cases, **not proven**.
12. **Gas, gas-limit DoS and behavior under congestion have not been analyzed.** In
    particular `CallLedger.submit` and `openQuestions` iterate over caller-supplied arrays
    (`:57`, `:70`) with no explicit cap on length: the limit is the block gas.

---

## How to reproduce

```bash
cd contracts
forge test --no-match-path 'test/fork/*'                      # what matters: 0 failed
forge coverage --report summary --no-match-path 'test/fork/*' # src/ 100% lines
forge test --match-path 'test/fork/*' --fork-url robinhood    # needs network; see note
slither . --filter-paths "lib/|test/|script/" --exclude-informational
```

Slither is not a project dependency and must not be installed in the system Python. In this
session it was installed in a throwaway venv:

```bash
python3 -m venv "$SCRATCH/slitherenv"
"$SCRATCH/slitherenv/bin/pip" install slither-analyzer
```
