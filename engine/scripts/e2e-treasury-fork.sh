#!/usr/bin/env bash
# The treasury on real Pons contracts: a local anvil fork of Robinhood Chain mainnet.
# Launch (fee recipient = our adapter), curve, pool, trading, Pons' sweep (impersonated), then the
# engine alone collects the escrow and runs the buyback with its own minOut.
# Needs FORK_RPC_URL: an RPC that keeps state (the public one prunes it after ~10 minutes).
set -uo pipefail
export PATH=$HOME/.foundry/bin:$PATH
: "${FORK_RPC_URL:?set FORK_RPC_URL to an archive RPC for Robinhood Chain mainnet}"
HERE=$(cd "$(dirname "$0")" && pwd); ENGINE=$(dirname "$HERE"); CONTRACTS=$(dirname "$ENGINE")/contracts
cd $ENGINE && set -a && source .env && set +a
PORT=${ANVIL_PORT:-8549}; A=http://127.0.0.1:$PORT
anvil --fork-url "$FORK_RPC_URL" --host 127.0.0.1 --port $PORT --silent & ANVIL=$!; trap 'kill $ANVIL' EXIT; sleep 6

FACTORY=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e; ESCROW=0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e
HOOK=0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044; UR=0x8876789976dEcBfCbBbe364623C63652db8C0904
OPERATOR=0x49BbF2b70955Fb3a106e084D4BFDa92d334573d2
MN="test test test test test test test test test test test junk"; k() { cast wallet private-key "$MN" $1; }
PK0=$(k 0); OWNER=$(cast wallet address $PK0); PKK=$(k 1); KEEPER=$(cast wallet address $PKK)
PKT=$(k 2); TRADER=$(cast wallet address $PKT); SCORER=$(cast wallet address $(k 3)); GUARD=$(cast wallet address $(k 4))
ok=0; ko=0
check() { if [ "$1" = "$2" ]; then echo "  ✓ $3"; ok=$((ok+1)); else echo "  ✗ $3 — expected '$2', got '$1'"; ko=$((ko+1)); fi; }
send() { cast send "$@" --rpc-url $A --json | jq -r .status; }
fc() { (cd $CONTRACTS && forge create --rpc-url $A --private-key $PK0 --broadcast "$@" 2>&1 | awk '/Deployed to/{print $3}'); }

echo "1. adapter, then the launch that names it as fee recipient"
ADAPTER=$(fc src/PonsEscrowAdapter.sol:PonsEscrowAdapter --constructor-args $ESCROW $OWNER)
FEE=$(cast call $FACTORY 'launchFee()(uint256)' --rpc-url $A | awk '{print $1}')
SIG='launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)'
RC=$(cast send $FACTORY "$SIG" "(\"Treasury Fork\",\"TFORK\",\"\",\"fork\",(\"\",\"\",\"\",\"\",\"\"),$ADAPTER,0,false,0x0000000000000000000000000000000000000000000000000000000000000000,$(cast keccak tfork-$RANDOM))" 0 0x0000000000000000000000000000000000000000 --value $FEE --private-key $PK0 --rpc-url $A --json)
TOKEN=0x$(echo "$RC" | jq -r '.logs[] | select(.topics[0]=="0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607") | .topics[1][26:]')
LAUNCH_BLOCK=$(echo "$RC" | jq -r .blockNumber | cast to-dec)
REC=$(cast call $FACTORY 'getLaunchedToken(address)' $TOKEN --rpc-url $A | sed 's/^0x//' | fold -w64)
CURVE=0x$(echo "$REC" | sed -n 2p | cut -c25-)
check "$(echo "$REC" | sed -n 4p | cut -c25- | tr A-F a-f)" "$(echo ${ADAPTER:2} | tr A-F a-f)" "word 3 of the launch record = our adapter"

echo "2. curve -> graduation -> v4 pool"
cast rpc evm_increaseTime 600 --rpc-url $A >/dev/null; cast rpc evm_mine --rpc-url $A >/dev/null
for i in $(seq 1 30); do
  [ "$(cast call $CURVE 'graduated()(bool)' --rpc-url $A)" = "true" ] && break
  send $CURVE 'buy(uint256,uint256,address)' 500000000000000000 0 $TRADER --value 0.5ether --private-key $PKT >/dev/null
done
check "$(send $FACTORY 'createGraduatedPool(address)' $TOKEN --private-key $PKT)" "0x1" "createGraduatedPool"

