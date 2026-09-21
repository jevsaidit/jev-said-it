#!/usr/bin/env bash
# End-to-end test of block 2 on anvil, against the repo's real CallLedger.
set -uo pipefail
export PATH=$HOME/.foundry/bin:$PATH
# Requires: anvil and forge in PATH, development Postgres in .env, up-to-date v4 index (`index`).
HERE=$(cd "$(dirname "$0")" && pwd); ENGINE=$(dirname "$HERE"); CONTRACTS=$(dirname "$ENGINE")/contracts
A=http://127.0.0.1:${ANVIL_PORT:-8545}
anvil --host 127.0.0.1 --port ${ANVIL_PORT:-8545} --silent & ANVIL=$!; trap 'kill $ANVIL' EXIT; sleep 2
PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # keeper (anvil test key)
PK1=$(cast wallet private-key "test test test test test test test test test test test junk" 1)
DEP=$(cast wallet address $PK0)
TOK=$(cd $CONTRACTS && forge create --rpc-url $A --private-key $PK0 --broadcast test/mocks/MockERC20.sol:MockERC20 | awk '/Deployed to/{print $3}')
GEN=$(( $(cast block latest -f timestamp --rpc-url $A) - 3600 ))   # epoch 0 started an hour ago
LED=$(cd $CONTRACTS && forge create --rpc-url $A --private-key $PK0 --broadcast src/CallLedger.sol:CallLedger --constructor-args $TOK $DEP $DEP $GEN | awk '/Deployed to/{print $3}')
U1=$(cast wallet address $PK1)
cd $ENGINE && set -a && source .env && set +a
# Its own database, like the other tests: on 21/09 this script wrote into the main one, and its
# anvil questions were read as testnet epoch 0.
export DATABASE_URL="${DATABASE_URL%/*}/$(basename ${DATABASE_URL})_anvil"
node -e "
const pg=require('pg');const u=new URL(process.env.DATABASE_URL);const db=u.pathname.slice(1);u.pathname='/postgres';
const c=new pg.Client({connectionString:u.toString()});c.connect().then(async()=>{await c.query('DROP DATABASE IF EXISTS '+db);await c.query('CREATE DATABASE '+db);await c.end()})"
export LEDGER_RPC_URL=$A CALL_LEDGER=$LED KEEPER_PK=$PK0
npx tsx src/cli/main.ts migrate
q() { node scripts/sql.mjs "$1"; }
# Seeded candidates: 10 pools with recent swaps, at blocks close to the mainnet head. This way the
# test does not depend on another database's index (it did, silently, until 21/09).
H=$(cast block-number --rpc-url $RPC_URL)
q "INSERT INTO cursors VALUES ('v4', $H) ON CONFLICT (name) DO UPDATE SET block = EXCLUDED.block" >/dev/null
for i in $(seq 1 10); do
  q "INSERT INTO pools VALUES ('0x$(printf '%064x' $i)', '0x$(printf '%040x' $i)', $((H - 1000)))" >/dev/null
  for j in $(seq 1 $((20 - i))); do q "INSERT INTO swaps VALUES ('0x$(printf '%064x' $i)', $((H - 100 + j)), $i, '0x', '0x', 0, 0, 1000000000000000000000000000000, 0, 0, 0)" >/dev/null; done
  # Pools 1-9 also traded between 1h and 6h ago (60 swaps); pool 10 is a one-hour burst on an
  # otherwise dead pool: 10 swaps in the last hour and nothing before. The 6h floor must drop it.
  if [ $i -le 9 ]; then
    V=$(for j in $(seq 1 60); do printf "('0x%064x', %d, %d, '0x', '0x', 0, 0, 1000000000000000000000000000000, 0, 0, 0)," $i $((H - 170000 + j)) $((i * 1000 + j)); done)
    q "INSERT INTO swaps VALUES ${V%,}" >/dev/null
  fi
done
ok=0; ko=0
check() { if [ "$1" = "$2" ]; then echo "  ✓ $3"; ok=$((ok+1)); else echo "  ✗ $3 — expected '$2', got '$1'"; ko=$((ko+1)); fi; }
q "DELETE FROM questions" >/dev/null   # DEVELOPMENT database: never against the production one

