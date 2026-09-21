# Verdict Engine — spec v0.1

Date: 21 September 2026 · Status: draft to be agreed · Launch: **within 48 hours**
Not affiliated with TypeSafe AI.

The engine is the missing off-chain piece: it opens the questions, has the model answer, resolves
the outcomes, computes the scores and publishes the rewards root. The contracts (`contracts/`) are
already done and tested: this spec takes them as a fixed interface and **does not propose changes
to the contracts**, except those flagged as questions in §10.

---

## 1. Three measurements that decide the design

They were measured on the Pons launches of September 2026, read from the chain's own events.
The sample below is made of the ETH-paired launches of two days, 10–11/09, old enough for all of
them to have an outcome.

**1a. A question "is this launch a rug?" measures nothing.** 1.5% graduate. Whoever always
says "rug" is right 98.5% of the time, and "Jev was right 98% of the time" would be true and empty.

**1b. The real uncertainty is high up the curve.**

| Point of the curve reached | Launches | Graduate |
|---|---|---|
| at launch | 20,122 | 1.5% |
| 10% | 5,505 | 5.5% |
| 25% | 3,260 | 9.2% |
| 50% | 1,507 | 20.0% |
| 75% | 746 | 40.3% |
| 90% | 505 | 59.6% |

**1c. …but there the outcome arrives before a human can answer.** Of the 148 launches that graduate
after touching 75% (out of 389, sample of 10/09): **79 graduate within 2 minutes, 115 within
10, 131 within an hour.** A graduation question opened at 75% resolves while people are
still reading the tweet.

**Consequence.** At launch the questions are not about the graduation of fresh launches. They are about
**the price of already graduated tokens**, with the reference price read **at the close of the
calls** and not at the opening. This way nobody can answer after seeing the outcome: it is true by
construction, not by the engine's punctuality.

---

## 2. What is needed at T0 and what can wait

The rewards root is not needed at launch: the first one is needed at the end of the first epoch, and the distributor
will have tokens only after the first `processSwap`. This is the room that makes a 48h launch possible.

| When | What | Why not earlier / not later |
|---|---|---|
| **T0** | `Transfer` indexer of $JEVSAIDIT from `LAUNCH_BLOCK` | runbook §5.7: if it starts late, the epochs cannot be reconstructed |
| **T0** | PoolManager `Swap` indexer for the candidate tokens | needed for the reference price and for resolution |
| **T+10 min** | first epoch: questions + verdicts + `openQuestions` | public commitment of runbook §5.1–5.2 |
| **T0 → always** | public JSON feed (questions, verdicts, outcomes) | it is the product: without a feed there is nothing to see |
| **end of epoch 1 + horizon** | resolution, scores, first `setEpochRoot` | the distributor must have a free balance (§7.4) |
| later | graduation questions (§3, type B), rebate (§4.3.4 of the draft), API/MCP | they need measurements that do not exist today |

---

## 3. The questions

### Type A — price of a graduated token (T0)

> *"Will $X at the close of the horizon be above the price at the close of the calls?"*

- **Candidates:** Pons tokens graduated in the last 48h, with at least 10 swaps in the last hour and
  60 over the last 6h (22/09: a one-hour burst on a dead pool gave VOIDs on testnet).
- **Reference (rule v2, 22/09):** the time-weighted average of `sqrtPriceX96` over the 10 minutes
  (`window` = 600 s, committed in the question) ending at the block where the calls close. v1 used the
  last swap, and whoever had called could push the price in the deadline block, when nobody can call
  any more: an average makes that cost ten minutes of holding the price. It is read from the logs, not
  from state: the node prunes historical state after about 10 minutes, the logs it does not (runbook §5.7).
- **Outcome:** same average over the 10 minutes ending at `deadline + HORIZON`. `1` if the price is
  strictly above, `0` if it is below or equal, `VOID` if no swap happened between the two instants.
  Each question is resolved by the rule version it committed to.
- **Horizon:** 6h, so that each epoch resolves the questions of the previous epoch.
- **Base rate: not yet measured.** Our corpus covers the curves, not the v4 pools after
  graduation. Until 30 questions are resolved the declared baseline is `0.5`, with the label
  *"not measured"*. From then on it is the observed frequency on the engine's own already
  resolved questions. A baseline number that has not been measured is not published.

### Type B — graduation (after launch)

It is switched back on once it is measured what remains after the anti-peek rule: a question whose launch
graduates **before** the close of the calls is **voided**, not resolved. From §1c, today most
positives would be voided, and the remaining sample would have a rate different from the one
in the table. It must be measured with the same rule before using it.

---

## 4. The verdict is committed on-chain before the calls

`openQuestions` accepts arbitrary `id`s. The engine uses them as a commitment:

```
questionId = keccak256(utf8(canonical JSON of the question))
```

