# Deploy on Railway

One service (`engine`) and one Postgres, in the same project. The engine keeps no state outside the
database: it can be redeployed or restarted at any time without losing anything.

## 1. Services

1. **Postgres**: *New → Database → PostgreSQL*.
2. **engine**: *New → GitHub Repo* on this repo, then in *Settings*:
   - **Root Directory: `engine`**. `railway.json` and `Dockerfile` live there.
   - the healthcheck (`/health`) and the restart policy are taken from `railway.json`.
   - *Networking → Generate Domain*, for the public feed.

## 2. Variables of the `engine` service

| variable | value | notes |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | reference to the Postgres service |
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | |
| `TOKEN` | $JEVSAIDIT address | after launch |
| `LAUNCH_BLOCK` | launch block (runbook §4.4) | balances start from here |
| `V4_START_BLOCK` | `LAUNCH_BLOCK - 1700000` | about 48h earlier: candidates need history |
| `CALL_LEDGER` | CallLedger address | without it, the engine only indexes |
| `LEDGER_START_BLOCK` | block of the **Timelock** transaction, the first of the twelve `DeployCore` sends (`contracts/broadcast/DeployCore.s.sol/4663/run-latest.json`) | **required** with `REWARDS_DISTRIBUTOR`: 0 would scan the ledger from genesis. The twelve txs span several 0.1-s blocks; the CallLedger is the fourth, and a later block is safe only because no question can exist before `CALL_LEDGER` is set — take the first |
| `KEEPER_PK` | key of the CallLedger publisher **and** of the FeeRouter `keeper` (same key: it signs `openQuestions`, `claim()` and `processSwap`) | **only here**, never in the repo. Generated as a key of its own, distinct from `SCORER_PK` and from the guardian |
| `REWARDS_DISTRIBUTOR` | address | without it, no rewards. Set it after checking the first root by hand (runbook §5.0 step 3, at the end of epoch 1 ≈ T+12h) — **together with `SCORER_PK`, `LEDGER_START_BLOCK` and `EXCLUDE`, in one change**: with it set, boot loads the rewards config and a missing one of the three throws → exit 2 → `ON_FAILURE` restart ×10 (`railway.json`), a crash loop. Config is read once at boot; Railway redeploys on any variable change; nothing is re-indexed |
| `SCORER_PK` | scorer key | **distinct** from `KEEPER_PK`. Not on Railway before the first root is checked by hand |
| `EXCLUDE` | **canonical list, referenced by the runbook, `.env.example` and the spec**: the team's EOAs and `TEAM_WALLET` (operative — only an address that can call `submit` can ever be a beneficiary), plus, as harmless padding, FeeRouter, RewardsDistributor, CallLedger, UniV4SwapAdapter, PonsEscrowAdapter, the PoolManager `0x8366…`, the Pons curve and `0x…dEaD`; comma-separated, case-insensitive | runbook §5.4. The engine drops excluded callers before scoring and refuses a root in which one still appears |
| `PONS_ESCROW_ADAPTER` | the adapter that the launch names as fee recipient | check word 3 of `getLaunchedToken` right after launch (runbook §4.5) |
| `FEE_ROUTER` | router address | with it, the engine collects the escrow and runs one buyback per epoch (the keeper must be the router's `keeper`). **Set it only when both are true**: `getMinDelay()` = 86400 after the timelock's `executeBatch` (runbook §4.7) **and** `router()` on the adapter = the FeeRouter (§4.6.3) — before `setRouter`, `claim()` reverts `NotSet` and the treasury task fails every cycle (runbook §5.0 step 4) |
| `MODEL` | `jev` | `none` = the engine indexes and resolves but opens no questions. `stub` is refused on mainnet. **`jev` without `TYPESAFE_API_KEY` throws at boot**: set the key first |
| `TYPESAFE_API_KEY` | TypeSafe key (console.typesafe.ai) | **only here**. With a wrong key the engine opens nothing and ends `FAILED` with the 401 in the message |
| `JEV_MODEL` | `jev-1.13.0` | pinned version: the committed JSON gets the one that actually answered |
| `ANNOUNCE_MODE` | `off` → `test` at T-1h → `live` after the first epoch is visible on the feed | `off` (default): silent. `test`: every post, both channels' versions, to `TELEGRAM_TEST_CHAT_ID`. `live`: the channel and X. Any other value throws at boot (runbook §5.0 step 6) |
| `TELEGRAM_BOT_TOKEN` | BotFather token | required as soon as `ANNOUNCE_MODE` ≠ `off` |
| `TELEGRAM_CHANNEL_ID` | the public announcements channel | `live` only; the bot must be an admin of the channel |
| `TELEGRAM_TEST_CHAT_ID` | one private chat | `test` only |
| `PUBLIC_SITE_URL` | `https://www.jevsaidit.com` | the canonical site, linked from every post; that is also the default |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | OAuth 1.0a user context of @jevsaidit (developer app with write access) | **all four or none**: half of them throws at boot; none of them = X is not a channel and its posts are recorded as `unconfigured`, never sent later |
| `X_DAILY_CAP` | `6` (default) | posts per UTC day on X. 2 slots are reserved for the epoch verdict and 1 for the buyback: a batch opening cannot exhaust the cap before the verdict |

All the others have a sensible default: see `.env.example`.

⛔ **`GUARDIAN` does not go on Railway.** It is the brake against a compromised `SCORER`, and it
cannot live where the `SCORER` lives (spec §9.1).

## 3. What to watch after the deploy

```bash
curl -s https://<domain>/health | jq '{ok, indexLagBlocks, model, tasks}'
```

- `indexLagBlocks` drops by about 30,000 per cycle during the initial catch-up. Below 2,000 the
  engine starts opening questions: not before, because it would choose candidates on stale swaps.
- `tasks.questions.state = DISABLED` with `model: null` means `MODEL=none`: no questions.
- If the engine stays blind (RPC down) for more than `HEALTH_MAX_AGE_SEC` it exits with code **3**,
  and Railway restarts it. A series of restarts = *crashed* deploy in the dashboard: that is the signal.

## Public feed

`/epochs/current` · `/epochs/:n` · `/q/:id.json` (the committed JSON, byte for byte) ·
`/leaderboard/:n` · `/claim/:n/:address` · `/calibration`

## The fee path, and what we do not control

Fees reach the Pons escrow only when **Pons' operator sweeps our pool** (`hook.sweepPoolFees`,
restricted to them). The engine collects whatever has been swept (`adapter.claim()`), then runs one
buyback per epoch at a time derived from the keeper's secret, with `minOut` computed from the pool's
state and the hook cut read on-chain. Every action is public at `/treasury`. Proven end to end on real
Pons contracts by `contracts/test/fork/FeePipeline.fork.t.sol` and `engine/scripts/e2e-treasury-fork.sh`.
