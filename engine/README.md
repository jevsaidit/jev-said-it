# Verdict Engine

The off-chain engine of Jev Said It. Spec: `../docs/2026-09-21-verdict-engine-spec.md`.
Not affiliated with TypeSafe AI.

**Status: all 5 blocks.** To run on mainnet, only a `TYPESAFE_API_KEY` and the deploy
(`DEPLOY.md`) are missing.
- block 1: indexer of the token's `Transfer` events and of the v4 PoolManager, on Postgres;
- block 2: type-A questions, canonical JSON committed as `questionId`, `openQuestions` with the
  epoch guards the contract does not have;
- block 3: Jev through TypeSafe's direct API (`src/questions/jev.ts`), with the market state from
  the index as context;
- block 4: outcome resolution, scores, Merkle root and `setEpochRoot`;
- treasury: collects the Pons escrow and runs one buyback per epoch (`src/treasury/`), proven on a mainnet fork (`scripts/e2e-treasury-fork.sh`, 11/11);
- block 5: the service (`serve`), i.e. loop, `/health`, public feed, Dockerfile and `railway.json`.

The model is Jev via the TypeSafe API (`MODEL=jev`). The placeholder model (`MODEL=stub`) exists only
for tests, and it **refuses to start on mainnet**.

## Commands

```bash
pnpm install
cp .env.example .env              # and fill it in
npx tsx src/cli/main.ts migrate
npx tsx src/cli/main.ts serve                            # the service: loop + /health + feed
npx tsx src/cli/main.ts index [--loop]
npx tsx src/cli/main.ts open-questions [--stub]          # MODEL=jev|stub; --stub testnet/anvil only
npx tsx src/cli/main.ts resolve                          # outcomes of expired questions
npx tsx src/cli/main.ts close-epoch <n> [--publish]      # scores, root, setEpochRoot
npx tsx src/cli/main.ts verify-balances [n]
npx tsx src/cli/main.ts verify-price [poolId]
pnpm test
bash scripts/e2e-anvil.sh                               # questions, below
bash scripts/e2e-epoch.sh                               # a whole epoch, below
bash scripts/e2e-service.sh                             # the service on its own, below
```

Run them with `tsx` or `node dist/cli/main.js`, **not with `pnpm run`**: pnpm reduces every non-zero
exit code to 1, and here there are three codes.

| exit | meaning |
|---|---|
| 0 | done, or verified and matching |
| 1 | verified and **wrong** |
| 2 | **observation failed** (RPC down, state not served, empty index) |

## How it was verified (21/09/2026)

On a real, hot Pons token (OpenJEV, `0x4d06…33AEb7FA`), from launch block 67,319,398:

- first pass: **93,616 `Transfer` and 29,424 `Swap` in 3m16s**, zero errors;
- `verify-balances 20`: 20 holders **with a non-zero balance** (the 10 largest plus 10 random) and
  the `totalSupply` match on-chain `balanceOf` to the wei at the same block;
- `verify-price`: the last indexed `sqrtPriceX96` matches the pool's `slot0` read via `extsload`;
- **both verifiers were sabotaged**: 1 wei removed from a `Transfer` of the largest holder, or +1
  on the price of the last swap, and the verifier answered `1` (mismatch).
  A verifier that has never failed anything is not a verifier.

⚠️ The verifiers read **state** at a past block, and the public RPC only serves it for about
10 minutes (runbook §5.7). Run them right after an `index`. If the block is too old, they exit
with `2`, not `0`.

## Block 2 — verified on 21/09/2026

**The pools.** Every token that graduates on Pons drags along dozens of junk pools opened by bots
on the same token: null hook, random fee and tickSpacing, up to 13 for a single token. The engine
keeps only the real pool (ETH as `currency0`, Pons hook, fee 0, tickSpacing 200), discovered from
the `Initialize` event. Over 48h: **133 Pons/ETH pools, 571,817 swaps**. The price of a randomly
picked pool matches the on-chain `slot0`.

