#!/usr/bin/env bash
# Compile the ZK circuit and run the Groth16 trusted setup.  Works on Linux and macOS.
#
#   bash scripts/zk_setup.sh                          # download a public powers-of-tau file
#   PTAU_FILE=~/Downloads/x.ptau bash scripts/zk_setup.sh   # use a file you downloaded yourself
#   CHUNK_SIZE=4096 bash scripts/zk_setup.sh
#
# Powers of tau (phase 1), tried in order:
#   1. Hermez ceremony (54 contributions + beacon) from circom.info, checked against the
#      blake2b hash published in the snarkjs README
#   2. PSE perpetual powers of tau (80 contributions + beacon), from PSE's S3 bucket
#   3. a LOCAL single-party file (dev only: whoever generates it could forge proofs)
#
# Produces, in zk/build/:
#   update_chunk_js/update_chunk.wasm   witness generator (used by hospitals)
#   update_chunk.zkey                   proving key        (used by hospitals)
#   verification_key.json               verifying key      (used by the trust layer)
#   meta.json                           written last; its presence means setup completed
# and trust-layer/contracts/Groth16Verifier.sol (on-chain verifier).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N="${CHUNK_SIZE:-4096}"
BUILD="$ROOT/zk/build"
PTAU_DIR="$ROOT/zk/ptau"
PY=python3; [ -x "$ROOT/.venv/bin/python" ] && PY="$ROOT/.venv/bin/python"

command -v circom >/dev/null || { echo "circom not found. See README (cargo install --git https://github.com/iden3/circom.git --tag v2.2.2 circom)"; exit 1; }
[ -d "$ROOT/node_modules/snarkjs" ] || { echo "Run 'npm install' first."; exit 1; }

snarkjs() { node "$ROOT/node_modules/snarkjs/build/cli.cjs" "$@"; }
rand_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
blake2b() { "$PY" -c 'import hashlib,sys
h=hashlib.blake2b()
with open(sys.argv[1],"rb") as f:
    for c in iter(lambda: f.read(1<<20), b""): h.update(c)
print(h.hexdigest())' "$1"; }

# Runs a long, silent command and prints elapsed time so it never looks frozen.
with_timer() { # with_timer <label> <cmd...>
  local label=$1; shift
  local log; log=$(mktemp)
  "$@" > "$log" 2>&1 &
  local pid=$! t0; t0=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    local s=$(( $(date +%s) - t0 ))
    printf '\r    %s ... %dm%02ds' "$label" $((s / 60)) $((s % 60))
  done
  local rc=0; wait "$pid" || rc=$?
  printf '\r    %s ... done in %dm%02ds\n' "$label" $(( ($(date +%s) - t0) / 60 )) $(( ($(date +%s) - t0) % 60 ))
  if [ "$rc" -ne 0 ]; then echo "    FAILED:"; tail -20 "$log"; rm -f "$log"; return "$rc"; fi
  rm -f "$log"
}

# blake2b-512 of the prepared Hermez files, copied from the snarkjs README
hez_hash() {
  case "$1" in
    10) echo 6cfeb8cda92453099d20120bdd0e8a5c4e7706c2da9a8f09ccc157ed2464d921fd0437fb70db42104769efd7d6f3c1f964bcf448c455eab6f6c7d863e88a5849;;
    11) echo 47c282116b892e5ac92ca238578006e31a47e7c7e70f0baa8b687f0a5203e28ea07bbbec765a98dcd654bad618475d4661bfaec3bd9ad2ed12e7abc251d94d33;;
    12) echo ded2694169b7b08e898f736d5de95af87c3f1a64594013351b1a796dbee393bd825f88f9468c84505ddd11eb0b1465ac9b43b9064aa8ec97f2b73e04758b8a4a;;
    13) echo 58efc8bf2834d04768a3d7ffcd8e1e23d461561729beaac4e3e7a47829a1c9066d5320241e124a1a8e8aa6c75be0ba66f65bc8239a0542ed38e11276f6fdb4d9;;
    14) echo eeefbcf7c3803b523c94112023c7ff89558f9b8e0cf5d6cdcba3ade60f168af4a181c9c21774b94fbae6c90411995f7d854d02ebd93fb66043dbb06f17a831c1;;
    15) echo 982372c867d229c236091f767e703253249a9b432c1710b4f326306bfa2428a17b06240359606cfe4d580b10a5a1f63fbed499527069c18ae17060472969ae6e;;
    16) echo 6a6277a2f74e1073601b4f9fed6e1e55226917efb0f0db8a07d98ab01df1ccf43eb0e8c3159432acd4960e2f29fe84a4198501fa54c8dad9e43297453efec125;;
    17) echo 6247a3433948b35fbfae414fa5a9355bfb45f56efa7ab4929e669264a0258976741dfbe3288bfb49828e5df02c2e633df38d2245e30162ae7e3bcca5b8b49345;;
    18) echo 7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e;;
    19) echo bca9d8b04242f175189872c42ceaa21e2951e0f0f272a0cc54fc37193ff6648600eaf1c555c70cdedfaf9fb74927de7aa1d33dc1e2a7f1a50619484989da0887;;
    20) echo 89a66eb5590a1c94e3f1ee0e72acf49b1669e050bb5f93c73b066b564dca4e0c7556a52b323178269d64af325d8fdddb33da3a27c34409b821de82aa2bf1a27b;;
    21) echo 9aef0573cef4ded9c4a75f148709056bf989f80dad96876aadeb6f1c6d062391f07a394a9e756d16f7eb233198d5b69407cca44594c763ab4a5b67ae73254678;;
    22) echo 0d64f63dba1a6f11139df765cb690da69d9b2f469a1ddd0de5e4aa628abb28f787f04c6a5fb84a235ec5ea7f41d0548746653ecab0559add658a83502d1cb21b;;
    *) echo "";;
  esac
}

