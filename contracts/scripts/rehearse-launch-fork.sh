#!/usr/bin/env bash
# Dress rehearsal of docs/runbook-launch.md §4, on a local anvil fork of Robinhood Chain MAINNET.
# Same scripts, same order, same checks as launch day; only the keys are throwaway.
#
#   §2.2 map from nonce 0 -> §4.1 DeployAdapter -> §4.4 launch from a separate EOA
#   -> §4.5 gate on the launch record -> §4.6 DeployCore -> §4.6.1 map comparison -> §4.6.2 wiring
#   -> §4.7 handover batch (acceptOwnership x3 + updateDelay 24h, executed at once) -> §4.6.3 setRouter
#   -> curve, graduation, trading, Pons' sweep -> the engine's treasury pass on the live wiring.
#
# The deployer is a FRESH random key, never the mainnet one: a rehearsal must not be able to touch
# the real deploy key's nonce, not even by a wrong --rpc-url. Broadcast records go to a temp dir,
# so broadcast/<4663>/ in the repo stays clean (runbook §4.1, first box).
# Needs FORK_RPC_URL: an RPC that keeps state (the public one prunes it after ~10 minutes).
set -uo pipefail
export PATH=$HOME/.foundry/bin:$PATH
: "${FORK_RPC_URL:?set FORK_RPC_URL to an archive RPC for Robinhood Chain mainnet}"
HERE=$(cd "$(dirname "$0")" && pwd); CONTRACTS=$(dirname "$HERE"); ENGINE=$(dirname "$CONTRACTS")/engine
WORK=$(mktemp -d); export FOUNDRY_BROADCAST=$WORK/broadcast
PORT=${ANVIL_PORT:-8551}; A=http://127.0.0.1:$PORT
anvil --fork-url "$FORK_RPC_URL" --host 127.0.0.1 --port $PORT --silent & ANVIL=$!
trap 'kill $ANVIL; rm -rf $WORK' EXIT; sleep 6

FACTORY=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
OPERATOR=0x49BbF2b70955Fb3a106e084D4BFDa92d334573d2
Z=0x0000000000000000000000000000000000000000000000000000000000000000
ZA=0x0000000000000000000000000000000000000000
MN="test test test test test test test test test test test junk"; k() { cast wallet private-key "$MN" $1; }
ad() { cast wallet address $1; }
lc() { echo "$1" | tr A-F a-f; }
ok=0; ko=0
check() { if [ "$(lc "$1")" = "$(lc "$2")" ] && [ -n "$1" ]; then echo "  ✓ $3"; ok=$((ok+1)); else echo "  ✗ $3 — expected '$2', got '$1'"; ko=$((ko+1)); fi; }
st() { cast send "$@" --rpc-url $A --json 2>/dev/null | jq -r .status; }
fund() { cast rpc anvil_setBalance $1 0x56BC75E2D63100000 --rpc-url $A >/dev/null; }   # 100 ETH
# Three states, not two: a dead RPC or a cast argument error gives an empty status, and reading that as
# "reverted" would let a negative assertion pass on a tool failure.
# A fixed gas limit skips estimation: without it a call that reverts is refused by cast before it is sent,
# no receipt exists, and every negative assertion read "not measured" (seen on 22/09/2026).
rv() { local r; r=$(st "$@" --gas-limit 1000000); case "$r" in 0x1) echo "went through";; 0x0) echo reverted;; *) echo "not measured";; esac; }
warp() { cast rpc evm_increaseTime $1 --rpc-url $A >/dev/null; cast rpc evm_mine --rpc-url $A >/dev/null; }

DEPLOYER_PK=$(cast wallet new --json | jq -r '(.data // .) | if type=="array" then .[0] else . end | .private_key'); DEPLOYER=$(ad $DEPLOYER_PK)
PROPOSER_PK=$(k 0); LAUNCH_PK=$(k 1); KEEPER_PK=$(k 2); SCORER_PK=$(k 3); TRADER_PK=$(k 8)
export DEPLOYER_PK TIMELOCK_PROPOSER=$(ad $PROPOSER_PK) KEEPER=$(ad $KEEPER_PK) SCORER=$(ad $SCORER_PK) \
  GUARDIAN=$(ad $(k 4)) COMPUTE_WALLET=$(ad $(k 5)) OPS_WALLET=$(ad $(k 6)) TEAM_WALLET=$(ad $(k 7)) \
  PONS_FEE_ESCROW=0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e UNIVERSAL_ROUTER=0x8876789976dEcBfCbBbe364623C63652db8C0904 \
  POOL_FEE=0 POOL_TICK_SPACING=200 POOL_HOOKS=0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044
