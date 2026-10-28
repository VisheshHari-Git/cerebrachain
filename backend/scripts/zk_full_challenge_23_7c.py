#!/usr/bin/env python3
"""Generate and verify an offline post-commitment ZK challenge."""

import fcntl
import hashlib
import json
import os
import secrets
from pathlib import Path

import numpy as np

from cerebrachain import secagg
from cerebrachain.fields import R, x_for

os.umask(0o077)

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs/3d_fl_smoke"

COMMIT_DIR = RUNS / "zk_full_commit_stage_v1"
MASK_DIR = RUNS / "zk_full_mask_stage_v1"

SEAL_PATH = COMMIT_DIR / "sealed_commitments_v1.json"
BINDING_PATH = MASK_DIR / "mask_binding_manifest.json"
CHALLENGE_PATH = MASK_DIR / "offline_challenge_v1.json"

EXPECTED_SEAL = (
    "92cb6fd365d5e9f7205f113f3ab10e99467b978008e272fcda2756b023c723fd"
)

EXPECTED_BINDING = (
    "f5a2f456b026dc23ba479c3711e527ab096c13237dff18dcac41aec40a4f5ebb"
)

DOMAIN = b"ZKP-CerebraChain|offline-full-model-challenge|v1"
DIM = 2453636
CHUNKS = 600
ROUND = 2305


def canonical(value):
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":")
    ).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def sha_file(path):
    h = hashlib.sha256()

    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)

    return h.hexdigest()


def checked_manifest(path, hash_key, expected):
    if path.is_symlink():
        raise RuntimeError(f"Unexpected symlink: {path}")

    data = json.loads(path.read_text())

    supplied = data.get(hash_key)

    unsigned = {
        k: v for k, v in data.items()
        if k != hash_key
    }

    calculated = sha(canonical(unsigned))

    if supplied != calculated or supplied != expected:
        raise RuntimeError(
            f"Integrity mismatch: {path.name}"
        )

    return data


def calculate_challenges(seed):
    values = []

    for index in range(CHUNKS):
        x = int(x_for(seed, index))

        if not 0 < x < int(R):
            raise RuntimeError(
                f"Invalid field challenge at chunk {index}"
            )

        values.append(x)

    if len(set(values)) != CHUNKS:
        raise RuntimeError("Duplicate evaluation challenge")

    packed = b"".join(
        x.to_bytes(32, "big")
        for x in values
    )

    return values, sha(packed)


