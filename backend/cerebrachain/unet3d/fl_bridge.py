
"""Deterministic MONAI 3D U-Net state_dict vector adapter.

This module only converts model tensors to/from flat vectors.
It does NOT perform encryption, secure aggregation, or ZK proving.
"""

import numpy as np
import torch


def model_schema(state):
    return tuple(
        (key, tuple(value.shape), str(value.dtype))
        for key, value in sorted(state.items())
        if value.is_floating_point()
    )


def flatten_state(state, reference):
    if state.keys() != reference.keys():
        raise ValueError("Model state keys mismatch")

    arrays = []

    for key, expected in sorted(reference.items()):
        value = state[key]

        if value.shape != expected.shape:
            raise ValueError(f"Shape mismatch: {key}")

        if value.dtype != expected.dtype:
            raise ValueError(f"Dtype mismatch: {key}")

        if not expected.is_floating_point():
            continue

        if expected.dtype != torch.float32:
            raise ValueError(f"Unsupported floating dtype: {key}")

        if not torch.isfinite(value).all():
            raise ValueError(f"Non-finite values: {key}")

        arrays.append(
            value.detach().cpu().contiguous().reshape(-1)
        )

    return torch.cat(arrays).numpy().copy()


def restore_state(vector, reference):
    vector = np.asarray(vector)

    if vector.dtype != np.float32 or vector.ndim != 1:
        raise ValueError("Expected one-dimensional float32 vector")

    expected_size = sum(
        value.numel()
        for value in reference.values()
        if value.is_floating_point()
    )

    if vector.size != expected_size:
        raise ValueError(
            f"Expected {expected_size} values, got {vector.size}"
        )

    if not np.isfinite(vector).all():
        raise ValueError("Non-finite vector values")

    restored = {}
    offset = 0

    for key, value in sorted(reference.items()):
        if not value.is_floating_point():
            restored[key] = value.clone()
            continue

        count = value.numel()

        restored[key] = torch.from_numpy(
            vector[offset:offset + count].copy()
        ).reshape(value.shape)

        offset += count

    # Preserve original state_dict key order.
    return {
        key: restored[key]
        for key in reference.keys()
    }
