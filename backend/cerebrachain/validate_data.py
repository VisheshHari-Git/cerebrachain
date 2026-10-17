"""Validate private hospital MRI datasets before training.

Usage:
  python -m cerebrachain.validate_data --data-dir data --hospitals 4

This validates shapes, finiteness, masks and local split metadata. It does NOT
verify medical-image provenance, DICOM signatures or patient consent.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def validate_hospital(data_dir: str | Path, hospital_id: int, expected_size: int | None = None):
    root = Path(data_dir) / f"hospital_{hospital_id}"
    results = {}
    for split in ("train", "val"):
        p = root / f"{split}.npz"
        if not p.is_file():
            raise ValueError(f"Missing {p}")
        with np.load(p, allow_pickle=False) as z:
            if not {"X", "Y"}.issubset(z.files):
                raise ValueError(f"{p}: expected X and Y arrays")
            X, Y = z["X"], z["Y"]
        if X.ndim != 4 or Y.ndim != 4:
            raise ValueError(f"{p}: expected X[n,4,H,W] and Y[n,1,H,W]")
        if X.shape[0] == 0 or X.shape[1] != 4 or Y.shape[1] != 1:
            raise ValueError(f"{p}: empty dataset or incorrect modality/mask channels")
        if X.shape[0] != Y.shape[0] or X.shape[-2:] != Y.shape[-2:]:
            raise ValueError(f"{p}: image/mask dimensions do not match")
        h, w = X.shape[-2:]
        if h != w or (expected_size is not None and h != expected_size):
            raise ValueError(f"{p}: unexpected slice size {h}x{w}")
        if not np.issubdtype(X.dtype, np.number) or not np.issubdtype(Y.dtype, np.number):
            raise ValueError(f"{p}: numeric data required")
        if not np.isfinite(X).all() or not np.isfinite(Y).all():
            raise ValueError(f"{p}: images/masks contain NaN or infinity")
        if not np.logical_or(Y == 0, Y == 1).all():
            raise ValueError(f"{p}: whole-tumour masks must be binary (0 or 1)")
        results[split] = {"slices": len(X), "image_shape": list(X.shape),
                          "tumour_slices": int(np.count_nonzero(Y.reshape(len(Y), -1).any(axis=1)))}

    summary_path = root / "split_summary.json"
    if summary_path.exists():
        summary = json.loads(summary_path.read_text())
        if summary.get("strategy") != "patient-level":
            raise ValueError(f"{summary_path}: expected patient-level strategy")
        if min(summary.get("train_cases", 0), summary.get("val_cases", 0)) < 1:
            raise ValueError(f"{summary_path}: train and validation each need patients")
        for split in ("train", "val"):
            if summary.get(f"{split}_slices") != results[split]["slices"]:
                raise ValueError(f"{summary_path}: {split} slice count mismatch")
        results["patient_split"] = summary
    return results


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--hospitals", type=int, default=None)
    args = ap.parse_args(argv)
    root = Path(args.data_dir)
    meta_path = root / "meta.json"
    if not meta_path.is_file():
        ap.error(f"Missing {meta_path}; run python -m cerebrachain.data first")
    meta = json.loads(meta_path.read_text())
    n = args.hospitals if args.hospitals is not None else meta["hospitals"]
    if n < 1:
        ap.error("--hospitals must be >= 1")
    if meta.get("source") != "synthetic" and meta.get("split_unit") != "patient":
        ap.error("Real datasets require patient-level splitting; rebuild using the updated loader")
    reports = {}
    for h in range(n):
        results = validate_hospital(root, h, expected_size=meta["size"])
        if meta.get("source") != "synthetic" and "patient_split" not in results:
            raise ValueError(f"hospital {h}: missing patient-level split summary")
        reports[f"hospital_{h}"] = results
        print(f"Hospital {h}: train={results['train']['slices']} slices, "
              f"validation={results['val']['slices']} slices — OK")
    print("DATA VALIDATION PASSED")
    return reports


if __name__ == "__main__":
    main()
