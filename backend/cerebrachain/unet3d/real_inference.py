"""Real 3D U-Net MRI segmentation for ZKP-CerebraChain."""

from pathlib import Path

import nibabel as nib
import numpy as np
import torch

from monai.networks.nets import UNet
from monai.inferers import SlidingWindowInferer
from monai.transforms import (
    Compose,
    LoadImaged,
    EnsureChannelFirstd,
    NormalizeIntensityd,
    EnsureTyped,
)

from cerebrachain.unet3d.model_adapter import load_trained_model


# Must match Roshan's training order
MODALITIES = ("flair", "t1", "t1ce", "t2")


def create_model(checkpoint_path, device="cpu"):
    """Create Roshan's exact 3D U-Net architecture."""

    model = UNet(
        spatial_dims=3,
        in_channels=4,
        out_channels=4,
        channels=(16, 32, 64, 128, 256),
        strides=(2, 2, 2, 2),
        num_res_units=1,
        norm="instance",
    )

    return load_trained_model(
        model=model,
        checkpoint_path=str(checkpoint_path),
        device=device,
    )


def preprocess_mri(case_dir):
    """Load and normalize four aligned BraTS MRI volumes."""

    case_dir = Path(case_dir)
    patient = case_dir.name

    paths = [
        case_dir / f"{patient}_{modality}.nii.gz"
        for modality in MODALITIES
    ]

    for path in paths:
        if not path.is_file():
            raise FileNotFoundError(f"Missing MRI: {path}")

    # Check spatial alignment before inference
    reference = nib.load(str(paths[0]))

    if len(reference.shape) != 3:
        raise ValueError("Expected a 3D MRI volume")

    for path in paths[1:]:
        image = nib.load(str(path))

        if (
            image.shape != reference.shape
            or not np.allclose(image.affine, reference.affine)
        ):
            raise ValueError("MRI modalities are not aligned")

    # Match Roshan's original MONAI preprocessing
    transforms = Compose([
        LoadImaged(keys="image"),
        EnsureChannelFirstd(keys="image"),
        NormalizeIntensityd(
            keys="image",
            nonzero=True,
            channel_wise=True,
        ),
        EnsureTyped(keys="image"),
    ])

    processed = transforms({
        "image": [str(path) for path in paths]
    })

    tensor = processed["image"].unsqueeze(0)

    if not bool(torch.isfinite(tensor).all()):
        raise ValueError("MRI contains invalid values")

    return tensor, reference


def predict_real_mri(
    case_dir,
    checkpoint_path,
    output_path,
    device="cpu",
):
    """Predict multiclass tumor segmentation and save NIfTI."""

    output_path = Path(output_path)

    if output_path.exists():
        raise FileExistsError(
            f"Prediction already exists: {output_path}"
        )

    print("[1/4] Preprocessing MRI...", flush=True)

    tensor, reference = preprocess_mri(case_dir)

    print("Input Shape:", tuple(tensor.shape), flush=True)

    print("[2/4] Loading trained 3D U-Net...", flush=True)

    model = create_model(checkpoint_path, device=device)

    print("[3/4] Running inference...", flush=True)

    inferer = SlidingWindowInferer(
        roi_size=(96, 96, 96),
        sw_batch_size=1,
        overlap=0.5,
        mode="gaussian",
    )

    model.eval()

    with torch.inference_mode():
        logits = inferer(tensor.to(device), model)

        prediction = (
            torch.argmax(logits, dim=1)
            .squeeze(0)
            .cpu()
            .numpy()
            .astype(np.uint8)
        )

    # Match Roshan's inference postprocessing
    flair = np.asanyarray(reference.dataobj)
    prediction[flair == 0] = 0

    # Restore BraTS label convention
    prediction[prediction == 3] = 4

    print("[4/4] Saving prediction...", flush=True)

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    header = reference.header.copy()
    header.set_data_dtype(np.uint8)

    result = nib.Nifti1Image(
        prediction,
        affine=reference.affine,
        header=header,
    )

    nib.save(result, str(output_path))

    return {
        "status": "success",
        "model": "trained_3d_unet",
        "patient": Path(case_dir).name,
        "output_shape": list(prediction.shape),
        "labels": np.unique(prediction).tolist(),
        "tumor_voxels": int(np.count_nonzero(prediction)),
        "output_path": str(output_path),
    }
