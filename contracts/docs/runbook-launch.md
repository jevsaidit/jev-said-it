# Launch runbook — Jev Said It ($JEV) on Pons v2

Chain: **Robinhood Chain, id 4663**. Testnet: **46630**.
Identity: name **Jev Said It**, ticker **$JEV**, domain **jevsaidit.com**
(defensive **jevsaidit.fun**, **jevsaidit.xyz**), X handle **@jevsaidit** (the engine posts from it, labeled automated; since 22/09 there is no separate X bot account), Telegram bot **@jevsaidit_bot**.

This document is read on launch day, with real money at stake. Every step has:
the exact command, **what to note down** from its output, **what to verify** before moving to the
next one. Irreversible steps are marked **[IRREVERSIBLE]** and say what can no longer be
undone.

**Run it in order.** The numbered steps are sequential: the time in the title is indicative,
the order is not.

Not affiliated with TypeSafe AI.

---

## 0. Constants verified on-chain

Reread with `cast` on 2026-09-20 against `https://rpc.mainnet.chain.robinhood.com` (chain id 4663).
The addresses and the proofs are in [`addresses.md`](./addresses.md): **that is the original,
this is only an operational reminder**.

| What | Value | Read from |
|---|---|---|
| PonsV2LaunchFactory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | `addresses.md` |
| PonsV2FeeEscrow | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` | `factory.feeEscrow()` |
| PonsV2MemeHook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | `factory.memeHook()` |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | `factory.poolManager()` |
| **UniversalRouter** | **`0x8876789976dEcBfCbBbe364623C63652db8C0904`** | see warning below |
| `launchFee` | `500000000000000` wei (0.0005 ETH) | `factory.launchFee()` |
| `maxCreatorTaxBps` | `1000` (10%) | `factory.maxCreatorTaxBps()` |
| `snipeTaxStartBps` | `9900` (99%) | `factory.snipeTaxStartBps()` |
| `snipeTaxSeconds` | `3` | `factory.snipeTaxSeconds()` |
| `hookFeeBps` | `100` (1%) | `hook.hookFeeBps()` |
| `CREATOR_FEE_RECIPIENT_TIMELOCK` | `259200` (3 days) | `factory.CREATOR_FEE_RECIPIENT_TIMELOCK()` |
| `CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW` | `259200` (3 days) | `factory.CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW()` |
| PoolKey | `currency0=0x0` (ETH), `currency1=$JEV`, `fee=0`, `tickSpacing=200`, `hooks=memeHook` | `addresses.md` |

Reread them before launch (30 seconds, and it tells you whether Pons has changed anything):

```bash
export PATH="$HOME/.foundry/bin:$PATH"
export RPC=https://rpc.mainnet.chain.robinhood.com
export FACTORY=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
export MEME_HOOK=0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044
for f in launchFee maxCreatorTaxBps snipeTaxStartBps snipeTaxSeconds; do
  echo "$f = $(cast call $FACTORY "$f()(uint256)" --rpc-url $RPC)"
done
cast call $MEME_HOOK 'hookFeeBps()(uint256)' --rpc-url $RPC
```

If any of these values differs from the table, **stop**: the rest of the
runbook (sizing of `minOut`, cost of the launch) is calibrated on these numbers.

> `snipeTaxStartBps` and `snipeTaxSeconds` stay in the table because they describe the factory, not
> because they concern us as a step: **we buy nothing on the curve** (§1.3). Whoever buys in the
> first 3 seconds pays 99%, and that applies to the public, not to a transaction of ours.

> ### Warning about the UniversalRouter
> `0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af` **must not be used**. It is a UniversalRouter deployed
> on this chain with the Ethereum mainnet immutables: its `poolManager()` has no code on
> 4663 and every `V4_SWAP` reverts. The right address is
> `0x8876789976dEcBfCbBbe364623C63652db8C0904`. Full evidence in `addresses.md`.
> `.env.example` already has the right one: do not replace it by hand.

> ### Warning about red output and source verification
> **On this chain `forge script` prints red lines even when everything is fine, and even without
> `--verify`.** `foundry.toml` has an `[etherscan]` section for `robinhood`, and Blockscout answers
> with a Cloudflare challenge: forge tries to contact it anyway and logs
> `ERROR etherscan: Failed to deserialize response ... "Just a moment..."`. Measured: **six lines
> of error** on a plain `forge script --rpc-url robinhood` simulation **without** `--verify`,
> followed by `SIMULATION COMPLETE`. **It is expected noise. It is not your deploy failing.**
> What matters is the **verdict line** — `SIMULATION COMPLETE`, or
> `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL` — and the printed addresses. Careful: **it is not
> the last line of the output.** After it forge still prints
> `Transactions saved to: …/broadcast/…/run-latest.json` and
> `Sensitive values saved to: …/cache/…/run-latest.json`. The verdict must be searched for, not read at
> the bottom. (The second of those two files contains the private key used: it is under `cache/`, which
> is gitignored, and must not be copied anywhere else.)
>
> **And also: do not use `--verify` together with `--broadcast`.** `forge script` first broadcasts and then
> verifies: if verification fails, the red arrives **on a deploy that succeeded**, and this time
> at the bottom of the output, where it looks like the outcome. The Blockscout API answers `403` behind Cloudflare and
> `foundry.toml` has `key = "none"`, so failure is the expected scenario, not the exception. An operator who reads the red and
> reruns the script deploys a **second** contract: at step 4.1 that would mean two adapters, and
> the one registered on Pons could be the one whose `setRouter` — only one call
> possible — was never made. The only way out is the 3 days of
> `CREATOR_FEE_RECIPIENT_TIMELOCK`, while the fees accrue towards a dead address.
>
> **Rule: a verification error does not mean the deploy failed.** Before rerunning
> anything, read `broadcast/<script>/<chainid>/run-latest.json` and run `cast code` on the
> contract. Verification is done afterwards, as a separate step, and can fail without consequences.

---

## 1. Decisions already made (do not reopen them on launch day)

### 1.1 Creator tax = 0 — and why

The factory allows a per-token creator tax up to `maxCreatorTaxBps = 1000`, i.e. **10% on
every single trade**, collected by the creator. It is the biggest revenue lever available, and we
are leaving it at **zero on purpose**.

**Reason**: it works against the project's stated goal, which is **volume**. A tax on the
trade is a brake on every swap, shows up in aggregators as a "token tax" and puts us in the
same bucket as the extractive launches we want to stand apart from. The fees we need already come
from the hook's protocol leg; volume does the rest.

**With the tax at zero we still collect 0.70% of volume**, and it is a verified fact, not a
hope: the 1% protocol leg is split **70/30 between creator and Pons**, exact to the wei.
Evidence (394 reconciliations, `s = 0.7` in every case, 421 pools out of 428 exact) in
[`addresses.md`](./addresses.md), section "Creator revenue with the creator tax at zero". Zero does not
mean free for us: it means we give up the **second** leg, not the first.

At launch, the creator tax field gets **0**. Not "the minimum": zero.

### 1.2 Direct consequence: how `minOut` is sized

The hook takes its cut in `afterSwap` in **two legs**: the protocol fee `hookFeeBps` (100 bps,
the same for all pools) **plus** the creator tax chosen per token. On live pools the total cut
ranges from 1% to 7% and can reach 11%. Evidence, census and cross-checks in
`addresses.md` — **do not repeat them here, read them there**.

On our token:

```
total haircut = hookFeeBps + creatorTax = 100 bps + 0 bps = 100 bps = 1%
```

**It is 1% only because we chose zero.** It is not a constant of the hook, it is not a property
of Pons, and it differs from almost every other pool.

> **Do not confuse the 1% with the 0.70% of §1.1.** The **1%** is what the pool takes from the swap: it is
> what is missing from the output, and it is **what** `minOut` is sized on. The **0.70%** is
> how much of that 1% comes back to us afterwards, by another route (the Pons escrow) and at another
> time. Discounting `minOut` by 0.70% instead of by 1% makes every `processSwap` revert
> with `Slippage()`.

Operating rules for whoever computes `minOut` for `FeeRouter.processSwap(minOut)`:

1. `minOut` is compared with the **net after the hook's cut**, not with the pool's gross.
   Verified in executable form by `test/fork/UniV4SwapAdapter.fork.t.sol`
   (`amountOut == gross - leg1 - leg2`), and rechecked inside `UniV4SwapAdapter`, which
   reverts with `Slippage()` if what is delivered is below `minOut`.
2. Sizing:
   `minOut = quote_gross * (1 - haircut) * (1 - slippage_tolerance)`
   with `haircut = 0.01` as long as the creator tax stays zero. `slippage_tolerance` is a
   number, not a symbol: the engine's default is **300 bps** (`SWAP_SLIPPAGE_BPS`,
   `engine/src/config.ts`), applied on top of the hook cut it re-reads on-chain every pass.
3. **Where `quote_gross` comes from.** *(The engine does this itself since 21/09: `engine/src/treasury/quote.ts`
   computes the exact in-range output from the pool's `slot0` and `liquidity` — checked against 10,398
   real buys — and re-reads the hook fee and creator tax on-chain every pass. QuoterV4 below is not
   implemented. The rest of this point is kept as the reasoning.)* The $JEV pool does not exist until the token graduates, so
   the quote cannot be precomputed today. In steady state, in order of preference:
   - v4-periphery's `QuoterV4` / `quoteExactInputSingle` on the §0 PoolKey, in `eth_call` at the
     same block the transaction starts from — it is the quote the hook has not yet taxed,
     so it is already the **gross** the formula needs;
   - failing that, the PoolManager's `slot0` for the $JEV PoolId and a price derived from the tick,
     remembering that it ignores the order's price impact;
   - **never** a price taken from an aggregator or from Dexscreener: that one is already net of the hook's
     cut, and applying `(1 - haircut)` to it again discounts twice.
4. **If the creator tax ever changes, `minOut` must be resized.** A keeper that keeps
   discounting 1% after a tax increase makes every `processSwap` revert (and the swap bucket
   stays stuck until someone notices).
5. The real value of our pool is reread from the two legs of the `HookFeeCollected` event of
   a swap on $JEV, or from the word at index 8 of `factory.getLaunchedToken($JEV)`.
   After launch this check is step 4.5.

### 1.3 The team receives no supply: it is paid from the fees

The team **receives no share of the supply**. No reserved allocation, no purchase
on the curve, no vesting — because there is nothing to vest. At launch the team wallets
hold **zero $JEV**, and they keep holding zero.

The compensation is a **recurring share of the trading fees**: `teamBps = 2000`, i.e. **20%
of the ETH** that enters the `FeeRouter`, accumulated in the `teamBalance` bucket and withdrawable **only** by the
`TEAM_WALLET` with `withdrawTeam()` (§6.4). It is earned on volume, not on supply.

The mitigations change sign. No longer "we publish the wallets so you can check how much
we hold", but:

- **we hold no tokens**: there is no share to dump, and there is no moment when the team
  could sell into those who bought;
- **we are paid on volume**: if the token dies, the team earns nothing. The alignment is by
  construction, not by promise;
- **everything is readable on-chain**: `teamBps()` gives the share, `teamBalance()` gives how much has
  accrued, every withdrawal emits `TeamWithdrawn` (topic0 in §6.3). Changing the share requires
  `setSplits` from the timelock, i.e. 24 hours of public notice.

One transparency step remains, and it is the only one: **publish the `TEAM_WALLET` at T-24h** (§4.2),
saying that it is the recipient of the fee bucket and not a wallet that holds supply. At T+15 min it must be
labeled that way on the dashboard (§5.3).

> **How much this changes the launch, and why it is worth saying.** The previous version of
> this procedure included buying 25% of the supply on the curve in the first seconds: full
> exposure to the **99%** snipe tax window (§0), an ETH spending cap to decide
> under pressure, and the most irreversible and most expensive step of the whole document. **It no longer
> exists.** The capital at risk on launch day drops to the `launchFee` (0.0005 ETH) plus the
> gas of the two scripts. The launch is noticeably less fragile than it was a day ago.

---

## 2. Prerequisites (from T-4 days to T-24h)

Tick them all. If one is red, the launch moves — and it moves **before** the public
announcement of date and time, which goes out at T-2 days. After that announcement, postponing costs credibility
that cannot be recovered: that is why the two checks that can say "no" are due at **T-4**
(expected addresses, §2.2) and **T-2** (guardian, §2.3), i.e. before the announcement and not at T-1h.

- [ ] `cd contracts && forge test` green. What matters is **`0 failed`**: on 2026-09-20 the suite
      gave **59 passed, 1 skipped**, on 2026-09-21 after the review fixes **80 passed, 2 skipped**, on
      2026-09-22 **81 passed, 2 skipped, 0 failed**; the total grows as tests are added, so a
      higher number is not a problem — a `failed`, even a single one, stops the launch.
      The skipped one is the fork test, which skips itself without `--fork-url`.
- [ ] `forge test --match-path 'test/fork/*' --fork-url robinhood` green: **2 passed** (FeePipeline + UniV4SwapAdapter). This is
      the only test that exercises the real swap — if it is red, the `processSwap` path is not
      proven and the launch stops.
- [ ] `docs/addresses.md` reread today, with the §0 constants re-verified.
- [ ] Legal opinion received.
- [ ] Domains `jevsaidit.com` / `.fun` / `.xyz` registered and served; X handle `@jevsaidit` active,
      bio with `$JEV`, website `https://www.jevsaidit.com`; `engine/scripts/check-announcer.ts` exits 0.
- [ ] Engine (Plan 2) **running on Railway from T-1h** (§5.0 step 1), with the mainnet `KEEPER_PK`
      loaded and **`SCORER_PK` NOT loaded until §5.0 step 3** (the first root is checked by hand
      first), **and with the `Transfer` indexer ready to start from the launch block** (§5.7).
- [ ] Testnet dress rehearsal completed (§3).
- [ ] Mainnet `.env` filled in from `.env.example` and **never** committed (`.env` and `.env.*` are in
      `.gitignore`).
- [ ] **T-4: expected addresses of the six contracts computed and published, deploy key unused,
      at nonce 0** (§2.2).
- [ ] **T-2: the four guardian conditions are all four true** (§2.3). If one is missing,
      there is no launch.
- [ ] **Verified today which proof of control Dexscreener asks for** (§4.6.4). The mechanism has
      changed several times: it must be looked up, not remembered.
- [ ] The four fields of §2.4 are filled in, or it is written down that they arrive empty and
      who takes on the consequence.
- [ ] Gas also on the four operating keys, or the product stops on its own (review of 21/09):
      `TIMELOCK_PROPOSER` (`setRouter` §4.6.3, `scheduleBatch` §4.7), `KEEPER` (`openQuestions` every
      ~2h, `claim()`, `processSwap`: without it the first epoch never opens), `SCORER` (`setEpochRoot`
      4 times a day), `GUARDIAN` (`voidEpoch`, rare but it must never be the reason it cannot act).
- [ ] ETH on **two different wallets** (§2.1), loaded before T-4:
      - **deploy key**: only the gas of the two scripts (estimate from the dry run: ~0.59M gas phase 1,
        ~8.4M gas phase 2). Nothing else, ever — see the box in §2.2.
      - **launch EOA**: `launchFee` 0.0005 ETH + the gas of the launch transaction.

### 2.1 Who is who in `.env`

