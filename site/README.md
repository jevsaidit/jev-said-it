# Jev Said It — site

The public site of Jev Said It (`jevsaidit.com`). Next.js 16 (App Router), one static page plus
two server routes: `/api/health` and `/api/feed/*`.
Not affiliated with TypeSafe AI.

## What it says and where it gets it

Every number on the site comes from a file in the repository, and lives in one place only:
[`src/lib/site.ts`](src/lib/site.ts).

| On the site | Source |
|---|---|
| 1 call per 10,000 tokens, max 50, 6h epochs | `contracts/src/CallLedger.sol` |
| fee split 50 / 15 / 20 / 10 / 5 | `contracts/src/FeeRouter.sol` (default values) |
| 6h horizon, top 10%, minimum 3 calls, 20% `UNRESOLVABLE` threshold, claim at 12h | `docs/2026-09-21-verdict-engine-spec.md` §3, §6, §7 |
| the five-wallet table | `engine/README.md`, block 4 (`scripts/e2e-epoch.sh`) |
| the receipt and its hash | `engine/src/questions/canonical.ts` and `open.ts` |

**The receipt is a sample, and it says so.** The fields and the rule are the engine's real ones,
the addresses are not. The hash is computed in the browser with the same canonicalization as the
engine ([`src/lib/verdict.ts`](src/lib/verdict.ts)); checked against `cast keccak` on the same JSON.
If `canonical.ts` changes, `verdict.ts` must change too.

## Commands

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm build
pnpm start        # reads PORT, default 3000
pnpm typecheck
```

## Environment variables

All optional: without them, the site shows the pre-launch state. See [`.env.example`](.env.example).

| Variable | Effect |
|---|---|
| `ENGINE_FEED_URL` | base of the engine's public feed (spec §9.4). Read **at runtime** by the server, no rebuild needed |
| `NEXT_PUBLIC_TOKEN_ADDRESS` | token address. Empty = "Not launched". **Fill it in only once the contract is public** |
| `NEXT_PUBLIC_TICKER` | ticker without `$`, default `JEVSAIDIT` |
| `NEXT_PUBLIC_SITE_URL` | canonical URL for Open Graph, default `https://jevsaidit.com` |
| `NEXT_PUBLIC_TELEGRAM_URL` | if set, the Telegram link appears in the footer |

The `NEXT_PUBLIC_*` variables end up in the bundle **at build time**: after changing them you need
to redeploy.

## The feed

The browser never talks to the engine: it calls `/api/feed/...`, which forwards to `ENGINE_FEED_URL`.
This way the engine doesn't have to open CORS, and the URL changes without rebuilding. The proxy only
accepts the spec's paths (`epochs/current`, `epochs/<n>`, `q/<id>.json`, `leaderboard/<n>`,
`calibration`); anything else is 404.

| The engine... | `/api/feed/*` responds | The site shows |
|---|---|---|
| is not configured | `503 {"state":"offline"}` | "No epoch yet" |
| doesn't respond within 8s | `502 {"state":"blind"}` | "Can't see the engine", **not** an empty list |
| responds | its body and its status, 30s cache | the questions |

Expected shape of `GET /epochs/current` (the engine doesn't expose it yet; the site reads
defensively):

```json
{ "epoch": 12, "questions": [{ "id": "0x…", "token": "0x…", "symbol": "ABC", "p": "0.6412",
  "model": "jev", "deadline": 1790604000, "status": "OPEN", "outcome": null }] }
```

## Deploy

The `site/` folder is a project of its own: on both Vercel and Railway it must be set as the
service's **root directory**.

### Vercel

1. New Project → import this repository.
2. **Root Directory: `site`**. Framework: Next.js (detected; `vercel.json` pins pnpm).
3. Environment variables as above, then Deploy.
4. Domains: `jevsaidit.com` as primary, `.fun` and `.xyz` as redirects.

### Railway

1. New Service → GitHub repo this repository.
2. Settings → **Root Directory: `site`**. Build and start are read from `railway.json`
   (`pnpm build`, `pnpm start`, healthcheck on `/api/health`).
3. Variables as above. Railway sets `PORT` and `next start` reads it on its own.
4. If the engine runs in the same Railway project, `ENGINE_FEED_URL` can point to its private
   domain (`http://<service>.railway.internal:<port>`): the feed stays off the internet and the
   site forwards it.

`/api/health` only says the site is up. The engine's state is its own `/health` (spec §9.3).

## Design

- Colors taken from the logo: Robinhood green `#3DF07A`, ring `#0E2A17`, chain gold `#F2C230`,
  face pink `#F59A8F` for disagreement. The background is green-black `#07120B`, not black.
- Type: Pixelify Sans (headings, like the logo), Atkinson Hyperlegible Next (body), Martian Mono
  (hashes and data).
- The only light element on the page is the **receipt**: it's the object the project promises.
- Mobile down to 360px, visible focus, `prefers-reduced-motion` respected, the receipt is visible
  even without JavaScript.
