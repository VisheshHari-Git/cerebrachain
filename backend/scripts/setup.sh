#!/usr/bin/env bash
# One-time setup on Ubuntu or macOS (8 GB RAM is enough).
#
#   bash scripts/setup.sh              # CPU PyTorch (small download; the model is tiny)
#   TORCH=cuda bash scripts/setup.sh   # CUDA PyTorch from PyPI (~2.5 GB, needs a recent NVIDIA driver)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- prerequisites
command -v node >/dev/null || { echo "Node.js >= 18 is required (https://nodejs.org or: sudo apt install nodejs npm)"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || { echo "Node.js >= 18 required, found $(node -v)"; exit 1; }

# ---------------------------------------------------------------- python env (Flower needs Python >= 3.11)
say "Python environment (.venv, Python 3.12 via uv)"
if ! command -v uv >/dev/null; then
  if [ -x "$HOME/.local/bin/uv" ]; then export PATH="$HOME/.local/bin:$PATH"
  else curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; fi
fi
[ -d .venv ] || uv venv --python 3.12 .venv
if [ "${TORCH:-cpu}" = "cuda" ]; then
  uv pip install --python .venv/bin/python torch
else
  uv pip install --python .venv/bin/python torch --index-url https://download.pytorch.org/whl/cpu
fi
uv pip install --python .venv/bin/python -r requirements.txt
# shellcheck disable=SC1091
source .venv/bin/activate

# ---------------------------------------------------------------- node deps
say "Node packages (snarkjs, circomlib, ethers, express, solc, hardhat)"
npm install --no-audit --no-fund

# ---------------------------------------------------------------- circom
if ! command -v circom >/dev/null; then
  say "Installing circom 2.2.2 (Rust)"
  if ! command -v cargo >/dev/null; then
    echo "Rust is needed to build circom: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
  fi
  cargo install --git https://github.com/iden3/circom.git --tag v2.2.2 circom
fi

# ---------------------------------------------------------------- ZK trusted setup
if [ ! -s zk/build/meta.json ]; then   # meta.json is written last, so it means "setup completed"
  say "Compiling circuit + Groth16 setup"
  bash scripts/zk_setup.sh
fi

say "Compiling smart contracts"
node trust-layer/scripts/compile.js

if [ ! -d data/hospital_0 ]; then
  say "Generating synthetic multi-modal MRI for 4 hospitals"
  python -m cerebrachain.data --source synthetic --hospitals 4 --out data
fi

say "Running unit tests"
python -m pytest -q tests/test_core.py

say "Setup complete. Start the demo with: bash scripts/run_demo.sh"
