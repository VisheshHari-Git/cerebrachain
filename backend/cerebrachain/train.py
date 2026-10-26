"""Local training and evaluation inside a hospital."""
from __future__ import annotations

import numpy as np
import torch
import torch.nn.functional as F


def pick_device(pref: str = "auto") -> torch.device:
    if pref == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device(pref)


def dice_loss(logits, target, eps=1.0):
    p = torch.sigmoid(logits)
    inter = (p * target).sum((1, 2, 3))
    den = p.sum((1, 2, 3)) + target.sum((1, 2, 3))
    return (1 - (2 * inter + eps) / (den + eps)).mean()


def _augment(x, y):
    if torch.rand(1).item() < 0.5:
        x, y = x.flip(-1), y.flip(-1)
    if torch.rand(1).item() < 0.5:
        x, y = x.flip(-2), y.flip(-2)
    return x, y


def train_local(model, X, Y, epochs=2, lr=2e-3, batch_size=16, device="cpu", seed=None):
    if seed is not None:
        torch.manual_seed(seed)
    model.to(device).train()
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    Xt, Yt = torch.from_numpy(X), torch.from_numpy(Y)
    n = len(Xt)
    losses = []
    for _ in range(epochs):
        perm = torch.randperm(n)
        for i in range(0, n, batch_size):
            idx = perm[i:i + batch_size]
            x, y = _augment(Xt[idx].to(device), Yt[idx].to(device))
            logits = model(x)
            loss = F.binary_cross_entropy_with_logits(logits, y) + dice_loss(logits, y)
            opt.zero_grad()
            loss.backward()
            opt.step()
            losses.append(loss.item())
    model.to("cpu")
    return float(np.mean(losses))


@torch.no_grad()
def recalibrate_bn(model, X, device="cpu", batch_size=32):
    """Re-estimate this hospital's BatchNorm statistics for the new global weights.

    With FedBN the conv weights change every round while BN statistics stay local,
    so the stored running stats are stale. One forward pass over local training
    data (no gradients, no labels) refreshes them."""
    bns = [m for m in model.modules() if isinstance(m, torch.nn.BatchNorm2d)]
    saved = [m.momentum for m in bns]
    for m in bns:
        m.reset_running_stats()
        m.momentum = None  # cumulative average over the pass
    model.to(device).train()
    for i in range(0, len(X), batch_size):
        model(torch.from_numpy(X[i:i + batch_size]).to(device))
    for m, mom in zip(bns, saved):
        m.momentum = mom
    model.to("cpu").eval()


@torch.no_grad()
def evaluate(model, X, Y, device="cpu", batch_size=32):
    """Returns mean Dice over slices that contain tumour, plus pixel-level metrics."""
    model.to(device).eval()
    dices, tp, fp, fn = [], 0.0, 0.0, 0.0
    for i in range(0, len(X), batch_size):
        x = torch.from_numpy(X[i:i + batch_size]).to(device)
        y = torch.from_numpy(Y[i:i + batch_size]).to(device)
        pred = (torch.sigmoid(model(x)) > 0.5).float()
        inter = (pred * y).sum((1, 2, 3))
        ps, ys = pred.sum((1, 2, 3)), y.sum((1, 2, 3))
        for a, b, c in zip(inter.tolist(), ps.tolist(), ys.tolist()):
            if c > 0:
                dices.append(2 * a / (b + c + 1e-6))
        tp += inter.sum().item()
        fp += (ps - inter).sum().item()
        fn += (ys - inter).sum().item()
    model.to("cpu")
    return {
        "dice": float(np.mean(dices)) if dices else 0.0,
        "pixel_dice": float(2 * tp / (2 * tp + fp + fn + 1e-6)),
        "n": int(len(X)),
    }