download() { # download <url> <dest>   (progress bar, retries; nothing left behind on failure)
  echo "    $1"
  if curl -fL --progress-bar --retry 2 --connect-timeout 20 -o "$2.part" "$1"; then
    mv "$2.part" "$2"
  else
    rm -f "$2.part"; return 1
  fi
}

mkdir -p "$BUILD" "$PTAU_DIR"
cat > "$BUILD/update_chunk.circom" <<EOF
pragma circom 2.1.6;
include "../circuits/update_chunk.circom";
component main {public [ctx, x]} = UpdateChunk($N);
EOF

echo "==> Compiling circuit (chunk size N=$N)"
rm -f "$BUILD/meta.json"
circom "$BUILD/update_chunk.circom" --r1cs --wasm --O2 -o "$BUILD" >/dev/null
CONSTRAINTS=$(snarkjs r1cs info "$BUILD/update_chunk.r1cs" | grep -i "# of constraints" | grep -oE '[0-9]+$')
echo "    constraints: $CONSTRAINTS"

# Smallest power of two that fits the constraints (+ some headroom for public inputs)
POW=10
while [ $((1 << POW)) -lt $((CONSTRAINTS + 64)) ]; do POW=$((POW + 1)); done
echo "    needs powers of tau 2^$POW"

# ------------------------------------------------------------------ powers of tau
HEZ="$PTAU_DIR/powersOfTau28_hez_final_${POW}.ptau"
PSE="$PTAU_DIR/ppot_0080_${POW}.ptau"
LOCAL="$PTAU_DIR/local_dev_${POW}.ptau"
WANT=$(hez_hash "$POW")
PTAU=""; PTAU_SOURCE=""

HASH_NOTE="hash verified"
check_hez() { # check_hez <file> -> 0 if it matches the published hash (or no hash is published)
  if [ -z "$WANT" ]; then HASH_NOTE="hash not checked"; echo "    (no published hash for 2^$POW; not checked)"; return 0; fi
  local got; got=$(blake2b "$1")
  if [ "$got" = "$WANT" ]; then echo "    blake2b hash matches the snarkjs README"; return 0; fi
  echo "    blake2b hash MISMATCH for $1 (expected ${WANT:0:16}..., got ${got:0:16}...)"; return 1
}

if [ -n "${PTAU_FILE:-}" ]; then
  [ -s "$PTAU_FILE" ] || { echo "PTAU_FILE=$PTAU_FILE not found"; exit 1; }
  case "$(basename "$PTAU_FILE")" in
    powersOfTau28_hez_final_${POW}.ptau) check_hez "$PTAU_FILE" || exit 1; PTAU_SOURCE="hermez-ceremony (user-supplied, $HASH_NOTE)";;
    *) PTAU_SOURCE="user-supplied ($(basename "$PTAU_FILE"))";;
  esac
  PTAU="$PTAU_FILE"
fi

