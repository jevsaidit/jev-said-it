# Jev Said It ($JEV)

A model commits to a probability **on-chain, before anyone answers**. Holders agree or disagree.
When the price settles, the best-calibrated calls are paid in $JEV from the token's own
trading fees. On Robinhood Chain, launched through Pons.

Not affiliated with TypeSafe AI. "Jev" is TypeSafe's model; this project uses it as a component.
Nothing here is investment advice. Calls are free: nobody stakes tokens or bets against anyone.

## How it works

1. **The question is a receipt.** Every question (for example: *will token X be priced higher in
   ETH 6 hours after calls close?*) is a small canonical JSON with the model's probability in it.
   Its keccak256 hash is the question's id, and the `CallLedger` stores that id before anyone can
   answer. Nobody can move the number after seeing the outcome, including us.
2. **Holders call it.** One call per 10,000 tokens held at the start of the epoch, up to 50. A
   buy after the epoch starts does not add calls.
3. **The price settles it.** The outcome is read from the pool's own `Swap` events: the
   time-weighted average price over the 10 minutes before the calls close, against the same average
   6 hours later. A price pushed in the last block barely moves an average. An outcome that cannot
   be read is declared `UNRESOLVABLE`, never guessed; above 20% of an epoch, that epoch pays nobody.
4. **Calibration pays.** Scores are Brier scores against a published baseline, computed in integer
   arithmetic so anyone can recompute them. Rewards go out as a Merkle root anyone can check.
5. **Fees pay for all of it.** Pons pays the creator 0.70% of volume on average. It goes to the
   `PonsEscrowAdapter`, never to a person, then to the `FeeRouter`, which splits it on-chain: 50%
   buys the token for the rewards, 15% buys it to burn, 20% to the team in ETH, 10% ops, 5% compute.

## Playing

Connect a browser wallet on the site, pick agree or disagree on the open questions, send them in one
transaction. The contract refuses calls without tokens; the engine counts only what you held when
the epoch started. Winners claim from the same panel. After a call or a win, the site offers a
receipt card to post on X: what it prints comes from the engine, never from the link.

## What is where

| folder | what |
|---|---|
| `contracts/` | Solidity (Foundry): fee router, call ledger, rewards distributor, Pons and Uniswap v4 adapters, the launch runbook and the security checklist |
| `engine/` | the verdict engine (TypeScript): indexes the chain, opens questions, resolves them, scores, publishes roots, collects the fees and runs the buyback; public JSON feed |
| `site/` | the public site (Next.js) |
| `docs/` | the project draft and the engine spec |
| `brand/` | the pixel-art mascot and banners, generated from code |

## Check it yourself

```bash
# contracts: unit tests, then the whole fee path on a fork of mainnet, real Pons contracts
cd contracts && forge test
forge test --match-path 'test/fork/*' --fork-url robinhood

# engine: unit tests and end-to-end runs against the real contracts on a local chain
cd engine && pnpm install && pnpm test
bash scripts/e2e-epoch.sh      # an epoch from questions to a winner's claim
bash scripts/e2e-service.sh    # the service alone opens, resolves and pays an epoch

# the launch runbook, step by step, on a fork of mainnet (throwaway keys)
FORK_RPC_URL=<archive rpc> bash contracts/scripts/rehearse-launch-fork.sh

# the site: contracts + engine + site + a headless browser clicking Connect, Submit, Claim
bash site/scripts/e2e-play.sh

# a live question: its hash must equal its id
curl -s https://jevsaidit.com/api/feed/q/<id>.json | tr -d '\n' | cast keccak
```

The fork test launches a token on the real Pons factory with our adapter as fee recipient, trades
it, lets Pons settle the fees, and follows them through the split, the buyback and the epoch root
to a winner's claim.

## Status

Not launched. The contract address will be published here and on
[@jevsaidit](https://x.com/jevsaidit) before launch. An address you see anywhere else first is not
ours.
