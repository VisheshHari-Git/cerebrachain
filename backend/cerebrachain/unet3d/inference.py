"""Experimental 3D binary segmentation inference."""

import numpy as np
import torch


@torch.inference_mode()
def predict_3d(model, input_tensor, threshold=0.5):
    """
    Run binary 3D segmentation inference.

    Input:
        [1, C, D, H, W]

    Expected model output:
        [1, 1, D, H, W]

    Returns:
        probability_map: [D, H, W]
        segmentation_mask: [D, H, W]
    """

    if not isinstance(input_tensor, torch.Tensor):
        raise TypeError("Input must be a PyTorch tensor")

    if input_tensor.ndim != 5:
        raise ValueError("Expected a 5D MRI tensor")

    if input_tensor.shape[0] != 1:
        raise ValueError("Only batch size 1 is supported")

    if not torch.isfinite(input_tensor).all().item():
        raise ValueError("MRI contains invalid values")

    if not 0.0 < threshold < 1.0:
        raise ValueError("Threshold must be between 0 and 1")

    model.eval()

    device = next(
        model.parameters(),
        torch.empty(0)
    ).device

    input_tensor = input_tensor.to(device)

    logits = model(input_tensor)

    expected_shape = (
        1, 1, *input_tensor.shape[2:]
    )

    if tuple(logits.shape) != expected_shape:
        raise ValueError(
            f"Expected binary segmentation output "
            f"{expected_shape}, got {tuple(logits.shape)}"
        )

    if not torch.isfinite(logits).all().item():
        raise ValueError("Model produced invalid values")

    probabilities = torch.sigmoid(logits)

    mask = (probabilities >= threshold).to(torch.uint8)

    probability_map = (
        probabilities[0, 0].cpu().numpy().copy()
    )

    segmentation_mask = (
        mask[0, 0].cpu().numpy().copy()
    )

    return {
        "probability_map": probability_map.astype(np.float32),
        "segmentation_mask": segmentation_mask,
    }
