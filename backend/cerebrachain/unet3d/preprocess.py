"""Basic 3D MRI tensor preparation."""

import numpy as np
import torch


def prepare_3d_input(volume):
    """
    Convert MRI volume from [4, H, W, D]
    to PyTorch tensor [1, 4, D, H, W].

    Does not modify MRI intensity values.
    """

    volume = np.asarray(volume, dtype=np.float32)

    if volume.ndim != 4:
        raise ValueError("Expected [4, H, W, D] MRI volume")

    if volume.shape[0] != 4:
        raise ValueError("Expected four MRI modalities")

    if not np.isfinite(volume).all():
        raise ValueError("MRI contains NaN or infinity")

    # Convert [4, H, W, D] to [4, D, H, W]
    volume = np.transpose(volume, (0, 3, 1, 2))

    # Add batch dimension
    volume = np.ascontiguousarray(volume)

    tensor = torch.from_numpy(volume).unsqueeze(0)

    return tensor
