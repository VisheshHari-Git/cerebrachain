"""2-D U-Net for multi-modal (T1, T1Gd, T2, FLAIR) brain-tumour segmentation.

Kept deliberately small (~29k federated parameters) so that every round's update
can be proven in zero knowledge on a laptop CPU. Widen ``channels`` for real data
if you have the proving budget (proof time grows linearly with parameter count).

FedBN: BatchNorm layers stay local to each hospital (they absorb scanner-specific
intensity statistics); only convolution weights are federated and proven.
"""
from __future__ import annotations

import hashlib

import numpy as np
import torch
import torch.nn as nn


class ConvBlock(nn.Sequential):
    def __init__(self, cin, cout):
        super().__init__(
            nn.Conv2d(cin, cout, 3, padding=1, bias=False),
            nn.BatchNorm2d(cout),
            nn.ReLU(inplace=True),
            nn.Conv2d(cout, cout, 3, padding=1, bias=False),
            nn.BatchNorm2d(cout),
            nn.ReLU(inplace=True),
        )


class UNet2D(nn.Module):
    def __init__(self, in_channels=4, out_channels=1, channels=(8, 16, 32)):
        super().__init__()
        c0, c1, c2 = channels
        self.enc1 = ConvBlock(in_channels, c0)
        self.enc2 = ConvBlock(c0, c1)
        self.bottleneck = ConvBlock(c1, c2)
        self.pool = nn.MaxPool2d(2)
        self.up2 = nn.ConvTranspose2d(c2, c1, 2, stride=2)
        self.dec2 = ConvBlock(2 * c1, c1)
        self.up1 = nn.ConvTranspose2d(c1, c0, 2, stride=2)
        self.dec1 = ConvBlock(2 * c0, c0)
        self.head = nn.Conv2d(c0, out_channels, 1)

    def forward(self, x):
        e1 = self.enc1(x)
        e2 = self.enc2(self.pool(e1))
        b = self.bottleneck(self.pool(e2))
        d2 = self.dec2(torch.cat([self.up2(b), e2], 1))
        d1 = self.dec1(torch.cat([self.up1(d2), e1], 1))
        return self.head(d1)


def build_model(seed: int | None = None) -> UNet2D:
    if seed is not None:
        torch.manual_seed(seed)
    return UNet2D()


def federated_keys(model: nn.Module) -> list[str]:
    """Parameter names that are shared and aggregated (everything except BatchNorm)."""
    bn_prefixes = {name + "." for name, m in model.named_modules() if isinstance(m, nn.BatchNorm2d)}
    return [n for n, _ in model.named_parameters() if not any(n.startswith(p) for p in bn_prefixes)]


def get_flat(model: nn.Module, keys: list[str]) -> np.ndarray:
    sd = model.state_dict()
    return np.concatenate([sd[k].detach().cpu().numpy().ravel() for k in keys]).astype(np.float32)


def set_flat(model: nn.Module, keys: list[str], flat: np.ndarray) -> None:
    sd = model.state_dict()
    off = 0
    with torch.no_grad():
        for k in keys:
            t = sd[k]
            n = t.numel()
            t.copy_(torch.from_numpy(np.asarray(flat[off:off + n], np.float32)).view_as(t))
            off += n
    if off != len(flat):
        raise ValueError(f"flat vector has {len(flat)} values, model expects {off}")


def model_hash(flat: np.ndarray) -> bytes:
    """Hash of the global (federated) weights; anchors every round on-chain."""
    return hashlib.sha256(np.ascontiguousarray(flat, dtype="<f4").tobytes()).digest()