LAUNCH_EOA=$(ad $LAUNCH_PK); TRADER=$(ad $TRADER_PK)
fund $DEPLOYER; fund $LAUNCH_EOA; fund $TIMELOCK_PROPOSER; fund $TRADER
cd $CONTRACTS

echo "§2.2 map from nonce 0 (deployer $DEPLOYER, throwaway)"
check "$(cast nonce $DEPLOYER --rpc-url $A)" "0" "deploy key unused"
for n in 0 1 2 3 4 5; do MAP[$n]=$(cast compute-address $DEPLOYER --nonce $n | awk '{print $NF}'); done

echo "§4.1 DeployAdapter"
SIM=$(forge script script/DeployAdapter.s.sol --rpc-url $A 2>&1)
check "$(echo "$SIM" | awk -F': ' '/chain id \(mainnet = 4663\)/{print $2; exit}' | tr -d ' ')" "4663" "simulation prints chain id 4663"
OUT=$(forge script script/DeployAdapter.s.sol --rpc-url $A --broadcast 2>&1)
export PONS_ESCROW_ADAPTER=$(echo "$OUT" | awk '/PonsEscrowAdapter \(use this/{print $NF; exit}')
check "$PONS_ESCROW_ADAPTER" "${MAP[0]}" "adapter = announced nonce 0"
check "$(cast call $PONS_ESCROW_ADAPTER 'escrow()(address)' --rpc-url $A)" "$PONS_FEE_ESCROW" "adapter.escrow = Pons escrow"
check "$(cast call $PONS_ESCROW_ADAPTER 'owner()(address)' --rpc-url $A)" "$TIMELOCK_PROPOSER" "adapter.owner = TIMELOCK_PROPOSER"
check "$(cast call $PONS_ESCROW_ADAPTER 'router()(address)' --rpc-url $A)" "$ZA" "adapter.router still empty"

echo "§4.4 launch on Pons v2 from the launch EOA (not the deploy key)"
FEE=$(cast call $FACTORY 'launchFee()(uint256)' --rpc-url $A | awk '{print $1}')
SIG='launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)'
RC=$(cast send $FACTORY "$SIG" "(\"Jev Said It\",\"JEV\",\"\",\"rehearsal\",(\"\",\"\",\"\",\"\",\"\"),$PONS_ESCROW_ADAPTER,0,false,$Z,$(cast keccak jsi-rehearsal-$RANDOM))" 0 $ZA \
  --value $FEE --private-key $LAUNCH_PK --rpc-url $A --json)
export JEVSAID_TOKEN=0x$(echo "$RC" | jq -r '.logs[] | select(.topics[0]=="0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607") | .topics[1][26:]')
LAUNCH_TX=$(echo "$RC" | jq -r .transactionHash); LAUNCH_BLOCK=$(cast tx $LAUNCH_TX blockNumber --rpc-url $A)
check "$(cast tx $LAUNCH_TX from --rpc-url $A)" "$LAUNCH_EOA" "launch tx from = launch EOA"
check "$(cast nonce $DEPLOYER --rpc-url $A)" "1" "deploy key still at nonce 1 after the launch"

echo "§4.5 gate on the launch record"
REC=$(cast call $FACTORY 'getLaunchedToken(address)' $JEVSAID_TOKEN --rpc-url $A | sed 's/^0x//' | fold -w64)
w() { echo "$REC" | sed -n "$1p"; }; wa() { echo 0x$(w $1 | cut -c25-); }
check "$(wa 1)" "$JEVSAID_TOKEN" "row 1 = token"
check "$(wa 3)" "$LAUNCH_EOA" "row 3 = launch EOA (direct launch)"
check "$(wa 4)" "$PONS_ESCROW_ADAPTER" "row 4 = PonsEscrowAdapter (who gets paid)"
check "$(cast to-dec 0x$(w 5))" "0" "row 5 = native ETH pair"
check "$(cast to-dec 0x$(w 8))" "200" "row 8 = tickSpacing 200"
check "$(cast to-dec 0x$(w 9))" "0" "row 9 = creator tax 0"
CURVE=$(wa 2)