| Variable | Who it is | What it can do |
|---|---|---|
| `DEPLOYER_PK` | key that signs the two scripts, **unused and at nonce 0** (§2.2) | **temporary** owner of FeeRouter / RewardsDistributor / CallLedger until the timelock's `acceptOwnership` (§4.7). **Not** of `UniV4SwapAdapter`, which is plain `Ownable`: its handover to the timelock is already effective at the end of `DeployCore` |
| `TIMELOCK_PROPOSER` | team multisig or EOA | owner of the `PonsEscrowAdapter` (the only one that can `setRouter`), sole proposer of the timelock. **Between §4.1 (T-24h) and §4.6.3 this key alone can burn the adapter**: `setRouter` accepts any address with code (`src/PonsEscrowAdapter.sol:37`), once, irreversibly — a wrong or hostile call sends every future creator fee there and the only way out is §9.2. For that day it is a single point of failure with no timelock in front of it: keep it offline and sign nothing with it before §4.6.3 |
| `COMPUTE_WALLET` | compute treasury | withdraws the compute bucket (5%) with `withdrawCompute()` (§6.4) |
| `OPS_WALLET` | ops treasury | withdraws the ops bucket (10%) with `withdrawOps()` (§6.4) |
| `TEAM_WALLET` | team compensation | withdraws the team bucket (20%) with `withdrawTeam()` (§6.4). **Holds no supply** (§1.3) |
| `KEEPER` | engine key | `processSwap(minOut)` on the router, `openQuestions` on the ledger. **It is the same key as the `CallLedger` `publisher`**: `DeployCore` passes `KEEPER` to both roles, so rotating one means rotating the other. They could be separated with `setPublisher`, **but the engine signs both with one `KEEPER_PK` today**: separating them on-chain breaks one of the two jobs until the engine takes two keys. The contract refuses `processSwap(0)` since 21/09 |
| `SCORER` | engine key | `setEpochRoot` on the distributor |
| `GUARDIAN` | key separate from the scorer, held by a designated person | **only** voids an epoch within `CLAIM_DELAY`. It can never move or receive funds (§7). **Empty or `0x0` makes `DeployCore` revert**: the `RewardsDistributor` constructor rejects a zero guardian, and the revert would arrive at T+5 min with the pool already live (§2.3) |

`GUARDIAN` **must not** be the same key as `SCORER`: its only function is to block
an epoch published by a compromised scorer.

> ### The deploy key and the launch EOA are two different wallets
> `DEPLOYER_PK` signs **only** the two scripts (`DeployAdapter` in §4.1, `DeployCore` in §4.6).
> The transaction that launches the token on Pons at T0 (§4.4) goes out from **another** wallet, the **launch
> EOA**, which is not in `.env` because that step is done from the Pons UI.
>
> Today they are already two distinct wallets in practice; from now on it is a **rule**, for two
> independent reasons: (1) a `launchFee` paid by the deploy key would move its nonce between the
> adapter deploy and the core deploy, invalidating the announced addresses (§2.2); (2) the
> Dexscreener profile is claimed with the EOA that launched the token, which therefore must stay
> **available and attended** in the first fifteen minutes and cannot be archived at the end of the
> procedure (§4.6.4).
>
> Note here which wallet it is: launch EOA = ______________________

### 2.2 T-4 days — the contract addresses are computed in advance

The scripts deploy with `new`, i.e. **CREATE**: the address depends **only on deployer and nonce**,
not on the constructor arguments. With an unused deploy key the map is fixed in
advance, and the six addresses are announced **before** they exist — which turns the announcement from a
promise into a commitment anyone can verify.

| nonce | contract | deployed by | when |
|---|---|---|---|
| 0 | `PonsEscrowAdapter` | `DeployAdapter` | T-24h, §4.1 |
| 1 | `TimelockController` | `DeployCore` | T+5 min, §4.6 |
| 2 | `FeeRouter` | `DeployCore` | T+5 min, §4.6 |
| 3 | `RewardsDistributor` | `DeployCore` | T+5 min, §4.6 |
| 4 | `CallLedger` | `DeployCore` | T+5 min, §4.6 |
| 5 | `UniV4SwapAdapter` | `DeployCore` | T+5 min, §4.6 |

Verified on `script/DeployCore.s.sol:94-101`: the five `new` precede **all** the setters, so
nonces 1..5 are consecutive and in this order.

> **Since 22/09 the scripts check the nonce themselves.** `DeployAdapter` refuses to broadcast unless
> `vm.getNonce(deployer) == EXPECTED_NONCE` (env var, default **0**; `script/DeployAdapter.s.sol:36-37`),
> `DeployCore` the same with default **1** (`script/DeployCore.s.sol:81-82`); the revert is
> `NonceMoved(actual, expected)` and it fires in the simulation, before anything is sent. The `cast nonce`
> in §4.1 and §4.6 stays as the human check; the script is the machine check. If you have recomputed the
> map from a different starting nonce, set `EXPECTED_NONCE` accordingly — a script that reverts on a nonce
> you know about is telling you the map you published is not the one it is about to deploy.

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts
export RPC=robinhood
export DEPLOYER=<address of the deploy key>

# MUST print 0: if it is not 0, the map below is false
cast nonce "$DEPLOYER" --rpc-url $RPC
# need() is in the §4 preamble; here the guard is inline because this is a different shell.
# This map gets PUBLISHED: an empty line here becomes a public commitment that says nothing.
for n in 0 1 2 3 4 5; do
  A=$(cast compute-address "$DEPLOYER" --nonce "$n")
  if [ -z "$A" ]; then
    echo "!! nonce $n: computation failed. DO NOT publish the map: retry."
  else
    printf 'nonce %s -> %s\n' "$n" "$A"
  fi
done
```

If `cast nonce` does not print `0`, **publish nothing**: either use a new key, or recompute
the map starting from the real nonce and write down which nonce corresponds to which contract.

> ### The deploy key signs nothing else. Ever.
> Every extra transaction from that key moves the nonce and **invalidates all the
> announced addresses at once** from that nonce onwards — not one, all of them. A **failed** transaction
> counts too: a deploy that reverts still consumes the nonce, so "it went wrong, I'll rerun"
> is exactly the scenario that breaks the announcement.
>
> - No tests, no "I'll send one wei to see if it works", no warm-up `cast send`.
> - **The token launch at T0 is not done from this key** (§2.1): it is the launch EOA, and it is a
>   different wallet.
> - The gas is loaded **before T-4**. A top-up *to* the key does not consume the key's
>   nonce, but that is no reason to leave it dry and have to think about it at T+5 minutes.
> - The §3 dress rehearsal runs on testnet with testnet keys: the nonce is **per chain**, and
>   activity on 46630 does not touch the nonce on 4663. If for any reason the dress rehearsal
>   was done with the mainnet key, that key **is no longer unused** and must be replaced.
>
> **If the nonce moves anyway**: recompute the addresses, **republish them before
> launch** and say why they changed. An announcement corrected in advance is an incident; an
> announcement left standing while the chain says otherwise is what looks like a scam.

After each deploy the runbook compares what was deployed with what was announced and **stops if they diverge**:
§4.1 for the adapter, §4.6.1 for the five core contracts.

### 2.3 T-2 days — the guardian is a launch prerequisite, not a warning

**Why it is arithmetic and not prudence.** `voidEpoch` accepts the guardian **or** the owner, and
works only within `CLAIM_DELAY` = **12 hours** of `setEpochRoot`. But after the §4.7
handover the owner is the `TimelockController` with `minDelay` = **24 hours**. **An operation
scheduled on a 24-hour timelock cannot land inside a 12-hour window** — ever, for
any value, for any urgency. From the §4.7 handover batch onwards — minutes after `DeployCore`, since
22/09 — the guardian is **the only address in the world** that can void an epoch. It is not a second
pair of hands: it is the only pair.

**Why the deadline is T-2.** At T-2 days the social channel publicly announces date and time.
A check that can say "no" must have its outcome **before** that announcement.

Binary outcome, four conditions, all four:

- [ ] **Address fixed**, written here: ______________________
- [ ] **Key held by a named person** — a name, not "the team": ______________________
- [ ] **`GUARDIAN` filled in `.env`** (and therefore included in the §4.6 deploy), **or**
      `setGuardian` already executed. Verified after the deploy with
      `cast call $REWARDS_DISTRIBUTOR 'guardian()(address)' --rpc-url $RPC`.
- [ ] **The person is reachable within the response time declared in §7** (2 hours
      from the alert) during the 12 hours after every `setEpochRoot`, and has a named substitute.

**If a single one is missing, there is no launch.** Not "launch and fix it later": naming or correcting a
guardian after the handover costs 24 hours of timelock, and the first epochs are exactly the ones in which
things go wrong.

The role sits on a **hot key held by a single person, with no multisig**, and it is a reasoned
choice: the guardian can neither move nor receive tokens, the only function it can call is
voiding. The worst a stolen key can do is **block payments**, which is visible
instantly and fixable through the timelock. A multisig, on the contrary, would not make it inside a
12-hour window. The full reasoning is in §7.

### 2.4 Fields declared empty

Four decisions have not been made yet. They stay written here, with the consequence
next to them, because **a declared empty field is honest; a silent one is a lie you
discover at the worst moment.**

| Field | Value | Consequence if it arrives empty at launch |
|---|---|---|
| **Monthly spending cap of the technical reserve** | ____________ | The compute (5%) and ops (10%) buckets have no declared limit: nobody knows at what level of monthly spending the reserve stops holding up, and rebalancing via `setSplits` — 24 hours of timelock, §5.6 — starts late. It is not a launch-day risk: it is a second-month risk. |
| **Guardian** (§2.3) | ____________ | **Blocks the launch.** It is the only one of the four where the empty field is a veto, because of the 24h versus 12h arithmetic of §2.3. |
| **Custody of the `TEAM_WALLET`** (single EOA / multisig, and who) | ____________ | The `TEAM_WALLET` collects **20% of all fees in ETH** and `withdrawTeam()` pays **unconditionally** to whoever is configured. **The asymmetry with the guardian is the point**: a stolen guardian key can only *block* payments (§2.3), a stolen `TEAM_WALLET` key *collects*. The cost of a compromise is the balance already accrued **plus everything that accrues in the 24 hours** `setWallets` takes to pass through the timelock, and **there is no faster path**. A multisig solves it **without touching the contracts**: `withdrawTeam()` only requires `msg.sender == teamWallet`, and a Safe executing a transaction satisfies it. If the field arrives empty, the choice has been made anyway — by omission, in favor of the single EOA |
| **Decoy launch** (yes / no) | ____________ | If no, §4.4 stays **the only step of the runbook never run by anyone**, not even in simulation — §4.4 itself says so. A decoy launch (a throwaway token on the real factory, at the cost of `launchFee` + gas) would turn it into a tested step. If the answer is no, at T0 read twice and confirm once. |

The old ETH spending cap for buying 25% **no longer exists**: it lapses with §1.3, the
team buys nothing.

---

## 3. Testnet (46630) — dress rehearsal

**Constraint verified on 2026-09-20**: the testnet responds (chain id 46630); the Uniswap v4 PoolManager
**and** the good UniversalRouter `0x8876789976dEcBfCbBbe364623C63652db8C0904` are there, at the same
addresses as mainnet, but **PonsV2LaunchFactory and PonsV2FeeEscrow do NOT exist on testnet**
(`cast code` returns `0x`). So on testnet a real token **cannot** be launched on Pons, and
without a factory there is no $JEV pool to try a real swap on. The dress rehearsal uses
the mocks; the swap path is verified only on the mainnet fork (fork test, §2).

> Correction of 2026-09-20: the previous version said the UniversalRouter was also missing on
> testnet, but only the **wrong** address had been checked — the mis-deployed one of §0.
> The operational conclusion does not change (without a factory there is no pool); what changes is the value to put in
> `.env.testnet` at point 3 below. Evidence in [`addresses.md`](./addresses.md).

> **This section is entirely on testnet.** All the commands below use `$RPC`, which in
> this section is `robinhood_testnet` — and **§4 redefines it to `robinhood`**. Therefore:
> **do not** jump to §4.6 / §4.7 for `setRouter` and the `acceptOwnership` calls. If you do, you have
> crossed the `export RPC=robinhood` at the top of §4 and you are talking to mainnet; on
> `setRouter`, which can be called only once, that copy-paste on dress rehearsal day
> burns the production adapter. The testnet versions are steps **3.6** and **3.7**
> of this same section, below.
>
> One-second check, before every `cast send` in this section:
> `echo $RPC` must print `robinhood_testnet`.

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts                          # .env and the RPC aliases live here, not in the root
export RPC=robinhood_testnet          # <<-- in this section, always testnet
```

> `FACTORY` and `MEME_HOOK` are **not** exported here: on testnet the Pons factory does not exist
> (this very section says so) and no §3 command uses them. Keeping mainnet constants in the
> dress rehearsal shell only serves to have them end up, by mistake, inside a test command.

1. `cp .env.example .env.testnet` — **not `.env`** — and fill in `DEPLOYER_PK`, `TIMELOCK_PROPOSER`,
   `COMPUTE_WALLET`, `OPS_WALLET`, `TEAM_WALLET`, `KEEPER`, `SCORER`, `GUARDIAN` with **testnet** keys.
   Then `set -a; . ./.env.testnet; set +a` — `cast` does not read any env file by itself.

   > **Why a separate file.** §3 and §4 used to share one `contracts/.env`, and step 2 below writes the
   > **MockFeeEscrow** into `PONS_FEE_ESCROW`. That value is `immutable` in the adapter
   > (`src/PonsEscrowAdapter.sol:14`), `DeployAdapter` reads it from the environment, and the §4.1 check
   > "`escrow()` must be `0xd3AF…`" comes **after** the nonce-consuming deploy: a stale rehearsal
   > `.env` at T-24h would burn nonce 0 on an adapter wired to a mock, and shift the whole published map.
   > The §4 preamble now also refuses a `PONS_FEE_ESCROW` that is not the mainnet escrow, but the first
   > defense is not having the two sets of values in the same file.
   > `forge script` reads `contracts/.env` on its own **without overriding variables already exported**:
   > with `.env.testnet` sourced, the testnet values win. Check before step 4: `echo $PONS_FEE_ESCROW`
   > must print the mock from step 2, not `0xd3AF…`.
2. Deploy the mocks and put their addresses in `.env.testnet`:
   ```bash
   forge create test/mocks/MockERC20.sol:MockERC20 \
     --rpc-url $RPC --private-key $DEPLOYER_PK --broadcast     # -> JEVSAID_TOKEN
   forge create test/mocks/MockFeeEscrow.sol:MockFeeEscrow \
     --rpc-url $RPC --private-key $DEPLOYER_PK --broadcast     # -> PONS_FEE_ESCROW
   ```
3. For the PoolKey use the mainnet values (`POOL_FEE=0`, `POOL_TICK_SPACING=200`,
   `POOL_HOOKS=0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044`). **Warning, stated so that nobody
   discovers it by accident: on testnet that hook has NO code** — verified,
   `cast code 0xE5e7… --rpc-url $RPC` returns `0x` on chain id 46630. It is fine anyway, because
   `UniV4SwapAdapter.setPool` only **stores** the address and on testnet no swap
   dereferences it; but it must be said, because the §0 warning about the UniversalRouter comes exactly
   from the twin mistake — an address taken as good without `cast code`. And for `UNIVERSAL_ROUTER` use
   **the real address**, `0x8876789976dEcBfCbBbe364623C63652db8C0904`, which exists on testnet: it
   costs nothing and makes the adapter try the same value it will have on mainnet. The swap will not
   be exercised anyway, because on testnet the pool does not exist.
4. Phase 1, and note the adapter in `PONS_ESCROW_ADAPTER` (reload `.env.testnet` after writing it).
   The testnet deploy key must be at nonce 0 too, or the script reverts `NonceMoved` (§2.2): set
   `EXPECTED_NONCE` to the real one, this is the one place where that is fine:
   ```bash
   forge script script/DeployAdapter.s.sol --rpc-url $RPC --broadcast
   ```
5. Phase 2:
   ```bash
   forge script script/DeployCore.s.sol --rpc-url $RPC --broadcast
   ```
   Note `FeeRouter`, `RewardsDistributor`, `CallLedger`, `Timelock`, `UniV4SwapAdapter` and
   `CallLedger.genesis` as in §4.6, and export them with the same block as §4.6.1.
6. **3.6 — `setRouter`, testnet version** (from the testnet `TIMELOCK_PROPOSER`):
   ```bash
   cast send $PONS_ESCROW_ADAPTER 'setRouter(address)' $FEE_ROUTER \
     --rpc-url $RPC --private-key <TESTNET_TIMELOCK_PROPOSER_KEY>
   cast call $PONS_ESCROW_ADAPTER 'router()(address)' --rpc-url $RPC   # = $FEE_ROUTER
   ```
