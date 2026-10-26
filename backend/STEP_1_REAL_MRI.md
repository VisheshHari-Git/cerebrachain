# Step 1 — Real MRI Data Preparation and Validation

This is a focused backend improvement to the existing ZKP-CerebraChain v2 repository.
It does not change Flower, the model, the ZKP circuit, or the contract.

## Why

The original real-data importer split **2D slices at random**, allowing slices
from the same patient to appear in both training and validation. This is MRI
patient leakage and can inflate validation metrics. The updated importer now
assigns **whole patients** to train or validation within each simulated hospital.

## MRI input format

Use a licensed/research-authorized dataset containing four modalities and
segmentation labels, e.g. BraTS 2021 Task 1 NIfTI (`.nii.gz`) or Medical
Segmentation Decathlon `Task01_BrainTumour`. For BraTS 2021, place each subject
in its own directory with `<case>_t1.nii.gz`, `<case>_t1ce.nii.gz`,
`<case>_t2.nii.gz`, `<case>_flair.nii.gz`, `<case>_seg.nii.gz`.

**Important:** these formats are *not* verified original DICOM. DICOM ingestion,
validation of clinical provenance, medical consent and site-grade storage are
not implemented. Do not use identifiable patient data in this demo.

## Commands (from repo root, using existing .venv)

```bash
source .venv/bin/activate
python -m pytest -q tests/test_data_pipeline.py

# Smoke-test on small synthetic images without downloading real MRI:
python -m cerebrachain.data --source synthetic --hospitals 4 \
  --slices-per-hospital 24 --out data_synthetic_step1
python -m cerebrachain.validate_data --data-dir data_synthetic_step1

# AFTER you have downloaded and extracted the research dataset locally:
python -m cerebrachain.data --source brats2021 \
  --root "$HOME/data/BraTS2021_Training_Data" \
  --hospitals 4 --max-cases 40 --slices-per-case 12 --out data_brats
python -m cerebrachain.validate_data --data-dir data_brats

# OR MSD (Task01_BrainTumour):
python -m cerebrachain.data --source msd \
  --root "$HOME/data/Task01_BrainTumour" \
  --hospitals 4 --max-cases 40 --out data_msd
python -m cerebrachain.validate_data --data-dir data_msd
```

> 40 cases is a first experiment, not a requirement. For real data, each hospital
> needs at least 2 distinct cases so that train/validation can be disjoint.

## Outputs

- `data_brats/meta.json` — dataset type, image shape, modality order, split type.
- `data_brats/hospital_0/train.npz` and `val.npz` — 4-channel float32 MRI
  slices, paired with whole-tumour binary segmentation masks.
- `data_brats/hospital_0/split_summary.json` — **counts only**, no patient IDs.

The `data_*` folders stay LOCAL in each hospital environment in real deployment.
The current project runs all hospitals on one machine only for simulation.

## Expected validation success

```
Hospital 0: train=... slices, validation=... slices — OK
...
DATA VALIDATION PASSED
```

This is not an accuracy report and does not mean the MRI data is clinically
verified. The next step is training U-Net on this dataset and reporting held-out
patient-level Dice, precision/recall and segmentation previews.

## Official references

- BraTS 2021: https://www.med.upenn.edu/cbica/brats2021/
- Medical Segmentation Decathlon: http://medicaldecathlon.com/dataaws/