echo "3. project contracts, wired"
SWAP=$(fc src/adapters/UniV4SwapAdapter.sol:UniV4SwapAdapter --constructor-args $UR $OWNER)
send $SWAP 'setPool(address,uint24,int24,address)' $TOKEN 0 200 $HOOK --private-key $PK0 >/dev/null
ROUTER=$(fc src/FeeRouter.sol:FeeRouter --constructor-args $TOKEN $OWNER $(cast wallet address $(k 5)) $(cast wallet address $(k 6)) $(cast wallet address $(k 7)) $KEEPER)
DIST=$(fc src/RewardsDistributor.sol:RewardsDistributor --constructor-args $TOKEN $OWNER $SCORER $GUARD)
send $ROUTER 'setSwapAdapter(address)' $SWAP --private-key $PK0 >/dev/null
send $ROUTER 'setRewardsDistributor(address)' $DIST --private-key $PK0 >/dev/null
send $ADAPTER 'setRouter(address)' $ROUTER --private-key $PK0 >/dev/null
# genesis 5h ago: we are past the last possible buyback time of epoch 0, so the engine must act now
NOW=$(cast block latest -f timestamp --rpc-url $A)
LEDGER=$(fc src/CallLedger.sol:CallLedger --constructor-args $TOKEN $OWNER $KEEPER $((NOW - 18000)))

echo "4. trading, then Pons' operator sweeps the pool"
for i in 1 2 3 4 5; do send $SWAP 'swapExactETHForToken(address,uint256,address)' $TOKEN 1 $TRADER --value 1ether --private-key $PKT >/dev/null; done
cast rpc anvil_impersonateAccount $OPERATOR --rpc-url $A >/dev/null; cast rpc anvil_setBalance $OPERATOR 0xDE0B6B3A7640000 --rpc-url $A >/dev/null
POOL=$(cast keccak $(cast abi-encode 'f(address,address,uint24,int24,address)' 0x0000000000000000000000000000000000000000 $TOKEN 0 200 $HOOK))
check "$(cast send $HOOK 'sweepPoolFees(bytes32,uint256,uint256)' $POOL 1 0 --from $OPERATOR --unlocked --rpc-url $A --json | jq -r .status)" "0x1" "sweep by the Pons operator"
OWED=$(cast call $ESCROW 'balanceOf(address)(uint256)' $ADAPTER --rpc-url $A | awk '{print $1}'); echo "   escrow owes the adapter: $OWED wei"

echo "5. the engine: one treasury pass"
export DATABASE_URL="${DATABASE_URL%/*}/$(basename ${DATABASE_URL})_fork"
node -e "const pg=require('pg');const u=new URL(process.env.DATABASE_URL);const d=u.pathname.slice(1);u.pathname='/postgres';const c=new pg.Client({connectionString:u.toString()});c.connect().then(async()=>{await c.query('DROP DATABASE IF EXISTS '+d);await c.query('CREATE DATABASE '+d);await c.end()})"
export RPC_URL=$A LEDGER_RPC_URL=$A TOKEN=$TOKEN LAUNCH_BLOCK=$LAUNCH_BLOCK V4_START_BLOCK=$LAUNCH_BLOCK CALL_LEDGER=$LEDGER KEEPER_PK=$PKK \
  FEE_ROUTER=$ROUTER PONS_ESCROW_ADAPTER=$ADAPTER
node --import tsx src/cli/main.ts migrate
OUT=$(node --import tsx src/cli/main.ts treasury); echo "   $OUT" | cut -c1-240
check "$(echo "$OUT" | jq -r .state)" "OK" "treasury pass succeeded"
check "$(echo "$OUT" | jq -r .claimed)" "$OWED" "claimed exactly what the escrow owed"
check "$(cast call $ESCROW 'balanceOf(address)(uint256)' $ADAPTER --rpc-url $A | awk '{print $1}')" "0" "escrow owes nothing after the claim"
OUTTOK=$(echo "$OUT" | jq -r .swapped.tokenOut); MINOUT=$(echo "$OUT" | jq -r .swapped.minOut)
check "$([ -n "$MINOUT" ] && [ "$MINOUT" != "null" ] && [ "$(echo "$OUTTOK >= $MINOUT" | bc)" = 1 ] && echo yes)" "yes" "buyback delivered at least the engine's minOut"
echo "   minOut / delivered = $(echo "scale=4; $MINOUT / $OUTTOK" | bc)   (the slippage margin actually left)"
check "$([ "$(cast call $TOKEN 'balanceOf(address)(uint256)' $DIST --rpc-url $A | awk '{print $1}')" != "0" ] && echo yes)" "yes" "the rewards distributor holds tokens"
check "$(cast call $ROUTER 'swapBalance()(uint256)' --rpc-url $A | awk '{print $1}')" "0" "swap bucket emptied"

echo "6. a second pass in the same epoch does not buy again"
OUT2=$(node --import tsx src/cli/main.ts treasury)
check "$(echo "$OUT2" | jq -r '.swapped // "none"')" "none" "no second buyback in epoch 0"
check "$(node scripts/sql.mjs "SELECT count(*) FROM treasury_ops WHERE kind = 'SWAP'")" "1" "one SWAP recorded for the public /treasury"

echo; echo "$ok passed, $ko failed"; [ $ko -eq 0 ]
