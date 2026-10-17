"""Step 1: MRI prep and training/validation leakage prevention tests."""
import json
from pathlib import Path

import numpy as np
import pytest

from cerebrachain.data import _split_case_records, prepare_real, main as prep_main
from cerebrachain.validate_data import main as validate_main, validate_hospital


def _records(n=8, slices=3):
    # Constant ID marker in images makes patient/split overlap easy to catch.
    records = []
    for i in range(n):
        X = np.full((slices, 4, 16, 16), i + 1, dtype=np.float32)
        Y = np.zeros((slices, 1, 16, 16), dtype=np.float32)
        Y[:, :, 3:8, 5:10] = 1
        records.append((f"case-{i}", X, Y))
    return records


def test_patient_level_split_never_mixes_slices_of_same_patient():
    records = _records()
    trX, trY, valX, valY, tr_ids, val_ids = _split_case_records(
        records, np.random.default_rng(12))
    assert set(tr_ids).isdisjoint(val_ids)
    assert len(tr_ids) + len(val_ids) == 8
    assert len(trX) == 3 * len(tr_ids)
    assert len(valX) == 3 * len(val_ids)
    assert set(np.unique(trX)).isdisjoint(np.unique(valX))
    assert trY.shape[1:] == valY.shape[1:] == (1, 16, 16)


def test_single_patient_and_duplicate_patient_rejected():
    with pytest.raises(ValueError, match="2 distinct"):
        _split_case_records(_records(1), np.random.default_rng(0))
    dup = _records(2)
    dup[1] = (dup[0][0], dup[1][1], dup[1][2])
    with pytest.raises(ValueError, match="Duplicate"):
        _split_case_records(dup, np.random.default_rng(0))


def test_generated_synthetic_data_validates(tmp_path):
    out = tmp_path / "data"
    prep_main(["--source", "synthetic", "--hospitals", "2", "--out", str(out),
               "--size", "16", "--slices-per-hospital", "6"])
    reports = validate_main(["--data-dir", str(out)])
    assert len(reports) == 2
    assert sum(reports["hospital_0"][s]["slices"] for s in ("train", "val")) == 6


def test_validator_rejects_invalid_mask(tmp_path):
    root = tmp_path / "data" / "hospital_0"
    root.mkdir(parents=True)
    X = np.ones((2, 4, 16, 16), np.float32)
    Y = np.zeros((2, 1, 16, 16), np.float32)
    Y[0, 0, 0, 0] = 3
    for split in ("train", "val"):
        np.savez_compressed(root / f"{split}.npz", X=X, Y=Y)
    with pytest.raises(ValueError, match="binary"):
        validate_hospital(tmp_path / "data", 0, 16)


def test_real_prepare_keeps_patient_markers_separate_and_writes_counts(tmp_path, monkeypatch):
    import cerebrachain.data as data
    # Fake NIfTI iterator isolates patient-level split logic; no real MRI here.
    fake = [(f"case-{i}", None, None) for i in range(8)]
    monkeypatch.setattr(data, "_iter_brats2021", lambda root: iter(fake))
    def slices(vol, seg, size, max_slices, rng):
        i = fake_counter[0]
        fake_counter[0] += 1
        return ([np.full((4, size, size), i + 1, np.float32) for _ in range(2)],
                [np.ones((1, size, size), np.float32) for _ in range(2)])
    fake_counter = [0]
    monkeypatch.setattr(data, "_slices_from_volume", slices)
    out = tmp_path / "out"
    prepare_real("brats2021", "unused", 2, str(out), 16, 2, 8, 42)
    for h in range(2):
        with np.load(out / f"hospital_{h}" / "train.npz") as z:
            tr = set(np.unique(z["X"]))
        with np.load(out / f"hospital_{h}" / "val.npz") as z:
            vl = set(np.unique(z["X"]))
        assert tr.isdisjoint(vl)
        summary = json.loads((out / f"hospital_{h}" / "split_summary.json").read_text())
        assert summary["strategy"] == "patient-level"
        assert summary["train_cases"] + summary["val_cases"] == 4
        assert "case-" not in json.dumps(summary)
        validate_hospital(out, h, 16)
