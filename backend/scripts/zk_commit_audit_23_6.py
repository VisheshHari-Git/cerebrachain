#!/usr/bin/env python3
"""Resumable offline audit for all 1,800 Poseidon commitments."""

import argparse
import fcntl
import hashlib
import json
import os
import secrets
from pathlib import Path

import numpy as np
import torch

from cerebrachain import quant, zk
from cerebrachain.fields import R, ctx_for
from cerebrachain.unet3d.fl_bridge import flatten_state


os.umask(0o077)

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs/3d_fl_smoke"
OUT = RUNS / "zk_full_commit_stage_v1"

BASE = (
    Path.home()
    / "hackethon projects/ZKP Phaltan/mypro/cerebro-fl/model_final.pth"
)

HOSPITALS = {0: "A", 1: "B", 2: "C"}

DIM = 2453636
SIZE = 4096
CHUNKS = 600
TOTAL = 1800
OFFLINE_CONTEXT = 2305


def sha_file(path):
    h = hashlib.sha256()

    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)

    return h.hexdigest()


def atomic_save(path, value):
    temporary = path.with_name(
        "." + path.name + "." + secrets.token_hex(8) + ".tmp"
    )

    data = json.dumps(
        value,
        separators=(",", ":")
    ).encode()

    with temporary.open("xb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())

    temporary.replace(path)


def required_source_files():
    paths = {"model": BASE}

    for hid, name in HOSPITALS.items():

        paths[f"delta_{hid}"] = (
            RUNS / f"hospital_{name}/weight_delta.pth"
        )

        paths[f"metadata_{hid}"] = (
            RUNS / f"hospital_{name}/training_metadata.json"
        )

    return paths


def verify_sources(manifest):
    print("\n===== SOURCE INTEGRITY =====", flush=True)

    paths = required_source_files()

    if set(paths) != set(manifest["sourceHashes"]):
        raise RuntimeError("Source manifest entries mismatch")

    for label, path in paths.items():

        if not path.is_file():
            raise RuntimeError(f"Missing source: {label}")

        actual = sha_file(path)
        expected = manifest["sourceHashes"][label]

        if actual != expected:
            raise RuntimeError(
                f"Source file changed: {label}"
            )

    if sha_file(BASE) != manifest["modelHash"]:
        raise RuntimeError("Base model hash mismatch")

    print("✅ Original 3D model unchanged")
    print("✅ Three hospital updates unchanged")
    print("✅ Three hospital metadata files unchanged")


def load_quantized(manifest):

    reference = torch.load(
        BASE,
        map_location="cpu",
        weights_only=True
    )

    scale = quant.default_scale(2.0, DIM, 16.0)
    bound = int(quant.norm_bound(2.0, scale, DIM))

    quantized = {}

    print("\n===== RECONSTRUCTING MODEL UPDATES =====", flush=True)

    for hid, name in HOSPITALS.items():

        metadata = json.loads(
            (
                RUNS / f"hospital_{name}/training_metadata.json"
            ).read_text()
        )

        if (
            metadata.get("hospital") != name
            or int(metadata.get("patient_count", 0)) <= 0
        ):
            raise RuntimeError(
                f"Hospital {name}: metadata mismatch"
            )

        delta = torch.load(
            RUNS / f"hospital_{name}/weight_delta.pth",
            map_location="cpu",
            weights_only=True
        )

        flat = flatten_state(delta, reference)

        if flat.shape != (DIM,):
            raise RuntimeError(
                f"Hospital {name}: dimension mismatch"
            )

        if not np.all(np.isfinite(flat)):
            raise RuntimeError(
                f"Hospital {name}: non-finite update"
            )

        q = np.asarray(
            quant.quantize(
                quant.clip(flat, 2.0),
                scale,
                np.random.default_rng(
                    int(manifest["quantSeeds"][str(hid)])
                ),
                bound=bound
            ),
            dtype=np.int64
        )

        if q.shape != (DIM,):
            raise RuntimeError("Quantized dimension mismatch")

        if not np.all((q >= -128) & (q <= 127)):
            raise RuntimeError("Quantized int8 range mismatch")

        sum_sq = int(np.dot(q, q))

        if sum_sq > bound:
            raise RuntimeError(
                f"Hospital {name}: norm bound exceeded"
            )

        quantized[hid] = q

        print(
            f"✅ Hospital {name}: "
            f"{DIM} values reconstructed; norm PASS",
            flush=True
        )

    return quantized


def expected_chunk(q, index):
    start = index * SIZE
    actual = q[start:start + SIZE]

    chunk = np.zeros(SIZE, dtype=np.int64)
    chunk[:len(actual)] = actual

    return chunk


def inspect_all_files(manifest, quantized):
    """
    Validate all 1,800 witness/public-file pairs.
    This does not recompute every Poseidon commitment.
    """

    print("\n===== AUDITING ALL 1,800 SAVED FILE PAIRS =====", flush=True)

    private_dir = OUT / "private"
    public_dir = OUT / "public"

    expected_names = {
        f"hospital_{hid}_chunk_{index:03d}.json"
        for index in range(CHUNKS)
        for hid in HOSPITALS
    }

    actual_private = {
        p.name for p in private_dir.glob("*.json")
    }

    actual_public = {
        p.name for p in public_dir.glob("*.json")
    }

    if actual_private != expected_names:
        raise RuntimeError(
            "Private witness file coverage mismatch"
        )

    if actual_public != expected_names:
        raise RuntimeError(
            "Public commitment file coverage mismatch"
        )

    model_hash = bytes.fromhex(manifest["modelHash"])

    file_digests = {}
    count = 0

    for index in range(CHUNKS):

        for hid, name in HOSPITALS.items():

            filename = (
                f"hospital_{hid}_chunk_{index:03d}.json"
            )

            job = filename[:-5]

            witness_path = private_dir / filename
            public_path = public_dir / filename

            if (
                witness_path.is_symlink()
                or public_path.is_symlink()
            ):
                raise RuntimeError(
                    f"Unexpected symbolic link: {job}"
                )

            if witness_path.stat().st_mode & 0o077:
                raise RuntimeError(
                    f"Insecure private file permissions: {job}"
                )

            witness_hash = sha_file(witness_path)
            public_hash = sha_file(public_path)

            witness = json.loads(
                witness_path.read_text()
            )

            public = json.loads(
                public_path.read_text()
            )

            if (
                int(witness["hospitalId"]) != hid
                or int(witness["chunkIndex"]) != index
                or int(public["hospitalId"]) != hid
                or int(public["chunkIndex"]) != index
                or public["job"] != job
            ):
                raise RuntimeError(
                    f"Hospital/chunk identity mismatch: {job}"
                )

            context = int(
                ctx_for(
                    OFFLINE_CONTEXT,
                    hid,
                    model_hash
                )
            )

            if int(witness["ctx"]) != context:
                raise RuntimeError(
                    f"Context mismatch: {job}"
                )

            salt = int(witness["salt"])

            if not 0 < salt < int(R):
                raise RuntimeError(
                    f"Invalid private salt: {job}"
                )

            saved_q = np.asarray(
                [int(v) for v in witness["q"]],
                dtype=np.int64
            )

            original_q = expected_chunk(
                quantized[hid],
                index
            )

            if (
                saved_q.shape != (SIZE,)
                or not np.array_equal(
                    saved_q,
                    original_q
                )
            ):
                raise RuntimeError(
                    f"Private model-update mismatch: {job}"
                )

            commitment = int(
                public["commitment"]
            )

            if not 0 <= commitment < int(R):
                raise RuntimeError(
                    f"Invalid commitment value: {job}"
                )

            expected_root = (
                "0x" + hashlib.sha256(
                    commitment.to_bytes(32, "big")
                ).hexdigest()
            )

            if (
                public["commitmentRoot"].lower()
                != expected_root
            ):
                raise RuntimeError(
                    f"Commitment root mismatch: {job}"
                )

            if public["witnessSha256"] != witness_hash:
                raise RuntimeError(
                    f"Witness hash mismatch: {job}"
                )

            file_digests[job] = {
                "witness": witness_hash,
                "public": public_hash
            }

            count += 1

    if count != TOTAL:
        raise RuntimeError("Incomplete file audit")

    print("✅ All 1,800 witness files inspected")
    print("✅ All 1,800 public commitment files inspected")
    print("✅ Every saved chunk matches its source update")
    print("✅ All witness hashes match")
    print("✅ All stored per-chunk roots are consistent")
    print("✅ All hospital contexts verified")
    print("✅ All private salts within field range")

    return file_digests


def recompute_batch(manifest, digests, maximum):

    print("\n===== INDEPENDENT POSEIDON RECOMPUTATION =====", flush=True)

    audit_path = OUT / "audit_progress.json"

    if audit_path.exists():
        progress = json.loads(
            audit_path.read_text()
        )
    else:
        progress = {
            "kind": "FULL_COMMIT_POSEIDON_AUDIT_V1",
            "modelHash": manifest["modelHash"],
            "audited": {}
        }

    if (
        progress.get("kind")
        != "FULL_COMMIT_POSEIDON_AUDIT_V1"
        or progress.get("modelHash")
        != manifest["modelHash"]
    ):
        raise RuntimeError("Audit checkpoint identity mismatch")

    completed = progress["audited"]

    # Existing audit results remain valid only while the
    # corresponding source/witness/public files are unchanged.
    for job, recorded in completed.items():

        if job not in digests:
            raise RuntimeError(
                f"Unexpected audited job: {job}"
            )

        if recorded != digests[job]:
            raise RuntimeError(
                f"Previously audited files changed: {job}"
            )

    new = 0

    for index in range(CHUNKS):

        if new >= maximum:
            break

        for hid, name in HOSPITALS.items():

            if new >= maximum:
                break

            job = (
                f"hospital_{hid}_chunk_{index:03d}"
            )

            if job in completed:
                continue

            witness = json.loads(
                (
                    OUT / "private" / f"{job}.json"
                ).read_text()
            )

            public = json.loads(
                (
                    OUT / "public" / f"{job}.json"
                ).read_text()
            )

            q = np.asarray(
                [int(v) for v in witness["q"]],
                dtype=np.int64
            )

            calculated = zk.commit(
                int(witness["ctx"]),
                [q],
                [int(witness["salt"])],
                str(ROOT)
            )

            if (
                not isinstance(calculated, list)
                or len(calculated) != 1
            ):
                raise RuntimeError(
                    f"Unexpected Poseidon result: {job}"
                )

            if int(calculated[0]) != int(
                public["commitment"]
            ):
                raise RuntimeError(
                    f"POSEIDON COMMITMENT MISMATCH: {job}"
                )

            completed[job] = digests[job]

            # Persist progress after each independently
            # recomputed commitment.
            atomic_save(
                audit_path,
                progress
            )

            new += 1

            print(
                f"✅ POSEIDON VERIFIED: {job}",
                flush=True
            )

    audited_total = len(completed)

    summary = {
        "total": TOTAL,
        "structural_checks_passed": TOTAL,
        "poseidon_recomputed": audited_total,
        "newly_recomputed": new,
        "remaining": TOTAL - audited_total,
        "challenge_generated": False,
        "groth16_proofs_generated": 0,
        "blockchain_modified": False
    }

    print("\n===== FINAL AUDIT SUMMARY =====")

    print("Complete Witness/File Checks:", TOTAL)
    print("Independent Poseidon Checks:", audited_total)
    print("New Poseidon Checks:", new)
    print("Remaining Poseidon Checks:", TOTAL - audited_total)

    print("Blockchain Transactions: NONE")
    print("Groth16 Proofs Generated: NONE")
    print("Challenge Generated: NO")

    print(
        "\nCOMMIT_AUDIT_STATUS="
        + json.dumps(summary)
    )

    if audited_total == TOTAL:
        print("\n🎉 ALL 1,800 COMMITMENTS INDEPENDENTLY VERIFIED!")
    else:
        print("\n✅ AUDIT CHECKPOINT SAVED — RESUMABLE")


def main():

    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--max-new",
        type=int,
        default=30
    )

    args = parser.parse_args()

    if not 1 <= args.max_new <= TOTAL:
        raise RuntimeError(
            "--max-new must be between 1 and 1800"
        )

    print("\n===== STEP 23.6: FULL COMMITMENT INTEGRITY AUDIT =====")

    if not OUT.is_dir():
        raise RuntimeError("Full commitment directory missing")

    if OUT.stat().st_mode & 0o077:
        raise RuntimeError(
            "Commitment directory permissions too broad"
        )

    # Use the same lock as the commitment-generation script.
    # Do not audit concurrently with further commitment writes.
    with (OUT / ".process.lock").open("a+") as lock:

        try:
            fcntl.flock(
                lock,
                fcntl.LOCK_EX | fcntl.LOCK_NB
            )
        except BlockingIOError:
            raise RuntimeError(
                "Another commitment process is running"
            )

        manifest = json.loads(
            (OUT / "manifest.json").read_text()
        )

        if (
            manifest.get("kind")
            != "OFFLINE_3D_FULL_MODEL_COMMIT_STAGE_V1"
            or int(manifest.get("parameters", -1)) != DIM
            or int(manifest.get("chunkSize", -1)) != SIZE
            or int(manifest.get("chunksPerHospital", -1)) != CHUNKS
            or int(manifest.get("offlineContext", -1))
            != OFFLINE_CONTEXT
            or manifest.get("challengeGenerated") is not False
            or manifest.get("blockchainUsed") is not False
        ):
            raise RuntimeError(
                "Unexpected commitment manifest configuration"
            )

        verify_sources(manifest)

        quantized = load_quantized(manifest)

        digests = inspect_all_files(
            manifest,
            quantized
        )

        recompute_batch(
            manifest,
            digests,
            args.max_new
        )


if __name__ == "__main__":
    main()
