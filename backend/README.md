# ZKP-CerebraChain

Federated, zero-knowledge-verified brain-tumour segmentation across hospitals.
Smart India Hackathon 2026 prototype (MedTech, software).

Several hospitals train one multi-modal MRI segmentation model (T1, T1Gd, T2, FLAIR)
together. MRI never leaves a hospital, the aggregator never sees any single hospital's
model update, and every update carries a Groth16 zk-SNARK proof that is checked
off-chain and on-chain before it can affect the global model.

```
 Hospital A ┐                                   ┌─ Trust layer (Node/Express) ──┐
 Hospital B ├─ Flower SuperNodes ─ SuperLink ─ Aggregator ─┤  snarkjs verify  · IPFS CIDs │─ Dashboard
 Hospital C │   (local training,                (Flower    │  Fiat-Shamir challenge       │  :8787
 Hospital D ┘    int8 update,                 ServerApp)   └──────────────┬───────────────┘
                 Poseidon commitment,                                     │
                 masked upload,                              CerebraChainRegistry.sol
                 Groth16 proofs)                             + Groth16Verifier.sol (EVM)
```

## What happens in one round

1. **Train locally.** Each hospital trains the 2D U-Net on its own slices (FedBN: BatchNorm
   layers stay local and absorb scanner differences).
2. **Commit.** The weight change is clipped to an L2 norm `C`, quantised to int8 with
   stochastic rounding, split into chunks of 4096, and committed with Poseidon
   (commitment = output of the circuit's witness generator, so it is guaranteed to match
   the later proof). The hospital also uploads a **masked** copy of its update
   (pairwise X25519 masks, Bonawitz-style secure aggregation). Commitments go on-chain.
3. **Challenge.** The contract derives a Fiat-Shamir seed from *all* commitments and
   *all* masked uploads, so nobody can change their upload after seeing it.
4. **Prove.** For every chunk the hospital proves, in zero knowledge, that
   - the chunk matches its commitment and is bound to this round, hospital and global model,
   - every value is a valid int8,
   - and outputs `Σq²` (for the norm bound) and `q(x) = Σ q_j·x^j` at the challenge point.
5. **Verify.** The trust layer verifies every proof with snarkjs **and** submits it to
   the contract, which runs the Groth16 verifier on-chain and records accept/reject
   with a reason. An update whose total `Σq²` exceeds the bound (model poisoning) is rejected.
6. **Unmask.** If a hospital was excluded, the others reveal only their pairwise seed
   with *that* hospital for *this* round. Before revealing, each hospital checks the
   public ledger that the excluded hospital really was rejected.
7. **Aggregate + check.** The aggregator sums the masked uploads (masks cancel) and checks
   `Σ n_i·q_i(x) == (Σ n_i·q_i)(x)` for every chunk. If any hospital uploaded something
   other than what it proved, this fails (Schwartz-Zippel, error ≤ 4096/2²⁵⁴) and the
   round is discarded.
8. **Update + publish.** FedAvg on the de-quantised sum; the new model's hash and
   IPFS CID are recorded on-chain; every hospital reports validation Dice.

## Exactly what the zero-knowledge proof guarantees (and what it does not)

Proven for every accepted update:

| Property | How |
|---|---|
| The update the aggregator summed is exactly the one the hospital committed to | Poseidon commitment + polynomial identity check on the secure sum |
| Every value is an int8 | `Num2Bits(8)` range check per value |
| L2 norm ≤ bound (blocks boosted / poisoned updates) | `Σq²` output, summed over chunks and checked on-chain |
| Bound to this round, this hospital, this global model (no replay or copying) | `ctx = sha256(round, hospital, model hash)` public input |

**Not** proven: that the hospital actually ran the training algorithm on real MRI.
Proving full neural-network training in zero knowledge is far beyond laptop scale
today. This matches the "Challenges → Mitigation" slide: the proof covers fixed-point
(quantised) model-update commitments and validation. If the deck says "ZKP proves
that the update follows the required computation", the accurate wording is: *"each
update is committed, int8-quantised, norm-bounded, bound to the round, and provably
identical to what was aggregated"*.

## Setup (Ubuntu or macOS)

Needs: Node.js ≥ 18, Rust/cargo (for circom), `curl`, ~3 GB disk. Python 3.12 is
installed automatically by `uv` (Flower 1.39 needs Python ≥ 3.11). On macOS the
built-in `bash` 3.2 is fine; on Apple Silicon everything runs on the CPU.