echo "§4.6 DeployCore"
check "$(cast nonce $DEPLOYER --rpc-url $A)" "1" "nonce exactly 1 before phase 2"
SIM=$(forge script script/DeployCore.s.sol --rpc-url $A 2>&1)
check "$(echo "$SIM" | grep -c 'SIMULATION COMPLETE')" "1" "simulation complete"
OUT=$(forge script script/DeployCore.s.sol --rpc-url $A --broadcast 2>&1)
g() { echo "$OUT" | awk -v k="$1" '$1==k{print $2; exit}'; }
TIMELOCK=$(g Timelock:); FEE_ROUTER=$(g FeeRouter:); DIST=$(g RewardsDistributor:); LEDGER=$(g CallLedger:); SWAP=$(g UniV4SwapAdapter:)
echo "§4.6.1 comparison with the announced map"
check "$TIMELOCK" "${MAP[1]}" "Timelock = nonce 1"; check "$FEE_ROUTER" "${MAP[2]}" "FeeRouter = nonce 2"
check "$DIST" "${MAP[3]}" "RewardsDistributor = nonce 3"; check "$LEDGER" "${MAP[4]}" "CallLedger = nonce 4"
check "$SWAP" "${MAP[5]}" "UniV4SwapAdapter = nonce 5"

echo "§4.6.2 wiring and ownership"
check "$(cast call $SWAP 'poolOf(address)((address,address,uint24,int24,address))' $JEVSAID_TOKEN --rpc-url $A)" "($ZA, $JEVSAID_TOKEN, 0, 200, $POOL_HOOKS)" "swap adapter PoolKey"
check "$(cast call $FEE_ROUTER 'swapAdapter()(address)' --rpc-url $A)" "$SWAP" "router.swapAdapter"
check "$(cast call $FEE_ROUTER 'rewardsDistributor()(address)' --rpc-url $A)" "$DIST" "router.rewardsDistributor"
check "$(cast call $FEE_ROUTER 'token()(address)' --rpc-url $A)" "$JEVSAID_TOKEN" "router.token"
check "$(cast call $FEE_ROUTER 'keeper()(address)' --rpc-url $A)" "$KEEPER" "router.keeper"
check "$(cast call $SWAP 'universalRouter()(address)' --rpc-url $A)" "$UNIVERSAL_ROUTER" "swap adapter UniversalRouter"
for c in $FEE_ROUTER $DIST $LEDGER; do
  check "$(cast call $c 'owner()(address)' --rpc-url $A)" "$DEPLOYER" "$c owner = deployer (until acceptOwnership)"
  check "$(cast call $c 'pendingOwner()(address)' --rpc-url $A)" "$TIMELOCK" "$c pendingOwner = timelock"
done
check "$(cast call $SWAP 'owner()(address)' --rpc-url $A)" "$TIMELOCK" "swap adapter owner = timelock already"

echo "§4.7 handover batch, right away: acceptOwnership x3 + updateDelay(86400), delay 0"
check "$(cast call $TIMELOCK 'getMinDelay()(uint256)' --rpc-url $A)" "0" "the timelock is born with delay 0"
UPD=$(cast calldata 'updateDelay(uint256)' 86400)
TARGETS="[$FEE_ROUTER,$DIST,$LEDGER,$TIMELOCK]"; SELS="[0x79ba5097,0x79ba5097,0x79ba5097,$UPD]"
check "$(st $TIMELOCK 'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)' "$TARGETS" "[0,0,0,0]" "$SELS" $Z $Z 0 --private-key $PROPOSER_PK)" "0x1" "scheduleBatch by the proposer"
check "$(st $TIMELOCK 'executeBatch(address[],uint256[],bytes[],bytes32,bytes32)' "$TARGETS" "[0,0,0,0]" "$SELS" $Z $Z --private-key $TRADER_PK)" "0x1" "executeBatch at once, by anyone"
check "$(cast call $TIMELOCK 'getMinDelay()(uint256)' --rpc-url $A | awk '{print $1}')" "86400" "the delay is now 24h"
for c in $FEE_ROUTER $DIST $LEDGER $SWAP; do check "$(cast call $c 'owner()(address)' --rpc-url $A)" "$TIMELOCK" "$c owner = timelock"; done
check "$(rv $TIMELOCK 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' $FEE_ROUTER 0 $(cast calldata 'setKeeper(address)' $TRADER) $Z $Z 3600 --private-key $PROPOSER_PK)" "reverted" "from now on nothing can be scheduled under 24h"

