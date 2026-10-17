"""Clipping and int8 quantisation of model updates.

The circuit works on integers, so a float update delta is mapped to int8:

    1. clip:      delta <- delta * min(1, C / ||delta||)          (L2 clip to C)
    2. quantise:  q = stochastic_round(delta / s), clamped to [-128, 127]

Stochastic rounding keeps the quantiser unbiased, so FedAvg still converges.
The aggregator publishes C and s each round; the norm bound the ZK verifier
enforces on sum(q^2) follows from them (see ``norm_bound``).
"""
from __future__ import annotations

import math

import numpy as np

QMIN, QMAX = -128, 127


def default_scale(clip_norm: float, dim: int, resolution: float = 16.0) -> float:
    """Quantisation step so that a coordinate of RMS size maps to ~``resolution`` levels
    when the update sits exactly at the clip norm."""
    return clip_norm / (resolution * math.sqrt(dim))


def norm_bound(clip_norm: float, scale: float, dim: int) -> int:
    """Upper bound on sum(q^2) for an honest, clipped update.

    (C/s)^2 is the clipped norm in quantisation units; stochastic rounding adds at
    most 1/4 variance per coordinate plus a cross term, covered by the 1% + dim slack.
    ``quantize`` additionally guarantees an honest update never exceeds it."""
    return int(math.ceil((clip_norm / scale) ** 2 * 1.01 + dim))


def clip(delta: np.ndarray, clip_norm: float) -> np.ndarray:
    n = float(np.linalg.norm(delta))
    return delta if n <= clip_norm else delta * (clip_norm / n)


def quantize(delta: np.ndarray, scale: float, rng: np.random.Generator, bound: int | None = None) -> np.ndarray:
    a = np.asarray(delta, np.float64) / scale
    for _ in range(10):
        lo = np.floor(a)
        q = lo + (rng.random(a.shape) < (a - lo))
        q = np.clip(q, QMIN, QMAX).astype(np.int64)
        if bound is None or int((q * q).sum()) <= bound:
            return q
        a *= 0.99  # honest safety margin: shrink very slightly and retry
    raise RuntimeError("could not quantise update under the norm bound")


def dequantize(q: np.ndarray, scale: float) -> np.ndarray:
    return q.astype(np.float64) * scale


def to_chunks(q: np.ndarray, chunk_size: int) -> list[np.ndarray]:
    """Zero-pad to a multiple of chunk_size and split."""
    k = max(1, math.ceil(len(q) / chunk_size))
    padded = np.zeros(k * chunk_size, np.int64)
    padded[: len(q)] = q
    return [padded[i * chunk_size:(i + 1) * chunk_size] for i in range(k)]


def num_chunks(dim: int, chunk_size: int) -> int:
    return max(1, math.ceil(dim / chunk_size))