if [ -z "$PTAU" ] && [ -s "$HEZ" ] && check_hez "$HEZ"; then
  PTAU="$HEZ"; PTAU_SOURCE="hermez-ceremony ($HASH_NOTE)"
fi
if [ -z "$PTAU" ]; then
  echo "==> Downloading Hermez powers of tau (public multi-party ceremony, ~$(( (1 << POW) * 11 / 10240 )) MB)"
  if download "https://circom.info/powersOfTau28_hez_final_${POW}.ptau" "$HEZ"; then
    if check_hez "$HEZ"; then PTAU="$HEZ"; PTAU_SOURCE="hermez-ceremony ($HASH_NOTE)"; else rm -f "$HEZ"; fi
  fi
fi
if [ -z "$PTAU" ] && [ -s "$PSE" ]; then
  PTAU="$PSE"; PTAU_SOURCE="pse-perpetual-powers-of-tau-0080"
fi
if [ -z "$PTAU" ]; then
  echo "==> Trying the PSE perpetual powers of tau instead"
  if download "https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_${POW}.ptau" "$PSE"; then
    PTAU="$PSE"; PTAU_SOURCE="pse-perpetual-powers-of-tau-0080"
  fi
fi
if [ -z "$PTAU" ]; then
  PTAU="$LOCAL"; PTAU_SOURCE="local-dev (NOT for production)"
  if [ ! -s "$LOCAL" ] || [ ! -e "$LOCAL.ok" ]; then   # .ok = generation finished
    echo "==> Both downloads failed. Generating a LOCAL single-party file instead (dev only)."
    echo "    This takes roughly 5-40 minutes depending on your CPU. It is working even when quiet."
    echo "    Tip: download https://circom.info/powersOfTau28_hez_final_${POW}.ptau in a browser and run"
    echo "         PTAU_FILE=~/Downloads/powersOfTau28_hez_final_${POW}.ptau bash scripts/zk_setup.sh"
    T0="$PTAU_DIR/tmp_pot_0.ptau"; T1="$PTAU_DIR/tmp_pot_1.ptau"; TP="$PTAU_DIR/tmp_local.ptau"
    with_timer "phase 1: new"          snarkjs powersoftau new bn128 "$POW" "$T0"
    with_timer "phase 1: contribute"   snarkjs powersoftau contribute "$T0" "$T1" --name="cerebrachain-dev" -e="$(rand_hex)"
    with_timer "phase 1: prepare phase 2 (the slow step)" snarkjs powersoftau prepare phase2 "$T1" "$TP"
    mv "$TP" "$LOCAL"; touch "$LOCAL.ok"; rm -f "$T0" "$T1"
  fi
fi
echo "    using $(basename "$PTAU"): $PTAU_SOURCE"

# ------------------------------------------------------------------ phase 2 (circuit specific)
echo "==> Groth16 setup (circuit-specific phase 2)"
with_timer "groth16 setup"        snarkjs groth16 setup "$BUILD/update_chunk.r1cs" "$PTAU" "$BUILD/update_chunk_0.zkey"
with_timer "phase 2 contribution" snarkjs zkey contribute "$BUILD/update_chunk_0.zkey" "$BUILD/update_chunk.zkey.tmp" \
  --name="cerebrachain-phase2" -e="$(rand_hex)"
mv "$BUILD/update_chunk.zkey.tmp" "$BUILD/update_chunk.zkey"
rm -f "$BUILD/update_chunk_0.zkey"
snarkjs zkey export verificationkey "$BUILD/update_chunk.zkey" "$BUILD/verification_key.json" >/dev/null

echo "==> Exporting Solidity verifier"
mkdir -p "$ROOT/trust-layer/contracts"
snarkjs zkey export solidityverifier "$BUILD/update_chunk.zkey" "$ROOT/trust-layer/contracts/Groth16Verifier.sol" >/dev/null

cat > "$BUILD/meta.json.tmp" <<EOF
{
  "chunkSize": $N,
  "constraints": $CONSTRAINTS,
  "ptauPower": $POW,
  "ptauSource": "$PTAU_SOURCE",
  "publicSignals": ["commitment", "evalAtX", "sumSq", "ctx", "x"]
}
EOF
mv "$BUILD/meta.json.tmp" "$BUILD/meta.json"
echo "==> Done. Artifacts in zk/build/ (powers of tau: $PTAU_SOURCE)"
