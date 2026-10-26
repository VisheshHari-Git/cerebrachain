"""Adapter for loading a teammate's trained 3D U-Net checkpoint."""

from pathlib import Path

import torch
from torch import nn


def load_trained_model(
    model: nn.Module,
    checkpoint_path: str,
    device: str = "cpu",
) -> nn.Module:
    """Load compatible trained weights into a 3D U-Net model."""

    path = Path(checkpoint_path)

    if not path.is_file():
        raise FileNotFoundError(
            f"Model checkpoint not found: {path}"
        )

    checkpoint = torch.load(
        path,
        map_location="cpu",
        weights_only=True,
    )

    if not isinstance(checkpoint, dict):
        raise ValueError("Expected a model state dictionary")

    if "model_state_dict" in checkpoint:
        state_dict = checkpoint["model_state_dict"]
    elif "state_dict" in checkpoint:
        state_dict = checkpoint["state_dict"]
    else:
        state_dict = checkpoint

    if not isinstance(state_dict, dict):
        raise ValueError("Invalid model state dictionary")

    model.load_state_dict(state_dict, strict=True)

    model = model.to(device)
    model.eval()

    return model