The canonical JSON has sorted keys, no whitespace, numbers as decimal strings, and contains:
`v`, `epoch`, `kind`, `token`, `pool`, `deadline`, `horizon`, `model`, `p` (the model's
probability, 4 decimals), `baseline`.

The JSON is published at `/q/<questionId>.json`. Anyone can recompute the hash and see that **the
model's verdict existed on-chain before anyone answered**, without trusting the engine.
It does not cost a new contract: it is the same `bytes32` the contract already records.

---

## 5. Constraints the `CallLedger` places on the engine

They are all in the code, and none is checked by the contract. If the engine gets them wrong, the questions
exist but **nobody can answer**, and nobody sees it until someone tries.

1. **`epoch` passed to `openQuestions` = `currentEpoch()` read on-chain at that moment.**
   `submit` looks up the question under `currentEpoch()`: a wrong epoch gives no error
   at opening, it gives `QuestionClosed` on every call.
2. **`deadline ≤ genesis + (epoch+1) × 6h`.** A deadline beyond the end of the epoch is a
   false promise: from the epoch change the question shows as closed.
3. **A single deadline per transaction.** The engine groups by deadline.
4. **The contract counts capacity on the balance at the time of the call** (`balanceAtCall`), not at
   the start of the epoch. Buy → 50 calls → sell back within the same hour is possible on-chain. The engine
   recomputes: for each wallet the first `min(used, ⌊balance_at_epoch_start / 10,000⌋, 50)`
   calls in log order count, and the others are discarded. The balance at the start of the epoch comes from the
   `Transfer` indexer (runbook §5.7).

**Acceptance test:** on testnet, open a question, answer from a wallet, check that the
`CallSubmitted` event arrives. Then repeat 1 minute before the end of the epoch with a deadline beyond the
boundary, and check that the engine rejects it before sending the transaction.

---

## 6. Resolution: three states, never two

| State | When | Effect |
|---|---|---|
| `RESOLVED` (0 or 1) | price read at both blocks | enters the scores |
| `VOID` | no `Swap` between opening and deadline; launch graduated before the deadline (type B) | out of the scores, **declared** in the feed |
| `UNRESOLVABLE` | the engine could not read the logs (RPC down, log window exceeded) | out of the scores. If it affects more than 20% of the epoch's questions, **the epoch is not paid** (runbook §5.7: when in doubt, nobody is paid) |

"The observation failed" never turns into "that's how it went".

---

## 7. Score and rewards

### 7.1 Score

For each valid call on a `RESOLVED` question:

```
f      = agree ? p : 1 − p          # the forecast implied by the call
brier  = (f − y)²
skill  = (b − y)² − brier           # b = the question's baseline, from the committed JSON
```

Wallet score in the epoch = sum of the `skill`s. At least 3 resolved calls are needed to enter
the leaderboard. **Rewarded:** the top 10% with score > 0, in proportion to the score.

⚠️ **To be decided (§10.3):** against the baseline, whoever always agrees with the model earns
the model's skill, in proportion to their balance. Against the model (`skill = brier_model − brier`),
agreeing is always worth zero and only those who beat the model get paid. The first is more stable, the
second is more faithful to the name of the game.

### 7.2 Excluded

`TEAM_WALLET`, the team's personal wallets, FeeRouter, RewardsDistributor, the pool, `0x…dEaD`.
If one of these appears among the beneficiaries, **the root is not published** (runbook §5.4).

### 7.3 Root

The contract's leaf is `keccak256(bytes.concat(keccak256(abi.encode(account, amount))))`,
that is, the `@openzeppelin/merkle-tree` standard with types `["address","uint256"]`. That
library is used, not an implementation of our own.

**Compatibility test**: the engine generates a fixture tree in JSON, and a Foundry test
reads it and makes a real `claim` on the `RewardsDistributor`. If one day the encoding diverges, the
test breaks, not the first holder who tries to claim.

### 7.4 Constraints of `setEpochRoot`

- `budget ≤ free balance × 20%` (`maxEpochBudgetBps`). The engine reads `freeBalance()` and scales the
  amounts pro-rata. **With a free balance of zero, that is, before the first `processSwap`, the epoch is not
  published**: the scores stay in the feed, the rewards do not.
- Strictly increasing epochs and **at least 6h between two roots**. A late root pushes forward
  all the following ones. The cadence is: root of epoch `e` published at the end of epoch `e+1`, when its
  questions (6h horizon) are all resolved.
- Claims open 12h after the root, and the `GUARDIAN` can cancel within that window.

---

## 8. The model

- **Single interface:** `verdict(question) → { p, model, latencyMs }`. `model` goes into the committed
  JSON (§4) and into the feed.
