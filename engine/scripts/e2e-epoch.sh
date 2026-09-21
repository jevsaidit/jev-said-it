#!/usr/bin/env bash
# A whole epoch on anvil, against the repo's real CallLedger and RewardsDistributor:
# questions -> calls -> outcomes -> scores -> on-chain root -> a holder claims.
# Uses a SEPARATE database (<db>_e2e): it never touches the index one.
set -uo pipefail
export PATH=$HOME/.foundry/bin:$PATH
HERE=$(cd "$(dirname "$0")" && pwd); ENGINE=$(dirname "$HERE"); CONTRACTS=$(dirname "$ENGINE")/contracts
cd $ENGINE && set -a && source .env && set +a
A=http://127.0.0.1:${ANVIL_PORT:-8546}
anvil --host 127.0.0.1 --port ${ANVIL_PORT:-8546} --silent & ANVIL=$!; trap 'kill $ANVIL' EXIT; sleep 2

MN="test test test test test test test test test test test junk"
k() { cast wallet private-key "$MN" $1; }
PK0=$(k 0); DEP=$(cast wallet address $PK0)      # deployer + keeper
PKS=$(k 8); SCORER=$(cast wallet address $PKS)    # scorer: key distinct from the keeper (spec §9.1)
GUARD=$(cast wallet address $(k 9))
for i in 1 2 3 4 5; do eval "PK$i=$(k $i)"; eval "U$i=\$(cast wallet address \$PK$i)"; done
# U1 perfect · U2 capacity 3 · U3 always agrees · U4 buys AFTER epoch start · U5 team, excluded

ok=0; ko=0
check() { if [ "$1" = "$2" ]; then echo "  ✓ $3"; ok=$((ok+1)); else echo "  ✗ $3 — expected '$2', got '$1'"; ko=$((ko+1)); fi; }
send() { cast send "$@" --rpc-url $A >/dev/null; }
warp() { cast rpc evm_increaseTime $1 --rpc-url $A >/dev/null; cast rpc evm_mine --rpc-url $A >/dev/null; }
now() { cast block latest -f timestamp --rpc-url $A; }
head() { cast block-number --rpc-url $A; }
E18=000000000000000000

export DATABASE_URL="${DATABASE_URL%/*}/$(basename ${DATABASE_URL})_e2e"
node -e "
const pg=require('pg');const u=new URL(process.env.DATABASE_URL);const db=u.pathname.slice(1);u.pathname='/postgres';
const c=new pg.Client({connectionString:u.toString()});c.connect().then(async()=>{await c.query('DROP DATABASE IF EXISTS '+db);await c.query('CREATE DATABASE '+db);await c.end()})"
q() { node scripts/sql.mjs "$1"; }
cli() { npx tsx src/cli/main.ts "$@"; }

echo "0. deploy and balances"
TOK=$(cd $CONTRACTS && forge create --rpc-url $A --private-key $PK0 --broadcast test/mocks/MockERC20.sol:MockERC20 | awk '/Deployed to/{print $3}')
for u in $U1 $U3 $U5; do send $TOK 'mint(address,uint256)' $u 100000$E18 --private-key $PK0; done
send $TOK 'mint(address,uint256)' $U2 30000$E18 --private-key $PK0
warp 5; GEN=$(now)
LED=$(cd $CONTRACTS && forge create --rpc-url $A --private-key $PK0 --broadcast src/CallLedger.sol:CallLedger --constructor-args $TOK $DEP $DEP $GEN | awk '/Deployed to/{print $3}')
DIST=$(cd $CONTRACTS && forge create --rpc-url $A --private-key $PK0 --broadcast src/RewardsDistributor.sol:RewardsDistributor --constructor-args $TOK $DEP $SCORER $GUARD | awk '/Deployed to/{print $3}')
send $TOK 'mint(address,uint256)' $DIST 1000000$E18 --private-key $PK0
warp 5; send $TOK 'mint(address,uint256)' $U4 100000$E18 --private-key $PK0   # the flash-buyer arrives after the start

export RPC_URL=$A LEDGER_RPC_URL=$A TOKEN=$TOK LAUNCH_BLOCK=0 V4_START_BLOCK=0 CONFIRMATIONS=0 \
  CALL_LEDGER=$LED KEEPER_PK=$PK0 REWARDS_DISTRIBUTOR=$DIST SCORER_PK=$PKS LEDGER_START_BLOCK=0 \
  EXCLUDE="$U5,$DIST,$LED" TOP_FRACTION=1 STUB_P=0.7 QUESTIONS_PER_BATCH=5 MIN_SWAPS_LAST_HOUR=1
cli migrate

echo "1. five pools with a price, and the questions"
B=$(head)
for i in 1 2 3 4 5; do
  q "INSERT INTO pools VALUES ('0x$(printf '%064x' $i)', '0x$(printf '%040x' $i)', $B)" >/dev/null
  q "INSERT INTO swaps VALUES ('0x$(printf '%064x' $i)', $B, $i, '0x', '0x', 0, 0, 1000000000000000000000000000000, 0, 0, 0)" >/dev/null
