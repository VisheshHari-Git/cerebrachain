"""Hashing conventions shared by the hospitals, the aggregator, the trust layer
(trust-layer/src/protocol.js) and the smart contract (CerebraChainRegistry.sol).

All three implementations must produce identical values; tests/test_fields.py and
trust-layer/test/protocol.test.js pin them to the same test vectors.

Everything is SHA-256 over Solidity-style ``abi.encodePacked`` bytes, reduced
modulo the BN254 scalar field when the value has to enter the circuit.
"""
from __future__ import annotations

import hashlib
from typing import Iterable, Sequence

# BN254 scalar field (the field circom / Groth16 work in)
R = 21888242871839275222246405745257275088548364400416034343698204186575808495617

TAG_CTX = b"CerebraChain/ctx"
TAG_SEED = b"CerebraChain/seed"
TAG_X = b"CerebraChain/x"


def u256(v: int) -> bytes:
    """32-byte big-endian, like a Solidity uint256 in abi.encodePacked."""
    if v < 0 or v >= 1 << 256:
        raise ValueError("value does not fit in uint256")
    return v.to_bytes(32, "big")


def b32(v: bytes) -> bytes:
    if len(v) != 32:
        raise ValueError("expected 32 bytes")
    return v


def sha256(*parts: bytes) -> bytes:
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


def ctx_for(round_id: int, hospital_id: int, global_model_hash: bytes) -> int:
    """Public circuit input binding a proof to one round, one hospital and one global model."""
    d = sha256(TAG_CTX, u256(round_id), u256(hospital_id), b32(global_model_hash))
    return int.from_bytes(d, "big") % R


def challenge_seed(
    round_id: int,
    global_model_hash: bytes,
    entries: Iterable[tuple[int, bytes, bytes, int]],
) -> bytes:
    """Fiat-Shamir seed. ``entries`` = (hospital_id, commitment_root, masked_hash, num_samples)
    for every hospital that committed, in participant order. Because the masked
    uploads are hashed in, nobody can adapt their upload after seeing the challenge."""
    parts = [TAG_SEED, u256(round_id), b32(global_model_hash)]
    for hid, root, mhash, n in entries:
        parts += [u256(hid), b32(root), b32(mhash), u256(n)]
    return sha256(*parts)


def x_for(seed: bytes, chunk_index: int) -> int:
    """Per-chunk evaluation point for the polynomial identity check."""
    d = sha256(TAG_X, b32(seed), u256(chunk_index))
    return int.from_bytes(d, "big") % R


def commitment_root(chunk_commitments: Sequence[int]) -> bytes:
    """Root commitment of a whole update = sha256 over the per-chunk Poseidon commitments."""
    return sha256(*(u256(c) for c in chunk_commitments))


def poly_eval(values: Sequence[int], x: int) -> int:
    """sum_j values[j] * x^j mod R (Horner). Negative values are mapped into the field."""
    acc = 0
    for v in reversed(values):
        acc = (acc * x + int(v)) % R
    return acc
