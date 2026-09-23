# Jev Said It — site

The public site of Jev Said It (`https://www.jevsaidit.com`). Next.js 16 (App Router), one static
page plus server routes: `/api/health`, `/api/feed/*` (the feed proxy), `/api/card/*` (share
images), and the share pages `/c/<id>/<side>` and `/w/<epoch>/<address>`.
Not affiliated with TypeSafe AI.

**The canonical host is `www`.** The apex `jevsaidit.com` has no certificate, so anything the site
prints (the card footers, the `curl` command, Open Graph URLs) uses `https://www.jevsaidit.com`.
Putting TLS on the apex is a DNS task, not a site task; until it is done, never print the apex.

## What it says and where it gets it

Every number on the site comes from a file in the repository, and lives in one place only:
[`src/lib/site.ts`](src/lib/site.ts).

| On the site | Source |
|---|---|
| 1 call per 10,000 tokens, max 50, 6h epochs | `contracts/src/CallLedger.sol` |
| fee split 50 / 15 / 20 / 10 / 5 | `contracts/src/FeeRouter.sol` (default values) |
| 6h horizon, 10-minute reference window, top 10%, minimum 3 calls, 20% `UNRESOLVABLE` threshold | `docs/2026-09-21-verdict-engine-spec.md` §3, §6, §7; `engine/src/questions/open.ts` |
| claims open at 12h, expire at 90 days, 20% budget cap (today's value, owner-changeable) | `contracts/src/RewardsDistributor.sol` |
| the 24-hour timelock | a deployment fact (`FeeRouter.sol` "expected owner"): stated as design until `NEXT_PUBLIC_TIMELOCK_ADDRESS` is set |
| the five-wallet table | `engine/README.md`, block 4 (`scripts/e2e-epoch.sh`) |
| the receipt and its hash | `engine/src/questions/canonical.ts` and `open.ts` |
| contract error names shown in the play panel | `contracts/src/CallLedger.sol`, `contracts/src/RewardsDistributor.sol` (`src/lib/chains.ts`) |

**The receipt is a sample, and it says so.** The fields and the rule are the engine's real ones,
the addresses are not. The hash is computed in the browser with the same canonicalization as the
engine ([`src/lib/verdict.ts`](src/lib/verdict.ts)); checked against `cast keccak` on the same JSON.
If `canonical.ts` changes, `verdict.ts` must change too.

**Who answered is always printed.** A verdict carries the model id that gave it
(`typesafe/jev-…` or the fallback's id). Anything that is not Jev is labelled `(fallback)` on the
card, in the panel, in the post text and in the page title ([`src/lib/say.ts`](src/lib/say.ts)).

## Commands

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm build
pnpm start        # reads PORT, default 3000
pnpm typecheck
scripts/e2e-play.sh   # anvil + contracts + engine + this site + a headless browser (needs foundry, Postgres)
```

## Environment variables

All optional: without them, the site shows the pre-launch state. See [`.env.example`](.env.example).

| Variable | Effect |
|---|---|
| `ENGINE_FEED_URL` | base of the engine's public feed (spec §9.4). Read **at runtime** by the server, no rebuild needed |
| `NEXT_PUBLIC_TOKEN_ADDRESS` | token address. Empty = "Not launched", **and `/api/feed/config` stays closed** (503) so the address cannot be read from the site before the page prints it. **Fill it in only once the contract is public** |
| `NEXT_PUBLIC_TIMELOCK_ADDRESS` | the timelock that owns the router and the distributor after the handover. Printed in "Where the fees go" when set; the page states the design otherwise |
| `NEXT_PUBLIC_TICKER` | ticker without `$`, default `JEV` |
| `NEXT_PUBLIC_SITE_URL` | canonical URL for Open Graph and the printed commands, default `https://www.jevsaidit.com` |
| `NEXT_PUBLIC_TELEGRAM_URL` | if set, the Telegram link appears in the footer |

The `NEXT_PUBLIC_*` variables end up in the bundle **at build time**: after changing them you need
to redeploy.

## The feed

The browser never talks to the engine: it calls `/api/feed/...`, which forwards to `ENGINE_FEED_URL`.
This way the engine doesn't have to open CORS, and the URL changes without rebuilding. The proxy only
accepts the engine's public paths (`epochs/current`, `epochs/<n>`, `q/<id>.json`, `leaderboard/<n>`,
`calibration`, `config`, `holder/<address>`); anything else is 404.

| The engine... | `/api/feed/*` responds | The site shows |
|---|---|---|
| is not configured (`ENGINE_FEED_URL` empty) | `503 {"state":"offline"}` | "No epoch yet" / "Calls open at launch" |
| is up but has no CallLedger yet (its `404 CallLedger not configured` on `epochs/current`, `holder/*`) | `503 {"state":"offline"}` | the same: it answered, there is no epoch |
| doesn't respond within 8s, or answers 5xx | `502 {"state":"blind"}` | "Can't see the engine", **not** an empty list; retried every minute |
| responds | its body and its status, 30s cache (`holder/*` never cached) | the questions |
| — while `NEXT_PUBLIC_TOKEN_ADDRESS` is empty, whatever the engine says | `config` → `503 {"state":"offline"}` | the play panel's pre-launch note |

Shape of `GET /epochs/current` (`engine/src/server/feed.ts`, `publicQuestion`):

```json
{ "epoch": 12, "questions": [{ "id": "0x…", "token": "0x…", "symbol": "ABC", "p": "0.6412",
  "model": "typesafe/jev-1.13.0", "deadline": 1790604000, "status": "OPEN", "outcome": null }] }
```

## Share receipts

`/c/<id>/agree|disagree` and `/w/<epoch>/<address>` render a card (`/api/card/...`) from what the
engine published, never from the URL. Three answers, kept apart because X and Telegram scrape a
link once and cache what they get:

| The engine... | page | card image |
|---|---|---|
| says the question / reward exists | the card | `200 image/png` |
| says it does not exist (its 404), or the epoch was voided on-chain | 404 | 404 |
| could not be asked (not configured, timeout, 5xx, chain read failed) | the brand card, "the engine didn't answer", `no-store` | `503` + `retry-after: 30`, `no-store` |

## Play panel

`src/components/Play.tsx` is the shell: it reads `/api/feed/config` and shows one sentence until
there is a CallLedger on a supported chain. Only then does it load `PlayLive.tsx`, which carries viem
and the wallet code (~85KB gzipped): a visitor who never plays never downloads it.

The end-to-end test (`scripts/e2e-play.sh`) builds the site with `NEXT_PUBLIC_TOKEN_ADDRESS` set to
the local token, because that is what opens `/api/feed/config`, and covers: a wallet answering three
questions in one transaction, a wallet that bought after the epoch started (refused before gas),
a rejection in the wallet (nothing sent), and a claim after the root is published.

## Deploy

The `site/` folder is a project of its own: on both Vercel and Railway it must be set as the
service's **root directory**.

### Vercel

1. New Project → import this repository.
2. **Root Directory: `site`**. Framework: Next.js (detected; `vercel.json` pins pnpm).
3. Environment variables as above, then Deploy.
4. Domains: `www.jevsaidit.com` as primary; the apex should redirect to it **over HTTPS**, which
   needs a certificate on the apex (a DNS/host task; see the note at the top).

### Railway

1. New Service → GitHub repo this repository.
2. Settings → **Root Directory: `site`**. Build and start are read from `railway.json`
   (`pnpm build`, `pnpm start`, healthcheck on `/api/health`).
3. Variables as above. Railway sets `PORT` and `next start` reads it on its own.
4. If the engine runs in the same Railway project, `ENGINE_FEED_URL` can point to its private
   domain (`http://<service>.railway.internal:<port>`): the feed stays off the internet and the
   site forwards it.

`/api/health` only says the site is up. The engine's state is its own `/health` (spec §9.3).
`/robots.txt` and `/sitemap.xml` are generated (`src/app/robots.ts`, `sitemap.ts`); the icons are
`src/app/icon.png` (480²), `apple-icon.png` (180², the sprite at 4× with its own background as the
margin) and `favicon.ico` (48/32/16).

## Design

The site follows the X profile: the laser-eyes pfp and the degen banner (`brand/degen*.py`).

- **The hero is the banner, alive.** Pixel rays open from the mascot, green candles pump along the
  bottom, gold coins float around it, and it says "So I aped." The one moment of motion on the page:
  on load the lasers fire out of its eyes and cross the whole page, clear of the title's gold "IT."
  With `prefers-reduced-motion` they are simply there.
- **One pixel size.** The mascot is served at its native 40x40 (`public/mascot-laser.png`) and scaled
  by CSS with `image-rendering: pixelated` in whole numbers (`--mpx`: 10px on desktop, 6px on
  phones). Lasers, coins and the bubble are measured in the same unit, so they stay on its grid.
- **Palette from the art:** hood green `#3DF07A`, the banner's two ray greens `#09190F` / `#0E2817`,
  gold `#F2C230`, laser red `#FF2828`, paper `#F3F7EA`. Hard offset shadows, never soft ones: the
  receipt's shadow is a second torn sheet (`.receipt__wrap::before`), not a blur.
- **Type:** Pixelify Sans for headings (as in the art), Atkinson Hyperlegible Next for text, Martian
  Mono only for hashes and data. Two heading sizes: `--step-3` for the dense sections, `--step-2`
  for the two panel sections and the commitments.
- **Two spacing rhythms:** dense sections at `clamp(64px,10vw,128px)`, the panel sections (feed,
  play) at `clamp(48px,7vw,80px)`; the seam from the receipt into the epoch carries a 4px hood rule.
- **The receipt stays the page's one light object**: it is what the project promises. It prints
  itself when scrolled into view and, if the observer never fires, after 2.5s anyway.
