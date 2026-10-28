#!/usr/bin/env python3
"""Offline, resumable Groth16 proving for sealed full-model chunks."""

import argparse
import fcntl
import hashlib
import json
import os
import secrets
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from cerebrachain import zk
from cerebrachain.fields import R, ctx_for, x_for, poly_eval

os.umask(0o077)

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs/3d_fl_smoke"
COMMIT = RUNS / "zk_full_commit_stage_v1"
MASK = RUNS / "zk_full_mask_stage_v1"
OUT = RUNS / "zk_full_proofs_stage_v1"

WASM = ROOT / "zk/build/update_chunk_js/update_chunk.wasm"
ZKEY = ROOT / "zk/build/update_chunk.zkey"
VKEY = ROOT / "zk/build/verification_key.json"
SNARKJS = ROOT / "node_modules/.bin/snarkjs"

SEAL_SHA = "92cb6fd365d5e9f7205f113f3ab10e99467b978008e272fcda2756b023c723fd"
BIND_SHA = "f5a2f456b026dc23ba479c3711e527ab096c13237dff18dcac41aec40a4f5ebb"
CHALLENGE_SHA = "93266111c018a0b964817b14bded843d38229df7f2c4e120e530f2b383ac6856"

DOMAIN = b"ZKP-CerebraChain|offline-full-model-challenge|v1"
ROUND = 2305
SIZE = 4096
CHUNKS = 600
TOTAL = 1800


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for part in iter(lambda: f.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def load_sealed(path, field, expected):
    obj = json.loads(path.read_text())
    unsigned = {k: v for k, v in obj.items() if k != field}

    if obj.get(field) != expected or sha(canonical(unsigned)) != expected:
        raise RuntimeError(f"Manifest integrity FAILED: {path.name}")

    return obj


def save_json(path, obj):
    with path.open("xb") as f:
        f.write(canonical(obj))
        f.flush()
        os.fsync(f.fileno())


def snarkjs(args):
    result = subprocess.run(
        [str(SNARKJS), "groth16", *map(str, args)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=240
    )

    output = result.stdout + "\n" + result.stderr

    if result.returncode != 0:
        raise RuntimeError("snarkjs failed:\n" + output[-1600:])

    return output


def verify_proof(proof_path, public_path, expected):
    actual = json.loads(public_path.read_text())

    if [str(x) for x in actual] != expected:
        raise RuntimeError("Groth16 public signals mismatch")

    result = snarkjs([
        "verify", VKEY, public_path, proof_path
    ])

    if "OK!" not in result:
        raise RuntimeError("Groth16 verification FAILED:\n" + result[-1200:])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-new", type=int, default=3)
    args = parser.parse_args()

    if not 1 <= args.max_new <= TOTAL:
        raise RuntimeError("--max-new must be between 1 and 1800")

    print("\n===== STEP 23.8B: RESUMABLE FULL-MODEL GROTH16 =====", flush=True)

    for p in (WASM, ZKEY, VKEY, SNARKJS):
        if not p.is_file():
            raise RuntimeError(f"Missing circuit artifact: {p}")

    seal = load_sealed(
        COMMIT / "sealed_commitments_v1.json",
        "sealSha256",
        SEAL_SHA
    )

    binding = load_sealed(
        MASK / "mask_binding_manifest.json",
        "bindingSha256",
        BIND_SHA
    )

    challenge = load_sealed(
        MASK / "offline_challenge_v1.json",
        "challengeManifestSha256",
        CHALLENGE_SHA
    )

    if (
        binding["commitmentSealSha256"] != SEAL_SHA
        or challenge["commitmentSealSha256"] != SEAL_SHA
        or challenge["maskBindingSha256"] != BIND_SHA
        or int(binding["offlineRoundId"]) != ROUND
        or int(challenge["offlineRoundId"]) != ROUND
        or int(seal["offlineContext"]) != ROUND
    ):
        raise RuntimeError("Sealed transcript binding mismatch")

    if (
        int(seal["totalCommitments"]) != TOTAL
        or int(challenge["numChunkChallenges"]) != CHUNKS
    ):
        raise RuntimeError("Model/challenge dimensions mismatch")

    nonce = bytes.fromhex(challenge["randomNonceHex"])

    if len(nonce) != 32:
        raise RuntimeError("Incorrect challenge nonce length")

    seed = hashlib.sha256(
        DOMAIN + bytes.fromhex(SEAL_SHA)
        + bytes.fromhex(BIND_SHA) + nonce
    ).digest()

    if seed.hex() != challenge["challengeSeedHex"]:
        raise RuntimeError("Challenge seed mismatch")

    points = [int(x_for(seed, i)) for i in range(CHUNKS)]

    point_hash = sha(b"".join(
        x.to_bytes(32, "big") for x in points
    ))

    if point_hash != challenge["challengePointsSha256"]:
        raise RuntimeError("Challenge points digest mismatch")

    audit = json.loads((COMMIT / "audit_progress.json").read_text())

    if len(audit["audited"]) != TOTAL:
        raise RuntimeError("Commitment audit incomplete")

    print("✅ Sealed commitment snapshot verified")
    print("✅ Mask binding manifest verified")
    print("✅ Saved challenge and 600 points verified")
    print("✅ All 1,800 commitment audit records available")

    ignore = ROOT / ".gitignore"
    rule = "/runs/3d_fl_smoke/zk_full_proofs_stage_v1/"
    existing = ignore.read_text() if ignore.exists() else ""

    if rule not in existing.splitlines():
        with ignore.open("a") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            f.write("\n# Offline full-model ZK proving artifacts\n")
            f.write(rule + "\n")

    OUT.mkdir(mode=0o700, exist_ok=True)

    if OUT.stat().st_mode & 0o077:
        raise RuntimeError("Proof directory permissions too broad")

    with (OUT / ".process.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another Groth16 process is running")

        header = {
            "kind": "OFFLINE_FULL_MODEL_GROTH16_V1",
            "offlineRoundId": ROUND,
            "totalJobs": TOTAL,
            "sealSha256": SEAL_SHA,
            "maskBindingSha256": BIND_SHA,
            "challengeManifestSha256": CHALLENGE_SHA,
            "wasmSha256": file_sha(WASM),
            "zkeySha256": file_sha(ZKEY),
            "vkeySha256": file_sha(VKEY),
            "blockchainModified": False
        }

        manifest_path = OUT / "manifest.json"

        if manifest_path.exists():
            if json.loads(manifest_path.read_text()) != header:
                raise RuntimeError("Existing proof manifest mismatch")
            print("✅ RESUME MODE: Proof manifest matched")
        else:
            save_json(manifest_path, header)
            print("✅ Fresh proof manifest created")

        proofs_dir = OUT / "proofs"
        proofs_dir.mkdir(mode=0o700, exist_ok=True)

        new = 0
        resumed = 0

        for index in range(CHUNKS):
            if new >= args.max_new:
                break

            for hid in range(3):
                if new >= args.max_new:
                    break

                job = f"hospital_{hid}_chunk_{index:03d}"
                witness_path = COMMIT / "private" / f"{job}.json"
                commitment_path = COMMIT / "public" / f"{job}.json"

                recorded = audit["audited"].get(job)

                if recorded != {
                    "witness": file_sha(witness_path),
                    "public": file_sha(commitment_path)
                }:
                    raise RuntimeError(f"Audited files changed: {job}")

                witness = json.loads(witness_path.read_text())
                saved_public = json.loads(commitment_path.read_text())

                if (
                    int(witness["hospitalId"]) != hid
                    or int(witness["chunkIndex"]) != index
                    or int(saved_public["hospitalId"]) != hid
                    or int(saved_public["chunkIndex"]) != index
                ):
                    raise RuntimeError(f"Job identity mismatch: {job}")

                commitment = int(
                    seal["hospitals"][str(hid)]["commitments"][index]
                )

                if commitment != int(saved_public["commitment"]):
                    raise RuntimeError(f"Sealed commitment mismatch: {job}")

                ctx = int(ctx_for(
                    ROUND, hid, bytes.fromhex(seal["modelHash"])
                ))

                if ctx != int(witness["ctx"]):
                    raise RuntimeError(f"Context mismatch: {job}")

                salt = int(witness["salt"])

                if not 0 < salt < int(R):
                    raise RuntimeError(f"Invalid salt: {job}")

                q = np.array(
                    [int(v) for v in witness["q"]],
                    dtype=np.int64
                )

                if q.shape != (SIZE,) or not np.all(
                    (q >= -128) & (q <= 127)
                ):
                    raise RuntimeError(f"Invalid quantized chunk: {job}")

                x = points[index]
                evaluation = int(poly_eval(q, x))
                sum_sq = sum(int(v) ** 2 for v in q)

                expected_signals = [
                    str(commitment),
                    str(evaluation),
                    str(sum_sq),
                    str(ctx),
                    str(x)
                ]

                target = proofs_dir / job

                if target.exists():
                    receipt_path = target / "receipt.json"
                    if not receipt_path.is_file():
                        raise RuntimeError(f"Incomplete saved proof: {job}")

                    receipt = json.loads(receipt_path.read_text())

                    if (
                        receipt.get("job") != job
                        or receipt.get("challengeManifestSha256")
                        != CHALLENGE_SHA
                        or receipt.get("witnessSha256")
                        != recorded["witness"]
                        or receipt.get("proofSha256")
                        != file_sha(target / "proof.json")
                        or receipt.get("publicSha256")
                        != file_sha(target / "public.json")
                    ):
                        raise RuntimeError(f"Proof receipt mismatch: {job}")

                    verify_proof(
                        target / "proof.json",
                        target / "public.json",
                        expected_signals
                    )

                    resumed += 1
                    print(f"✅ RESUMED + VERIFIED: {job}", flush=True)
                    continue

                print(f"🔐 GENERATING: {job}", flush=True)

                temporary = Path(tempfile.mkdtemp(
                    prefix=f".{job}_",
                    dir=proofs_dir
                ))
                temporary.chmod(0o700)

                try:
                    input_file = temporary / "input.json"
                    proof_file = temporary / "proof.json"
                    public_file = temporary / "public.json"

                    save_json(input_file, {
                        "ctx": str(ctx),
                        "x": str(x),
                        "q": [str(int(v)) for v in q],
                        "salt": str(salt)
                    })

                    snarkjs([
                        "fullprove",
                        input_file,
                        WASM,
                        ZKEY,
                        proof_file,
                        public_file
                    ])

                    verify_proof(
                        proof_file, public_file, expected_signals
                    )

                    receipt = {
                        "job": job,
                        "hospitalId": hid,
                        "chunkIndex": index,
                        "witnessSha256": recorded["witness"],
                        "challengeManifestSha256": CHALLENGE_SHA,
                        "proofSha256": file_sha(proof_file),
                        "publicSha256": file_sha(public_file),
                        "groth16Verified": True
                    }

                    save_json(temporary / "receipt.json", receipt)

                    # Input contains private values. It must not
                    # become part of the saved proof directory.
                    input_file.unlink()

                    if target.exists():
                        raise RuntimeError(f"Proof already exists: {job}")

                    temporary.rename(target)
                    new += 1

                    print(
                        f"✅ GROTH16 PASS + SAVED: {job}",
                        flush=True
                    )

                finally:
                    if temporary.exists():
                        import shutil
                        shutil.rmtree(temporary)

        count = len([
            p for p in proofs_dir.iterdir()
            if p.is_dir() and not p.name.startswith(".")
        ])

        result = {
            "total": TOTAL,
            "completed": count,
            "new": new,
            "resumedAndVerified": resumed,
            "remaining": TOTAL - count,
            "challengeUnchanged": True,
            "blockchainModified": False
        }

        print("\n===== STEP 23.8B SUMMARY =====")
        print("Previously Resumed + Verified:", resumed)
        print("New Groth16 Proofs:", new)
        print("Total Proof Directories:", count)
        print("Remaining:", TOTAL - count)
        print("Blockchain Transactions: NONE")

        print(
            "\nFULL_GROTH16_STATUS="
            + json.dumps(result, separators=(",", ":"))
        )

        print("\n✅ STEP 23.8B PROOF BATCH COMPLETE!")


if __name__ == "__main__":
    main()
