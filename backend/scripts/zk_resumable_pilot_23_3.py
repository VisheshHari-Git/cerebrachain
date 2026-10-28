#!/usr/bin/env python3
"""Offline, resumable, three-hospital Groth16 proving pilot."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np
import torch

from cerebrachain import quant, zk
from cerebrachain.fields import R, ctx_for, x_for, poly_eval
from cerebrachain.unet3d.fl_bridge import flatten_state


os.umask(0o077)

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs/3d_fl_smoke"
OUTPUT = RUNS / "zk_resumable_pilot_v1"

CHECKPOINT = (
    Path.home()
    / "hackethon projects/ZKP Phaltan/mypro/cerebro-fl/model_final.pth"
)

SNARKJS = ROOT / "node_modules/.bin/snarkjs"
WASM = ROOT / "zk/build/update_chunk_js/update_chunk.wasm"
ZKEY = ROOT / "zk/build/update_chunk.zkey"
VKEY = ROOT / "zk/build/verification_key.json"

DIM = 2453636
CHUNK_SIZE = 4096
HOSPITALS = {0: "A", 1: "B", 2: "C"}
SELECTED_CHUNKS = (0, 1, 599)

# Offline namespace only. This is NOT a live round.
PILOT_CONTEXT = 2303


def save_json(path, value):
    path.write_text(json.dumps(value, separators=(",", ":")))
    path.chmod(0o600)


def sha(data):
    return hashlib.sha256(data).digest()


def run_command(args, timeout=180):
    result = subprocess.run(
        args,
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode:
        raise RuntimeError(
            "Command failed:\n"
            + (result.stdout + result.stderr)[-1500:]
        )
    return result.stdout + result.stderr


def check_git_ignored():
    """Protect private artifacts with or without an active Git repo."""

    ignore_file = ROOT / ".gitignore"

    required = {
        "/runs/3d_fl_smoke/zk_resumable_pilot_v1/",
        "/runs/3d_fl_smoke/.zk_pilot_preparing_*/",
        "/runs/3d_fl_smoke/live_round6_single_chunk/",
        "/runs/flower/**/x25519.key",
    }

    if not ignore_file.is_file():
        raise RuntimeError("Project .gitignore missing")

    rules = set(ignore_file.read_text().splitlines())

    if not required.issubset(rules):
        raise RuntimeError("Private artifact ignore rules missing")

    git_check = subprocess.run(
        ["git", "-C", str(ROOT), "rev-parse", "--is-inside-work-tree"],
        capture_output=True,
        text=True,
    )

    if git_check.returncode != 0:
        print("✅ No active Git repository")
        print("✅ .gitignore protection rules prepared")
        print("⚠️ Git rules will apply when this directory is in a repository")
        return

    protected_paths = [
        OUTPUT,
        RUNS / ".zk_pilot_preparing_test/private/example.json",
        RUNS / "live_round6_single_chunk/hospital_0/private_witness.json",
        ROOT / "runs/flower/hospital_0/x25519.key",
    ]

    for path in protected_paths:
        check = subprocess.run(
            [
                "git", "-C", str(ROOT),
                "check-ignore", "-q", "--no-index",
                str(path),
            ],
            capture_output=True,
        )

        if check.returncode != 0:
            raise RuntimeError(
                f"Git is not ignoring private path: {path}"
            )

    tracked = subprocess.run(
        [
            "git", "-C", str(ROOT), "ls-files", "--",
            "runs/3d_fl_smoke/zk_resumable_pilot_v1",
            "runs/3d_fl_smoke/live_round6_single_chunk",
            "runs/flower",
        ],
        capture_output=True,
        text=True,
        check=True,
    )

    sensitive = [
        path for path in tracked.stdout.splitlines()
        if (
            path.startswith(
                "runs/3d_fl_smoke/zk_resumable_pilot_v1/"
            )
            or path.startswith(
                "runs/3d_fl_smoke/live_round6_single_chunk/"
            )
            or path.endswith("/x25519.key")
        )
    ]

    if sensitive:
        raise RuntimeError(
            "Sensitive artifacts are already tracked by Git"
        )

    print("✅ Git ignore and tracked-file checks passed")

def prepare():
    if OUTPUT.exists():
        manifest = OUTPUT / "manifest.json"
        if not manifest.is_file():
            raise RuntimeError(
                "Existing pilot directory has no manifest. "
                "Refusing to overwrite it."
            )

        print("✅ Existing pilot manifest found — RESUME MODE")
        return json.loads(manifest.read_text())

    print("\n===== INITIALIZING RESUMABLE PILOT =====", flush=True)

    check_git_ignored()

    model_hash = sha(CHECKPOINT.read_bytes())

    reference = torch.load(
        CHECKPOINT, map_location="cpu", weights_only=True
    )

    scale = quant.default_scale(2.0, DIM, 16.0)
    bound = quant.norm_bound(2.0, scale, DIM)

    temporary = Path(
        tempfile.mkdtemp(
            prefix=".zk_pilot_preparing_",
            dir=RUNS,
        )
    )
    temporary.chmod(0o700)

    try:
        private_dir = temporary / "private"
        proof_dir = temporary / "proofs"

        private_dir.mkdir(mode=0o700)
        proof_dir.mkdir(mode=0o700)

        jobs = []

        for hid, name in HOSPITALS.items():

            delta = torch.load(
                RUNS / f"hospital_{name}/weight_delta.pth",
                map_location="cpu",
                weights_only=True,
            )

            metadata = json.loads(
                (
                    RUNS
                    / f"hospital_{name}/training_metadata.json"
                ).read_text()
            )

            if metadata.get("hospital") != name:
                raise RuntimeError("Hospital metadata mismatch")

            if int(metadata["patient_count"]) <= 0:
                raise RuntimeError("Invalid sample count")

            flat = flatten_state(delta, reference)

            if flat.shape != (DIM,):
                raise RuntimeError("Incorrect model dimension")

            if not np.all(np.isfinite(flat)):
                raise RuntimeError("Non-finite model update")

            q = np.asarray(
                quant.quantize(
                    quant.clip(flat, 2.0),
                    scale,
                    np.random.default_rng(20261026 + hid + 1),
                    bound=bound,
                ),
                dtype=np.int64,
            )

            ctx = int(ctx_for(PILOT_CONTEXT, hid, model_hash))

            for index in SELECTED_CHUNKS:

                start = index * CHUNK_SIZE
                actual = q[start:start + CHUNK_SIZE]

                chunk = np.zeros(CHUNK_SIZE, dtype=np.int64)
                chunk[:len(actual)] = actual

                if not np.all((chunk >= -128) & (chunk <= 127)):
                    raise RuntimeError("Invalid quantized range")

                salt = int.from_bytes(os.urandom(32), "big") % (int(R) - 1) + 1

                commitments = zk.commit(
                    ctx,
                    [chunk],
                    [salt],
                    str(ROOT),
                )

                if len(commitments) != 1:
                    raise RuntimeError("Invalid commitment count")

                commitment = int(commitments[0])

                if not 0 <= commitment < int(R):
                    raise RuntimeError("Invalid commitment field value")

                job_id = f"hospital_{hid}_chunk_{index:03d}"

                save_json(
                    private_dir / f"{job_id}.json",
                    {
                        "ctx": str(ctx),
                        "salt": str(salt),
                        "q": [str(int(v)) for v in chunk],
                    },
                )

                jobs.append({
                    "id": job_id,
                    "hospital": name,
                    "hospitalId": hid,
                    "chunkIndex": index,
                    "commitment": str(commitment),
                    "actualParameters": len(actual),
                    "padding": CHUNK_SIZE - len(actual),
                })

                print(
                    f"✅ Prepared Hospital {name}, chunk {index}",
                    flush=True,
                )

        # Challenge is derived only after all pilot commitments exist.
        seed_material = (
            b"cerebrachain/resumable-offline-pilot/v1"
            + model_hash
        )

        for job in jobs:
            seed_material += (
                job["hospitalId"].to_bytes(4, "big")
                + job["chunkIndex"].to_bytes(4, "big")
                + int(job["commitment"]).to_bytes(32, "big")
            )

        seed = sha(seed_material)

        manifest = {
            "kind": "OFFLINE_RESUMABLE_PILOT",
            "version": 1,
            "globalModelHash": model_hash.hex(),
            "challengeSeed": seed.hex(),
            "normBound": str(bound),
            "chunkSize": CHUNK_SIZE,
            "jobs": jobs,
            "onchain": False,
        }

        save_json(temporary / "manifest.json", manifest)

        if OUTPUT.exists():
            raise RuntimeError("Output directory appeared concurrently")

        temporary.rename(OUTPUT)

        print("✅ All commitments prepared")
        print("✅ Offline challenge fixed")
        print("✅ Private witnesses saved")

        return manifest

    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def validate_proof(job, witness, proof_path, public_path, seed, bound):

    public = json.loads(public_path.read_text())
    signals = [int(v) for v in public]

    q = [int(v) for v in witness["q"]]

    challenge = int(x_for(seed, job["chunkIndex"]))

    expected = [
        int(job["commitment"]),
        int(poly_eval(q, challenge)) % int(R),
        sum(v * v for v in q) % int(R),
        int(witness["ctx"]),
        challenge,
    ]

    if signals != expected:
        raise RuntimeError(
            f"{job['id']}: public signal mismatch"
        )

    if signals[2] > bound:
        raise RuntimeError(
            f"{job['id']}: norm bound exceeded"
        )

    output = run_command(
        [
            str(SNARKJS),
            "groth16",
            "verify",
            str(VKEY),
            str(public_path),
            str(proof_path),
        ],
        timeout=90,
    )

    if "OK!" not in output:
        raise RuntimeError(
            f"{job['id']}: cryptographic verification failed"
        )


def main():

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--max-new",
        type=int,
        default=3,
        help="Maximum new proofs to generate this execution",
    )

    args = parser.parse_args()

    if args.max_new < 0:
        raise RuntimeError("--max-new cannot be negative")

    print("\n===== STEP 23.3: RESUMABLE ZK PIPELINE =====")

    for path in (CHECKPOINT, SNARKJS, WASM, ZKEY, VKEY):
        if not path.is_file():
            raise RuntimeError(f"Missing artifact: {path}")

    check_git_ignored()

    manifest = prepare()

    if manifest.get("kind") != "OFFLINE_RESUMABLE_PILOT":
        raise RuntimeError("Invalid pilot manifest")

    if manifest.get("onchain") is not False:
        raise RuntimeError("Unexpected on-chain configuration")

    if sha(CHECKPOINT.read_bytes()).hex() != manifest["globalModelHash"]:
        raise RuntimeError("Original model checkpoint changed")

    seed = bytes.fromhex(manifest["challengeSeed"])
    bound = int(manifest["normBound"])

    total = len(manifest["jobs"])
    completed = 0
    new_proofs = 0

    print("\n===== PROOF CHECKPOINT PROCESSING =====", flush=True)

    for job in manifest["jobs"]:

        name = job["id"]

        witness_path = OUTPUT / "private" / f"{name}.json"
        proof_dir = OUTPUT / "proofs" / name

        if witness_path.stat().st_mode & 0o077:
            raise RuntimeError("Insecure private witness permissions")

        witness = json.loads(witness_path.read_text())

        if len(witness["q"]) != CHUNK_SIZE:
            raise RuntimeError("Invalid saved witness")

        if proof_dir.exists():

            validate_proof(
                job,
                witness,
                proof_dir / "proof.json",
                proof_dir / "public.json",
                seed,
                bound,
            )

            completed += 1

            print(
                f"✅ RESUMED: {name} — existing proof verified",
                flush=True,
            )
            continue

        if new_proofs >= args.max_new:
            continue

        working = Path(
            tempfile.mkdtemp(
                prefix=".proving_",
                dir=OUTPUT / "proofs",
            )
        )
        working.chmod(0o700)

        try:
            private_input = working / "input.json"
            proof_path = working / "proof.json"
            public_path = working / "public.json"

            challenge = int(
                x_for(seed, job["chunkIndex"])
            )

            save_json(
                private_input,
                {
                    "ctx": witness["ctx"],
                    "x": str(challenge),
                    "q": witness["q"],
                    "salt": witness["salt"],
                },
            )

            print(
                f"🔐 GENERATING: {name}",
                flush=True,
            )

            started = time.perf_counter()

            run_command(
                [
                    str(SNARKJS),
                    "groth16",
                    "fullprove",
                    str(private_input),
                    str(WASM),
                    str(ZKEY),
                    str(proof_path),
                    str(public_path),
                ],
                timeout=180,
            )

            validate_proof(
                job,
                witness,
                proof_path,
                public_path,
                seed,
                bound,
            )

            # Never store private proving inputs with public proofs.
            private_input.unlink()

            working.rename(proof_dir)

            completed += 1
            new_proofs += 1

            elapsed = time.perf_counter() - started

            print(
                f"✅ SAVED: {name} | "
                f"Groth16 PASS | {elapsed:.2f}s",
                flush=True,
            )

        finally:
            if working.exists():
                shutil.rmtree(working)

    remaining = total - completed

    print("\n===== RESUMABLE PIPELINE SUMMARY =====")

    print("Total Pilot Proofs:", total)
    print("Previously Completed + Verified:", completed - new_proofs)
    print("New Proofs Generated:", new_proofs)
    print("Total Completed:", completed)
    print("Remaining:", remaining)
    print("Checkpoint Directory:", OUTPUT)
    print("Blockchain Transactions: NONE")
    print("Existing Round 6: UNCHANGED")

    print(
        "\nZK_RESUME_STATUS=" + json.dumps({
            "total": total,
            "completed": completed,
            "new": new_proofs,
            "remaining": remaining,
            "offline": True,
        })
    )

    if remaining:
        print("\n✅ CHECKPOINT SAVED — READY TO RESUME")
    else:
        print("\n🎉 ALL 9/9 GROTH16 PROOFS VERIFIED!")


if __name__ == "__main__":
    main()