```bash
unzip zkp-cerebrachain.zip && cd zkp-cerebrachain
bash scripts/setup.sh                # CPU PyTorch (recommended; the model is small)
# TORCH=cuda bash scripts/setup.sh   # Linux + NVIDIA only: CUDA PyTorch (~2.5 GB download)
```

`setup.sh` creates `.venv`, installs Python and Node packages, builds circom if missing,
compiles the circuit and runs the Groth16 setup, compiles the contracts, generates
synthetic data for 4 hospitals and runs the unit tests. Re-running it skips the steps
that already finished.

**Trusted setup (powers of tau).** `scripts/zk_setup.sh` needs a phase-1 file for 2¹⁶
constraints (~72 MB). It tries, in order:

1. the **Hermez ceremony** file from `circom.info` (the mirror the snarkjs README has
   linked since October 2026; the old Google Cloud links now return 403), checked
   against the blake2b hash published in the snarkjs README;
2. the **PSE perpetual powers of tau** (`ppot_0080_16.ptau`, 80 contributions) from
   PSE's S3 bucket;
3. a **local single-party file**. It works, but it is **dev-only**: whoever generated
   it could forge proofs. It takes roughly 5–40 minutes depending on the CPU, and the
   script prints a timer so you can see it is still working.

The dashboard's "Trusted setup" row shows which one is in use. If your network blocks
both downloads, download the file in a browser and point the script at it:

```bash
# https://circom.info/powersOfTau28_hez_final_16.ptau
PTAU_FILE=~/Downloads/powersOfTau28_hez_final_16.ptau bash scripts/zk_setup.sh
```

## Run the demo

```bash
source .venv/bin/activate
bash scripts/run_demo.sh            # 4 hospitals, 5 rounds, Hospital D attacks every round
```

Open **http://127.0.0.1:8787** while it runs. You will see Hospital D's boosted update
rejected on-chain each round ("update norm exceeds bound"), the other three unmasked
and aggregated, the aggregate check pass, and Dice rise round by round.

Other scenarios:

```bash
bash scripts/run_demo.sh --attack none                      # all honest
bash scripts/run_demo.sh --attack tamper --attack-rounds 2  # D proves an honest update but
                                                            # uploads a different one -> round 2 discarded
bash scripts/run_demo.sh --mode local                       # same protocol in one process, no Flower
bash scripts/run_demo.sh --no-chain                         # skip the blockchain
bash scripts/run_demo.sh --device cpu --rounds 3 --exit     # exit when finished
bash scripts/stop_demo.sh                                   # clean up after a crash
```

What `run_demo.sh` starts (logs in `runs/logs/`):

| Process | Port |
|---|---|
| Hardhat local EVM chain | 8545 |
| Trust layer + dashboard | 8787 |
| Flower SuperLink | 8000 (control), 9091, 9092 |
| One Flower SuperNode per hospital | 9110 + id |

## Tests

```bash
python -m pytest -q tests/test_core.py   # seconds: hashing (Python vs JS), quantiser, secure aggregation
python -m pytest -q tests/test_e2e.py    # minutes: honest round, poisoned update rejected, tampered upload aborts
```

## Using real BraTS data

The default data is synthetic (procedural 4-modality phantoms; each hospital has its
own "scanner" so the sites are non-IID). To use real data, download either

- **Medical Segmentation Decathlon, Task01_BrainTumour** (BraTS-derived, see
  medicaldecathlon.com), or
- **BraTS 2021** (one folder per case with `_t1`, `_t1ce`, `_t2`, `_flair`, `_seg` NIfTI files),

then split the patients across hospitals (each patient belongs to exactly one hospital):

```bash
python -m cerebrachain.data --source msd --root ~/data/Task01_BrainTumour --hospitals 4 --out data --max-cases 120
python -m cerebrachain.data --source brats2021 --root ~/data/BraTS2021_Training_Data --hospitals 4 --out data
```

Slices are z-scored inside the brain and resized to 96×96; the label is the whole
tumour (all tumour classes). Real data is harder than the phantoms: use more rounds,
and consider a wider U-Net (`channels` in `cerebrachain/model.py`), remembering that
proving time grows linearly with the number of parameters.

## Performance (measured on a 2-vCPU cloud VM; a 4-core laptop will be faster)