def verify_binding(seal, binding):
    print("\n===== VERIFYING COMMITMENT BINDING =====", flush=True)

    if seal.get("kind") != "OFFLINE_FULL_MODEL_COMMITMENT_SEAL_V1":
        raise RuntimeError("Unexpected commitment seal type")

    if binding.get("kind") != "OFFLINE_FULL_MODEL_MASK_BINDING_V1":
        raise RuntimeError("Unexpected mask binding type")

    if binding.get("commitmentSealSha256") != EXPECTED_SEAL:
        raise RuntimeError("Mask binding references different seal")

    if (
        int(binding.get("offlineRoundId", -1)) != ROUND
        or int(seal.get("offlineContext", -1)) != ROUND
    ):
        raise RuntimeError("Offline round/context mismatch")

    if (
        int(seal.get("totalCommitments", -1)) != 1800
        or int(binding.get("parametersPerHospital", -1)) != DIM
        or int(binding.get("chunksPerHospital", -1)) != CHUNKS
    ):
        raise RuntimeError("Full-model configuration mismatch")

    if binding.get("globalModelHash") != "0x" + seal["modelHash"]:
        raise RuntimeError("Model hash mismatch")

    if (
        binding.get("secureSumMismatches") != 0
        or binding.get("challengeGenerated") is not False
        or seal.get("challengeGenerated") is not False
    ):
        raise RuntimeError("Invalid pre-challenge state")

    if (
        binding.get("proofsGenerated") != 0
        or binding.get("blockchainModified") is not False
        or seal.get("groth16ProofsGenerated") != 0
        or seal.get("blockchainModified") is not False
    ):
        raise RuntimeError("Unexpected prior proof or chain state")

    entries = binding.get("hospitalEntries", [])

    if len(entries) != 3:
        raise RuntimeError("Expected three hospital entries")

    if sorted(int(e["hospitalId"]) for e in entries) != [0, 1, 2]:
        raise RuntimeError("Incorrect hospital IDs")

    total_samples = 0

    for entry in entries:
        hid = int(entry["hospitalId"])
        hospital = seal["hospitals"][str(hid)]

        if int(entry["numSamples"]) != int(hospital["numSamples"]):
            raise RuntimeError("Patient sample count mismatch")

        if (
            entry["commitmentRoot"].lower()
            != hospital["commitmentRoot"].lower()
        ):
            raise RuntimeError("Hospital root mismatch")

        commitments = hospital["commitments"]

        if len(commitments) != CHUNKS:
            raise RuntimeError("Commitment count mismatch")

        packed = b"".join(
            int(c).to_bytes(32, "big")
            for c in commitments
        )

        actual_root = "0x" + sha(packed)

        if actual_root.lower() != entry["commitmentRoot"].lower():
            raise RuntimeError("Hospital commitment root changed")

        masked_path = MASK_DIR / f"hospital_{hid}_masked.npy"

        if masked_path.is_symlink():
            raise RuntimeError("Masked vector symlink detected")

        if sha_file(masked_path) != entry["maskedFileSha256"]:
            raise RuntimeError(f"Hospital {hid}: masked file changed")

        masked = np.load(
            masked_path,
            allow_pickle=False
        )

        if masked.shape != (DIM,) or masked.dtype != np.uint64:
            raise RuntimeError(f"Hospital {hid}: invalid masked vector")

        masked_hash = "0x" + secagg.masked_hash(masked).hex()

        if masked_hash.lower() != entry["maskedHash"].lower():
            raise RuntimeError(f"Hospital {hid}: masked hash mismatch")

        total_samples += int(entry["numSamples"])

        print(
            f"✅ Hospital {hid}: "
            "root + masked vector + hash verified",
            flush=True
        )

    if total_samples != int(binding["totalSamples"]):
        raise RuntimeError("Total sample count mismatch")

    print("✅ All three hospitals bound to the sealed transcript")


def derive_seed(nonce, seal_hash, binding_hash):
    return hashlib.sha256(
        DOMAIN
        + bytes.fromhex(seal_hash)
        + bytes.fromhex(binding_hash)
        + nonce
    ).digest()


