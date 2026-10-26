"""3D MRI loader for BraTS-style NIfTI datasets."""

from pathlib import Path

import nibabel as nib
import numpy as np

MODALITIES = ("t1", "t1ce", "t2", "flair")


def load_mri_volume(case_dir):
    """Load four aligned MRI volumes as [4, H, W, D]."""

    case_dir = Path(case_dir)
    case_id = case_dir.name

    volumes = []
    reference_shape = None
    reference_affine = None

    for modality in MODALITIES:
        path = case_dir / f"{case_id}_{modality}.nii.gz"

        if not path.is_file():
            raise FileNotFoundError(f"Missing MRI: {path}")

        image = nib.load(str(path))
        volume = image.get_fdata(dtype=np.float32)

        if volume.ndim != 3:
            raise ValueError(f"Expected 3D volume: {path}")

        if not np.isfinite(volume).all():
            raise ValueError(f"Invalid MRI values: {path}")

        if reference_shape is None:
            reference_shape = volume.shape
            reference_affine = image.affine
        elif (
            volume.shape != reference_shape
            or not np.allclose(image.affine, reference_affine)
        ):
            raise ValueError("MRI modalities are not aligned")

        volumes.append(volume)

    return np.stack(volumes, axis=0)


def load_segmentation(case_dir):
    """Load the original 3D segmentation labels."""

    case_dir = Path(case_dir)
    path = case_dir / f"{case_dir.name}_seg.nii.gz"

    if not path.is_file():
        raise FileNotFoundError(f"Missing segmentation: {path}")

    segmentation = np.asarray(
        nib.load(str(path)).dataobj
    )

    if segmentation.ndim != 3:
        raise ValueError("Expected a 3D segmentation mask")

    return segmentation
