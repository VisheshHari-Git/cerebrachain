#!/usr/bin/env bash
# Start the full network: local blockchain, trust layer + dashboard, Flower SuperLink,
# one Flower SuperNode per hospital, then run the federation.
#
#   bash scripts/run_demo.sh                         # 4 hospitals, 5 rounds, Hospital D attacks (boost)
#   bash scripts/run_demo.sh --attack none           # everyone honest
#   bash scripts/run_demo.sh --attack tamper --attack-rounds 2
#   bash scripts/run_demo.sh --mode local            # same protocol in one process, without Flower
#   bash scripts/run_demo.sh --no-chain --rounds 2   # skip the blockchain
#
# Dashboard: http://127.0.0.1:8787   Logs: runs/logs/
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .venv/bin/activate ] && source .venv/bin/activate

MODE=flower; ROUNDS=5; H=4; ATTACK=boost; ATTACKER=""; ATTACK_ROUNDS=all; CHAIN=1; KEEP=1; DEVICE=auto; EPOCHS=3
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE=$2; shift 2;;
    --rounds) ROUNDS=$2; shift 2;;
    --hospitals) H=$2; shift 2;;
    --attack) ATTACK=$2; shift 2;;
    --attacker) ATTACKER=$2; shift 2;;
    --attack-rounds) ATTACK_ROUNDS=$2; shift 2;;
    --epochs) EPOCHS=$2; shift 2;;
    --device) DEVICE=$2; shift 2;;
    --no-chain) CHAIN=0; shift;;
    --exit) KEEP=0; shift;;
    -h|--help) sed -n 2,12p "$0"; exit 0;;
    *) echo "unknown option $1"; exit 1;;
  esac
done
ATTACKER=${ATTACKER:-$((H - 1))}

[ -s zk/build/meta.json ] || { echo "ZK setup has not finished: run bash scripts/setup.sh"; exit 1; }
[ -d "data/hospital_$((H - 1))" ] || python -m cerebrachain.data --source synthetic --hospitals "$H" --out data

LOGS="$ROOT/runs/logs"; mkdir -p "$LOGS"
PIDS=()
# Each service gets its own process group so cleanup can stop it with all its children.
# Linux has `setsid`; macOS does not, so fall back to a two-line Python equivalent.
# `exec` matters: start() runs new_group in a background subshell, and exec makes the
# service keep that subshell's PID ($!), which is also its process-group id.
if command -v setsid >/dev/null 2>&1; then
  new_group() { exec setsid "$@"; }
else
  new_group() {
    exec python3 -c 'import os, sys
try: os.setsid()
except OSError: os.setpgid(0, 0)
os.execvp(sys.argv[1], sys.argv[1:])' "$@"
  }
fi
start() { # start <name> <cmd...>
  local name=$1; shift
  new_group "$@" < /dev/null > "$LOGS/$name.log" 2>&1 &
  PIDS+=($!)
  echo "  $name (pid $!) -> runs/logs/$name.log"
}
cleanup() {
  echo; echo "stopping services..."
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && { kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null || true; }; done
  sleep 3   # give them a moment to exit cleanly, then force anything still running
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && { kill -9 -- "-$p" 2>/dev/null || true; }; done
}
trap cleanup EXIT
trap 'exit 130' INT TERM
wait_for() { # wait_for <description> <command...>
  local what=$1; shift
  for _ in $(seq 1 90); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "timed out waiting for $what (see runs/logs/)"; exit 1
}
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in 8787 8545 8000 9091 9092; do
  port_free "$p" || { echo "port $p is in use (old demo still running? try: bash scripts/stop_demo.sh)"; exit 1; }
done

echo "==> Starting services"
TRUST_CHAIN=off
if [ "$CHAIN" = 1 ]; then
  [ -s trust-layer/artifacts/CerebraChainRegistry.json ] || node trust-layer/scripts/compile.js
  start chain npx hardhat node --hostname 127.0.0.1 --port 8545
  wait_for "local blockchain" curl -fs -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545
  node trust-layer/scripts/deploy.js | sed 's/^/  /'
  TRUST_CHAIN=required
fi
rm -rf storage
start trust-layer env CHAIN="$TRUST_CHAIN" node trust-layer/src/server.js
wait_for "trust layer" curl -fs http://127.0.0.1:8787/api/health
echo "  dashboard: http://127.0.0.1:8787"

NCPU=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)
THREADS=$(( NCPU / H )); [ "$THREADS" -ge 1 ] || THREADS=1
if [ "$MODE" = local ]; then
  rm -rf runs/local
  python -m cerebrachain.local_run --hospitals "$H" --rounds "$ROUNDS" --epochs "$EPOCHS" --attack "$ATTACK" \
    --attacker "$ATTACKER" --attack-rounds "$ATTACK_ROUNDS" --device "$DEVICE" --work-dir runs/local \
    2>&1 | tee "$LOGS/federation.log"
else
  export FLWR_HOME="$ROOT/runs/.flwr"
  mkdir -p "$FLWR_HOME"
  cat > "$FLWR_HOME/config.toml" <<EOF
[superlink]
default = "cerebra"

[superlink.cerebra]
address = "127.0.0.1:8000"
insecure = true
EOF
  rm -rf runs/flower runs/superlink.db
  start superlink flower-superlink --insecure --disable-runtime-dependency-installation --database "$ROOT/runs/superlink.db"
  wait_for "Flower SuperLink" grep -q "Uvicorn running" "$LOGS/superlink.log"
  for i in $(seq 0 $((H - 1))); do
    A=none; [ "$i" = "$ATTACKER" ] && A=$ATTACK
    start "hospital-$i" flower-supernode --insecure --superlink 127.0.0.1:9092 --port $((9110 + i)) \
      --node-config "hospital-id=$i data-dir='$ROOT/data' work-dir='$ROOT/runs/flower' project-root='$ROOT' trust-url='http://127.0.0.1:8787' attack='$A' attack-rounds='$ATTACK_ROUNDS' device='$DEVICE' torch-threads=$THREADS"
  done
  echo "==> Running federation (Flower). Hospital $ATTACKER attack: $ATTACK"
  flwr run . cerebra --stream --run-config \
    "num-server-rounds=$ROUNDS expected-hospitals=$H local-epochs=$EPOCHS project-root='$ROOT'" 2>&1 | tee "$LOGS/federation.log"
fi

echo
echo "==> Federation finished. Dashboard: http://127.0.0.1:8787  (state: storage/state.json)"
if [ "$KEEP" = 1 ]; then
  echo "    Services keep running so you can explore the dashboard. Press Ctrl+C to stop."
  while true; do sleep 3600; done
fi
