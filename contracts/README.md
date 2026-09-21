# Jev Said It — contracts

Not affiliated with TypeSafe AI. "Jev" is TypeSafe's model; this project uses it as a component.

Contracts that receive the Pons v2 creator fees on Robinhood Chain, split them into variable shares,
record the holders' calls and pay rewards via Merkle. Owner of everything: a 24h TimelockController.

## Commands
- `forge build`
- `forge test -vvv`
- `forge test --match-path 'test/fork/*' --fork-url robinhood` (fork test, needs network)
- Deploy: see `docs/runbook-launch.md`

## Dependency pins

Managed as git submodules (tracked in root `.gitmodules` and `contracts/lib/` gitlinks):

- **forge-std**: v1.16.2 — bf647bd6046f2f7da30d0c2bf435e5c76a780c1b
- **openzeppelin-contracts**: v5.7.0 — cab19933c33c2ad1d4c7a84864a3601dddfd16f3
- **murky**: v0.1.0 — 5feccd1253d7da820f7cccccdedf64471025455d
- **v4-periphery**: 9969eec44cfdf07e24b41de47f40276a58401976
- **universal-router**: v2.2.0 — 64027f3372aa235734207c4e05667204f6f927e1

Git submodules use tiny gitlinks (mode 160000) stored in `.gitmodules`, ensuring exact reproducibility
across clones. `contracts/foundry.lock` provides secondary documentation of resolved versions.

Clone with: `git clone --recurse-submodules <repo>`
After clone: `git submodule update --init --recursive`
