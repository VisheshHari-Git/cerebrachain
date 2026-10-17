"""Synthetic-only 3D MRI inference demonstration."""

import numpy as np
import torch
from torch import nn
from fastapi import APIRouter

from cerebrachain.unet3d.preprocess import prepare_3d_input
from cerebrachain.unet3d.inference import predict_3d

router = APIRouter(prefix="/demo", tags=["Synthetic MRI Demo"])


@router.get("/predict")
def demo_predict():
    """Run a deterministic test model on synthetic MRI data."""

    shape = (16, 16, 8)

    # Synthetic MRI volume: [4, H, W, D]
    volume = np.zeros((4, *shape), dtype=np.float32)

    # Artificial tumor-shaped region
    volume[0, 4:12, 4:12, 2:6] = 1.0

    # Synthetic grayscale brain-like background for visualization.
    # This is NOT a real MRI scan.
    h, w, d = np.indices(shape, dtype=np.float32)

    radius = (
        ((h - 7.5) / 7.2) ** 2
        + ((w - 7.5) / 7.0) ** 2
        + ((d - 3.5) / 3.7) ** 2
    )

    volume[1] = np.where(
        radius <= 1.0,
        0.15 + 0.28 * (1.0 - radius),
        0.02,
    ).astype(np.float32)

    # Convert into PyTorch 3D input
    tensor = prepare_3d_input(volume)

    # Deterministic test model, NOT a trained 3D U-Net
    model = nn.Conv3d(4, 1, kernel_size=1)

    with torch.no_grad():
        model.weight.zero_()
        model.weight[0, 0, 0, 0, 0] = 8.0
        model.bias.fill_(-4.0)

    result = predict_3d(model, tensor)

    mask = result["segmentation_mask"]

    # Middle depth slice for frontend visualization
    middle_slice = mask.shape[0] // 2

    return {
        "status": "success",
        "mode": "synthetic_demo",
        "is_real_patient_data": False,
        "is_trained_model": False,
        "model": "deterministic_test_conv3d",
        "input_shape": list(tensor.shape),
        "segmentation_shape": list(mask.shape),
        "segmented_voxels": int(mask.sum()),
        "slice_index": middle_slice,
        "segmentation_slice": mask[middle_slice].tolist(),
        "segmentation_volume": mask.tolist(),
        "mri_volume": np.transpose(
            volume[1], (2, 0, 1)
        ).round(3).tolist(),
        "mri_image_type": "synthetic_grayscale_background",
        "disclaimer": "Synthetic software test only. Not a medical prediction."
    }
