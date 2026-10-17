"""Multi-modal MRI data for each hospital.

Three sources, all producing the same on-disk format so the rest of the system
does not care where the data came from:

  synthetic  procedurally generated 4-modality brain phantoms with tumours. Each
             hospital gets its own "scanner" (gain, bias field, noise, contrast),
             so the hospitals are non-IID, like real sites.
  msd        Medical Segmentation Decathlon Task01_BrainTumour (BraTS-derived,
             one 4-D NIfTI per case: FLAIR, T1w, T1gd, T2w).
  brats2021  BraTS 2021 layout (one NIfTI per modality: _t1, _t1ce, _t2, _flair, _seg).

Output per hospital: data/hospital_<id>/{train,val}.npz with
  X: float32 [n, 4, H, W]  channels = T1, T1Gd, T2, FLAIR (z-scored inside the brain)
  Y: float32 [n, 1, H, W]  whole-tumour mask (edema + core)

Run:  python -m cerebrachain.data --source synthetic --hospitals 4 --out data
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from dataclasses import dataclass

import numpy as np

MODALITIES = ("T1", "T1Gd", "T2", "FLAIR")


# --------------------------------------------------------------------------- #
# Synthetic phantoms
# --------------------------------------------------------------------------- #
# Tissue intensities per modality (T1, T1Gd, T2, FLAIR). Chosen to mimic the
# qualitative contrast of real sequences, so that the tumour is only fully
# visible when modalities are combined:
#   edema: bright on T2 and FLAIR, but CSF is also bright on T2 (FLAIR suppresses it)
#   enhancing rim: only stands out on T1Gd
TISSUE = {
    "wm":       (0.80, 0.80, 0.40, 0.45),
    "gm":       (0.60, 0.62, 0.55, 0.55),
    "csf":      (0.20, 0.20, 1.00, 0.10),
    "edema":    (0.48, 0.50, 0.85, 0.95),
    "enhance":  (0.55, 1.00, 0.70, 0.72),
    "necrosis": (0.30, 0.32, 0.95, 0.40),
}


@dataclass
class Scanner:
    gain: np.ndarray      # per-modality multiplicative gain
    gamma: np.ndarray     # per-modality contrast curve
    bias: float           # strength of smooth multiplicative bias field
    noise: float          # Rician-ish noise level


def scanner_for(hospital_id: int) -> Scanner:
    rng = np.random.default_rng(1000 + hospital_id)
    return Scanner(
        gain=rng.uniform(0.7, 1.3, size=4),
        gamma=rng.uniform(0.75, 1.35, size=4),
        bias=float(rng.uniform(0.05, 0.35)),
        noise=float(rng.uniform(0.02, 0.08)),
    )


def _smooth_field(rng, size, scale, octaves=3):
    """Cheap low-frequency random field in [-1, 1]."""
    out = np.zeros((size, size), np.float32)
    for o in range(octaves):
        n = max(2, int(size / (scale / (2 ** o))))
        coarse = rng.standard_normal((n, n)).astype(np.float32)
        # bilinear upsample
        xi = np.linspace(0, n - 1, size)
        x0 = np.floor(xi).astype(int)
        x1 = np.minimum(x0 + 1, n - 1)
        t = (xi - x0)[None, :]
        rows = coarse[:, x0] * (1 - t) + coarse[:, x1] * t
        t2 = (xi - x0)[:, None]
        up = rows[x0, :] * (1 - t2) + rows[x1, :] * t2
        out += up / (2 ** o)
    out /= np.abs(out).max() + 1e-6
    return out


def _blob(rng, yy, xx, cy, cx, r, lobes=3):
    f = np.zeros_like(yy, dtype=np.float32)
    for _ in range(lobes):
        oy, ox = rng.normal(0, r * 0.35, size=2)
        rr = r * rng.uniform(0.6, 1.0)
        f += np.exp(-(((yy - cy - oy) ** 2 + (xx - cx - ox) ** 2) / (2 * rr ** 2)))
    return f / f.max()


def synth_slice(rng, scanner: Scanner, size=96, tumour=True):
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    c = size / 2
    # Brain: rotated ellipse with a wobbly outline
    a, b = rng.uniform(0.36, 0.44) * size, rng.uniform(0.30, 0.38) * size
    th = rng.uniform(-0.3, 0.3)
    y0, x0 = yy - c - rng.normal(0, 2), xx - c - rng.normal(0, 2)
    yr = y0 * np.cos(th) - x0 * np.sin(th)
    xr = y0 * np.sin(th) + x0 * np.cos(th)
    wobble = 1 + 0.04 * _smooth_field(rng, size, size / 3)
    brain = ((yr / a) ** 2 + (xr / b) ** 2) < wobble

    # Grey/white matter pattern and ventricles
    tex = _smooth_field(rng, size, size / 6)
    wm = brain & (tex > 0.05) & (((yr / a) ** 2 + (xr / b) ** 2) < 0.75)
    vent = np.zeros_like(brain)
    for s in (-1, 1):
        vy, vx = c + rng.normal(0, 1.5), c + s * rng.uniform(4, 7) * size / 96
        vent |= (((yy - vy) / (rng.uniform(7, 11) * size / 96)) ** 2
                 + ((xx - vx) / (rng.uniform(2.5, 4) * size / 96)) ** 2) < 1
    vent &= brain

    labels = np.full((size, size), "", dtype=object)
    labels[brain] = "gm"
    labels[wm] = "wm"
    labels[vent] = "csf"

    mask = np.zeros((size, size), np.float32)
    if tumour:
        for _ in range(20):  # place the tumour inside the brain
            ty, tx = rng.uniform(0.3, 0.7, size=2) * size
            if brain[int(ty), int(tx)]:
                break
        r = rng.uniform(4, 11) * size / 96
        f = _blob(rng, yy, xx, ty, tx, r, lobes=int(rng.integers(2, 5)))
        core = (f > 0.55) & brain
        edema = (f > rng.uniform(0.12, 0.25)) & brain
        rim = core & ~(f > 0.75)
        nec = core & (f > 0.75)
        labels[edema] = "edema"
        labels[rim] = "enhance"
        labels[nec] = "necrosis"
        mask = (edema | core).astype(np.float32)

    img = np.zeros((4, size, size), np.float32)
    for name, vals in TISSUE.items():
        sel = labels == name
        for m in range(4):
            img[m][sel] = vals[m]
    img *= (1 + 0.06 * _smooth_field(rng, size, size / 10))[None]  # tissue texture

    # Scanner effects
    bias = 1 + scanner.bias * _smooth_field(rng, size, size / 1.5)
    for m in range(4):
        x = np.clip(img[m], 0, None) ** scanner.gamma[m] * scanner.gain[m] * bias
        n1 = rng.normal(0, scanner.noise, x.shape)
        n2 = rng.normal(0, scanner.noise, x.shape)
        img[m] = np.sqrt((x + n1) ** 2 + n2 ** 2)  # Rician magnitude noise
    return img, mask[None], brain


def zscore_in_brain(img, brain):
    out = np.zeros_like(img)
    for m in range(img.shape[0]):
        v = img[m][brain]
        if v.size > 10:
            out[m] = (img[m] - v.mean()) / (v.std() + 1e-6)
        out[m][~brain] = 0
    return out


def make_synthetic_hospital(hospital_id: int, n: int, size=96, tumour_frac=0.8, seed=0):
    rng = np.random.default_rng(seed * 7919 + hospital_id)
    sc = scanner_for(hospital_id)
    X = np.zeros((n, 4, size, size), np.float32)
    Y = np.zeros((n, 1, size, size), np.float32)
    for i in range(n):
        img, m, brain = synth_slice(rng, sc, size, tumour=rng.random() < tumour_frac)
        X[i] = zscore_in_brain(img, brain)
        Y[i] = m
    return X, Y


# --------------------------------------------------------------------------- #
# Real data (BraTS-style NIfTI)
# --------------------------------------------------------------------------- #
def _resize(arr, size):
    import torch
    import torch.nn.functional as F
    t = torch.from_numpy(np.ascontiguousarray(arr)).float()[None]
    mode = "nearest" if arr.ndim == 2 else "bilinear"
    if arr.ndim == 2:
        t = t[None]
    out = F.interpolate(t, size=(size, size), mode=mode, align_corners=None if mode == "nearest" else False)
    return out[0].numpy() if arr.ndim == 3 else out[0, 0].numpy()


def _slices_from_volume(vol4, seg, size, max_slices, rng, tumour_frac=0.8):
    """vol4: [4, H, W, D] in order T1, T1Gd, T2, FLAIR. seg: [H, W, D]."""
    brain3 = vol4.sum(0) > 0
    area = brain3.sum((0, 1))
    tum = (seg > 0).sum((0, 1))
    cand = np.where(area > 0.15 * area.max())[0]
    with_t = [z for z in cand if tum[z] > 50]
    without = [z for z in cand if tum[z] == 0]
    k_t = min(len(with_t), int(round(max_slices * tumour_frac)))
    k_n = min(len(without), max_slices - k_t)
    pick = list(rng.choice(with_t, k_t, replace=False)) if k_t else []
    pick += list(rng.choice(without, k_n, replace=False)) if k_n else []
    Xs, Ys = [], []
    for z in pick:
        img = vol4[:, :, :, z].astype(np.float32)
        brain = brain3[:, :, z]
        img = zscore_in_brain(img, brain)
        Xs.append(_resize(img, size))
        Ys.append(_resize((seg[:, :, z] > 0).astype(np.float32), size)[None])
    return Xs, Ys


def _iter_msd(root):
    import nibabel as nib
    imgs = sorted(glob.glob(os.path.join(root, "imagesTr", "*.nii.gz")))
    imgs = [p for p in imgs if not os.path.basename(p).startswith("._")]
    for p in imgs:
        lab = os.path.join(root, "labelsTr", os.path.basename(p))
        v = np.asarray(nib.load(p).dataobj)            # H, W, D, 4: FLAIR, T1w, T1gd, T2w
        s = np.asarray(nib.load(lab).dataobj)
        vol4 = np.stack([v[..., 1], v[..., 2], v[..., 3], v[..., 0]])
        yield os.path.basename(p), vol4, s


def _iter_brats2021(root):
    import nibabel as nib
    cases = sorted(d for d in glob.glob(os.path.join(root, "*")) if os.path.isdir(d))
    for d in cases:
        cid = os.path.basename(d)
        get = lambda suf: np.asarray(nib.load(os.path.join(d, f"{cid}_{suf}.nii.gz")).dataobj)
        vol4 = np.stack([get("t1"), get("t1ce"), get("t2"), get("flair")])
        yield cid, vol4, get("seg")


def _split_case_records(records, rng, val_frac=0.25):
    """Split by patient *before* flattening MRI slices.

    records: [(case_id, X[n, 4, H, W], Y[n, 1, H, W]), ...]
    Returns (train_X, train_Y, val_X, val_Y, train_case_ids, val_case_ids).
    Case IDs are used in memory for split checking, never exported to the
    federated aggregator or included in any output manifest.
    """
    if len(records) < 2:
        raise ValueError("At least 2 distinct patient cases are required per hospital "
                         "for a leakage-free training/validation split.")
    ids = [r[0] for r in records]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate patient case IDs detected in one hospital")
    if not 0 < val_frac < 1:
        raise ValueError("val_frac must be between 0 and 1")

    shuffled = rng.permutation(len(records))
    n_val = min(len(records) - 1, max(1, int(round(len(records) * val_frac))))
    val_pos, train_pos = shuffled[:n_val], shuffled[n_val:]

    def stack_for(indices):
        chosen = [records[int(i)] for i in indices]
        return (np.concatenate([rec[1] for rec in chosen], axis=0),
                np.concatenate([rec[2] for rec in chosen], axis=0),
                [rec[0] for rec in chosen])

    train_X, train_Y, train_ids = stack_for(train_pos)
    val_X, val_Y, val_ids = stack_for(val_pos)
    assert set(train_ids).isdisjoint(val_ids)
    return train_X, train_Y, val_X, val_Y, train_ids, val_ids


def prepare_real(source, root, hospitals, out, size, slices_per_case, max_cases, seed):
    """Build hospital-private datasets, splitting *patients*, not slices.

    Existing BraTS/MSD NIfTI sources are research datasets, not a verified
    clinical DICOM ingestion pipeline. Patient identifiers stay local.
    """
    it = _iter_msd(root) if source == "msd" else _iter_brats2021(root)
    rng = np.random.default_rng(seed)
    per = {h: [] for h in range(hospitals)}
    seen_ids = set()
    for i, (cid, vol4, seg) in enumerate(it):
        if max_cases and i >= max_cases:
            break
        if cid in seen_ids:
            raise ValueError(f"Duplicate case ID: {cid}")
        seen_ids.add(cid)
        h = i % hospitals
        Xs, Ys = _slices_from_volume(vol4, seg, size, slices_per_case, rng)
        if not Xs:
            print(f"  skipping case {cid}: no eligible slices")
            continue
        per[h].append((cid, np.stack(Xs).astype(np.float32),
                       np.stack(Ys).astype(np.float32)))
        print(f"  {cid} -> hospital {h} ({len(Xs)} slices)")

    for h, cases in per.items():
        if len(cases) < 2:
            raise ValueError(f"hospital {h} has {len(cases)} usable case(s); "
                             "provide >= 2 distinct patients per hospital "
                             "(increase --max-cases if necessary)")
        Xtr, Ytr, Xv, Yv, tr_ids, v_ids = _split_case_records(cases, rng)
        d = os.path.join(out, f"hospital_{h}")
        os.makedirs(d, exist_ok=True)
        np.savez_compressed(os.path.join(d, "train.npz"), X=Xtr, Y=Ytr)
        np.savez_compressed(os.path.join(d, "val.npz"), X=Xv, Y=Yv)
        # Local summary contains counts, not case/patient IDs or MRI pixels.
        with open(os.path.join(d, "split_summary.json"), "w") as f:
            json.dump({"strategy": "patient-level", "train_cases": len(tr_ids),
                       "val_cases": len(v_ids), "train_slices": len(Xtr),
                       "val_slices": len(Xv)}, f, indent=2)
        print(f"hospital {h}: {len(tr_ids)} train / {len(v_ids)} val patients; "
              f"{len(Xtr)} train / {len(Xv)} val slices -> {d}")


# --------------------------------------------------------------------------- #
def _save_split(out, h, X, Y, rng, val_frac=0.25):
    idx = rng.permutation(len(X))
    nv = max(1, int(len(X) * val_frac))
    d = os.path.join(out, f"hospital_{h}")
    os.makedirs(d, exist_ok=True)
    np.savez_compressed(os.path.join(d, "val.npz"), X=X[idx[:nv]], Y=Y[idx[:nv]])
    np.savez_compressed(os.path.join(d, "train.npz"), X=X[idx[nv:]], Y=Y[idx[nv:]])
    print(f"hospital {h}: {len(X) - nv} train / {nv} val slices -> {d}")


def load_hospital(data_dir: str, hospital_id: int, split: str):
    z = np.load(os.path.join(data_dir, f"hospital_{hospital_id}", f"{split}.npz"))
    return z["X"], z["Y"]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["synthetic", "msd", "brats2021"], default="synthetic")
    ap.add_argument("--root", help="dataset root (msd: Task01_BrainTumour folder, brats2021: folder of case dirs)")
    ap.add_argument("--hospitals", type=int, default=4)
    ap.add_argument("--out", default="data")
    ap.add_argument("--size", type=int, default=96, help="slice size in pixels")
    ap.add_argument("--slices-per-hospital", type=int, default=160, help="synthetic only")
    ap.add_argument("--slices-per-case", type=int, default=12, help="real data only")
    ap.add_argument("--max-cases", type=int, default=0, help="real data only, 0 = all")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)

    if a.hospitals < 1 or a.size < 16 or a.size % 4 != 0:
        ap.error("--hospitals must be >= 1 and --size must be >=16 and divisible by 4")
    if a.slices_per_case < 1 or a.slices_per_hospital < 2:
        ap.error("slice counts must be positive; synthetic hospitals need >= 2 slices")
    if a.max_cases < 0:
        ap.error("--max-cases must be >= 0")

    os.makedirs(a.out, exist_ok=True)
    if a.source == "synthetic":
        rng = np.random.default_rng(a.seed)
        for h in range(a.hospitals):
            X, Y = make_synthetic_hospital(h, a.slices_per_hospital, a.size, seed=a.seed)
            _save_split(a.out, h, X, Y, rng)
    else:
        if not a.root:
            ap.error("--root is required for real data")
        prepare_real(a.source, a.root, a.hospitals, a.out, a.size, a.slices_per_case, a.max_cases, a.seed)
    with open(os.path.join(a.out, "meta.json"), "w") as f:
        json.dump({"source": a.source, "hospitals": a.hospitals, "size": a.size,
                   "modalities": MODALITIES,
                   "split_unit": "patient" if a.source != "synthetic" else "slice",
                   "label_type": "whole_tumour_binary"}, f, indent=2)


if __name__ == "__main__":
    main()