| Item | Value |
|---|---|
| Federated parameters (U-Net 8-16-32, FedBN) | 29,377 → 8 chunks |
| Circuit `UpdateChunk(4096)` | 46,674 constraints, powers of tau 2¹⁶ |
| Proof per chunk (snarkjs) | ~3.8 s single; ~100 s for all 4 hospitals × 8 chunks in parallel |
| Off-chain verification | ~25 ms per proof |
| On-chain verification | ~2.1 M gas per hospital per round (8 proofs); rejected-by-norm ≈ 0.26 M gas |
| Round time, 4 hospitals | ~2–2.5 min (proving dominates) |
| Validation Dice, synthetic data, 3 honest + 1 attacker | ~0.25 → ~0.86 → ~0.94 over 3 rounds (varies by run) |

## Code map

| Path | What it is |
|---|---|
| `zk/circuits/update_chunk.circom` | The circuit: int8 range checks, Σq², Horner evaluation, Poseidon commitment |
| `zk/prover.js` | Hospital-side prover (witness generation + Groth16 via snarkjs) |
| `scripts/zk_setup.sh` | Compile circuit, powers of tau, Groth16 setup, export Solidity verifier |
| `cerebrachain/data.py` | Synthetic phantoms, MSD and BraTS 2021 loaders, per-hospital split |
| `cerebrachain/model.py`, `train.py` | 2D U-Net (4 → 1 channels), training, Dice, FedBN recalibration |
| `cerebrachain/quant.py` | Clipping, stochastic int8 quantisation, norm bound, chunking |
| `cerebrachain/secagg.py` | X25519 pairwise masks, SHAKE-256 PRG, unmasking |
| `cerebrachain/fields.py` | Hashing conventions shared with JS and Solidity |
| `cerebrachain/hospital.py` | Everything that runs inside one hospital |
| `cerebrachain/aggregator.py` | Round orchestration, aggregate check, FedAvg |
| `cerebrachain/server_app.py`, `client_app.py` | Flower ServerApp / ClientApp wrappers |
| `cerebrachain/local_run.py` | Same protocol without Flower |
| `trust-layer/contracts/CerebraChainRegistry.sol` | On-chain registry, challenge, proof verification, round records |
| `trust-layer/src/server.js` | Trust layer API, off-chain verification, IPFS store, dashboard |
| `trust-layer/public/index.html` | Dashboard |

## Security model and known limitations

Be ready to discuss these with judges; they are honest boundaries of a prototype.

- **Training correctness is not proven** (see above). A hospital can still submit a
  small, well-formed but useless update; the norm bound limits how much harm it can do.
- **Who tampered is not identified.** A tampered upload is detected and the round is
  discarded, but finding the culprit needs an extra "blame" protocol.
- **Two survivors leak to each other.** If only two hospitals are aggregated, each can
  subtract its own update from the published aggregate. The aggregator refuses to
  aggregate fewer than `min-survivors` (default 2); use ≥ 3 honest hospitals in practice.
- **Small public leakage per chunk**: `Σq²` (norm) and one random projection `q(x)` per
  chunk of 4096 values are public.
- **Sample counts are self-reported** (capped) and weight FedAvg.
- **Keys are relayed by the aggregator.** Hospital X25519 keys are also registered
  on-chain; a hardened version would have hospitals read peers' keys from the contract.
- **Single aggregator account** writes to the contract; the local chain uses Hardhat's
  public test key. A real deployment needs per-hospital accounts and a permissioned chain.
- **Dev trusted setup** if both powers-of-tau downloads failed (see Setup). Phase 2
  (circuit-specific) always has a single local contributor; a real deployment would run
  a phase-2 ceremony among the hospitals.
- **IPFS**: blobs get real CIDv1 identifiers and are stored in `storage/ipfs/`; set
  `IPFS_API=http://127.0.0.1:5001` to also pin them to a running Kubo node.
- **2D slices and a small U-Net**, sized so proofs run on a laptop CPU.

## Troubleshooting

- *"port … is in use"*: run `bash scripts/stop_demo.sh`.
- *Setup seems frozen at "Generating a LOCAL single-party file"*: it is working (see
  Setup). To skip the wait, press Ctrl+C, download the file in a browser and use `PTAU_FILE`.
- *macOS asks whether Python/Node may accept incoming connections*: click Allow (or
  Deny; every service only listens on 127.0.0.1, so the demo works either way).
- *Hospitals never connect*: check `runs/logs/hospital-*.log` and `runs/logs/superlink.log`.
- *GPU*: optional. Each hospital is a separate process; with 4 hospitals on a 4 GB card
  use `--device cpu` if you hit CUDA out-of-memory. Proving, not training, is the slow part.
- *Low RAM (8 GB)*: 4 hospitals proving in parallel peak at about 4–5 GB in total. Use
  `--hospitals 3` if the machine swaps.