7. **3.7 — the handover batch, testnet version**: exactly the §4.7 box (acceptOwnership x3 +
   `updateDelay(86400)`, delay 0, executed at once), with the testnet `$RPC` and the testnet proposer
   key. Then check `getMinDelay()` = 86400 and the four owners.
8. Simulate a whole epoch:
   ```bash
   cast send $PONS_FEE_ESCROW 'credit(address)' $PONS_ESCROW_ADAPTER --value 0.01ether \
     --rpc-url $RPC --private-key $DEPLOYER_PK
   cast send $PONS_ESCROW_ADAPTER 'claim()'      --rpc-url $RPC --private-key $DEPLOYER_PK
   cast send $FEE_ROUTER          'distribute()' --rpc-url $RPC --private-key $DEPLOYER_PK
   ```
   On the testnet Blockscout `FeesReceived` and `Distributed` must appear. `processSwap` **cannot** be
   exercised on testnet (the pool is missing): the unit tests and the fork test cover it.
9. Run the engine for **3 complete epochs** on testnet against these contracts, then reread
   `callsUsed`, `roots` and the balances: it is the last chance to discover an epoch misalignment
   without paying for it. **Three epochs are 18 hours**, and §2 wants the dress rehearsal done before
   the §4.1 adapter deploy at T-24h: the engine must be running on testnet by **T-2 days at the
   latest**, i.e. before the public announcement, not the evening before the launch.
10. **Also rehearse the guardian procedure** (§7): publish a root, and before the 12h expire
    have the person who will hold the key on mainnet run `voidEpoch`, timing how long it
    takes from when they receive the alert. If it takes more than 12 hours, §7 does not work.

---

## 4. Mainnet (4663) — launch day

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts                          # BEFORE sourcing .env: .env and the RPC aliases live here
export RPC=robinhood                  # <<-- from here on, always mainnet
export FACTORY=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
export MEME_HOOK=0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044
set -a; . ./.env; set +a              # cast does NOT read .env by itself

# need <NAME>: stops your hand when a value has NOT been measured. Rule in the box below.
need() {
  eval "__v=\$$1"
  [ -n "$__v" ] && return 0
  echo "!! PAUSE: \$$1 is empty. The command that was supposed to fill it failed — the error is on"
  echo "!! stderr, not here. It is not a wrong value: it is a MISSING value. Repeat the command."
  return 1
}

# Check right away, not five steps later: an empty variable here becomes an
# incomprehensible error much further on, inside an irreversible step.
for v in RPC FACTORY MEME_HOOK DEPLOYER_PK TIMELOCK_PROPOSER COMPUTE_WALLET OPS_WALLET \
         TEAM_WALLET KEEPER SCORER GUARDIAN PONS_FEE_ESCROW UNIVERSAL_ROUTER \
         POOL_FEE POOL_TICK_SPACING POOL_HOOKS; do
  [ -n "$(eval echo \$$v)" ] || echo "!! EMPTY: $v"
done
echo "RPC=$RPC   (must print 'robinhood')"

# Non-empty is not enough: a rehearsal .env (§3) is non-empty and wrong. These three are
# immutable or one-shot downstream (adapter escrow, swap adapter router, pool hook).
[ "$(echo $PONS_FEE_ESCROW | tr A-F a-f)" = 0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e ] || echo "!! STOP: PONS_FEE_ESCROW is not the mainnet escrow (stale/testnet .env)"
[ "$(echo $UNIVERSAL_ROUTER | tr A-F a-f)" = 0x8876789976decbfcbbbe364623c63652db8c0904 ] || echo "!! STOP: UNIVERSAL_ROUTER wrong"
[ "$(echo $POOL_HOOKS | tr A-F a-f)" = 0xe5e702641ea86f4ae6cc3cdaed2b886f976be044 ] || echo "!! STOP: POOL_HOOKS wrong"