**The questions** (`scripts/e2e-anvil.sh`, against the repo's real `CallLedger`, 9 of 9):

1. the engine opens a batch of 10 questions on the most-traded graduated tokens;
2. `cast keccak` of the stored JSON = on-chain `questionId`. Anyone can redo it from the published JSON;
3. a holder answers two questions and two `CallSubmitted` arrive;
4. a second batch on top of an open one is refused;
5. after the deadline `submit` reverts;
6. 20 minutes before the end of the epoch the engine **does not open** (the deadline would cross the boundary);
7. in the next epoch it opens again, with the right epoch;
8. the placeholder model refuses on mainnet.

After sending, the engine reads the receipt and checks that `QuestionsOpened` reports exactly the
epoch, ids and deadline, and that the tx was included within the epoch and before the deadline.
Otherwise the batch is `FAILED`, i.e. it does not exist for anyone. The effect is verified, not the send.

## Block 3 — verified on 21/09/2026 (without a real key)

Format read from the source of the official SDK `@typesafe-ai/sdk` 0.6.0: `POST /v1/systemone`,
`noul` question (yes/no), answer `answers.up.noul` = probability.

- **Unit** (`test/jev.test.ts`): request shape; the version that answered takes precedence over
  the one requested; 429 retried, 401 not; a response without a valid probability is an error,
  never a fallback 0.5.
- **On the real path**, against a fake TypeSafe (`scripts/mock-typesafe.mjs`): mainnet data from
  the index, `CallLedger` on anvil, 4 questions opened. The fake server received the real market
  state (for example +14.7% in the last hour, 4,190 swaps), and the committed JSON contains
  `typesafe/jev-1.13.0`.
- **Wrong key**: 0 questions, no transaction, `FAILED` with the 401 in the message.

⚠️ **The real Jev has never been called**: it needs a `TYPESAFE_API_KEY`. The first real call must
be made while checking the response by hand, because the format comes from the SDK and not from a test.

## Block 4 — verified on 21/09/2026

**Scores in integer arithmetic.** Committed probabilities are 4-decimal strings, so in
ten-thousandths every Brier is an exact integer. Anyone recomputes the same scores from the
published JSON and the events, in any language.

**The price direction.** The pool has ETH as `currency0`, so `sqrtPriceX96` measures *token per
ETH*: the token's price rises when `sqrtPriceX96` falls. It lives in `decide()`, tested by hand,
because a wrong direction would invert every outcome and every test of the engine against itself
would still pass.

- **Outcomes on real data**: 5 questions on mainnet pools with a deadline 7 hours earlier. Outcome,
  price at the deadline and price at the end of the horizon match those recomputed from `cast logs`
  directly on the RPC, without going through the index. A pool born *after* the deadline comes out
  `VOID`, as the rule says.
- **Merkle compatibility** (`contracts/test/MerkleFixture.t.sol`): a tree generated here can be
  claimed on the real `RewardsDistributor`. With one wei changed in the fixture: `InvalidProof`.
- **A whole epoch** (`scripts/e2e-epoch.sh`, 14 of 14). Questions, calls, outcomes, scores, on-chain
  root and a holder who claims. Five wallets, one per rule:

  | wallet | what it does | result |
  |---|---|---|
  | U1 | answers everything right | rewarded, 64/72 of the budget |
  | U2 | capacity 3, two right and one wrong | rewarded, 8/72; the fourth call is rejected on-chain |
  | U3 | always agrees with a model that is wrong half the time | -0.16, no reward |
  | U4 | buys **after** the start of the epoch | 5 calls on-chain, **0 valid** |
  | U5 | team wallet, perfect answers | **absent** from the scores |

  U1's proof does not pay U3, and re-running the close does not send a second transaction.

## Block 5 — verified on 21/09/2026

**The service on its own** (`scripts/e2e-service.sh`, 15 of 15, three runs in a row): against anvil
the loop opens the questions, resolves them, closes the epoch and publishes the root **with no
manual command at all**. A holder claims with the proof taken from `/claim`. `keccak256` of
`/q/<id>.json` = `id`. With the chain shut down, `/health` goes to 503 and the process **exits with code 3**.

**Why it exits on its own.** Railway's healthcheck is only used at deploy; afterwards it restarts
nothing. A live, blind engine would stay there forever: by exiting, the restart policy brings it back up.

**The real container** against mainnet, empty database, 300,000 blocks to catch up: `/health` is
200 after about 50s, the lag drops by about 30,000 blocks per cycle (`MAX_BLOCKS_PER_CYCLE`), 90 MB
of RAM, `docker stop` in 10s. While the index is more than 2,000 blocks behind **no questions are
opened**, because candidates would be chosen on stale swaps.

Two defects found by this test, both in the test and not in the engine, but instructive:
- an orphan service from a previous run was holding the port, and the test was talking to it. `npx`
  leaves a child the `trap` does not kill: `node` is launched directly, and the test checks that
  the ports are free before starting;
- with the 2h window the loop **legitimately** opens several batches per epoch on the same tokens. A
  test looking for "the question on token X" finds two.

## Chain constraints, already built in

- no WebSocket, polling only;
- `eth_getLogs` rejects ranges that are too large (`logs matched by query exceeds limit of 10000`,
  or "log query timed out"): the **range is split**, not retried as is;
- rate limiting arrives as a JSON-RPC error `{"code":429}` **inside an HTTP 200 response**, which
  viem does not retry: it is recognised by its code and **waited out** with backoff, without splitting.
  Mistaking it for a range that is too wide made indexing 3.3 times slower;
- explicit `User-Agent` on every request;
- each indexer's cursor is updated in the same transaction as the data.
