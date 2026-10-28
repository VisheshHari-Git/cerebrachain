#!/usr/bin/env python3
"""Offline-only, crash-resumable commitment preparation."""

import argparse
import fcntl
import hashlib
import json
import os
import secrets
import subprocess
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

# Offline experiment only. NOT an active blockchain round.
OFFLINE_CONTEXT = 2305


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for part in iter(lambda: f.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def safe_save(path, obj):
    data = json.dumps(obj, separators=(",", ":")).encode()

    tmp = (
        path.parent
        / ("." + path.name + "." + secrets.token_hex(8) + ".tmp")
    )

    with tmp.open("xb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())

    tmp.replace(path)


def git_safety():
    pattern = "/runs/3d_fl_smoke/zk_full_commit_stage_v1/"
    ignore = ROOT / ".gitignore"

    existing = ignore.read_text() if ignore.exists() else ""

    if pattern not in existing.splitlines():
        with ignore.open("a") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")

            f.write(
                "\n# ZKP private full-model proving witnesses\n"
                + pattern
                + "\n"
            )

    check = subprocess.run(
        [
            "git", "-C", str(ROOT),
            "rev-parse", "--is-inside-work-tree"
        ],
        capture_output=True,
        text=True
    )

    if check.returncode == 0:
        ignored = subprocess.run(
            [
                "git", "-C", str(ROOT),
                "check-ignore", "-q",
                "--no-index", str(OUT)
            ]
        )

        if ignored.returncode:
            raise RuntimeError("Git ignore check failed")

        tracked = subprocess.run(
            [
                "git", "-C", str(ROOT),
                "ls-files", "--",
                str(OUT.relative_to(ROOT))
            ],
            capture_output=True,
            text=True,
            check=True
        )

        if tracked.stdout.strip():
            raise RuntimeError(
                "Private directory already tracked in Git"
            )

        print("✅ Git ignore rule active")

    else:
        print(
            "⚠️ No active Git repository; "
            ".gitignore rule prepared (not encryption)"
        )


def config_now():
    if not BASE.is_file():
        raise RuntimeError(
            "Missing original 3D U-Net checkpoint"
        )

    paths = {"model": BASE}

    for hid, name in HOSPITALS.items():
        paths[f"delta_{hid}"] = (
            RUNS / f"hospital_{name}/weight_delta.pth"
        )

        paths[f"metadata_{hid}"] = (
            RUNS / f"hospital_{name}/training_metadata.json"
        )

    for label, path in paths.items():
        if not path.is_file():
            raise RuntimeError(
                f"Missing {label}: {path}"
            )

    return {
        "kind": "OFFLINE_3D_FULL_MODEL_COMMIT_STAGE_V1",
        "offlineContext": OFFLINE_CONTEXT,
        "chunkSize": SIZE,
        "parameters": DIM,
        "chunksPerHospital": CHUNKS,
        "totalCommitments": CHUNKS * len(HOSPITALS),
        "modelHash": digest(BASE),
        "sourceHashes": {
            label: digest(path)
            for label, path in paths.items()
        },
        "quantSeeds": {
            str(hid): 20261026 + hid + 1
            for hid in HOSPITALS
        },
        "challengeGenerated": False,
        "blockchainUsed": False
    }


def get_quantized(hid, config, reference):
    name = HOSPITALS[hid]

    path = (
        RUNS / f"hospital_{name}/weight_delta.pth"
    )

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
            f"Hospital {name}: invalid metadata"
        )

    delta = torch.load(
        path,
        map_location="cpu",
        weights_only=True
    )

    flat = flatten_state(delta, reference)

    if flat.shape != (DIM,) or not np.all(np.isfinite(flat)):
        raise RuntimeError(
            f"Hospital {name}: invalid model update"
        )

    scale = quant.default_scale(2.0, DIM, 16.0)
    bound = quant.norm_bound(2.0, scale, DIM)

    q = np.asarray(
        quant.quantize(
            quant.clip(flat, 2.0),
            scale,
            np.random.default_rng(
                config["quantSeeds"][str(hid)]
            ),
            bound=bound
        ),
        dtype=np.int64
    )

    if (
        q.shape != (DIM,)
        or not np.all((q >= -128) & (q <= 127))
    ):
        raise RuntimeError(
            f"Hospital {name}: invalid quantization"
        )

    squared_norm = int(np.dot(q, q))

    if squared_norm > int(bound):
        raise RuntimeError(
            f"Hospital {name}: exceeds norm bound"
        )

    print(
        f"✅ Hospital {name}: {DIM} values; "
        f"norm={squared_norm} <= {bound}",
        flush=True
    )

    return q


def chunk_from(q, index):
    start = index * SIZE
    actual = q[start:start + SIZE]

    out = np.zeros(SIZE, dtype=np.int64)
    out[:len(actual)] = actual

    return out


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--max-new",
        type=int,
        default=3
    )

    args = parser.parse_args()

    if not 1 <= args.max_new <= 1800:
        raise RuntimeError(
            "Use --max-new between 1 and 1800"
        )

    print(
        "\n===== STEP 23.5: FULL-MODEL COMMITMENT PIPELINE =====",
        flush=True
    )

    if not (
        ROOT / "zk/build/update_chunk_js/update_chunk.wasm"
    ).is_file():
        raise RuntimeError("ZK circuit artifact missing")

    git_safety()
    current = config_now()

    if not OUT.exists():
        OUT.mkdir(mode=0o700)

    if OUT.stat().st_mode & 0o077:
        raise RuntimeError(
            "Private output directory permissions too broad"
        )

    (OUT / "private").mkdir(
        mode=0o700,
        exist_ok=True
    )

    (OUT / "public").mkdir(
        mode=0o700,
        exist_ok=True
    )

    # Prevent two processes from generating the same jobs.
    with (OUT / ".process.lock").open("a+") as lock:
        try:
            fcntl.flock(
                lock,
                fcntl.LOCK_EX | fcntl.LOCK_NB
            )
        except BlockingIOError as error:
            raise RuntimeError(
                "Another proving process is active"
            ) from error

        config_path = OUT / "manifest.json"

        if config_path.exists():
            previous = json.loads(
                config_path.read_text()
            )

            if previous != current:
                raise RuntimeError(
                    "Source model/configuration changed; "
                    "refusing to mix commitments"
                )

            print(
                "✅ Existing commitment manifest found — RESUME MODE"
            )

        else:
            if (
                any((OUT / "private").iterdir())
                or any((OUT / "public").iterdir())
            ):
                raise RuntimeError(
                    "Partial directory without manifest"
                )

            safe_save(config_path, current)

            print(
                "✅ Fresh offline commitment manifest created"
            )

        reference = torch.load(
            BASE,
            map_location="cpu",
            weights_only=True
        )

        model_hash = bytes.fromhex(
            current["modelHash"]
        )

        cache = {}
        new = 0
        resumed = 0

        # A chunk 0, B chunk 0, C chunk 0,
        # followed by chunk 1 for each hospital.
        for index in range(CHUNKS):

            if new >= args.max_new:
                break

            for hid, name in HOSPITALS.items():

                if new >= args.max_new:
                    break

                job = (
                    f"hospital_{hid}_chunk_{index:03d}"
                )

                witness_path = (
                    OUT / "private" / (job + ".json")
                )

                public_path = (
                    OUT / "public" / (job + ".json")
                )

                if hid not in cache:
                    cache[hid] = get_quantized(
                        hid,
                        current,
                        reference
                    )

                chunk = chunk_from(
                    cache[hid],
                    index
                )

                ctx = int(
                    ctx_for(
                        OFFLINE_CONTEXT,
                        hid,
                        model_hash
                    )
                )

                if witness_path.exists():
                    if witness_path.stat().st_mode & 0o077:
                        raise RuntimeError(
                            f"Insecure witness: {job}"
                        )

                    witness = json.loads(
                        witness_path.read_text()
                    )

                    q_saved = np.asarray(
                        [int(v) for v in witness["q"]],
                        dtype=np.int64
                    )

                    if (
                        int(witness["ctx"]) != ctx
                        or q_saved.shape != (SIZE,)
                        or not np.array_equal(
                            q_saved,
                            chunk
                        )
                    ):
                        raise RuntimeError(
                            f"Saved witness mismatch: {job}"
                        )

                    salt = int(witness["salt"])

                    if not 0 < salt < int(R):
                        raise RuntimeError(
                            f"Invalid saved salt: {job}"
                        )

                else:
                    if public_path.exists():
                        raise RuntimeError(
                            f"Public commitment has no witness: {job}"
                        )

                    salt = (
                        secrets.randbelow(int(R) - 1) + 1
                    )

                    safe_save(
                        witness_path,
                        {
                            "hospitalId": hid,
                            "chunkIndex": index,
                            "ctx": str(ctx),
                            "salt": str(salt),
                            "q": [
                                str(int(v))
                                for v in chunk
                            ]
                        }
                    )

                witness_sha = digest(witness_path)

                if public_path.exists():
                    pub = json.loads(
                        public_path.read_text()
                    )

                    commitment = int(
                        pub["commitment"]
                    )

                    if not 0 <= commitment < int(R):
                        raise RuntimeError(
                            f"Invalid saved commitment: {job}"
                        )

                    expected_root = (
                        "0x" + hashlib.sha256(
                            commitment.to_bytes(
                                32,
                                "big"
                            )
                        ).hexdigest()
                    )

                    if (
                        pub.get("job") != job
                        or pub.get("witnessSha256")
                        != witness_sha
                        or pub.get("commitmentRoot")
                        != expected_root
                    ):
                        raise RuntimeError(
                            f"Saved commitment mismatch: {job}"
                        )

                    resumed += 1
                    continue

                commits = zk.commit(
                    ctx,
                    [chunk],
                    [salt],
                    str(ROOT)
                )

                if (
                    not isinstance(commits, list)
                    or len(commits) != 1
                ):
                    raise RuntimeError(
                        f"Unexpected zk.commit output: {job}"
                    )

                commitment = int(commits[0])

                if not 0 <= commitment < int(R):
                    raise RuntimeError(
                        f"Invalid commitment: {job}"
                    )

                root_hash = (
                    "0x" + hashlib.sha256(
                        commitment.to_bytes(32, "big")
                    ).hexdigest()
                )

                safe_save(
                    public_path,
                    {
                        "job": job,
                        "hospitalId": hid,
                        "chunkIndex": index,
                        "commitment": str(commitment),
                        "commitmentRoot": root_hash,
                        "witnessSha256": witness_sha
                    }
                )

                new += 1

                print(
                    f"✅ COMMITTED (offline): {job}",
                    flush=True
                )

        total_done = len(
            list(
                (OUT / "public").glob(
                    "hospital_*_chunk_*.json"
                )
            )
        )

        remaining = 1800 - total_done

        status = {
            "total": 1800,
            "completed": total_done,
            "new": new,
            "remaining": remaining,
            "challengeGenerated": False,
            "proofsGenerated": 0,
            "blockchainModified": False
        }

        print("\n===== CHECKPOINT SUMMARY =====")
        print("Previously visited and validated:", resumed)
        print("New Commitments:", new)
        print("Total Commitments Stored:", total_done)
        print("Remaining:", remaining)
        print("Private Output:", OUT)

        print("⚠️ No challenge or Groth16 proofs generated")
        print("⚠️ No blockchain requests sent")

        print(
            "\nFULL_COMMIT_STATUS="
            + json.dumps(status)
        )

        print(
            "\n✅ STEP 23.5 COMMITMENT BATCH COMPLETE"
        )


if __name__ == "__main__":
    main()
