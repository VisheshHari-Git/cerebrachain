"""Secure aggregation with pairwise additive masks (Bonawitz et al., 2017, simplified).

Every pair of hospitals (i, j) agrees on a secret seed via X25519 Diffie-Hellman.
Hospital i uploads

    y_i = n_i * q_i + sum_{j > i} PRG(s_ij) - sum_{j < i} PRG(s_ij)   (mod 2^64)

The masks cancel in the sum, so the aggregator learns sum_i n_i * q_i but never an
individual hospital's update.

If a hospital is excluded (failed ZK verification or dropped out), the surviving
hospitals reveal *only their pairwise seed with that hospital, for this round only*,
so the aggregator can strip the now-unbalanced masks. Seeds are derived per round
with HKDF, so revealing one leaks nothing about other rounds.
"""
from __future__ import annotations

import hashlib
import os

import numpy as np
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def load_or_create_key(path: str) -> X25519PrivateKey:
    if os.path.exists(path):
        with open(path, "rb") as f:
            return X25519PrivateKey.from_private_bytes(f.read())
    key = X25519PrivateKey.generate()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                  serialization.NoEncryption()))
    return key


def public_bytes(key: X25519PrivateKey) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def pairwise_seed(my_key: X25519PrivateKey, my_id: int, peer_id: int, peer_pub: bytes, round_id: int) -> bytes:
    shared = my_key.exchange(X25519PublicKey.from_public_bytes(peer_pub))
    lo, hi = sorted((my_id, peer_id))
    info = f"cerebrachain/mask/v1/round={round_id}/pair={lo}-{hi}".encode()
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(shared)


def prg_u64(seed: bytes, length: int) -> np.ndarray:
    """Cryptographic PRG (SHAKE-256 XOF) -> uint64 vector."""
    return np.frombuffer(hashlib.shake_256(seed).digest(8 * length), dtype="<u8").copy()


def _sign(my_id: int, peer_id: int) -> int:
    return 1 if my_id < peer_id else -1


def mask_vector(values: np.ndarray, my_id: int, my_key: X25519PrivateKey,
                peers: dict[int, bytes], round_id: int) -> np.ndarray:
    """values: int64 vector (n_i * q_i). peers: {peer_id: x25519 public key} (excluding self)."""
    y = values.astype(np.int64).view(np.uint64).copy()
    for pid, pub in sorted(peers.items()):
        if pid == my_id:
            continue
        m = prg_u64(pairwise_seed(my_key, my_id, pid, pub, round_id), len(y))
        if _sign(my_id, pid) > 0:
            y += m
        else:
            y -= m
    return y


def masked_hash(y: np.ndarray) -> bytes:
    return hashlib.sha256(np.ascontiguousarray(y, dtype="<u8").tobytes()).digest()


def aggregate(masked: dict[int, np.ndarray], revealed: dict[tuple[int, int], bytes]) -> np.ndarray:
    """Sum the surviving hospitals' uploads and strip masks shared with excluded hospitals.

    masked:   {hospital_id: uint64 vector} for surviving hospitals
    revealed: {(survivor_id, excluded_id): seed} pairwise seeds revealed after exclusion
    Returns the int64 aggregate sum_i n_i * q_i over survivors.
    """
    length = len(next(iter(masked.values())))
    acc = np.zeros(length, np.uint64)
    for y in masked.values():
        acc += y
    for (sid, eid), seed in revealed.items():
        m = prg_u64(seed, length)
        if _sign(sid, eid) > 0:
            acc -= m
        else:
            acc += m
    return acc.view(np.int64)