echo "§4.6.3 setRouter, only once"
check "$(st $PONS_ESCROW_ADAPTER 'setRouter(address)' $FEE_ROUTER --private-key $PROPOSER_PK)" "0x1" "setRouter from the proposer"
check "$(cast call $PONS_ESCROW_ADAPTER 'router()(address)' --rpc-url $A)" "$FEE_ROUTER" "adapter.router = FeeRouter"
check "$(rv $PONS_ESCROW_ADAPTER 'setRouter(address)' $TRADER --private-key $PROPOSER_PK)" "reverted" "a second setRouter reverts"
check "$(cast nonce $DEPLOYER --rpc-url $A)" "13" "deploy key used only by the two scripts (1 + 12 txs)"

echo "market: curve -> graduation -> v4 pool -> trading -> Pons' sweep"
warp 600
for i in $(seq 1 40); do
  [ "$(cast call $CURVE 'graduated()(bool)' --rpc-url $A)" = "true" ] && break
  st $CURVE 'buy(uint256,uint256,address)' 500000000000000000 0 $TRADER --value 0.5ether --private-key $TRADER_PK >/dev/null
done
check "$(st $FACTORY 'createGraduatedPool(address)' $JEVSAID_TOKEN --private-key $TRADER_PK)" "0x1" "createGraduatedPool"
for i in 1 2 3 4 5; do st $SWAP 'swapExactETHForToken(address,uint256,address)' $JEVSAID_TOKEN 1 $TRADER --value 1ether --private-key $TRADER_PK >/dev/null; done
cast rpc anvil_impersonateAccount $OPERATOR --rpc-url $A >/dev/null; fund $OPERATOR
POOL=$(cast keccak $(cast abi-encode 'f(address,address,uint24,int24,address)' $ZA $JEVSAID_TOKEN 0 200 $POOL_HOOKS))
check "$(cast send $POOL_HOOKS 'sweepPoolFees(bytes32,uint256,uint256)' $POOL 1 0 --from $OPERATOR --unlocked --rpc-url $A --json | jq -r .status)" "0x1" "sweep by the Pons operator"
OWED=$(cast call $PONS_FEE_ESCROW 'balanceOf(address)(uint256)' $PONS_ESCROW_ADAPTER --rpc-url $A | awk '{print $1}')
echo "   escrow owes the adapter: $OWED wei"

echo "§5-6 the engine on the live wiring: one treasury pass"
warp 18000   # 5h into the current epoch: past the latest possible buyback time, so the engine acts now
cd $ENGINE && set -a && source .env && set +a
export DATABASE_URL="${DATABASE_URL%/*}/$(basename ${DATABASE_URL})_rehearsal"
node -e "const pg=require('pg');const u=new URL(process.env.DATABASE_URL);const d=u.pathname.slice(1);u.pathname='/postgres';const c=new pg.Client({connectionString:u.toString()});c.connect().then(async()=>{await c.query('DROP DATABASE IF EXISTS '+d);await c.query('CREATE DATABASE '+d);await c.end()})"
export RPC_URL=$A LEDGER_RPC_URL=$A TOKEN=$JEVSAID_TOKEN LAUNCH_BLOCK=$LAUNCH_BLOCK V4_START_BLOCK=$LAUNCH_BLOCK \
  CALL_LEDGER=$LEDGER KEEPER_PK=$KEEPER_PK FEE_ROUTER=$FEE_ROUTER PONS_ESCROW_ADAPTER=$PONS_ESCROW_ADAPTER
node --import tsx src/cli/main.ts migrate >/dev/null
OUT=$(node --import tsx src/cli/main.ts treasury); echo "   $OUT" | cut -c1-240
check "$(echo "$OUT" | jq -r .state)" "OK" "treasury pass succeeded"
check "$(echo "$OUT" | jq -r .claimed)" "$OWED" "claimed exactly what the escrow owed"
TEAMB=$(cast call $FEE_ROUTER 'teamBalance()(uint256)' --rpc-url $A 2>/dev/null | awk '{print $1}')
echo "   team bucket after the split: ${TEAMB:-n/a} wei (20% of the claim, withdrawn by TEAM_WALLET)"
check "$([ "$(cast call $JEVSAID_TOKEN 'balanceOf(address)(uint256)' $DIST --rpc-url $A | awk '{print $1}')" != "0" ] && echo yes)" "yes" "rewards distributor holds \$JEV bought from the fees"

echo "repo hygiene: no rehearsal record under broadcast/"
check "$(ls $CONTRACTS/broadcast 2>/dev/null | wc -l)" "0" "contracts/broadcast/ untouched"

echo; echo "$ok passed, $ko failed"; [ $ko -eq 0 ]
