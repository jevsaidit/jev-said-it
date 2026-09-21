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
| `LEDGER_START_BLOCK` | CallLedger deploy block | |
| `KEEPER_PK` | key of the CallLedger publisher | **only here**, never in the repo |
| `REWARDS_DISTRIBUTOR` | address | without it, no rewards |
| `SCORER_PK` | scorer key | **distinct** from `KEEPER_PK` |
| `EXCLUDE` | `TEAM_WALLET`, team wallets, FeeRouter, RewardsDistributor, pools, `0x…dEaD`, comma-separated | runbook §5.4 |
| `PONS_ESCROW_ADAPTER` | the adapter that the launch names as fee recipient | check word 3 of `getLaunchedToken` right after launch (runbook §4.5) |
| `FEE_ROUTER` | router address | with it, the engine collects the escrow and runs one buyback per epoch (the keeper must be the router's `keeper`) |
| `MODEL` | `jev` | `none` = the engine indexes and resolves but opens no questions. `stub` is refused on mainnet |
| `TYPESAFE_API_KEY` | TypeSafe key (console.typesafe.ai) | **only here**. With a wrong key the engine opens nothing and ends `FAILED` with the 401 in the message |
| `JEV_MODEL` | `jev-1.13.0` | pinned version: the committed JSON gets the one that actually answered |

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