echo "1. opening a batch"
out=$(npx tsx src/cli/main.ts open-questions --stub); echo "   $out" | cut -c1-160
check "$(echo "$out" | jq -r .state)" OPENED "batch opened"
check "$(q "SELECT count(*) FROM questions") $(q "SELECT count(*) FROM questions WHERE token = '0x$(printf '%040x' 10)'")" "9 0" "9 questions: the one-hour burst pool (10) is dropped by the 6h floor"
EPOCH=$(echo "$out" | jq -r .epoch); DL=$(echo "$out" | jq -r .deadline)
ID0=$(echo "$out" | jq -r '.ids[0]'); ID1=$(echo "$out" | jq -r '.ids[1]')

echo "2. the commitment: keccak256 of the stored JSON = on-chain id"
J=$(q "SELECT json FROM questions WHERE id='$ID0'")
check "$(cast keccak "$J")" "$ID0" "hash of the publishable JSON = questionId"
check "$(cast call $LED 'questionDeadline(uint256,bytes32)(uint64)' $EPOCH $ID0 --rpc-url $A | awk '{print $1}')" "$DL" "deadline recorded on-chain"
echo "   JSON: $J" | cut -c1-220

echo "3. the question can be answered by a holder"
cast send $TOK 'mint(address,uint256)' $U1 100000000000000000000000 --private-key $PK0 --rpc-url $A >/dev/null
r=$(cast send $LED 'submit(bytes32[],bool[])' "[$ID0,$ID1]" "[true,false]" --private-key $PK1 --rpc-url $A --json | jq -r '.status, (.logs|length)' | tr '\n' ' ')
check "$r" "0x1 2 " "submit succeeded, 2 CallSubmitted"

echo "4. no second batch on top of an open one"
check "$(npx tsx src/cli/main.ts open-questions --stub | jq -r .state)" SKIPPED "second batch refused"

echo "5. after the deadline the call is closed"
NOW=$(cast block latest -f timestamp --rpc-url $A); cast rpc evm_increaseTime $((DL - NOW + 1)) --rpc-url $A >/dev/null; cast rpc evm_mine --rpc-url $A >/dev/null
cast send $LED 'submit(bytes32[],bool[])' "[$ID0]" "[true]" --private-key $PK1 --rpc-url $A >/dev/null 2>&1
check "$?" "1" "submit after the deadline reverted"

echo "6. 20 minutes before the end of the epoch the engine does not open"
END=$(( GEN + (EPOCH + 1) * 21600 )); NOW=$(cast block latest -f timestamp --rpc-url $A)
cast rpc evm_increaseTime $((END - 1200 - NOW)) --rpc-url $A >/dev/null; cast rpc evm_mine --rpc-url $A >/dev/null
out=$(npx tsx src/cli/main.ts open-questions --stub); echo "   $out" | cut -c1-160
check "$(echo "$out" | jq -r .state)" SKIPPED "refusal below the minimum window"

echo "7. in the next epoch it opens again, with the right epoch"
cast rpc evm_increaseTime 1300 --rpc-url $A >/dev/null; cast rpc evm_mine --rpc-url $A >/dev/null
out=$(npx tsx src/cli/main.ts open-questions --stub)
check "$(echo "$out" | jq -r .state) $(echo "$out" | jq -r .epoch)" "OPENED $((EPOCH+1))" "batch opened in epoch $((EPOCH+1))"

echo "8. the same key on mainnet refuses to use the fake model"
msg=$(LEDGER_RPC_URL=$RPC_URL npx tsx src/cli/main.ts open-questions --stub 2>&1); rc=$?
# Code AND message: a 2 for another reason (for example the ledger guard) does not count.
check "$rc $(echo "$msg" | grep -c 'stubModel refused')" "2 1" "stub refused on 4663, for the right reason"

echo; echo "$ok passed, $ko failed"; [ $ko -eq 0 ]