# The deploy key's ADDRESS (not its key): the one published at T-4 (§2.2). Not in .env, so it is
# exported here, once per shell, because §4.1 and §4.6 both compare the chain against it.
export DEPLOYER=<address of the deploy key, as published at T-4>
need DEPLOYER
```

> **`TEAM_WALLET` is in that loop because `DeployCore` reads it.** Since Task 11 the `FeeRouter`
> constructor takes six arguments and one of them is the team wallet: with `TEAM_WALLET` empty the
> preflight would pass, the launch would happen — irreversible — and the phase 2 deploy would revert at
> T+5 minutes **with the pool already live**. It is exactly the failure the comment above
> describes: an empty variable that becomes an incomprehensible error inside an irreversible
> step.

> **`cd contracts` comes first on purpose.** From the repo root `. ./.env` finds
> nothing — `.env` is in `contracts/` — and `--rpc-url robinhood` does not resolve, because the alias is
> defined in `contracts/foundry.toml`. The trouble is that the error **half-corrects itself**:
> as soon as you enter `contracts`, `forge script` reads `.env` on its own and the deploy succeeds,
> while `$TIMELOCK_PROPOSER` in **your** shell has stayed empty — and it ends up like that, empty,
> inside the `--constructor-args` of the verification in §4.1. The loop above is there to see it.

> ### Rule for all of §4: new shell, redo the preamble
> This section spans from T-24h to T+15 min — a day apart. Hours pass between one step and the next: the shell
> closes, the laptop reboots, another person takes over. **Nothing of what is above
> survives.** Every time you open a new shell, before touching any §4 command:
>
> 1. rerun the preamble block above (including `cd contracts` and the `DEPLOYER` export);
> 2. from §4.4 onwards, also re-export `JEVSAID_TOKEN`;
> 3. from §4.6.1 onwards, also re-export the six values printed by `DeployCore`.
>
> That is why §4.6.1 says to also keep them in a notes file outside the repo: they are the only
> copy that survives the shell.
>
> **`LAUNCH_BLOCK` is not in this list on purpose**: no §4 command consumes it. Its
> only consumer is §5.7, i.e. another system at another time. It goes in the notes file
> together with `LAUNCH_TX`, not re-exported in every shell.

> ### Rule: a value that was not measured never goes into an `echo`
> `cast` writes errors to **stderr**. A failed command does not make the line that contains it
> fail: it leaves an **empty value**, and the empty value disguises itself. Inside an `echo` it becomes a space,
> inside a comparison it becomes "different", inside a pipe it prints nothing — and every time
> **it looks like a measurement**, with the same face as a correct one.
>
> So, throughout §4:
>
> 1. every `cast` value that a decision rests on is **assigned to a variable**, never consumed
>    on the fly inside an `echo`, a `printf` or a `--flag $(cast …)`;
> 2. right after, that variable goes through **`need`** (defined in the preamble above);
> 3. if `need` complains, **it is not an outcome**: you did not read a wrong value, you read
>    nothing. Repeat the command; do not interpret the empty value.
>
> Why it is a rule and not a warning: this defect has already been found and closed **three
> times** in this document, on `LAUNCH_BLOCK`, on `$DEPLOYER` and on the nonce, and every time it
> came back in a new form. The rule is greppable — you search for `$(cast` inside an `echo` —
> while "remember to check" is not. **No block in this document uses `set -e`:
> the warnings stop nothing on their own, you have to read them.**

> ### Two command words for all of §4: **STOP** and **PAUSE**
> From here to the end of §4 every outcome that stops your hand is written with one of these two, **in capitals**.
> In ordinary speech they can mean the same thing; here they do not, and the difference is the only thing that matters when you read them.
>
> **STOP** = **you do not continue on your own: the team is convened.** No **STOP** clears itself and
> none gets "fixed later". The exact consequence depends on where you meet it: in §4.5
> it means the core is not deployed and the way out is §9.2.
>
> **PAUSE** = **interruption, not end.** You do the thing written next to it — a single one, stated — and
> then you resume from where you were. Every **PAUSE** carries its verb and the tail "then continue".
>
> The two words never swap meaning: where there is **PAUSE** nobody is convened,
> where there is **STOP** you do not continue.

### 4.1 T-24h — phase 1: adapter deploy

> **New shell?** §4 covers from T-24h to T+15 min: more than one session, by construction.
> Before any command of this step, rerun the **§4 preamble**.

> ### First of all: clear `broadcast/` of the dress rehearsal records
> **Done only once, here.**
> `forge script` writes to `broadcast/<script>/<chainid>/run-latest.json`, and **the folder
> name is the chain id, not the environment**. A dress rehearsal done **by hand** on a local fork
> *pinned to 4663* writes **to the very same files** that the real deploy will then use. The
> official rehearsal, `contracts/scripts/rehearse-launch-fork.sh`, does not: it points
> `FOUNDRY_BROADCAST` at a temp dir (script line 18) and asserts at the end that
> `contracts/broadcast/` is empty (line 155). The check below is for the hand-run case, and it
> costs one command, so it stays.
>
> The risk is not theoretical: the deployer recovery command in §4.6.4 reads exactly that
> file. With a dress rehearsal record still there, it returns the address of the **fake deployer**
> — with the same confident face as a correct one — and that address ends up in the
> `--constructor-args` of the verification. (Actually found in this repo: the records contained
> `0xf39Fd6e5…`, i.e. anvil's default account, under `4663`.)
>
> **Check and clear:**
>
> ```bash
> grep -rho '"from": *"0x[0-9a-fA-F]*"' broadcast/ 2>/dev/null | sort -u
> ```
>
> If it prints anything that is not your deployer — in particular `0xf39fd6e5…`, anvil's
> account 0 — those records are from a rehearsal, not a deploy. Move them out of the repo (not into the repo:
> `contracts/.gitignore` excludes only `31337/` and the `dry-run/` folders, so a record written under
> `4663` **is not ignored** and would end up in a commit):
>
> ```bash
> mkdir -p ~/jevsaid-prove
> mv broadcast/DeployAdapter.s.sol broadcast/DeployCore.s.sol ~/jevsaid-prove/ 2>/dev/null
> # now it must print nothing:
> grep -rho '"from": *"0x[0-9a-fA-F]*"' broadcast/ 2>/dev/null | sort -u
> ```

**First the simulation, without `--broadcast`:**

```bash
forge script script/DeployAdapter.s.sol --rpc-url $RPC
```

The output must contain **`chain id (mainnet = 4663): 4663`** **and**
**`escrow (immutable, cannot be changed after the deploy): 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`**.
If it prints `46630` you still have the dress rehearsal RPC: fix `$RPC` and redo. If the escrow line
shows anything else, you have the §3 rehearsal values in the environment: the adapter would be born
wired to a mock, and `escrow` is `immutable`. These lines are printed **before** the broadcast on
purpose — in the simulation there is nothing to undo, in the real deploy there is. The simulation
also runs the script's own nonce check: a `NonceMoved(actual, expected)` revert here means the deploy
key is not at nonce 0 (§2.2) and nothing has been sent.

**Then the deploy [IRREVERSIBLE]** — without `--verify`, see the §0 warning. Immediately before,
the nonce, measured now and not four days ago (§2.2 checked it at T-4; this is the last moment a
shifted nonce is cheap):

```bash
N=$(cast nonce "$DEPLOYER" --rpc-url $RPC)
need N && [ "$N" = 0 ] || echo "!! STOP: nonce $N, the map published at T-4 is already false — republish (§4.2) before deploying"
```

The script repeats the same check on its own (`EXPECTED_NONCE`, default 0, §2.2) and refuses to
broadcast on any other value; the line above is so that you read it before the script does.

```bash
forge script script/DeployAdapter.s.sol --rpc-url $RPC --broadcast
```

**Note down**: the `PonsEscrowAdapter` address. Put it in `.env` as `PONS_ESCROW_ADAPTER` and
re-export:

```bash
export PONS_ESCROW_ADAPTER=<printed address>
```

**Comparison with the address announced at T-4 (§2.2) — if they diverge: PAUSE AND REPUBLISH:**

```bash
need DEPLOYER   # exported in the §4 preamble
ATTESO=$(cast compute-address "$DEPLOYER" --nonce 0)
if need ATTESO && need PONS_ESCROW_ADAPTER; then
  echo "expected  = $ATTESO"
  echo "deployed  = $PONS_ESCROW_ADAPTER"
fi
```

They must match (the comparison is **case-insensitive**: `cast` prints in checksum form, the
script output may not). If they do not match, the deploy key was not at nonce 0:
**PAUSE AND REPUBLISH, then continue**. It is not the deploy that is wrong — it is the public
announcement that has become wrong, and the five core addresses (§2.2) are wrong too,
because they start from the same shifted nonce. Recompute the map, **republish it before launch**
(procedure in §4.2) saying why, and only then continue.

**Verify before continuing** — if even one of these three is wrong, the adapter must be redone
now, because after launch it cannot be:

```bash
cast call $PONS_ESCROW_ADAPTER 'escrow()(address)' --rpc-url $RPC
# must be 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e
cast call $PONS_ESCROW_ADAPTER 'owner()(address)' --rpc-url $RPC
# must be TIMELOCK_PROPOSER
cast call $PONS_ESCROW_ADAPTER 'router()(address)' --rpc-url $RPC
# must be 0x0000000000000000000000000000000000000000
```

> **A redeploy of the adapter consumes another nonce** and shifts all five core addresses
> by one. If you are forced to redo it, the §2.2 map must be recomputed and republished: it is not a
> communication detail, it is the only thing that makes the announcement verifiable.

`escrow` is `immutable`: if it is wrong the only remedy is to redeploy the adapter **before** the
launch. After launch, changing the creator fee recipient costs the 3 days of
`CREATOR_FEE_RECIPIENT_TIMELOCK` plus an execution window of another 3 days (§9.2).

**Source verification, a separate step with no consequences:**

```bash
ARGS=$(cast abi-encode 'c(address,address)' \
      0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e $TIMELOCK_PROPOSER)
need ARGS && forge verify-contract $PONS_ESCROW_ADAPTER \
  src/PonsEscrowAdapter.sol:PonsEscrowAdapter \
  --chain 4663 --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  --constructor-args "$ARGS"
```

If it fails (a Cloudflare 403 is the expected scenario), **do not rerun the deploy**: the contract is already
there, you just read it with `cast call`. Retry the verification later, or publish the source
by hand from the Blockscout UI.

### 4.2 T-24h — publication

- [ ] Adapter address published on X and on the site, with the sentence: it is the contract that
      collects the creator fees, not a wallet.
- [ ] Publicly confirmed that the deployed adapter **matches the address announced at
      T-4** (§2.2), and that the five core addresses remain the announced ones.
- [ ] **`TEAM_WALLET` published** (§1.3), with the right sentence: it is the recipient of the **team's
      fee bucket**, not a wallet that holds supply.
- [ ] Stated that **the team receives no share of the supply** and is paid with 20% of the
      trading fees (§1.3), and that the creator tax is zero, with the reason (§1.1).

### 4.3 T-1h — standby

- [ ] Engine on standby with the mainnet KEEPER/SCORER keys.
- [ ] Dashboard pointed at the events (topic0 in §6.3).
- [ ] Reread the §0 constants (command at the end of §0).
- [ ] **Guardian**: the four §2.3 conditions are **still** true, and the person holding the
      key answers **now**. This is a reconfirmation, not the check: that one is due at
      T-2 days, and if you are doing it here for the first time you are two days late.
- [ ] Launch EOA (§2.1) available and attended, with `launchFee` + gas on it.
- [ ] Mainnet `.env` complete except `JEVSAID_TOKEN`, which does not exist yet.

### 4.4 T0 — launch on Pons v2 **[IRREVERSIBLE]**

> **New shell?** §4 covers from T-24h to T+15 min: more than one session, by construction.
> Before any command of this step, rerun the **§4 preamble**.

> **Tested on a mainnet fork on 2026-09-21** (`contracts/scripts/rehearse-launch-fork.sh`, §4.5 gate
> green on rows 1, 3, 4, 5, 8, 9). The direct call below is the one that ran; it is the primary path.
> A launch through the Pons UI is equivalent only if it fills the same fields.
>
> ```bash
> SIG='launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)'
> FEE=$(cast call $FACTORY 'launchFee()(uint256)' --rpc-url $RPC | awk '{print $1}')   # cast prints "500000000000000 [5e14]": the suffix is expected
> need FEE && cast send $FACTORY "$SIG" \
>   "(\"Jev Said It\",\"JEV\",\"<image url>\",\"<description>\",(\"\",\"\",\"\",\"\",\"\"),$PONS_ESCROW_ADAPTER,0,false,0x0000000000000000000000000000000000000000000000000000000000000000,$(cast keccak jevsaidit-launch))" \
>   0 0x0000000000000000000000000000000000000000 --value $FEE --rpc-url $RPC --private-key <LAUNCH_EOA_KEY>
> ```
> Fields in order: name, symbol, image, description, five socials, **creator fee recipient = the
> adapter**, **creator tax = 0**, **holder sharing = false**, extra, salt; then initial buy 0 and
> **pair = 0x0 (native ETH)**.

From the **launch EOA** (§2.1) — **not** from the deploy key, which must sign nothing else
(§2.2) — on the factory
`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` (via the Pons UI or a direct call), with:

| Field | Value | Why |
|---|---|---|
| creator fee recipient | **the address of the `PonsEscrowAdapter` from step 4.1** | it is the whole point of the architecture |
| creator tax | **0** | decision §1.1 |
| pair token | **native ETH** | the whole adapter → router → swap adapter chain is in ETH |
| Pons native holder-sharing | **off** | the fees must reach the adapter, then the router splits them |
| launch fee | 0.0005 ETH | `factory.launchFee()` |

**What can no longer be undone**: the creator fee recipient is registered in the token's record.
Changing it requires the factory timelock, **3 days** of waiting plus an execution
window of 3 days (§9.2). Meanwhile the creator fees accrue towards the wrong address.
The creator tax registered at launch must be treated as **final**: we have not verified
any path to lower or raise it afterwards.

**Note down — all three, right away, before anything else:**

```bash
export JEVSAID_TOKEN=<token address from the launch receipt>

# launch block: it is the block the Transfer indexer starts from (§5.7)
export LAUNCH_TX=<launch transaction hash>
export LAUNCH_BLOCK=$(cast tx "$LAUNCH_TX" blockNumber --rpc-url $RPC)

# PAUSE AND REREAD THE HASH if it is empty: see the box below, it is not a courtesy check
if [ -z "$LAUNCH_BLOCK" ]; then
  echo "!! LAUNCH_BLOCK EMPTY — wrong hash or node unreachable. Do not go on with the"
  echo "!! empty variable: reread the hash from the receipt and repeat. Then continue."
else
  echo "token=$JEVSAID_TOKEN  block=$LAUNCH_BLOCK"
fi

# From WHICH key the launch went out, and by which route:
cast tx "$LAUNCH_TX" from --rpc-url $RPC   # must be the launch EOA (§2.1)
cast tx "$LAUNCH_TX" to   --rpc-url $RPC   # = $FACTORY if you launched with a direct call
```

> ### `from` must be the launch EOA. If it is the deploy key: **PAUSE AND REPUBLISH**
> **[costly]** It is the most important check of this step and it costs one command. The three rules
> in §2.1, §2.2 and §8 forbid launching from the deploy key for one reason only: **the
> `launchFee` would move its nonce**, and the six addresses published at T-4 would all become
> wrong — the core would end up at nonces 2..6 instead of 1..5.
>
> If `from` is the deploy key, the damage **is already done and is not reversible**, but it is
> fully recoverable **if you discover it now**: recompute the map from the real nonce
> (`cast nonce`, §2.2) and **republish it before §4.6** saying why it changed. The publication
> procedure — where it is published and with which sentence — is **§4.2**: redo that one, with the
> new addresses. Then in §4.6.1 compare against the new map. If instead you do not discover it now, you
> discover it in §4.6.1 — and on the worst path after the §4.6.3 `setRouter`, which is irreversible.
>
> Note down `from` **and** `to`: they are two rows of the "To note down" table below, and `to` is what
> decides how row 3 of the §4.5 gate is read.

> **Why `LAUNCH_BLOCK` has a guard of its own.** `cast tx` writes errors to *stderr*: with
> a wrong hash the variable stays **empty without it showing**, and the command that uses it does not
> fail — an empty **unquoted** variable simply disappears from the command line and the
> downstream tool applies its own default. The same goes for the indexer: started from the
> wrong block it produces a balance book that is **plausible and incomplete**, not an error. And
> wrong balances from epoch 0 are discovered when someone disputes a reward, not before.
>
> The variables here are quoted, and the guard is on `LAUNCH_BLOCK` because it is the only value of
> this step that another system consumes without being able to check it.

| To note down | Where it is needed |
|---|---|
| `JEVSAID_TOKEN` | §4.5, §4.6, `.env` |
| `LAUNCH_TX` | launch receipt, to keep outside the shell |
| `from` (from `cast tx "$LAUNCH_TX" from`) | §4.4 — proof of which key signed: it is the most important check of this step |
| `to` (from `cast tx "$LAUNCH_TX" to`) | **§4.5, row 3 of the gate** — `to` = `$FACTORY` or not is what distinguishes the two outcomes of row 3 |
| **`LAUNCH_BLOCK`** | **§5.7 — starting block of the `Transfer` indexer** |

> If you did not note it down, recover it from `LAUNCH_TX` with the command above: the token is already
> launched and it is not going anywhere. But **recover it before §5.7**, because from there on every epoch
> relies on that number.

### 4.5 T0+30s — check of the launch record — **GATE: nothing is wired before this**

> **This is a gate, not a courtesy check.** Until it has passed, **the core
> deploy does not start** (§4.6). The reason is that §4.6 writes `JEVSAID_TOKEN` into contracts that
> cannot be corrected: `FeeRouter.token` is `immutable`, the swap adapter's PoolKey is
> set in the same script, and the §4.6.3 `setRouter` is called **only once**. If
> it fails now, what you have spent is the `launchFee`; if it fails after §4.6, you have wired
> a whole core around the wrong token and the only way out is §9.2.

```bash
RECORD=$(cast call $FACTORY 'getLaunchedToken(address)' $JEVSAID_TOKEN --rpc-url $RPC)
if need RECORD; then
  echo "$RECORD" | sed 's/^0x//' | fold -w64 | nl -ba
else
  echo "!! NO WORD READ — this is the THIRD OUTCOME of the gate (below the table)."
  echo "!! The gate has NOT passed and §4.6 does not start. Do not interpret an empty table."
fi
```

Read the words (numbered from 1; the 0-based index is `n-1`). **At least nine numbered rows
must appear**: if none appears, go straight to the third outcome.

> ### Three outcomes. The first two are recognized by the first word, the third by silence
> The two command words are defined in the **§4 preamble** and apply literally here. If
> you got here in a hurry, these lines are enough: **STOP** = you do not continue on your own, the team is
> convened — here it means the core is not deployed and the way out is §9.2. **PAUSE** =
> interruption: you do the thing written next to it, a single one, and then you resume from where you were.
>
> **The third outcome is "the command printed nothing", and it is neither STOP nor PAUSE.** If
> the call fails — node down, `$JEVSAID_TOKEN` or `$FACTORY` empty in this shell — the error
> goes to stderr and the pipeline prints **zero rows**: no table, no value. There is
> nothing to judge, so **nothing is judged**: it is not a missing row 4, it is a read that did not
> happen. Forcing an empty result into STOP or PAUSE is the mistake this box exists to
> prevent, thirty seconds before an irreversible deploy.
>
> Where there is **PAUSE** nobody is convened, where there is **STOP** you do not continue, and where there is
> **nothing** nothing is decided.

| Row | Index | Must be | If it differs |
|---|---|---|---|
| 1 | 0 | `$JEVSAID_TOKEN` | **STOP** |
| **3** | **2** | **who called the factory.** With a direct launch (`to` = `$FACTORY`, §4.4) it is the **launch EOA** (§2.1) | **PAUSE AND CHECK THE NONCE**, if the launch is direct; if it went through a UI, see the box |
| **4** | **3** | the address of the **`PonsEscrowAdapter`** — it is the recipient the escrow actually pays | **STOP** |
| 5 | 4 | `0x0` — zero pair token = **native ETH**. If it is not zero, the token is paired with an ERC-20 and the whole ETH chain is wrong | **STOP** |
| 8 | 7 | `0xc8` = 200 — `tickSpacing`, matches the PoolKey | **STOP** |
| 9 | 8 | **`0x0`** = creator tax **0 bps** | **PAUSE AND RECOMPUTE** `minOut` (§1.2) |

> ### The two words say two different things: **who launched** and **who gets paid**
> Measured on the real launch transactions, not deduced: the word at **index 2 is the factory
> caller**, the word at **index 3 is the creator fee recipient**. Evidence and
> command in [`addresses.md`](./addresses.md), section "Who the escrow actually pays".
>
> **It follows that for us the two words ALWAYS diverge, by construction**, not "sometimes":
> we sign from an EOA and pay to a contract (§4.4). They diverge in 100% of cases, and a
> divergence here is never a reason for alarm.
>
> **But index 2 is not "just any value to note down": it has an expected value, and it is known.**
> On **18 direct launches out of 18** index 2 is exactly the transaction signer. If
> §4.4 says `to` = `$FACTORY`, then index 2 **must** be the §2.1 launch EOA, which has been
> published since T-4. If it is not, the addresses announced at T-4 **may** be skipped: it is the
> **earliest** on-chain signal that something does not add up, available at T0+30 seconds instead of
> after the `setRouter`. But *which* key you signed with is told by `from` (§4.4), not by this word —
> and if `from` was the right EOA, the arbiter is the deploy key's nonce (§2.2): see the matching
> outcome below.
>
> **If instead the launch went through a UI** (`to` different from `$FACTORY`), index 2 can be
> an intermediary contract: over 62 launches of this kind it was the signer in 61 cases and the called
> contract in 1. In that case index 2 **is noted down and nothing is stopped** — the check on the
> key you already did in §4.4 with `cast tx … from`, which holds on any path.
>
> Why this box was rewritten twice: the first version required **both**
> words to equal the adapter, which would have produced a **guaranteed false alarm** at T0+30s —
> token already live, everything correct — while the first epoch is promised at T+10 minutes (§5.1) and the
> Dexscreener window lasts fifteen minutes (§4.6.4). The second went to the opposite extreme,
> "note down anything", throwing away a check with a known value. Neither extreme is
> the right check: **index 3 says whether the fees will arrive, index 2 says which key
> you signed with.**
>
> The definitive proof, when it arrives, remains the first non-zero `claimable()` on the adapter.

**Gate outcome:**

- **the block printed no numbered row** (or printed `!! NO WORD READ`) →
  **it is not an outcome: it is a failed command.** There is nothing to read and nothing to decide.
  Check that `$JEVSAID_TOKEN` and `$FACTORY` are set in **this** shell (§4 wants its
  preamble in every new shell) and that the RPC responds, then **repeat the command**. Until you see
  the numbered rows the gate **has not passed**, so §4.6 does not start: it is not "everything
  looks fine", you simply have not looked;
- **row 4 (index 3) = adapter**, **row 3 (index 2) = launch EOA** if `to` was `$FACTORY`,
  plus rows 1, 5, 8, 9 as in the table → **move on to §4.6**;
- **row 4 different from the adapter** → **STOP — the team is convened**: the creator fees will never
  reach the adapter, and deploying the core now wires it around a token that will not pay it.
  The way out is §9.2;
- row 5 different from `0x0` → **STOP — the team is convened**: the token is paired with an ERC-20 and
  the whole ETH chain does not hold;
- row 9 different from `0x0` → **PAUSE AND RECOMPUTE, then continue**: decide whether the value is
  acceptable and **recompute `minOut`** (§1.2) before the first `processSwap` — not before
  §4.6, which does not use it. The rest of the runbook assumes zero;
- **row 3 (index 2) different from row 4** → **it is not an outcome, it is the normal case**: for us it
  always happens. Note it down and move on;
- **row 3 different from the launch EOA, with `to` = `$FACTORY` in §4.4** → **PAUSE AND CHECK THE
  NONCE, then continue** (and republish **only** if the nonce has moved: see below). It is not
  the token that is compromised: what may be skipped are the
  **six addresses announced at T-4** (§2.2). **Do not conclude "I launched with the wrong
  key" if the §4.4 `from` has already said otherwise**: `cast tx … from` is the direct
  proof of who signed, index 2 the corroboration. **The arbiter is the nonce**:
  `cast nonce "$DEPLOYER" --rpc-url $RPC` (§2.2). If after §4.1 it is still **1**, nothing went out
  from the deploy key, the published map is intact and **there is nothing to
  republish** — note the anomaly and continue. If it is anything else, recompute the map from that nonce,
  republish it with the **§4.2** procedure before §4.6, and compare it in §4.6.1;
- **row 3 different from the launch EOA, with `to` different from `$FACTORY`** → **it is not an outcome**:
  the launch went through a UI and index 2 can be the intermediary. You have already
  verified the key in §4.4.

> **No team capital moves in this step or in the ones after.** The team does not buy
> supply (§1.3): the old version of this runbook had the purchase of 25% on the curve here,
> with the 99% snipe tax window to dodge. If you were expecting it, it is not missing: it was removed.

### 4.6 T+5 min — phase 2: core deploy

> **New shell?** §4 covers from T-24h to T+15 min: more than one session, by construction.
> Before any command of this step, rerun the **§4 preamble**, plus the §4.4 `export`s.

> ### Between phase 1 and phase 2 the deploy key has signed nothing — and this is checked
> The six addresses published at T-4 are CREATE: they depend **only** on deployer and nonce (§2.2).
> Any transaction sent from that key after §4.1 — a transfer of nothing, a test
> `cast send`, a failed attempt — shifts **all five** core addresses by one.
> No test notices: `test/DeployOrder.t.sol` pins the order **inside** the script,
> not the nonce the script starts from. It is the only defense of the whole system that depends only on
> a person not doing something — so here it is measured, instead of recommended.
>
> ```bash
> need DEPLOYER   # exported in the §4 preamble: the address published at T-4
> NONCE_ORA=$(cast nonce "$DEPLOYER" --rpc-url $RPC)
> echo "nonce = $NONCE_ORA   (must be exactly 1: the §4.1 adapter consumed 0)"
> if [ -z "$NONCE_ORA" ]; then
>   echo "!! EMPTY NONCE — node unreachable or command failed, NOT a shifted nonce."
>   echo "!! Do not recompute and do not republish anything: repeat the command. Then continue."
> elif [ "$NONCE_ORA" != "1" ]; then
>   echo "!! NONCE SHIFTED: from here on the map published at T-4 is false."
>   echo "!! PAUSE AND REPUBLISH: recompute from $NONCE_ORA (§2.2), republish (§4.2), then continue."
> fi
> ```
>
> A nonce other than `1` breaks nothing on-chain: the contracts would be born correctly wired anyway.
> What breaks is the announcement — and the only moment when fixing it is cheap is **now**, before the
> §4.6.3 `setRouter` (§4.6.1). Since 22/09 the script does **not** deploy on any nonce but the expected
> one: `DeployCore` reverts `NonceMoved(actual, expected)` unless `vm.getNonce(deployer) ==
> EXPECTED_NONCE` (default 1). To deploy on a shifted nonce after republishing the map, run it with
> `EXPECTED_NONCE=<that nonce>` — deliberately, not by removing the check.

With `JEVSAID_TOKEN` and `PONS_ESCROW_ADAPTER` in `.env` and in the environment.

**First the simulation, without `--broadcast`:**

```bash
forge script script/DeployCore.s.sol --rpc-url $RPC
```

It must print **`chain id (mainnet = 4663): 4663`**, the right token and the right adapter, and
reach `SIMULATION COMPLETE` (the fork rehearsal checks that verdict line only; here read both). Four
reverts are intended and stop the simulation before anything is sent: `AdapterHasNoCode` if the
adapter in `.env` is stale (that address ends up verbatim in the one-shot `setRouter`);
`TokenHasNoCode` / `RouterHasNoCode` if `JEVSAID_TOKEN` or `UNIVERSAL_ROUTER` has no code — both are
`immutable` downstream, a wrong one is a redeploy and the ledger's genesis would move with it;
`NonceMoved(actual, expected)` if the deploy key is not at nonce 1 (box above).

**Then the deploy [IRREVERSIBLE]**, without `--verify`:

```bash
forge script script/DeployCore.s.sol --rpc-url $RPC --broadcast
```

> **If the script stops halfway** (it is twelve transactions: timelock, four contracts, three
> setters, four `transferOwnership`): **do not rerun it**. A second run deploys a second complete
> set and the first stays there, half wired, confusing anyone who reads the chain. Read
> `broadcast/DeployCore.s.sol/4663/run-latest.json` to know which transactions went through, and
> complete the missing setters by hand with `cast send` from the **deployer**, which at this stage is still
> owner of all four contracts. The order in the script — first all the configuration, then
> all the `transferOwnership` — is designed precisely for this: until the first
> `transferOwnership` goes out, every setter is still within the deployer's reach.

**Note down from the output**: `Timelock`, `FeeRouter`, `RewardsDistributor`, `CallLedger`,
`UniV4SwapAdapter` and **`CallLedger.genesis`** — that timestamp is the start of epoch 0, and the
engine must be aligned to it, not to the launch time.

#### 4.6.1 Export the addresses just printed

`cast` **does not read `.env`**, and these five addresses (plus the `genesis`) are not in
`.env.example` because they do not
exist until the script runs. Without this block every command that follows expands to nothing
and fails with a message that has nothing to do with it.

```bash
export TIMELOCK=<Timelock from the output>
export FEE_ROUTER=<FeeRouter from the output>
export REWARDS_DISTRIBUTOR=<RewardsDistributor from the output>
export CALL_LEDGER=<CallLedger from the output>
export UNIV4_SWAP_ADAPTER=<UniV4SwapAdapter from the output>
export CALL_LEDGER_GENESIS=<genesis from the output>

# check: no row may be empty — and `need` says so, instead of leaving it for you to notice
for v in RPC FACTORY PONS_ESCROW_ADAPTER JEVSAID_TOKEN TIMELOCK FEE_ROUTER \
         REWARDS_DISTRIBUTOR CALL_LEDGER UNIV4_SWAP_ADAPTER CALL_LEDGER_GENESIS; do
  printf '%-22s = %s\n' "$v" "$(eval echo \$$v)"
  need "$v"
done
```

Also put them in a notes file outside the repo: if the shell dies, you have lost them.

**Comparison with the addresses announced at T-4 (§2.2) — if even one diverges: PAUSE AND REPUBLISH:**

```bash
export DEPLOYER=<address of the deploy key>
need DEPLOYER
for n in 1 2 3 4 5; do
  ATT=$(cast compute-address "$DEPLOYER" --nonce "$n")
  need ATT && printf 'nonce %s expected: %s\n' "$n" "$ATT"
done
printf 'deployed 1..5:    %s %s %s %s %s\n' \
  "$TIMELOCK" "$FEE_ROUTER" "$REWARDS_DISTRIBUTOR" "$CALL_LEDGER" "$UNIV4_SWAP_ADAPTER"
```

In order: nonce 1 = `TIMELOCK`, 2 = `FEE_ROUTER`, 3 = `REWARDS_DISTRIBUTOR`, 4 = `CALL_LEDGER`,
5 = `UNIV4_SWAP_ADAPTER`. The comparison is **case-insensitive**.

> **If they diverge, the deploy is not wrong: it is the announcement that has become wrong.** The contracts are
> correctly wired to each other and work; what no longer holds is the post published at
> T-4. **PAUSE AND REPUBLISH, before the §4.6.3 `setRouter`**: publish the real addresses
> saying why they changed (almost certainly one transaction too many from the deploy key,
> §2.2), and then continue. There is no technical hurry: the creator fees accumulate
> in the Pons escrow and are not lost until the `setRouter` has been given.

#### 4.6.2 Check of the wiring and of ownership, before the `setRouter`

```bash
cast call $UNIV4_SWAP_ADAPTER 'poolOf(address)((address,address,uint24,int24,address))' \
  $JEVSAID_TOKEN --rpc-url $RPC
# currency0 0x0, currency1 = $JEVSAID_TOKEN, fee 0, tickSpacing 200, hooks = memeHook
cast call $FEE_ROUTER 'swapAdapter()(address)'        --rpc-url $RPC   # = $UNIV4_SWAP_ADAPTER
cast call $FEE_ROUTER 'rewardsDistributor()(address)' --rpc-url $RPC   # = $REWARDS_DISTRIBUTOR
cast call $FEE_ROUTER 'token()(address)'              --rpc-url $RPC   # = $JEVSAID_TOKEN
cast call $FEE_ROUTER 'keeper()(address)'             --rpc-url $RPC   # = $KEEPER
cast call $UNIV4_SWAP_ADAPTER 'universalRouter()(address)' --rpc-url $RPC
# MUST be 0x8876789976dEcBfCbBbe364623C63652db8C0904

# has the ownership handover started? (if not, the §4.7 executeBatch reverts because there is
# no transfer to accept — and the deploy key stays owner until you notice)
for c in $FEE_ROUTER $REWARDS_DISTRIBUTOR $CALL_LEDGER; do
  OWN=$(cast call $c 'owner()(address)'        --rpc-url $RPC)
  PEND=$(cast call $c 'pendingOwner()(address)' --rpc-url $RPC)
  if need OWN && need PEND; then
    echo "$c owner=$OWN pending=$PEND"
  else
    echo "!! $c: read failed. Do NOT conclude that the transferOwnership did not go through: repeat."
  fi
done
# expected: owner = deployer, pending = $TIMELOCK on all three
cast call $UNIV4_SWAP_ADAPTER 'owner()(address)' --rpc-url $RPC
# expected: already $TIMELOCK (plain Ownable, no acceptance required)
```

If a `pendingOwner` is not the timelock, the corresponding `transferOwnership` did not go through:
redo it now from the deployer (`cast send <contract> 'transferOwnership(address)' $TIMELOCK`), which
is still owner, instead of finding out when the §4.7 batch reverts.

> **Only if you have read it.** An **empty** `pending=` is not a wrong `pendingOwner`: it is a
> read that did not happen (rule in the §4 preamble). Redoing a `transferOwnership` on that basis
> means signing one more transaction **from the deploy key** — that is, doing, out of a
> misunderstanding, exactly the thing that §2.2 and §8 forbid and that moves the nonce.

> ### As soon as the three rows are right, **run the §4.7 handover batch right away**
> The command is the box at the top of **§4.7** and can be given **now**: it needs only `$TIMELOCK`
> and the three addresses printed in §4.6.1, and its precondition (`pendingOwner` = timelock) has
> just been verified above. It executes at once (the timelock is born with delay 0) and sets the
> 24-hour delay in the same transaction: until it has gone through, the timelock has no delay, so do
> not leave it for after §4.6.4.

#### 4.6.3 `setRouter` **[IRREVERSIBLE — only once in the contract's life]**

> **Executed order ≠ numbered order, on purpose.** By the time you are here the §4.7 handover batch
> has already gone through (§4.6.2 says to run it there, and the fork rehearsal does 4.7 before 4.6.3).
> The order actually executed is **4.6.2 → 4.7 → 4.6.3 → 4.6.4**; the numbers were not changed
> because too many cross-references (this document, the checklist, `engine/DEPLOY.md`) point at §4.7.
> Check `getMinDelay()` = 86400 before this step; if it is still 0, do §4.7 first.

From the `TIMELOCK_PROPOSER`, which is the adapter's owner:

```bash
cast send $PONS_ESCROW_ADAPTER 'setRouter(address)' $FEE_ROUTER \
  --rpc-url $RPC --private-key <TIMELOCK_PROPOSER_KEY>
```

> `setRouter` takes **a single argument**. It can be called **only once**: a second
> call reverts with `AlreadySet` (selector `0xa741a045`). If you put in the wrong address,
> the creator fees end up there forever and the only remedy is §9.2. **Reread the address twice
> before pressing enter**, and compare it with the one printed by `DeployCore`.

```bash
cast call $PONS_ESCROW_ADAPTER 'router()(address)' --rpc-url $RPC   # = $FEE_ROUTER
```

#### 4.6.4 Source verification and Dexscreener

**Expected failures, no consequences: do not rerun any deploy** (§0).

> **The `--constructor-args` must be rebuilt with the values at deploy time, not with the ones
> of now.** In particular the `owner` passed to the constructor of our four contracts is the
> **deployer**, not the timelock: the handover to the timelock happens afterwards, with `transferOwnership`.
> Using `$TIMELOCK` here makes verification fail with an error that looks like a Blockscout problem
> and is not. `$CALL_LEDGER_GENESIS`, noted in §4.6.1, is also needed: without it, `CallLedger` does not
> verify.

> **The two checks below are in this order on purpose.** The first does not leave this
> machine: the §4.1 adapter is CREATE from nonce 0 of the deploy key, so
> `$DEPLOYER` and the `$PONS_ESCROW_ADAPTER` that the §4 preamble already read from `.env` are enough, and
> `cast compute-address` is arithmetic — it calls nobody. The second says a different and
> equally useful thing, namely whether what we **published** at T-4 and what actually
> happened coincide; but for that you need the announcement at hand. **A check that depends
> on the internet, inside a recovery procedure, is missing exactly when you call on it**: a
> deleted post, a platform down, no connection. That is why the anchoring
> comes first, and the comparison with the announcement stays but is neither the first step nor the only one.

```bash
# The deployer's address, NOT its key: it is the one published at T-4 (§2.2), exported in the §4
# preamble, and the source is the announcement, not the repo.
need DEPLOYER

# 1) ANCHORING — depends on nothing outside this machine, so it comes first.
#    Nonce 0 of this key MUST give the §4.1 adapter: if it does not, the key is a different one.
ATTESO0=$(cast compute-address "$DEPLOYER" --nonce 0 | grep -o '0x[0-9a-fA-F]\{40\}')
X=$(echo "$ATTESO0"             | tr 'A-Z' 'a-z')
Y=$(echo "$PONS_ESCROW_ADAPTER" | tr 'A-Z' 'a-z')
if [ -z "$ATTESO0" ] || [ "$X" != "$Y" ]; then
  echo "!! STOP — nonce 0 of $DEPLOYER gives $ATTESO0, but the §4.1 adapter is $PONS_ESCROW_ADAPTER"
  echo "!! This key did not produce the published map. Do NOT verify ANYTHING with this"
  echo "!! address and convene the team: a page verified with the wrong owner says something false."
else
  echo "anchoring ok: nonce 0 of $DEPLOYER is the §4.1 adapter"
fi

# 2) Comparison with the broadcast record, for whoever has lost the deployer. That file is written by
#    ANY run of the script on chain 4663, dress rehearsal on a local fork included
#    (§4.1): on its own it proves nothing, and indeed here the announcement is the arbiter.
REC=broadcast/DeployCore.s.sol/4663/run-latest.json
DEP_REC=$(grep -o '"from": *"0x[0-9a-fA-F]*"' "$REC" 2>/dev/null | head -1 |
          grep -o '0x[0-9a-fA-F]*')
A=$(echo "$DEPLOYER" | tr 'A-Z' 'a-z')
B=$(echo "$DEP_REC"  | tr 'A-Z' 'a-z')
if [ -z "$DEP_REC" ]; then
  echo "!! record missing or unreadable: take the deployer ONLY from the T-4 announcement."
elif [ "$A" != "$B" ]; then
  echo "!! THEY DIVERGE: announced=$DEPLOYER  record=$DEP_REC"
  echo "!! The record is from another run (dress rehearsal, §4.1). Do NOT use it here: verifying"
  echo "!! with the wrong owner publishes a page that says something false about who controls the core."
else
  echo "deployer confirmed from both sides: $DEPLOYER"
fi
Z=0x0000000000000000000000000000000000000000
BS=https://robinhoodchain.blockscout.com/api

# ARGS is reassigned in every block: if `cast abi-encode` fails it stays empty, and `need` stops
# that verify instead of sending it with the wrong arguments (rule in the §4 preamble).
ARGS=$(cast abi-encode 'c(uint256,address[],address[],address)' \
      0 "[$TIMELOCK_PROPOSER]" "[$Z]" $Z)          # 0 = minDelay AT BIRTH, not 86400: see below
need ARGS && forge verify-contract $TIMELOCK \
  lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController \
  --chain 4663 --verifier blockscout --verifier-url $BS --constructor-args "$ARGS"

ARGS=$(cast abi-encode 'c(address,address,address,address,address,address)' \
      $JEVSAID_TOKEN $DEPLOYER $COMPUTE_WALLET $OPS_WALLET $TEAM_WALLET $KEEPER)
need ARGS && forge verify-contract $FEE_ROUTER src/FeeRouter.sol:FeeRouter \
  --chain 4663 --verifier blockscout --verifier-url $BS --constructor-args "$ARGS"

# 5 arguments since 21/09: the last one is the genesis, the SAME value as the CallLedger's (§4.6.1)
ARGS=$(cast abi-encode 'c(address,address,address,address,uint256)' \
      $JEVSAID_TOKEN $DEPLOYER $SCORER $GUARDIAN $CALL_LEDGER_GENESIS)
need ARGS && forge verify-contract $REWARDS_DISTRIBUTOR \
  src/RewardsDistributor.sol:RewardsDistributor \
  --chain 4663 --verifier blockscout --verifier-url $BS --constructor-args "$ARGS"

ARGS=$(cast abi-encode 'c(address,address,address,uint256)' \
      $JEVSAID_TOKEN $DEPLOYER $KEEPER $CALL_LEDGER_GENESIS)
need ARGS && forge verify-contract $CALL_LEDGER src/CallLedger.sol:CallLedger \
  --chain 4663 --verifier blockscout --verifier-url $BS --constructor-args "$ARGS"

ARGS=$(cast abi-encode 'c(address,address)' $UNIVERSAL_ROUTER $DEPLOYER)
need ARGS && forge verify-contract $UNIV4_SWAP_ADAPTER \
  src/adapters/UniV4SwapAdapter.sol:UniV4SwapAdapter \
  --chain 4663 --verifier blockscout --verifier-url $BS --constructor-args "$ARGS"
```

> **Here the empty value is particularly treacherous**: §0 and the box above have just
> told you that verification failures on this chain are **normal**. A `verify` that fails
> because `$DEPLOYER` was empty looks the same as one that fails on the Cloudflare 403,
> and the box gets ticked anyway. That is why the arguments go through `need` **before**
> starting: that way the empty-variable failure is the only one of the two that announces itself.

> **The flags are repeated on every line on purpose.** Collecting them in a variable
> (`V="--chain 4663 --verifier blockscout ..."` and then `$V`) works in bash but **not in zsh**,
> which is the default shell on macOS: zsh does not word-split unquoted expansions, and
> passes the whole string as **a single argument**. The command dies with
> `error: unexpected argument '--chain 4663 --verifier ...' found` **before touching the network** —
> and here that is worse than a broken command, because §0 has just told you that verification failures
> on this chain are normal: the right answer and the wrong one look alike, you tick the
> box and never verify anything.

`0` is the timelock's `minDelay` **at birth** (`script/DeployCore.s.sol:94`, since 22/09): §4.7
raises it to 86400 afterwards with `updateDelay`, but the constructor argument — and therefore the
bytecode the verifier compares against — carries the birth value. Encoding `86400` here fails on a
bytecode mismatch that looks exactly like the usual Cloudflare 403. The executors are `[address(0)]`
(anyone) and the admin is `address(0)` (nobody) — the same values `DeployCore` passes to the constructor.

> **The `FeeRouter` constructor takes six addresses, not five**, and the order is
> `token, owner, computeWallet, opsWallet, teamWallet, keeper` — `teamWallet` comes **after**
> `opsWallet` and **before** `keeper`. Read from `src/FeeRouter.sol:65-72` and confirmed by the call in
> `script/DeployCore.s.sol:97`, which is the one that actually deployed the contract.
>
> **Do not guess the order if the command fails.** An encoding with the wrong order — or with
> five arguments — does not produce an honest error: in the worst case it produces a **verified
> source whose arguments do not match the deployed bytecode**, i.e. a public page
> that says something false about who collects. If the command does not pass, reread the constructor in the source:
> it is the only source of truth.

**Claiming the Dexscreener profile** (site, X, docs) must be done **now**, in the first fifteen
minutes, and needs care because two rules of this runbook seem to contradict each other:

- the creator fee recipient is the `PonsEscrowAdapter`, which is a **contract**: it has no
  key, it cannot sign, it cannot give proof of control. **It is not the adapter that claims the
  profile.**
- the claimant is the **launch EOA** (§2.1), i.e. the wallet that sent the launch
  transaction at T0. It must be **available and attended** in this window, not archived at the end of the
  procedure.
- the §4.7 rule — "the deployer key stays offline and signs nothing else" — concerns
  `DEPLOYER_PK`, which is a **different wallet** (§2.1). The two rules do not contradict each other: they are about
  two keys.

> **Which proof Dexscreener asks for today must be checked, not remembered.** The mechanism has changed
> several times: it can be an off-chain signature, a transaction from the token deployer's wallet,
> or a form with manual review. §2 puts this check among the prerequisites precisely for this reason:
> it is looked up **before** the launch, so that at T+5 minutes you execute instead of discovering. The
> prudent behavior — keeping the launch EOA available and attended in the first fifteen
> minutes — is right **whatever** the mechanism, so it applies regardless.

### 4.7 T+5 min — the handover batch (since 22/09: minutes, not 24 hours)

> **Changed on 22/09/2026.** The timelock is now born with **delay 0** (`DeployCore`), and the
> proposer runs **one** batch right after §4.6.2, which takes ownership of the three contracts AND
> sets the delay to 24 hours. The window in which the deploy key owns everything shrinks from 24
> hours to the minutes between `DeployCore` and this batch, and the fees can be switched on at once
> (§5.0 step 4), so the first epochs are paid. From the batch on, every change waits 24 hours as before.
> **Until `getMinDelay()` reads 86400 the timelock has no delay at all**: run it immediately.
>
> ```bash
> Z=0x0000000000000000000000000000000000000000000000000000000000000000
> UPD=$(cast calldata 'updateDelay(uint256)' 86400)
> T="[$FEE_ROUTER,$REWARDS_DISTRIBUTOR,$CALL_LEDGER,$TIMELOCK]"
> D="[0x79ba5097,0x79ba5097,0x79ba5097,$UPD]"          # acceptOwnership() x3, updateDelay(24h)
> cast send $TIMELOCK 'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)' \
>   "$T" "[0,0,0,0]" "$D" $Z $Z 0 --rpc-url $RPC --private-key <TIMELOCK_PROPOSER_KEY>
> cast send $TIMELOCK 'executeBatch(address[],uint256[],bytes[],bytes32,bytes32)' \
>   "$T" "[0,0,0,0]" "$D" $Z $Z --rpc-url $RPC --private-key <ANY_KEY_WITH_GAS>
> MD=$(cast call $TIMELOCK 'getMinDelay()(uint256)' --rpc-url $RPC)
> need MD && echo "minDelay = $MD   (MUST be 86400)"
> ```
> Then the owner check at the end of this section (all four = `$TIMELOCK`). Rehearsed on the mainnet
> fork (`contracts/scripts/rehearse-launch-fork.sh`), including that a later `schedule` under 24h reverts
> (since 22/09 the rehearsal's negative checks have three outcomes — went through / reverted / **not
> measured** — so a dead RPC can no longer pass as a revert), and pinned by
> `test/DeployOrder.t.sol::test_handover_batch_takes_ownership_and_sets_24h`.
> **The rest of this section describes the old 24-hour window**: it now applies only to the minutes
> before the batch, and its emergency rules still hold in those minutes.
>
> **One key is outside the timelock for a whole day, and it is not the deploy key.** From the §4.1
> adapter deploy (T-24h) until §4.6.3, the `TIMELOCK_PROPOSER` alone — as the adapter's owner — can
> call the one-shot `setRouter` towards **any** contract with code (`src/PonsEscrowAdapter.sol:32-40`):
> irreversible, and every future creator fee would go there (§9.2). No batch, no delay, no second
> signer stands in front of it, and the rehearsal cannot exercise this because there is nothing to
> assert. Keep that key offline from §4.1 to §4.6.3, and sign nothing with it before the batch above.

Until the `acceptOwnership`, **`DEPLOYER_PK` is owner** of FeeRouter, RewardsDistributor and
CallLedger, and can change their splits, wallets, keeper and scorer **with no wait at all**.

> **How long the window really lasts.** It runs from the end of `DeployCore` to the **`executeBatch`**
> in the box above — **minutes**, if the batch is run where §4.6.2 says, as soon as the three
> `pendingOwner` values are right. (Until 22/09 the title of this section read "T+5 min → T+24h" and
> the 24 hours started from a `scheduleBatch`; a batch scheduled after §4.6.4 meant 24 hours **plus**
> the Dexscreener claim and five `forge verify-contract` calls. That arithmetic is gone: the timelock is
> born with delay 0 and the batch is scheduled and executed in the same minute.) What is left of the old
> window is the time you spend between the two scripts and the box above — do not spend it on §4.6.4.

**What the key can do in this window, in full** — you need this clear before the
cases below, because two of these items are not obvious:

| Contract | With a single transaction | Effect |
|---|---|---|
| `FeeRouter` | `setWallets(x,x,x)` then `withdrawCompute/Ops/Team` | **all three buckets**, in two transactions |
| `FeeRouter` | `setSwapAdapter(<their contract>)` | the swap bucket leaves at the first `processSwap` |
| `FeeRouter` | `setSplits(...)`, `setRewardsDistributor(...)`, `setKeeper(...)` | diverts **future** fees |
| `RewardsDistributor` | `setMaxEpochBudgetBps(10000)` + `setScorer(<theirs>)` + `setGuardian(<theirs>)`, then a root over the whole pool | **Old window; today moot.** With a 24-hour window, 100% of the pool was claimable after `CLAIM_DELAY` = **12 hours**, inside the window and with the guardian valve disarmed. In a window of minutes no root can be set at all: `setEpochRoot` reverts `EpochNotEnded` (`src/RewardsDistributor.sol:105`) until genesis + 6h, and the distributor holds 0 tokens until the first `processSwap` anyway |
| `CallLedger` | `setPublisher` | no funds |

The `RewardsDistributor` row was the surprising one when the window lasted a day: **12 hours fit
inside 24**, so the timelock did not arrive in time even if you noticed right away, and `voidEpoch`
did not help because the attacker had already made itself guardian. The row is kept because the
reasoning explains two rules that still stand: the distributor is not funded before the batch (the
only thing that fills the pool is the `FeeRouter`'s `processSwap`, apart from someone sending tokens
to that address on their own initiative — see §6.1), and the batch is run **immediately**, not after
§4.6.4. The setters that would divert **future** fees (`setSwapAdapter`, `setRewardsDistributor`,
`setKeeper`, `setWallets`, `setSplits`) are the live part of this table, and §4.6.2 reads all of
them back before the batch.

These are two different things, and they must be kept apart:

- **Ordinary use: forbidden.** No routine changes, no "while I'm at it". The key stays
  offline and signs nothing else. Every touch in this window is a change without the 24 hours of
  public notice that the timelock exists to guarantee.
  **This rule applies to `DEPLOYER_PK`, not to the launch EOA** (§2.1), which instead must
  stay available and attended for the Dexscreener profile claim (§4.6.4). They are two
  different wallets and they have two opposite rules: confusing them gets the wrong one archived.
- **Emergency use: it is your only fast lever, and it expires at the `executeBatch`.** If the §4.6.2 checks
  reveal wrong wiring — `setSwapAdapter`, `setRewardsDistributor` or `setKeeper` on a
  wrong address — **it is corrected now from the deployer**, in one transaction. After
  the `acceptOwnership` the same correction costs 24 hours of timelock, during which the swap
  bucket stays stuck or the wrong keeper can act. Pulling the lever is right **only** to
  put a value back on the track this runbook expects, never to change policy.
- **If you suspect the deployer key is compromised in this window**: do not wait, and **do not
  assume any bucket is safe**. In this window the attacker **is the owner**, and the owner can
  reassign the wallets. In this order:

  1. **First of all the wallets collect, right away, before any other move.**
     `COMPUTE_WALLET`, `OPS_WALLET` and `TEAM_WALLET` call their own `withdraw*()` (§6.4): one
     transaction each, from **their** keys, without the deploy key and without the timelock. It is
     the only move that saves that money, and it secures everything accrued up to that block.
     **Why it is urgent**: `setWallets(x,x,x)` followed by the three withdrawals empties the three buckets in
     **two transactions**, and the attacker is owner now. A previous version of this runbook
     said here that the three buckets "are not at risk". That is true **in steady state** — after the handover
     `setWallets` goes through the 24 hours of the timelock — and it is **false inside this window**, which is
     exactly when this paragraph is read. The monthly cadence recommended
     in §6.4 **does not apply here** either: here you withdraw now.
  2. **No `processSwap` until the `executeBatch` has gone through.** It protects two things at once: the
     swap bucket, which would leave towards a replaced `swapAdapter`, and **the rewards pool**, which
     stays at zero balance until some `processSwap` fills it (table above). This line
     **overrides §6.1**, which under normal conditions pushes for an early first `processSwap`.
  3. **Warn the guardian (§7), knowing that in this window its valve is not guaranteed**:
     `setGuardian` is an owner move, so the compromised key can replace it. The
     guardian remains useful — the attacker has to remember to do it — but it is not a defense to
     build the plan on. That is point 2.
  4. **From the `TIMELOCK_PROPOSER`, a single `scheduleBatch` with the `acceptOwnership` first**, and the
     corrections (`setKeeper`, `setSwapAdapter`, `setWallets` to the right values) **after, in the
     same array**. Not two separate batches: `setKeeper` and `setSwapAdapter` are `onlyOwner`, and
     until the `acceptOwnership` is executed the owner is still the deployer, so a batch
     executed as an emergency measure first **reverts entirely** with `OwnableUnauthorizedAccount` and
     costs another 24 hours — in the scenario where 24 hours are exactly what you do not have. Putting them in a
     single batch, the order is enforced by the timelock, not by whoever happens to call `executeBatch`.

`UniV4SwapAdapter` is plain `Ownable`: its `transferOwnership` is **already effective** at the
end of `DeployCore`, it requires no acceptance — and therefore it is **not** correctable by the deployer.

The acceptances are no longer scheduled here with a 24-hour delay: they are the handover batch in
the box at the top of this section, executed at once together with `updateDelay(86400)`.

**Final check** — after this, **[IRREVERSIBLE]**: every parameter goes through the 24 hours.

```bash
for c in $FEE_ROUTER $REWARDS_DISTRIBUTOR $CALL_LEDGER $UNIV4_SWAP_ADAPTER; do
  OWN=$(cast call $c 'owner()(address)' --rpc-url $RPC)
  if need OWN; then
    echo "$c owner=$OWN"
  else
    echo "!! $c: read failed. Do NOT conclude that the owner is not the timelock: repeat."
  fi
done
# all four must equal $TIMELOCK
```

---

## 5. Product start

### 5.0 The engine goes live on Railway — order matters (review of 21/09)

The engine is not started at T0: it is **already running** from T-1h, and each variable is added
when the thing it points to exists. Railway: project `natural-nurturing`, engine service
(`engine/DEPLOY.md`). **The mainnet Postgres is a fresh, empty one**, never the database of the §3
rehearsal: the engine refuses a database that belongs to another ledger and would crash-loop.

1. **T-1h, index warm-up.** `TOKEN` = placeholder (any graduated Pons token), `LAUNCH_BLOCK` and
   `V4_START_BLOCK` = head − 1,700,000, `MODEL=none`, no `CALL_LEDGER`. The PoolManager index needs
   25-40 minutes to reach the head: started at T0 it would make the first epoch late.
2. **T+5, after DeployCore (§4.6).** Set `TOKEN=$JEVSAID_TOKEN`, `LAUNCH_BLOCK` (§4.4),
   `CALL_LEDGER`, `KEEPER_PK`, **`LEDGER_START_BLOCK` = the block of the Timelock transaction** — the
   first of the twelve, read from `broadcast/DeployCore.s.sol/4663/run-latest.json` (the twelve span
   several 0.1-second blocks; the `CallLedger` is the fourth, so its own block would also work, only
   because no question can exist before `CALL_LEDGER` is set — take the first and do not reason about
   it), `TYPESAFE_API_KEY` **before** `MODEL=jev` (`MODEL=jev` without the key throws at boot),
   `JEV_MODEL`. The Transfer cursor is per token, so switching `TOKEN` is clean.
   The engine reads the genesis from the contract: `$CALL_LEDGER_GENESIS` is for your notes and for
   the §4.6.4 verification, not an engine variable.
   Prerequisite: **one real call to TypeSafe checked by hand** before T0 (`engine/README.md`).
3. **Rewards: first root by hand — at the end of epoch 1, not of epoch 0.** Leave
   `REWARDS_DISTRIBUTOR`, `SCORER_PK`, `LEDGER_START_BLOCK` and `EXCLUDE` unset on Railway at first.
   `close-epoch 0` answers `WAIT` until **every question of epoch 0 is resolved**, i.e. deadline +
   horizon (6h): the earliest useful moment is the end of epoch 1, about **T+12h**. Then, in YOUR
   shell (not on Railway), `cd engine` and export **all ten** variables the command loads at start —
   missing any one of them exits 2 with `missing environment variable`:
   `DATABASE_URL`, `RPC_URL`, `TOKEN`, `LAUNCH_BLOCK` (base config), `CALL_LEDGER`, `KEEPER_PK`
   (ledger config), `REWARDS_DISTRIBUTOR`, `SCORER_PK`, `LEDGER_START_BLOCK`, `EXCLUDE` (rewards
   config). Two of them are not what they look like:
   - `KEEPER_PK`: `close-epoch` without `--publish` **never signs with it** — any 32-byte hex
     satisfies the loader. Do not export the real keeper key into a laptop shell for a dry run.
   - `DATABASE_URL`: the Railway **public** URL (TCP proxy), not `postgres.railway.internal`, which
     resolves only inside Railway.
   Run `node --import tsx src/cli/main.ts close-epoch 0` (it computes, it does not publish
   **on-chain**), read the `PAYABLE` payload, and only then set the four rewards variables on Railway
   (step 3b). Two things the words "dry run" hide:
   - **it writes to the production database.** `close-epoch` runs `indexCalls` into the shared
     `calls` table and stores the verdict in the shared `epochs` table: a `NOT_PAYABLE` stored by your
     hand run is **final for the service**, which skips `PUBLISHED`/`NOT_PAYABLE` epochs
     (`engine/src/server/service.ts:110-117`). Consistent with step 4 — an epoch that closes with an
     empty distributor is `NOT_PAYABLE` for good — but it is the hand run that makes it final;
   - **every hour you are late is an hour of permanent lag.** The contract wants ≥ 6h between two
     roots (`EpochTooSoon`, `src/RewardsDistributor.sol:108`) and epochs last 6h, so the cadence can
     never catch up: root(0) landing at T+13h instead of T+12h delays root(1), root(2)… and each of
     their 12h claim openings by that hour, for good. Only a `NOT_PAYABLE` epoch (no root, no spacing
     consumed) absorbs lag. The engine waits, it does not burn gas.
   It is `PAYABLE` only if a buyback has already funded the distributor (step 4); with an empty
   distributor it stores `NOT_PAYABLE` ("distributor has no free balance") and epoch 0 is unpaid,
   which is acceptable and expected if fees were thin.
   `EXCLUDE`: the canonical list is in `engine/DEPLOY.md` — operatively the team EOAs and
   `TEAM_WALLET` (only an address that can call `submit` can ever be a beneficiary; the contracts,
   the PoolManager and the curve are harmless padding). The engine drops excluded callers before
   scoring and refuses the root if one still appears among the beneficiaries.
   **Then the four rewards variables go on Railway in ONE change, before the end of epoch 2.**
   `REWARDS_DISTRIBUTOR` alone crash-loops the service: with it set, boot loads the rewards config,
   which requires `SCORER_PK`, `LEDGER_START_BLOCK` and `EXCLUDE` — a missing one throws, exit 2,
   Railway `ON_FAILURE` restarts up to 10 times (`engine/railway.json`). Config is read once at boot;
   Railway redeploys on any variable change; no re-index (cursors and `epochs` persist in Postgres,
   `assertSingleLedger` passes because the ledger is unchanged). The service then publishes root(0)
   itself from the stored `PAYABLE` payload.
4. **Fees: right after the §4.7 handover batch AND the §4.6.3 `setRouter`** (minutes after
   DeployCore, not 24h). Set `FEE_ROUTER` and `PONS_ESCROW_ADAPTER` only when **both** are true:
   `getMinDelay()` reads 86400 with the three owners = timelock (§4.7 — before that the deploy key
   could still redirect the router), **and** `router()` on the adapter = `$FEE_ROUTER` (§4.6.3 —
   before that `claim()` reverts `NotSet`, `src/PonsEscrowAdapter.sol:51`, and the treasury task
   fails every cycle: blind, not destructive, but it is noise you would then have to tell apart from
   a real fault). Then set them: the first buyback funds the distributor and the first epochs are paid
   (an epoch that closes with an empty distributor is stored NOT_PAYABLE for good).
5. **Site.** `NEXT_PUBLIC_TOKEN_ADDRESS` is build-time: set it on the site service and redeploy at
   T0+. `ENGINE_FEED_URL` = the engine's private domain on Railway.
6. **Announcer.** Nothing posts until `ANNOUNCE_MODE` is set (default `off`). At T-1h set
   `ANNOUNCE_MODE=test` with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_TEST_CHAT_ID` (every post, both
   channels' versions, goes to that one private chat), plus `PUBLIC_SITE_URL=https://www.jevsaidit.com`
   and the four X credentials `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` —
   **all four or none**: half of them is a boot error, none of them means X posts are recorded as
   `unconfigured` and never sent later. Switch to `ANNOUNCE_MODE=live` (with `TELEGRAM_CHANNEL_ID`,
   the bot admin of the channel) only **after the first epoch is visible on the feed**, so the first
   public post describes something that exists. The X day is capped (`X_DAILY_CAP`, default 6) and 2
   slots are reserved for the epoch verdict and 1 for the buyback, so a batch opening cannot exhaust
   the cap before the verdict. Variables table in `engine/DEPLOY.md`.

- **5.1 — T+10 min or so**: the engine opens the first epoch (`openQuestions` from the `KEEPER`) on
  its own once `CALL_LEDGER` and `MODEL` are set and the index is at the head.
- **5.2**: first verdict published. The public wording is "shortly after launch", not a minute count:
  the engine opens a batch only when its data is fresh, and it says so on `/health`.
- **5.3 — T+15 min**: `TEAM_WALLET` **labeled** on the dashboard for what it is — recipient
  of the team's fee bucket — and next to it the team's share of supply: **zero** (§1.3). The number to
  publish is `teamBps` = 2000 on the fees, not a percentage of supply.
- **5.4 — before the first `setEpochRoot`**: `TEAM_WALLET` and the team's personal wallets
  **excluded** from rewards and rebates in the engine configuration. Check it on the first root before
  publishing it: if one of those addresses appears among the beneficiaries, the root is not published.
  With the §1.3 model this check is **stronger** than before, not weaker: the
  `TEAM_WALLET` holds no tokens, so it cannot legitimately appear in any root, and if
  it appears it is a symptom — see point 3 of §7.
- **5.5 — first `processSwap`: sent by the engine, not by hand.** See §6.1. Since `FEE_ROUTER` is
  set (step 4) the treasury task sends one `processSwap` per epoch, at a secret time inside the
  epoch, only if the bucket is ≥ 0.005 ETH, with `minOut` from the pool's own state. It is still the
  very first time `minOut` is computed on the $JEV pool, which did not exist until yesterday:
  read the first `SwapProcessed` against the quote on `/treasury` (§6.1 point 3).
- **5.6 — first 72 hours**: **the splits are not changed.** If the data says they must change, they
  change on day 4, via the timelock, with 24h of public notice.
- **5.7 — from the launch block, continuously**: the `Transfer` indexer. See below: it is
  a requirement, not an optimization.

### 5.7 Balances are rebuilt from events, not from an archive node

The engine's requirement is **not** "an archive RPC is needed". It is:

> **the engine indexes the $JEV `Transfer` events from the launch block (`LAUNCH_BLOCK`,
> §4.4) and derives per-block balances from them, keeping its own book.**

The balance check at the start of an epoch thus becomes a read of a local table, not a
call to historical state.

**Why the wording changes, measured on this RPC on 2026-09-20:**

| What is asked of the node | How far back it answers |
|---|---|
| historical **state** (`cast call` at a past block) | −6,000 blocks ok, −7,000 **fails**: about **10 minutes** |
| historical **logs** (`eth_getLogs`) | served at least as far as **−5,000,000 blocks**, about **6 days** |

Logs are not pruned the way state is. So any defense that can be built **from events** does not
need an archive, and a holder's balance at any block is exactly reconstructible
from the `Transfer` events (topic0 in §6.3). An archive endpoint remains a **recovery path** for outages
longer than the log window, not a dependency of normal operation.

**Behavior on failure — written beforehand, not decided afterwards.** If the indexer stays
down and the log window passes, those epochs **cannot be reconstructed**:

1. an approximate root is not published;
2. the epochs that cannot be reconstructed are **voided** with `voidEpoch` within the 12-hour window (§7),
   or their root is simply not published;
3. the budget returns to the free balance. **The winners of the voided epoch are not paid later**: the engine does not rescore a voided epoch, and its number cannot be published again (`RootExists`). The budget goes to the following epochs' winners. Decided on 22/09: simpler, and nothing to exploit.

**When in doubt nobody is paid, rather than paying wrongly.** A wrong root that has been claimed does not come
back; a postponed round of rewards can be recovered — **only while no later root has been
published**: epochs are strictly increasing (`EpochNotIncreasing`, `src/RewardsDistributor.sol:107`),
so once root(N+1) is on-chain, root(N) can never be set. The engine guarantees the order by blocking
on the earliest epoch that is neither published nor declared `NOT_PAYABLE`
(`engine/src/server/service.ts:110-117`); a root published by hand out of order would not.

---

## 6. Per-epoch operations (steady state)

| Action | Who | Command |
|---|---|---|
| collect the creator fees | anyone — **done by the engine** (treasury task, once `FEE_ROUTER` is set) | `cast send $PONS_ESCROW_ADAPTER 'claim()'` — manual only with `FEE_ROUTER` unset |
| split into the buckets | anyone — **done by the engine** (`processSwap` calls `distribute()` first) | `cast send $FEE_ROUTER 'distribute()'` — manual only with `FEE_ROUTER` unset |
| buyback + burn + rewards | **`KEEPER` only** — **done by the engine**: one per epoch, at a secret time in [start+1h, end−1h], only if the bucket ≥ `MIN_SWAP_WEI` = 0.005 ETH, `minOut` = pool quote − hook cut − 300 bps | `cast send $FEE_ROUTER 'processSwap(uint256)' <minOut>` — manual only with `FEE_ROUTER` unset; a hand-sent one is invisible to the engine (its next pass finds a small bucket → `SWAP_SKIPPED`, harmless) |
| publish the root | **`SCORER` only** — done by the engine (rewards task) | `setEpochRoot(epoch, root, budget)` |
| void a suspicious epoch | **`GUARDIAN`** or timelock | `voidEpoch(epoch)`, within `CLAIM_DELAY` = 12h (§7) |
| withdraw the compute bucket | **`COMPUTE_WALLET` only** | `cast send $FEE_ROUTER 'withdrawCompute()'` (§6.4) |
| withdraw the ops bucket | **`OPS_WALLET` only** | `cast send $FEE_ROUTER 'withdrawOps()'` (§6.4) |
| withdraw the team bucket | **`TEAM_WALLET` only** | `cast send $FEE_ROUTER 'withdrawTeam()'` (§6.4) |
| **free an epoch's unclaimed budget** | **anyone** | `cast send $REWARDS_DISTRIBUTOR 'sweepExpired(uint256)' <EPOCH>`, **90 days after** its root (`CLAIM_WINDOW`) |

> ### `sweepExpired` is not optional: it is maintenance, and without it the system chokes
> An epoch's budget stays **committed** (`committed`) until it is claimed, voided or
> swept. In an airdrop part of the rewards is **never** claimed: without `sweepExpired`
> that part stays committed **forever**.
>
> The consequence accumulates by itself. The free balance is `balanceOf - committed`, and the cap of
> every epoch is a percentage **of the free balance** (`maxEpochBudgetBps`, 2000 bps). So every
> epoch can reward **less than the previous one**, epoch after epoch, while the tokens are in there
> and visible. It is not an edge case: it is the normal path, and nobody notices in the first
> month.
>
> Ninety days after every `setEpochRoot`, therefore, `sweepExpired(<epoch>)` is called on
> that epoch. **The call is open to anyone**: none of our keys is needed, all it needs is
> for someone to remember it — put it in the operations calendar together with the epoch, not in
> somebody's memory.
>
> The number to watch, once a month:
>
> ```bash
> # need() is in the §4 preamble; here the guard is inline because this is a different shell
> COMMITTED=$(cast call $REWARDS_DISTRIBUTOR 'committed()(uint256)' --rpc-url $RPC)
> SALDO=$(cast call $JEVSAID_TOKEN 'balanceOf(address)(uint256)' $REWARDS_DISTRIBUTOR \
>   --rpc-url $RPC)
> if [ -z "$COMMITTED" ] || [ -z "$SALDO" ]; then
>   echo "!! read failed: repeat, it is not a zero balance"
> else
>   echo "committed = $COMMITTED   balance = $SALDO   (free = balance - committed)"
> fi
> ```
>
> If `committed` rises and never falls, there are epochs to sweep: and every epoch not swept is
> a piece of cap lost for all future ones.

Before every `processSwap` (and after every `claim()` — see the note):

```bash
cast call $PONS_ESCROW_ADAPTER 'claimable()(uint256)' --rpc-url $RPC
cast call $FEE_ROUTER 'swapBalance()(uint256)'        --rpc-url $RPC
```

> **`claim()` swallows every escrow revert, not only "zero balance"** (`try escrow.claim() {} catch {}`,
> `src/PonsEscrowAdapter.sol:52`). A paused escrow, or one whose recipient was changed on the factory,
> looks identical to "nothing owed": the call succeeds and forwards 0. The only way to tell them apart
> is `claimable()` **before and after**: if it was non-zero before and is still non-zero after, the
> escrow did not pay and the reason is upstream, not in our contracts. The engine's treasury task does
> this comparison; whoever calls `claim()` by hand must do it too.

`processSwap` must be sent in a **random block inside the window**, so as not to be
front-runnable, and `minOut` is computed as in §1.2 — the engine does both (`engine/src/treasury/`:
time = hash(secret, epoch) mapped into the epoch minus 1h at each end; `minOut` from `slot0` and
`liquidity`, minus the hook cut read on-chain, minus `SWAP_SLIPPAGE_BPS` = 300). **The burn is
irreversible**: the burn share goes to `0x…dEaD` in the same transaction (skipped only when the burn
share rounds to 0).

### 6.1 The first `processSwap` is kept small — but not before the §4.7 `executeBatch`

> ### Which of the two rules wins, and why
> This section says "early"; §4.7 says "not before the `acceptOwnership` is **executed**".
> Until the handover batch has gone through — minutes, since 22/09 — the two contradict each other,
> and **§4.7 wins**. In practice the conflict has dissolved: `FEE_ROUTER` is set on the engine only
> after the batch (§5.0 step 4), and the engine is what sends `processSwap`.
>
> It is not a matter of generic prudence; they are two risks of different size. The §6.1 risk
> is getting `minOut` wrong on a bucket that at that point is worth little: if you get it wrong, `processSwap`
> reverts with `Slippage()` and **you have lost nothing**, the bucket is intact and you retry. The
> §4.7 risk is that the deploy key, which in that window is still owner of everything, diverts the
> swap bucket with `setSwapAdapter` **and** drains 100% of the rewards pool in 12 hours: irreversible,
> and with no lever that arrives in time.
>
> The `processSwap` is also **the only thing that puts tokens into the `RewardsDistributor`**. Not running it
> means keeping that contract at a balance of **zero** for the whole window: the defense costs nothing and
> asks nobody to keep watch.
>
> The cost was that, with a 24-hour window, the first `processSwap` would have been one of 24 hours
> of fees instead of a few hours. With the batch in minutes the cost is gone: the first bucket is
> whatever accrues before the engine's first swap time.

`processSwap` consumes the **whole** `swapBalance` in one go: there is no parameter to spend
only part of it. "Small" is therefore not a decision any more: **the engine decides when**, and its
rule is one swap per epoch, at a time derived from a secret and the epoch number (unpredictable
outside, stable across restarts), only if the bucket is at least `MIN_SWAP_WEI` = **0.005 ETH**
(below it: `SWAP_SKIPPED`, carried to the next epoch), with `minOut` = in-range quote from `slot0`
and `liquidity` − hook cut (re-read on-chain) − **300 bps** (`SWAP_SLIPPAGE_BPS`). The old "early and
small" rule below is kept for the case where `FEE_ROUTER` is unset and someone runs it by hand:

1. Do not wait for fees to accumulate for days before the first attempt. As soon as
   `swapBalance()` is non-zero and worth an amount you would be comfortable losing entirely,
   run that one.
2. Compute `minOut` as in §1.2 and send it.
3. Read the `SwapProcessed` event (topic0 in the table below) and compare `tokenOut` with the quote
   used (the engine's is on `/treasury`): the difference is the real estimation error on this pool,
   and from there on the slippage tolerance is calibrated on a measured number, not on a guess.
4. Only after a `processSwap` has succeeded, let the bucket grow at the normal
   pace.

If the first one reverts with `Slippage()`, you have lost nothing: the bucket is intact, `minOut`
was wrong. Recompute it and repeat — the engine records it as `SWAP_REVERTED` and retries in the
next epoch.

### 6.2 How the fees are really split

Two separate splits, and confusing them gets the burn rate wrong on the dashboard.

**On incoming ETH** (`distribute()`, bps out of 10,000): compute **500** (5%), ops **1000** (10%),
team **2000** (20%), and the rest — **6500**, i.e. 65% — into the swap bucket. The sum of the five bps
(`500 + 1000 + 2000 + 1500 + 5000`) is `10_000`, and it is an invariant that `setSplits` checks.

> The swap bucket is derived by **subtraction** (`amount - toCompute - toOps - toTeam`), not by
> multiplication: that is how the rounding remainder ends up there instead of vanishing. It is not
> a cosmetic detail — on an amount no bps divides exactly, the nominal version
> loses wei on every `distribute()`.

**On the tokens bought** (`processSwap`, `src/FeeRouter.sol:155`): the burn is `burnBps / (burnBps +
rewardsBps)` = `1500 / 6500` ≈ **23.08%** of the tokens, the rest ≈ **76.92%** to the RewardsDistributor.
Those percentages are **within the swap bucket**, not on the fee total.

Brought back to the total, the plan's numbers return: `65% × 23.08% = 15%` burned and
`65% × 76.92% = 50%` to rewards. A dashboard that shows "15% burn" on the fee total is right;
one that shows "15% burn" on the tokens bought is off by a third.

The new split moves **only** compute and ops (they were 1500 and 2000) and introduces the team: burn and
rewards do not change by a single bps, so the swap bucket stays 6500 and all the arithmetic of the
paragraph above is the same as before.

Verified by the tests, not by a rehearsal: `test/Integration.t.sol` asserts, on 10 ETH distributed,
compute `0.5` / ops `1.0` / team `2.0` / swap `6.5` ETH. On 1 ETH they are `0.05` / `0.10` / `0.20` /
`0.65`.

### 6.3 Topic0 for the dashboard

| Event | topic0 |
|---|---|
| `Forwarded(uint256)` (adapter) | `0x6d6c62c4853ee2ccc569c1d81b83de5d128716d2ebfb6f0c1dedade7323c67eb` |
| `FeesReceived(address,uint256)` | `0x2ccfc58c2cef4ee590b5f16be0548cc54afc12e1c66a67b362b7d640fd16bb2d` |
| `Distributed(uint256,uint256,uint256,uint256,uint256)` | `0xb73f574d3938a4a6a7f1b40567d099c03e92300e3124649e8285baaef0cc00c2` |
| `SwapProcessed(uint256,uint256,uint256,uint256)` | `0x79dd72a5507049036244cf4dcb3032c6dca4572927ba3634cdc5ad30350cc3b2` |
| `EpochRootSet(uint256,bytes32,uint256)` | `0xb1e84f0e16ad503c316d64a7caf01a922416ce7b735d499cdd9134489483c85b` |
| `TeamWithdrawn(address,uint256)` | `0x54d3fa92c6e03b3a6fb65169846a53ff33eb81ee22c1585cc3c66e587758d993` |
| `SplitsSet(uint16,uint16,uint16,uint16,uint16)` | `0xf8d3abbe973accac9f8bc1488b4b2e3e88070e56493fcfdc411930b89a49dc4a` |
| `WalletsSet(address,address,address)` | `0xb8ccc1ed0a6227eb93cf90b2b0005aa020bb991388d0be83ae37257fd10798fb` |
| `Transfer(address,address,uint256)` (ERC-20, for §5.7) | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |

> **`Distributed` has changed signature.** Since Task 11 it has **five** parameters
> (`amount, toCompute, toOps, toTeam, toSwap`), and therefore a different topic0. The old value
> `0xf7576d8c…` corresponded to the four-parameter version and **will never be emitted by this
> deploy**: a dashboard filtering on it would show no events, silently and without
> errors. If you have a filter saved from before, replace it.
>
> They can be recomputed at any time, and it is worth doing after every change to the contract:
> `cast keccak 'Distributed(uint256,uint256,uint256,uint256,uint256)'`. The nine values above
> were derived that way from the declarations in `src/`.

### 6.4 Withdrawing the buckets: who, when, with which command

The three ETH buckets do not leave by themselves. Each one is withdrawn **only from its own wallet** — not
from the owner, not from the timelock, not from the deployer: `withdrawTeam()` called by anyone else
reverts with `NotAuthorized`, and the destination is not a parameter, so it cannot be influenced by
the caller.

| Bucket | Share | Who holds the key | Command | Event |
|---|---|---|---|---|
| compute | 5% | `COMPUTE_WALLET` (compute treasury) | `cast send $FEE_ROUTER 'withdrawCompute()' --rpc-url $RPC --private-key <COMPUTE_WALLET_KEY>` | `ComputeWithdrawn` |
| ops | 10% | `OPS_WALLET` (ops treasury) | `cast send $FEE_ROUTER 'withdrawOps()' --rpc-url $RPC --private-key <OPS_WALLET_KEY>` | `OpsWithdrawn` |
| **team** | **20%** | **`TEAM_WALLET`** — who holds the key, and in what form, is the declared field of **§2.4**: ______________________ | `cast send $FEE_ROUTER 'withdrawTeam()' --rpc-url $RPC --private-key <TEAM_WALLET_KEY>` | `TeamWithdrawn` (topic0 in §6.3) |

**When to withdraw.** There is no technical deadline: the balance stays in the contract until
it is called, and **in steady state** it is not at risk — the only possible exit is towards the
configured wallet, and changing it (`setWallets`) costs the 24 hours of the timelock. The recommended cadence is
**monthly, and not before the first successful `processSwap`** (§6.1), so that the first month of
operations does not have a withdrawal in the middle muddling the reading of the balances.

> **"In steady state" means after the handover, and it has two exceptions in which you withdraw right away.**
> `setWallets` is `onlyOwner`: the 24-hour wait exists only when the owner is the timelock.
> - **In the §4.7 window** (from the deploy to the `executeBatch`) the owner is still the deploy
>   key: whoever has that key reassigns the three wallets and withdraws, in two transactions. If you suspect
>   it is compromised, §4.7 says to **withdraw first**, before any other move.
> - **If it is a wallet's key that is compromised** (§2.4): there it is the thief who can
>   withdraw, and `setWallets` takes 24 hours to take the address away from them. Withdrawing right away reduces the
>   accrued amount they can take.
>
> In both cases the monthly cadence above does not apply: it is advice for accounting order
> in normal times, not a security rule.

**Before withdrawing, look at how much there is:**

```bash
cast call $FEE_ROUTER 'computeBalance()(uint256)' --rpc-url $RPC
cast call $FEE_ROUTER 'opsBalance()(uint256)'     --rpc-url $RPC
cast call $FEE_ROUTER 'teamBalance()(uint256)'    --rpc-url $RPC
```

A bucket at zero makes the withdrawal revert with `NothingToDo`: that is the expected behavior, not an
encoding error. And if `teamBalance()` is zero while fees are arriving, the right suspicion
is that nobody has called `distribute()` — which is open to anyone (§6).

---

## 7. Guardian procedure

The `GUARDIAN` can do **one thing only**: `voidEpoch(epoch)`, which freezes the not-yet-claimed
budget of an epoch and prevents every future claim on that epoch. It cannot move funds, it cannot
receive tokens, it cannot unlock anything. It is a brake, not a steering wheel.

**The window is `CLAIM_DELAY` = 12 hours from `setEpochRoot`.** After that, `voidEpoch` reverts
with `VoidWindowClosed` (selector `0x1ece2d80`) and the claims are open. Epochs last 6 hours: that means that every day there
are four twelve-hour windows, overlapping. **A guardian who does not watch is not a defense.**

> ### Why it is the only actor, and why it sits on a hot key
> `voidEpoch` accepts the guardian **or** the owner. But after §4.7 the owner is the
> `TimelockController` with `minDelay` = **24 hours**, and **an operation scheduled on a 24-hour
> timelock cannot land inside a 12-hour window**: arithmetic, not prudence. From the §4.7 handover
> batch onwards — minutes after `DeployCore`, since 22/09 — the owner path is dead for voiding, and
> the guardian is the only address that can void an epoch — forever. (Before the batch the deployer
> is still owner and could do it right away, but no root can exist yet — `EpochNotEnded` until
> genesis + 6h — so that window is not one to build into plans.)
>
> Two things follow from this that seem contradictory and are not:
>
> - **the appointment is a binding launch prerequisite** (§2.3), not a field to fill in at
>   leisure;
> - **the key is hot, held by a single person, with no multisig.** The guardian can neither
>   move nor receive tokens: the only function it can call is voiding. The worst a
>   stolen key can do is **block payments** — visible instantly, and fixable by the
>   timelock with `setGuardian`. A multisig would protect against a harm that does not exist, at the price of
>   never making it inside twelve hours.

| What | Answer — fixed at T-2 days (§2.3), reconfirmed at T-1h (§4.3) |
|---|---|
| Who holds the key | ____________________ (a named person, not "the team") |
| Substitute if unreachable | ____________________ |
| How they are alerted | automatic alert on every `EpochRootSet` (topic0 in §6.3) to a channel that **rings** at night: push or SMS, not an email. The alert must be tested **before** launch, at night, on the real person |
| How fast they must respond | **2 hours** from the alert, i.e. one sixth of the window |
| Who checks that the alert still works | ____________________ , at what cadence: ____________ |

**What triggers a `voidEpoch`** — any single one of these is enough:

1. The epoch's `budget` is out of scale compared with the previous ones (the contract already caps it at
   `maxEpochBudgetBps` = 2000 bps of the free balance, but the cap is a ceiling, not normality).
2. The root does not match the one the engine computed: the engine must recompute it
   independently and compare. A divergence = `SCORER` key compromised until proven
   otherwise.
3. A **team wallet** appears among the beneficiaries (they must be excluded, §5.4), or an address
   on the exclusion list.
4. The `setEpochRoot` comes from an IP / a machine that is not the engine's, or outside the
   expected cadence.
5. **The epoch cannot be reconstructed** because the `Transfer` indexer (§5.7) has a gap over
   that window: the balances the root relies on cannot be verified, so the root cannot be
   verified.
6. Serious doubt that cannot be resolved within the window. **When in doubt, void**: a voided epoch
   costs one round of rewards: the budget returns to the free balance and funds the following
   epochs; that epoch's winners are not paid (§5.7 list, point 3). A fraudulent root that has been claimed does not come back.

```bash
cast send $REWARDS_DISTRIBUTOR 'voidEpoch(uint256)' <EPOCH> \
  --rpc-url $RPC --private-key <GUARDIAN_KEY>
```

The timelock can also call `voidEpoch`, but with a 24-hour delay: **on a 12-hour window
it is useless**. That is why the guardian key is the only defense that arrives in time.

**If the window passes unattended**: the claims open and there is no command that
stops them. From that moment the only lever is the timelock on `setScorer` (24h) to prevent the
*next* epoch, plus `setMaxEpochBudgetBps` to reduce future damage. The budget already claimed is
lost, and it **does not come back** even with a late `voidEpoch`: `voidEpoch` freezes what has not yet been
claimed, it does not recall what has left.

The `maxEpochBudgetBps` = 2000 cap limits the damage of **one** epoch to 20% of the free balance: it is the
reason why a single missed window is not a catastrophe. It is not a reason to miss
two in a row.

If this scenario is acceptable, then the guardian is not needed and §2.3 must be changed
accordingly — **but it must be decided, not suffered**, and decided at T-2 days, when there is still the
option to postpone without contradicting a public announcement.

---

## 8. What not to do

- **Do not** use `--verify` together with `--broadcast` (§0), and **do not** rerun a deploy because of a
  verification error.
- **Do not** set a creator tax other than zero (§1.1) — and if someone changes it, resize
  `minOut` before the next `processSwap`.
- **Do not** enable Pons native holder-sharing: the fees must reach the adapter.
- **Do not** change the splits in the first 72 hours.
- **Do not** deploy the core (§4.6) before the §4.5 gate has passed.
- **Do not** stop the launch because the word at **index 2** differs from index 3 (§4.5): for
  us it **always** happens, because we sign from an EOA and pay to a contract. The comparison that
  matters for index 2 is with the **launch EOA**, not with index 3.
- **Do not** trust `broadcast/…/4663/run-latest.json` if you have not cleared the folder of the dress
  rehearsal records (§4.1): it would contain a rehearsal's deployer.
- **Do not** sign **anything** with the deploy key other than the two scripts: every extra transaction,
  even a failed one, moves the nonce and invalidates all the announced addresses (§2.2).
- **Do not** launch the token from the deploy key: it is launched from the launch EOA (§2.1).
- **Do not** archive the launch EOA before claiming the Dexscreener profile (§4.6.4):
  the adapter is a contract and cannot give proof of control in its place.
- **Do not** use `0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af` as the UniversalRouter.
- **Do not** give `GUARDIAN` the same key as `SCORER`.
- **Never** commit a `.env`, and never put a private key in a repo file.
- **Do not** use the deployer key for ordinary work in the §4.7 window (the emergency
  exception is described there).
- **Do not** run the §4 commands during the testnet dress rehearsal. Careful: **do not**
  look for the word `robinhood` in the block to decide whether it is safe — after parametrization
  those commands contain `$RPC`, not a literal. The danger is that **the §4 preamble
  exports `RPC=robinhood`**: if you have crossed that line, `$RPC` is mainnet everywhere, and the
  one-shot `setRouter` goes out against the production adapter. The testnet versions are steps
  **3.6** and **3.7** of §3. Check with `echo $RPC` before every `cast send`.

---

## 9. Summary of what is irreversible

| Step | What cannot be undone | Remedy, if any |
|---|---|---|
| 4.1 adapter deploy | `escrow` is `immutable` | redeploy **before** the launch |
| 4.4 launch on Pons | creator fee recipient and creator tax in the token's record | recipient: §9.2. Tax: no verified path |
| 4.6 core deploy | `FeeRouter.token` is `immutable`, the swap adapter's PoolKey is written in the same script | redeploy the core **before** the `setRouter`, which is the point of no return |
| 4.6.3 `setRouter` | a single call, then `AlreadySet` | §9.2, and it is the only way |
| 4.7 `acceptOwnership` | the timelock becomes owner; every change costs 24h | none, and it is intended |
| 6 `processSwap` | the burn share goes to `0x…dEaD` | none |
| 7 guardian window expired | the epoch's claims open | none for the current epoch |

> Compared with the previous version one row is missing: **the team's purchase of 25% on the curve**,
> which was the only irreversible step that cost capital. It has not been forgotten — that step no longer
> exists (§1.3). Today the only unrecoverable outlay on launch day is the
> `launchFee` plus gas.

### 9.1 Note on the basis of these statements

What follows is reconstructed from the **factory's public constants**, read with `cast`
(`CREATOR_FEE_RECIPIENT_TIMELOCK` and `CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW`, both `259200`).
**It has not been tested**, and the exact function names are not known: the factory ABI cannot be
downloaded because Blockscout answers `403` behind Cloudflare, and on testnet Pons does not exist.
Treat it as "the path exists and takes at least three days", not as a tested procedure.

### 9.2 Wrong `setRouter`, or wrong creator fee recipient: what can be done

They are the same problem: the creator fees accrue towards an address they do not leave.

1. **Assess the damage, and know what is NOT in your power.**
   `cast call $PONS_ESCROW_ADAPTER 'router()(address)'` tells you where the adapter points. If it is not
   our FeeRouter, every `claim()` forwards the collected ETH there.
   **`claim()` is permissionless**: anyone can call it, at any time, and
   this same runbook says so in §6 ("anyone"). So **"stop calling it" is not a decision
   you can make** — and a previous version of this step presented it as one, which
   made the premise of the whole recovery false. What is true:
   - **the backlog in the escrow is exposed for all six days** of step 4, to
     anyone: a bot following the adapter, or someone who read the step 5 announcement;
   - **what you can do** is not call it yourself and turn off our automations that call it
     (that is the most likely cause, not the only one);
   - **what you must measure**: `cast call $PONS_ESCROW_ADAPTER 'claimable()(uint256)'` is
     how much a `claim()` would move **now**, and it grows by itself with volume. Treat it as
     **money already lost** in planning: if it is large, it is an argument for speeding up
     step 4, not for hoping nobody calls.
2. **There is no corrective `setRouter`.** `AlreadySet` (`0xa741a045`) is final: the adapter
   is burned. A new adapter is needed.
3. **Deploy a new `PonsEscrowAdapter`** (§4.1) and run `setRouter` on it to the right FeeRouter,
   this time verifying first with `cast call`.
4. **Change the creator fee recipient on the factory** to the new adapter. It is the long part:
   the factory imposes `CREATOR_FEE_RECIPIENT_TIMELOCK` = **259,200 seconds = 3 days** between the
   request and the execution, and then it must be executed within `CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW` =
   another **3 days**, otherwise it lapses and you start over. **Mark on the calendar both the day
   the window opens and the day it expires.** The exact functions must be read from the Pons UI
   or from the verified contract: see §9.1.
5. **Communicate it — but decide *when*, because the announcement is also an invitation.** Six days of stuck
   fees are visible on-chain and it is better for the announcement to come from us. But the announcement also tells
   anyone that during this window a `claim()` sends ETH to a burned adapter, and
   `claim()` is open to all (step 1): publishing it at the start of the window increases the risk
   instead of reducing it. The practical rule: if `claimable()` is small, announce right away; if it is
   large, **execute step 4 first and announce right after**, saying what happened and what it
   cost. What is not done is staying silent after the fact.
6. **After the execution**, `claim()` on the new adapter collects the whole backlog accumulated
   in the escrow: `cast call <NEW_ADAPTER> 'claimable()(uint256)'` first, to know how much.

Fees already forwarded to the wrong address by the old adapter, if there were any, are
lost — unless that address is ours anyway and recoverable.
