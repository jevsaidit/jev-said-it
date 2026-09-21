#!/usr/bin/env bash
# The service (`serve`) left running on its own against anvil: it opens, resolves and closes an epoch
# with no manual commands. Then the chain is shut down, and /health must stop saying 200.
set -uo pipefail
export PATH=$HOME/.foundry/bin:$PATH
HERE=$(cd "$(dirname "$0")" && pwd); ENGINE=$(dirname "$HERE"); CONTRACTS=$(dirname "$ENGINE")/contracts
cd $ENGINE && set -a && source .env && set +a
PORT_A=${ANVIL_PORT:-8547}; A=http://127.0.0.1:$PORT_A; S=http://127.0.0.1:${SERVE_PORT:-18080}
for p in ${SERVE_PORT:-18080} $PORT_A; do
  if (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null; then echo "port $p already in use: an orphan service would skew the test"; exit 2; fi
done
anvil --host 127.0.0.1 --port $PORT_A --silent & ANVIL=$!; SERVE=""
trap 'kill $ANVIL $SERVE 2>/dev/null' EXIT; sleep 2

MN="test test test test test test test test test test test junk"
k() { cast wallet private-key "$MN" $1; }
PK0=$(k 0); DEP=$(cast wallet address $PK0); PKS=$(k 8); SCORER=$(cast wallet address $PKS); GUARD=$(cast wallet address $(k 9))
PK1=$(k 1); U1=$(cast wallet address $PK1); u1=$(echo $U1 | tr A-F a-f)
ok=0; ko=0
check() { if [ "$1" = "$2" ]; then echo "  ✓ $3"; ok=$((ok+1)); else echo "  ✗ $3 — expected '$2', got '$1'"; ko=$((ko+1)); fi; }
send() { cast send "$@" --rpc-url $A >/dev/null; }
warp() { cast rpc evm_increaseTime $1 --rpc-url $A >/dev/null; cast rpc evm_mine --rpc-url $A >/dev/null; }
now() { cast block latest -f timestamp --rpc-url $A; }
get() { curl -s "$S$1"; }
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
# CALL_WINDOW_SEC=21600: a single batch per epoch (deadline = end of epoch - margin). With the default
# window (2h) the loop legitimately opens more batches in the same epoch on the same tokens, and a
# test looking for "the id of the question on token X" would find two: a race in the test, not in the engine.
# Waits up to 60s for a condition on the feed to become true: the service works on its own.
until_() { for _ in $(seq 60); do eval "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
E18=000000000000000000

export DATABASE_URL="${DATABASE_URL%/*}/$(basename ${DATABASE_URL})_svc"
node -e "
const pg=require('pg');const u=new URL(process.env.DATABASE_URL);const db=u.pathname.slice(1);u.pathname='/postgres';
const c=new pg.Client({connectionString:u.toString()});c.connect().then(async()=>{await c.query('DROP DATABASE IF EXISTS '+db);await c.query('CREATE DATABASE '+db);await c.end()})"
q() { node scripts/sql.mjs "$1"; }

TOK=$(cd $CONTRACTS && forge create --rpc-url $A --private-key $PK0 --broadcast test/mocks/MockERC20.sol:MockERC20 | awk '/Deployed to/{print $3}')
send $TOK 'mint(address,uint256)' $U1 100000$E18 --private-key $PK0
warp 5; GEN=$(now)
LED=$(cd $CONTRACTS && forge create --rpc-url $A --private-key $PK0 --broadcast src/CallLedger.sol:CallLedger --constructor-args $TOK $DEP $DEP $GEN | awk '/Deployed to/{print $3}')
DIST=$(cd $CONTRACTS && forge create --rpc-url $A --private-key $PK0 --broadcast src/RewardsDistributor.sol:RewardsDistributor --constructor-args $TOK $DEP $SCORER $GUARD $GEN | awk '/Deployed to/{print $3}')
send $TOK 'mint(address,uint256)' $DIST 1000000$E18 --private-key $PK0

export RPC_URL=$A LEDGER_RPC_URL=$A TOKEN=$TOK LAUNCH_BLOCK=0 V4_START_BLOCK=0 CONFIRMATIONS=0 \
  CALL_LEDGER=$LED KEEPER_PK=$PK0 REWARDS_DISTRIBUTOR=$DIST SCORER_PK=$PKS LEDGER_START_BLOCK=0 \
  EXCLUDE="$DIST,$LED" TOP_FRACTION=1 MODEL=stub STUB_P=0.7 QUESTIONS_PER_BATCH=3 MIN_SWAPS_LAST_HOUR=1 MIN_SWAPS_LAST_6H=1 \
  CALL_WINDOW_SEC=21600 FEED_CACHE_SEC=0 POLL_MS=1000 HEALTH_MAX_AGE_SEC=8 PORT=${SERVE_PORT:-18080}
npx tsx src/cli/main.ts migrate
B=$(cast block-number --rpc-url $A)
for i in 1 2 3; do
  q "INSERT INTO pools VALUES ('0x$(printf '%064x' $i)', '0x$(printf '%040x' $i)', $B)" >/dev/null
  q "INSERT INTO swaps VALUES ('0x$(printf '%064x' $i)', $B, $i, '0x', '0x', 0, 0, 1000000000000000000000000000000, 0, 0, 0)" >/dev/null
done
# node directly, not npx: npx leaves a child the trap does not kill, and the next run would talk to
# an orphan service connected to a database that no longer exists (it happened on 21/09).
node --import tsx src/cli/main.ts serve > /tmp/jsi-serve-$$.log 2>&1 & SERVE=$!

echo "1. the service comes up and opens the questions on its own"
until_ '[ "$(code $S/health)" = 200 ]'; check "$(code $S/health)" 200 "/health 200"
until_ '[ "$(get /epochs/current | jq ".questions|length")" = 3 ]'
check "$(get /epochs/current | jq '.questions|length')" 3 "3 questions opened by the loop, with no commands"
check "$(get /health | jq -r .model)" "stub-fixed-0.7" "/health declares which model answered"
# The shape the site (site/README.md) expects for each question.
check "$(get /epochs/current | jq -r '.questions[0] | [has("id","token","symbol","p","model","deadline","status","outcome") | tostring] | unique | join(",")')" "true" "/epochs/current has the fields the site reads"
check "$(get /epochs/current | jq -r '.questions[0].status')" "OPEN" "status OPEN while the calls are open"
ID=$(get /epochs/current | jq -r '.questions[0].id')
check "$(cast keccak "$(get /q/$ID.json)")" "$ID" "keccak256 of /q/<id>.json = id: the commitment is verifiable from the feed"
check "$(code -X POST $S/health) $(code $S/nope) $(code $S/q/0x$(printf '%064x' 0).json)" "405 404 404" "unknown methods and paths rejected"
lc() { echo "$1" | tr A-F a-f; }
check "$(get /config | jq -r '[.chainId, .callLedger, .rewardsDistributor, .token] | map(tostring) | join(",")' | tr A-F a-f)" "31337,$(lc $LED),$(lc $DIST),$(lc $TOK)" "/config: the chain and the contracts the engine scores"
check "$(get /holder/$U1 | jq -r '[.balanceAtStart, .capacityAtStart, (.claims|length)] | join(",")')" "100000$E18,10,0" "/holder: U1 counted at epoch start, 100k tokens = 10 calls"
check "$(get /holder/$(cast wallet address $(k 5)) | jq -r '[.balanceAtStart, .capacityAtStart] | join(",")')" "0,0" "/holder: a wallet with no tokens has no calls"

echo "2. a holder answers, time passes, the service resolves and pays on its own"
qid() { get /epochs/0 | jq -r --arg t "0x$(printf '%040x' $1)" '.questions[] | select(.token == $t) | .id'; }
send $LED 'submit(bytes32[],bool[])' "[$(qid 1),$(qid 2),$(qid 3)]" "[true,false,true]" --private-key $PK1
DL=$(get /epochs/0 | jq -r '.questions[0].deadline')
warp $(( DL - $(now) + 60 )); B=$(cast block-number --rpc-url $A)
for pair in "1 900000000000000000000000000000" "2 1100000000000000000000000000000" "3 950000000000000000000000000000"; do
  set -- $pair; q "INSERT INTO swaps VALUES ('0x$(printf '%064x' $1)', $B, $1, '0x', '0x', 0, 0, $2, 0, 0, 0)" >/dev/null
done
warp 21700
until_ '[ "$(get /leaderboard/0 | jq -r .state)" = PUBLISHED ]'
check "$(get /epochs/0 | jq -r '[.questions | sort_by(.token)[].outcome] | join(",")')" "1,0,1" "outcomes in the feed (T1 up, T2 down, T3 up)"
check "$(get /epochs/0 | jq -r '[.questions[].status] | unique | join(",")')" "RESOLVED" "status RESOLVED once the outcome is decided"
check "$(get /leaderboard/0 | jq -r .state)" PUBLISHED "epoch 0 closed and root published by the loop"
check "$(get /calibration | jq -r '.resolved, .modelBeatsBaseline' | paste -sd' ')" "3 true" "public calibration: 3 resolved, the model beats the baseline"
AMT=$(get /claim/0/$U1 | jq -r .amount); PROOF=$(get /claim/0/$U1 | jq -c .proof | tr -d '"')
warp 43300
send $DIST 'claim(uint256,uint256,bytes32[])' 0 $AMT "$PROOF" --private-key $PK1
check "$(cast call $DIST 'hasClaimed(uint256,address)(bool)' 0 $U1 --rpc-url $A)" true "U1 claims with the proof taken from the feed"
check "$(get /holder/$U1 | jq -r '.claims | map("\(.epoch):\(.amount)") | join(",")')" "0:$AMT" "/holder lists the published reward the site offers to claim"

echo "3. the chain disappears: /health stops saying 200, then the process exits to get restarted"
kill $ANVIL; sleep 12
check "$(code $S/health)" 503 "/health 503 when the engine cannot see the chain"
# Railway's healthcheck only applies at deploy: a blind engine must exit on its own, so the
# restart policy brings it back up. Code 3, and the log says why.
for _ in $(seq 90); do kill -0 $SERVE 2>/dev/null || break; sleep 1; done
wait $SERVE; rc=$?; SERVE=""
check "$rc" 3 "the blind process exits with code 3"
check "$(grep -c 'exiting, to be restarted' /tmp/jsi-serve-$$.log)" 1 "and the log says why"

echo; echo "$ok passed, $ko failed"; [ $ko -eq 0 ] || { echo "--- service log"; tail -20 /tmp/jsi-serve-$$.log; }
rm -f /tmp/jsi-serve-$$.log; [ $ko -eq 0 ]
