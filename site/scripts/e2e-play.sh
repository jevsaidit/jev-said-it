#!/usr/bin/env bash
# The play panel end to end: anvil + the real contracts + the engine's service + this site, and a
# headless browser clicking Connect, Agree/Disagree, Submit and Claim. Every click is a real transaction.
#   U1 held 100k tokens at the epoch's start: 10 calls, answers 3, later claims its reward.
#   U2 bought after the epoch started: the panel must refuse to let it send calls that would be dropped.
set -uo pipefail
export PATH=$HOME/.foundry/bin:$PATH
HERE=$(cd "$(dirname "$0")" && pwd); SITE=$(dirname "$HERE"); ENGINE=$(dirname "$SITE")/engine; CONTRACTS=$(dirname "$SITE")/contracts
PORT_A=${ANVIL_PORT:-8548}; A=http://127.0.0.1:$PORT_A; SP=${SERVE_PORT:-18082}; S=http://127.0.0.1:$SP; WP=${SITE_PORT:-3917}; W=http://127.0.0.1:$WP
for p in $PORT_A $SP $WP; do
  if (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null; then echo "port $p already in use"; exit 2; fi
done
LOG=$(mktemp -d)
anvil --host 127.0.0.1 --port $PORT_A --silent & ANVIL=$!; SERVE=""; WEB=""
trap 'kill $ANVIL $SERVE $WEB 2>/dev/null; rm -rf $LOG' EXIT; sleep 2

MN="test test test test test test test test test test test junk"
k() { cast wallet private-key "$MN" $1; }
PK0=$(k 0); DEP=$(cast wallet address $PK0); PKS=$(k 8); SCORER=$(cast wallet address $PKS); GUARD=$(cast wallet address $(k 9))
U1=$(cast wallet address $(k 1)); U2=$(cast wallet address $(k 2)); U3=$(cast wallet address $(k 3))
ok=0; ko=0
check() { if [ "$1" = "$2" ]; then echo "  ✓ $3"; ok=$((ok+1)); else echo "  ✗ $3 — expected '$2', got '$1'"; ko=$((ko+1)); fi; }
has() { if echo "$1" | grep -q -- "$2"; then echo "  ✓ $3"; ok=$((ok+1)); else echo "  ✗ $3 — '$2' not in: $1"; ko=$((ko+1)); fi; }
send() { cast send "$@" --rpc-url $A >/dev/null; }
warp() { cast rpc evm_increaseTime $1 --rpc-url $A >/dev/null; cast rpc evm_mine --rpc-url $A >/dev/null; }
now() { cast block latest -f timestamp --rpc-url $A; }
get() { curl -s "$S$1"; }
until_() { for _ in $(seq 90); do eval "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
browse() { SHOT=$LOG/$3.png node $HERE/play.e2e.mjs $W $A $1 $2; }
E18=000000000000000000

cd $ENGINE && set -a && source .env && set +a
export DATABASE_URL="${DATABASE_URL%/*}/$(basename ${DATABASE_URL})_play"
node -e "
const pg=require('pg');const u=new URL(process.env.DATABASE_URL);const db=u.pathname.slice(1);u.pathname='/postgres';
const c=new pg.Client({connectionString:u.toString()});c.connect().then(async()=>{await c.query('DROP DATABASE IF EXISTS '+db);await c.query('CREATE DATABASE '+db);await c.end()})"
q() { node scripts/sql.mjs "$1"; }

TOK=$(cd $CONTRACTS && forge create --rpc-url $A --private-key $PK0 --broadcast test/mocks/MockERC20.sol:MockERC20 | awk '/Deployed to/{print $3}')
send $TOK 'mint(address,uint256)' $U1 100000$E18 --private-key $PK0
send $TOK 'mint(address,uint256)' $U3 20000$E18 --private-key $PK0   # U3: holds before the epoch, will reject in the wallet
warp 5; GEN=$(now)
LED=$(cd $CONTRACTS && forge create --rpc-url $A --private-key $PK0 --broadcast src/CallLedger.sol:CallLedger --constructor-args $TOK $DEP $DEP $GEN | awk '/Deployed to/{print $3}')
DIST=$(cd $CONTRACTS && forge create --rpc-url $A --private-key $PK0 --broadcast src/RewardsDistributor.sol:RewardsDistributor --constructor-args $TOK $DEP $SCORER $GUARD $GEN | awk '/Deployed to/{print $3}')
send $TOK 'mint(address,uint256)' $DIST 1000000$E18 --private-key $PK0
warp 5
send $TOK 'mint(address,uint256)' $U2 50000$E18 --private-key $PK0   # after the epoch started

export RPC_URL=$A LEDGER_RPC_URL=$A TOKEN=$TOK LAUNCH_BLOCK=0 V4_START_BLOCK=0 CONFIRMATIONS=0 \
  CALL_LEDGER=$LED KEEPER_PK=$PK0 REWARDS_DISTRIBUTOR=$DIST SCORER_PK=$PKS LEDGER_START_BLOCK=0 \
  EXCLUDE="$DIST,$LED" TOP_FRACTION=1 MODEL=stub STUB_P=0.7 QUESTIONS_PER_BATCH=3 MIN_SWAPS_LAST_HOUR=1 MIN_SWAPS_LAST_6H=1 \
  CALL_WINDOW_SEC=21600 FEED_CACHE_SEC=0 POLL_MS=1000 HEALTH_MAX_AGE_SEC=30 PORT=$SP
node --import tsx src/cli/main.ts migrate >/dev/null
B=$(cast block-number --rpc-url $A)
for i in 1 2 3; do
  q "INSERT INTO pools VALUES ('0x$(printf '%064x' $i)', '0x$(printf '%040x' $i)', $B)" >/dev/null
  q "INSERT INTO swaps VALUES ('0x$(printf '%064x' $i)', $B, $i, '0x', '0x', 0, 0, 1000000000000000000000000000000, 0, 0, 0)" >/dev/null
done
node --import tsx src/cli/main.ts serve > $LOG/serve.log 2>&1 & SERVE=$!
until_ '[ "$(get /epochs/current | jq ".questions|length")" = 3 ]'

cd $SITE
# A production build that knows the local chain (31337); real builds never do. The token address is
# what opens /api/feed/config: without it the site is pre-launch and the panel never loads the wallet.
rm -rf .next && NEXT_PUBLIC_ALLOW_ANVIL=1 NEXT_PUBLIC_ANVIL_RPC=$A NEXT_PUBLIC_TOKEN_ADDRESS=$TOK pnpm build >/dev/null
# The feed proxy caches for 30s on disk: a previous run's questions must not leak into this one.
rm -rf .next/cache/fetch-cache
ENGINE_FEED_URL=$S node_modules/.bin/next start -p $WP -H 127.0.0.1 > $LOG/site.log 2>&1 & WEB=$!
until_ "curl -sf $W/api/health"

echo "1. U1 connects, sees its capacity, answers three questions in one transaction"
R=$(browse $U1 call u1-call)
has "$(echo "$R" | jq -r .before)" "100,000" "the panel shows the balance held at epoch start"
has "$(echo "$R" | jq -r .before)" "10 of 10" "10 calls left: 100k tokens / 10k per call"
check "$(echo "$R" | jq -r .questions)" 3 "the three open questions are listed"
QID=$(get /epochs/current | jq -r '.questions[0].id // "none"')
check "$(curl -s -o /dev/null -w '%{http_code}' $W/q/$QID) $(curl -s -o /dev/null -w '%{http_code} %{content_type}' $W/api/card/q/$QID)" "200 200 image/png" "each question has its own page and card"
check "$(echo "$R" | jq -r .headerWallet)" "Switch to Robinhood Chain" "the header wallet button sees the account and the wrong network"
check "$(echo "$R" | jq -r .submitLabel)" "Submit 3 calls" "the submit button counts the picks"
has "$(echo "$R" | jq -r .tx)" "Confirmed on-chain" "the transaction is confirmed"
check "$(cast call $LED 'callsUsed(uint256,address)(uint256)' 0 $U1 --rpc-url $A)" 3 "on-chain: 3 calls recorded for U1"
H=$(echo "$R" | jq -r '.hash // empty')
if [ "$(cast call $LED 'callsUsed(uint256,address)(uint256)' 0 $U1 --rpc-url $A)" != 3 ] && [ -n "$H" ]; then
  echo "   U1 tx $H — gas limit $(cast tx $H gas --rpc-url $A), used $(cast receipt $H gasUsed --rpc-url $A)"
  cast run $H --rpc-url $A 2>&1 | grep -iE "revert|error|Gas used|OutOfGas|←" | tail -6
  echo "   U1 tx block $(cast tx $H blockNumber --rpc-url $A), to $(cast tx $H to --rpc-url $A) (ledger $LED)"
  cast calldata-decode 'submit(bytes32[],bool[])' $(cast tx $H input --rpc-url $A) | sed 's/^/   sent: /'
  echo "   chain epoch $(cast call $LED 'currentEpoch()(uint256)' --rpc-url $A), chain now $(now), genesis $GEN"
  for id in $(get /epochs/current | jq -r '.questions[].id'); do
    echo "   feed $id deadline(feed) $(get /epochs/current | jq -r --arg i $id '.questions[]|select(.id==$i).deadline') on-chain e0 $(cast call $LED 'questionDeadline(uint256,bytes32)(uint64)' 0 $id --rpc-url $A)"
  done
  cast logs --from-block 0 --address $LED 'QuestionsOpened(uint256,bytes32[],uint64)' --rpc-url $A --json | jq -r '(if type=="object" then .data else . end)[] | "   opened: block \(.blockNumber) epoch \(.topics[1]) data \(.data[0:200])"'
  tail -30 $LOG/serve.log | grep -E "questions|OPENED" | cut -c1-240
fi
has "$(echo "$R" | jq -r .after)" "7 of 10" "the panel updates to 7 calls left"
has "$(echo "$R" | jq -r .after)" "answered" "answered questions are marked"
echo "   share: the receipt of each call"
check "$(echo "$R" | jq -r '.share | length')" 3 "one 'Post on X' per call"
check "$(echo "$R" | jq -r '.shareAfterReload | length')" 3 "after a reload, the three 'Post on X' come back from CallSubmitted"
has "$(echo "$R" | jq -r '.share[0]')" "%24JEV" "the post carries the \$JEV cashtag"
SH=$(echo "$R" | jq -r '.share[0]'); URL=$(node -e "console.log(new URL(process.argv[1]).searchParams.get('url'))" "$SH")
has "$SH" "x.com/intent/post" "the button opens X's composer"
has "$(node -e "console.log(new URL(process.argv[1]).searchParams.get('text'))" "$SH")" "@jevsaidit #jevsaidit" "the post tags @jevsaidit and #jevsaidit"
P=$(echo "$URL" | sed "s|^https\?://[^/]*||")
has "$(curl -s $W$P)" 'twitter:card" content="summary_large_image' "the share page declares a large card"
IMG=$(curl -s $W$P | grep -oE 'og:image" content="[^"]+' | head -1 | sed 's/.*content="//')
check "$(curl -s -o $LOG/call.png -w '%{http_code} %{content_type}' "$W$(echo $IMG | sed "s|^https\?://[^/]*||")")" "200 image/png" "the call card renders"
[ "$(echo "$R" | jq -r '.error // empty')" ] && echo "   error: $(echo "$R" | jq -r .error) | $(echo "$R" | jq -r .panel)"

echo "2. U2 bought after the epoch started: the panel does not let it waste gas on dropped calls"
R=$(browse $U2 late u2-late)
has "$(echo "$R" | jq -r .before)" "You bought after this epoch started" "U2 is told why"
check "$(echo "$R" | jq -r .submitDisabled) $(echo "$R" | jq -r .agreeDisabled)" "true true" "submit and the picks are disabled"

echo "2b. U3 presses Reject in the wallet: the panel says so, and nothing was sent"
R=$(browse $U3 reject u3-reject)
has "$(echo "$R" | jq -r .tx)" "You rejected it in the wallet" "the rejection is named, not shown as a selector"
check "$(echo "$R" | jq -r '.hash // "none"')" none "no transaction hash: nothing left the wallet"
check "$(cast call $LED 'callsUsed(uint256,address)(uint256)' 0 $U3 --rpc-url $A)" 0 "on-chain: 0 calls recorded for U3"
[ "$(echo "$R" | jq -r '.error // empty')" ] && echo "   error: $(echo "$R" | jq -r .error) | $(echo "$R" | jq -r .panel)"

echo "3. the epoch settles, the root is published, U1 claims from the panel"
DL=$(get /epochs/0 | jq -r '.questions[0].deadline')
warp $(( DL - $(now) + 60 )); B=$(cast block-number --rpc-url $A)
for pair in "1 900000000000000000000000000000" "2 1100000000000000000000000000000" "3 950000000000000000000000000000"; do
  set -- $pair; (cd $ENGINE && q "INSERT INTO swaps VALUES ('0x$(printf '%064x' $1)', $B, $1, '0x', '0x', 0, 0, $2, 0, 0, 0)") >/dev/null
done
warp 21700
until_ '[ "$(get /leaderboard/0 | jq -r .state)" = PUBLISHED ]'
check "$(get /leaderboard/0 | jq -r .state)" PUBLISHED "epoch 0 published by the engine"; [ "$(get /leaderboard/0 | jq -r .state)" = PUBLISHED ] || { echo "   leaderboard: $(get /leaderboard/0 | cut -c1-400)"; (cd $ENGINE && q "SELECT epoch,state,reason FROM epochs ORDER BY epoch"); }
warp 43300
R=$(browse $U1 claim u1-claim)
has "$(echo "$R" | jq -r .tx)" "Confirmed on-chain" "the claim transaction is confirmed"
check "$(cast call $DIST 'hasClaimed(uint256,address)(bool)' 0 $U1 --rpc-url $A)" true "on-chain: U1 has claimed epoch 0"
has "$(echo "$R" | jq -r .after)" "claimed" "the panel marks the reward as claimed"
echo "   share: the receipt of the win, and a forged one"
has "$(echo "$R" | jq -r '.share[0]')" "%2Fw%2F0%2F" "a 'Post on X' for the win"
check "$(curl -s -o $LOG/win.png -w '%{http_code} %{content_type}' $W/api/card/win/0/$U1)" "200 image/png" "the win card renders from the published epoch"
check "$(curl -s -o /dev/null -w '%{http_code}' $W/api/card/win/0/$U2) $(curl -s -o /dev/null -w '%{http_code}' $W/w/0/$U2)" "404 404" "no card and no page for a reward that was not published"
[ "$(echo "$R" | jq -r '.error // empty')" ] && echo "   error: $(echo "$R" | jq -r .error) | $(echo "$R" | jq -r .panel)"

check "$(curl -s -o /dev/null -w '%{http_code}' $W/api/feed/calibration) $(curl -s $W/api/feed/calibration | jq -r 'has("resolved")')" "200 true" "Jev's record is public through the site"
check "$(curl -s -o /dev/null -w '%{http_code}' $W/api/feed/treasury) $(curl -s $W/api/feed/treasury | jq -r 'type')" "200 array" "the treasury log is public through the site"
# It may answer "not measurable" (502) off mainnet, but it must ANSWER: an unbounded read of it kept the
# whole page loading on 22/09/2026, and the e2e only saw it as "the panel is empty".
CURVE_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 $W/api/feed/curve || echo timeout)
check "$(case $CURVE_CODE in 200|502) echo answers;; *) echo "$CURVE_CODE";; esac)" "answers" "the curve route answers within 8s"
echo "4. two wallets installed, Phantom holding window.ethereum: the header asks, remembers, recovers"
R=$(node $HERE/wallets.e2e.mjs $W)
check "$(echo "$R" | jq -r '.picker | join(",")')" "Phantom,MetaMask" "both wallets are offered"
check "$(echo "$R" | jq -r .afterPick)" "0x1111…2222" "MetaMask connected and on Robinhood Chain"
check "$(echo "$R" | jq -r .phantomCalls)" 0 "Phantom was never called"
check "$(echo "$R" | jq -r .stored)" io.metamask "the pick is remembered"
check "$(echo "$R" | jq -r .phantomNote)" "Phantom can't use Robinhood Chain: pick another wallet" "Phantom's failure is named"
check "$(echo "$R" | jq -r '.pickerAgain | join(",")')" "Phantom,MetaMask" "after it, the wallets are offered again"
echo; echo "$ok passed, $ko failed"
[ -n "${KEEP_SHOTS:-}" ] && cp $LOG/*.png "$KEEP_SHOTS"/ 2>/dev/null
[ $ko -eq 0 ] || { echo "--- engine"; tail -8 $LOG/serve.log; echo "--- site"; tail -8 $LOG/site.log; }
[ $ko -eq 0 ]