def main():
    print(
        "\n===== STEP 23.7C: OFFLINE FULL-MODEL CHALLENGE =====",
        flush=True
    )

    if not MASK_DIR.is_dir():
        raise RuntimeError("Missing masked-update directory")

    with (MASK_DIR / ".challenge.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)

        seal = checked_manifest(
            SEAL_PATH,
            "sealSha256",
            EXPECTED_SEAL
        )

        binding = checked_manifest(
            BINDING_PATH,
            "bindingSha256",
            EXPECTED_BINDING
        )

        print("✅ Commitment seal integrity: PASS")
        print("✅ Mask binding integrity: PASS")

        verify_binding(seal, binding)

        print("\n===== CHALLENGE GENERATION =====", flush=True)

        if CHALLENGE_PATH.exists():
            saved = json.loads(CHALLENGE_PATH.read_text())

            supplied_hash = saved.get("challengeManifestSha256")

            unsigned = {
                k: v for k, v in saved.items()
                if k != "challengeManifestSha256"
            }

            if sha(canonical(unsigned)) != supplied_hash:
                raise RuntimeError("Saved challenge manifest corrupted")

            if (
                saved.get("kind")
                != "OFFLINE_FULL_MODEL_CHALLENGE_V1"
                or saved.get("commitmentSealSha256") != EXPECTED_SEAL
                or saved.get("maskBindingSha256") != EXPECTED_BINDING
            ):
                raise RuntimeError("Saved challenge binding mismatch")

            nonce = bytes.fromhex(saved["randomNonceHex"])

            if len(nonce) != 32:
                raise RuntimeError("Saved nonce has wrong length")

            seed = derive_seed(
                nonce,
                EXPECTED_SEAL,
                EXPECTED_BINDING
            )

            if seed.hex() != saved["challengeSeedHex"]:
                raise RuntimeError("Saved challenge seed mismatch")

            challenges, challenge_hash = calculate_challenges(seed)

            if (
                challenge_hash != saved["challengePointsSha256"]
                or len(challenges) != int(saved["numChunkChallenges"])
            ):
                raise RuntimeError("Saved challenge points mismatch")

            if saved.get("sampleChallenges") != {
                str(k): str(challenges[k])
                for k in (0, 1, 599)
            }:
                raise RuntimeError("Saved sample challenges mismatch")

            print("✅ RESUME MODE: Existing challenge verified")
            challenge = saved

        else:
            # Fresh nonce is generated only after both
            # commitment and masked-update manifests are fixed.
            nonce = secrets.token_bytes(32)

            seed = derive_seed(
                nonce,
                EXPECTED_SEAL,
                EXPECTED_BINDING
            )

            challenges, challenge_hash = calculate_challenges(seed)

            challenge = {
                "kind": "OFFLINE_FULL_MODEL_CHALLENGE_V1",
                "offlineRoundId": ROUND,
                "commitmentSealSha256": EXPECTED_SEAL,
                "maskBindingSha256": EXPECTED_BINDING,
                "modelHash": seal["modelHash"],
                "randomNonceHex": nonce.hex(),
                "challengeSeedHex": seed.hex(),
                "numChunkChallenges": CHUNKS,
                "challengePointsSha256": challenge_hash,
                "sampleChallenges": {
                    str(k): str(challenges[k])
                    for k in (0, 1, 599)
                },
                "generator": "local_secrets_token_bytes_32",
                "externalRandomnessBeacon": False,
                "groth16ProofsGenerated": 0,
                "blockchainModified": False
            }

            challenge["challengeManifestSha256"] = sha(
                canonical(challenge)
            )

            temp = CHALLENGE_PATH.with_name(
                "." + CHALLENGE_PATH.name
                + "." + secrets.token_hex(8)
                + ".tmp"
            )

            try:
                with temp.open("xb") as f:
                    f.write(canonical(challenge))
                    f.flush()
                    os.fsync(f.fileno())

                # Refuse to replace an already-created challenge.
                os.link(temp, CHALLENGE_PATH)

            finally:
                if temp.exists():
                    temp.unlink()

            print("✅ Fresh 256-bit random nonce generated")
            print("✅ Challenge seed generated")
            print("✅ Challenge saved without overwriting existing files")

        print("\n===== CHUNK CHALLENGE VALIDATION =====")
        print("✅ 600 finite-field evaluation points generated")
        print("✅ All 600 challenges are distinct")
        print("✅ Chunk 0 challenge:", challenges[0])
        print("✅ Chunk 1 challenge:", challenges[1])
        print("✅ Chunk 599 challenge:", challenges[599])

        result = {
            "status": "PASS",
            "offlineRoundId": ROUND,
            "totalCommitmentsBound": 1800,
            "hospitalCount": 3,
            "challengeCount": CHUNKS,
            "challengeSeedHex": seed.hex(),
            "challengePointsSha256": challenge["challengePointsSha256"],
            "challengeManifestSha256": challenge["challengeManifestSha256"],
            "groth16ProofsGenerated": 0,
            "blockchainModified": False
        }

        print("\n===== FINAL CHALLENGE SUMMARY =====")
        print("✅ Commitment Seal: VERIFIED")
        print("✅ Mask Binding: VERIFIED")
        print("✅ Challenge Seed: SAVED")
        print("✅ Chunk Challenges: 600")
        print("✅ No Groth16 proofs generated")
        print("✅ No blockchain transactions")

        print(
            "\nFULL_CHALLENGE_RESULT="
            + json.dumps(result, separators=(",", ":"))
        )

        print("\n🎉 STEP 23.7C PASSED!")


if __name__ == "__main__":
    main()