done
cli index >/dev/null
out=$(cli open-questions --stub); check "$(echo "$out" | jq -r '.state + " " + (.ids|length|tostring)')" "OPENED 5" "5 questions opened"
DL=$(echo "$out" | jq -r .deadline)
qid() { q "SELECT id FROM questions WHERE token = '0x$(printf '%040x' $1)'"; }
Q1=$(qid 1); Q2=$(qid 2); Q3=$(qid 3); Q4=$(qid 4); Q5=$(qid 5)

echo "2. the calls (outcomes to come: T1 up, T2 down, T3 up, T4 down, T5 no swap)"
PERF="[$Q1,$Q2,$Q3,$Q4,$Q5]"; PA="[true,false,true,false,true]"
send $LED 'submit(bytes32[],bool[])' "$PERF" "$PA" --private-key $PK1
send $LED 'submit(bytes32[],bool[])' "[$Q1,$Q2,$Q3]" "[true,false,false]" --private-key $PK2
send $LED 'submit(bytes32[],bool[])' "[$Q1,$Q2,$Q3,$Q4]" "[true,true,true,true]" --private-key $PK3
send $LED 'submit(bytes32[],bool[])' "$PERF" "$PA" --private-key $PK4
send $LED 'submit(bytes32[],bool[])' "$PERF" "$PA" --private-key $PK5
cast send $LED 'submit(bytes32[],bool[])' "[$Q4]" "[false]" --private-key $PK2 --rpc-url $A >/dev/null 2>&1
check "$?" "1" "U2 beyond its capacity (3) is rejected on-chain"

echo "3. the swaps after the deadline, then the horizon passes"
warp $(( DL - $(now) + 60 )); B=$(head)
for pair in "1 900000000000000000000000000000" "2 1100000000000000000000000000000" "3 950000000000000000000000000000" "4 1050000000000000000000000000000"; do
  set -- $pair; q "INSERT INTO swaps VALUES ('0x$(printf '%064x' $1)', $B, $1, '0x', '0x', 0, 0, $2, 0, 0, 0)" >/dev/null
done
warp 21700; cli index >/dev/null
check "$(cli resolve | jq -r .resolved)" "5" "5 questions resolved"
check "$(q "SELECT string_agg(outcome, ',' ORDER BY token) FROM questions")" "1,0,1,0,VOID" "outcomes: up, down, up, down, VOID"

echo "4. closing the epoch and on-chain root"
out=$(cli close-epoch 0 --publish); echo "   $out" | cut -c1-150
check "$(echo "$out" | jq -r .state)" "PUBLISHED" "root published and verified on the receipt"
ROOT=$(echo "$out" | jq -r .root)
check "$(cast call $DIST 'roots(uint256)(bytes32)' 0 --rpc-url $A)" "$ROOT" "on-chain roots(0) = engine root"
P=$(q "SELECT payload FROM epochs WHERE epoch = 0")
w() { echo "$P" | jq -r --arg a "$(echo $1 | tr A-F a-f)" ".wallets[] | select(.address == \$a) | $2"; }
check "$(w $U4 .callsValid)" "0" "U4 (flash-buy): 5 calls on-chain, 0 valid"
check "$(w $U5 .address)" "" "U5 (team) absent from the scores"
check "$(w $U3 .score)" "-16000000" "U3 always agrees: -0.16"
check "$(echo "$P" | jq -r '[.claims[].account] | map(ascii_downcase) | sort | join(",")')" "$(echo -e "$(echo $U1 | tr A-F a-f)\n$(echo $U2 | tr A-F a-f)" | sort | paste -sd,)" "only U1 and U2 rewarded"
AMT1=$(echo "$P" | jq -r --arg a "$(echo $U1 | tr A-F a-f)" '.claims[] | select((.account|ascii_downcase) == $a) | .amount')
check "$AMT1" "177777777777777777777777" "U1 gets 64/72 of the budget (20% of the free balance)"

echo "5. a holder claims"
warp 43300
PROOF=$(echo "$P" | jq -r --arg a "$(echo $U1 | tr A-F a-f)" '.claims[] | select((.account|ascii_downcase) == $a) | "[" + (.proof|join(",")) + "]"')
BEFORE=$(cast call $TOK 'balanceOf(address)(uint256)' $U1 --rpc-url $A | awk '{print $1}')
send $DIST 'claim(uint256,uint256,bytes32[])' 0 $AMT1 "$PROOF" --private-key $PK1
AFTER=$(cast call $TOK 'balanceOf(address)(uint256)' $U1 --rpc-url $A | awk '{print $1}')
check "$(echo "$AFTER - $BEFORE" | bc)" "$AMT1" "U1 claimed exactly its amount"
cast send $DIST 'claim(uint256,uint256,bytes32[])' 0 $AMT1 "$PROOF" --private-key $PK3 --rpc-url $A >/dev/null 2>&1
check "$?" "1" "U1's proof does not pay U3"

echo "6. re-running the close does not republish"
check "$(cli close-epoch 0 --publish | jq -r .state)" "WAIT" "epoch already published: no second tx"

echo; echo "$ok passed, $ko failed"; [ $ko -eq 0 ]