- **Status of Jev on 21/09: the channel exists.** 🔴 *Corrected:* here it said that Jev was not on
  OpenRouter. It was the writer's mistake: the public list `/api/v1/models` does not show it, but
  `typesafe/jev-1.13` exists ($0.042/M input, output free, 32k context). **It is not a
  text model**: it returns "decisions", and the OpenRouter endpoint does not declare the standard
  parameters. The engine therefore uses **TypeSafe's direct API**, with the format read from the source
  of the official SDK (`@typesafe-ai/sdk` 0.6.0): `POST /v1/systemone`, question of type `noul`
  (yes/no), answer = probability. It needs a `TYPESAFE_API_KEY` (early access, console.typesafe.ai).
- **What Jev receives** (`state`): what the index knows about the token, that is, hours since graduation,
  price change over 1h and 6h, trades in the last hour and in the last 6.
- **Rule:** a verdict from a model other than Jev **is not published as "Jev said it"**. The
  fallback exists so as not to stop the product, but the feed always says who answered. The project's
  name is a promise about the model.
- **Public calibration:** every epoch the feed publishes the model's Brier, the baseline's Brier
  and the number of resolved questions, **even when the model loses** (draft §7).

---

## 9. Operations

### 9.1 Hosting

Railway, on the project's account. One Node service (`engine/`) and one Postgres. No project
resources on any of our own VPSs.

| Key | Where | Why |
|---|---|---|
| `KEEPER` (opens questions, `processSwap`) | Railway variable | needed every epoch |
| `SCORER` (`setEpochRoot`) | Railway variable, **separate key** | theft of one does not compromise the other |
| `GUARDIAN` | **outside Railway**, held by a person | it is the brake against a compromised `SCORER`: it cannot be where the `SCORER` is |

### 9.2 The chain

- No WebSocket: block polling.
- `eth_getLogs` in windows that halve when the node refuses.
- On HTTP 429, wait with backoff: a 429 is contention, not a failure.
- Explicit `User-Agent` on every request, because some endpoints reject requests without one.
- Confirmation depth before treating a log as final.

### 9.3 Health

Every cycle ends in one of three states: `OK` (it looked and it acted), `IDLE` (it looked, nothing
to do), `BLIND` (the observation failed). `/health` exposes the age of the last `OK|IDLE` cycle and
responds 503 beyond 10 minutes. **An engine that runs blind and responds 200 is the worst failure**,
because everything looks green.

🔴 *Corrected on 21/09 during block 5:* here it said «Railway restarts the service». **That is
not true.** Railway's healthcheck is used only at deploy, to decide when to switch traffic
to the new service, and afterwards it restarts nothing. For this reason the engine **exits by itself with code 3**
when it has been blind for longer than `HEALTH_MAX_AGE_SEC`, and the `ON_FAILURE` restart policy brings it back up. If
it keeps crashing, Railway marks the deploy as crashed, which is a visible signal. A process
that is alive and blind would not be.

### 9.4 Public feed (T0)

`GET /epochs/current`, `/epochs/:n`, `/q/:id.json`, `/leaderboard/:n`, `/calibration`. All
static or nearly static JSON, cacheable. The Terminal and the X bot read from here.

---

## 10. Decisions — closed on 21/09/2026

Agreed between the two collaborators on 21/09, by phone.

1. **Channel for Jev: TypeSafe's direct API** (`MODEL=jev`, `TYPESAFE_API_KEY`), not OpenRouter:
   Jev returns "decisions", not text, and the OpenRouter endpoint does not declare the standard
   parameters (§8). The key goes **directly into the Railway variables** and does not pass through
   any other place.
2. **At launch type A is used** (price of graduated tokens, reference at the close of the calls).
   Type B waits for the measurement in §3.
3. **Score against the baseline** (`SCORE_REFERENCE=baseline`): more stable. Against the model,
   agreeing would always be worth zero, and with a well-calibrated model the rewards would go to whoever
   got lucky.
4. **No changes to the `CallLedger` before launch.** The `epoch == currentEpoch()` guard is
   already applied by the engine (§5, `planBatch` + check on the receipt, tested on anvil). Touching
   an already tested contract one or two days before deploy is a risk with no upside.
   Candidate for a v2.

---

## 11. The next 48 hours

| Block | What | Check |
|---|---|---|
| **1** | scaffold `engine/` (TypeScript), `Transfer` and `Swap` indexers, Postgres | reconstructed balances = `balanceOf` at a recent block, for 20 wallets |
| **2** | type A questions, canonical JSON, `openQuestions` on testnet 46630 | the hash recomputed from the published JSON = `id` of the `QuestionsOpened` event |
| **3** | model adapter, public feed | an open question has `p` and `model` in the feed |
| **4** | resolution, scores, Merkle tree | the Foundry compatibility test (§7.3) is green |
| **5** | deploy on Railway, a full epoch on testnet | a complete epoch with zero `BLIND` and the feed updated |
| **T0** | launch following the runbook, with the engine already up | first epoch opened within 10 minutes |
