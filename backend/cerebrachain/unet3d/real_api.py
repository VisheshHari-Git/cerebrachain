"""Real MRI prediction API for ZKP-CerebraChain.

Research prototype. Not for clinical use.
"""

import os
import shutil
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from cerebrachain.unet3d.real_inference import predict_real_mri


router = APIRouter(prefix="/real", tags=["Real MRI Inference"])

# Prevent simultaneous CPU-intensive predictions.
inference_lock = threading.Lock()

MAX_FILE_SIZE = 64 * 1024 * 1024  # 64 MiB per file


def save_uploaded_mri(upload, destination):
    """Save one NIfTI upload with a size limit."""

    if not (upload.filename or "").lower().endswith(".nii.gz"):
        raise HTTPException(
            status_code=400,
            detail="Only .nii.gz MRI files are accepted.",
        )

    size = 0

    with open(destination, "wb") as output:
        while True:
            chunk = upload.file.read(1024 * 1024)

            if not chunk:
                break

            size += len(chunk)

            if size > MAX_FILE_SIZE:
                raise HTTPException(
                    status_code=413,
                    detail="MRI file exceeds 64 MiB.",
                )

            output.write(chunk)

    if size == 0:
        raise HTTPException(
            status_code=400,
            detail="Empty MRI file.",
        )


@router.post("/predict")
def predict(
    flair: UploadFile = File(...),
    t1: UploadFile = File(...),
    t1ce: UploadFile = File(...),
    t2: UploadFile = File(...),
):
    """Upload four MRI modalities and return a 3D tumor mask."""

    root = Path(tempfile.mkdtemp(prefix="cerebrachain_mri_"))

    try:
        patient = "uploaded_case"
        case_dir = root / patient
        case_dir.mkdir()

        uploads = {
            "flair": flair,
            "t1": t1,
            "t1ce": t1ce,
            "t2": t2,
        }

        for modality, upload in uploads.items():
            destination = (
                case_dir / f"{patient}_{modality}.nii.gz"
            )
            save_uploaded_mri(upload, destination)

        # Prefer configured model path; otherwise use local clone.
        default_checkpoint = (
            Path(__file__).resolve().parents[4]
            / "cerebro-fl"
            / "model_final.pth"
        )

        checkpoint = Path(
            os.environ.get(
                "CEREBRACHAIN_3D_UNET_CHECKPOINT",
                str(default_checkpoint),
            )
        )

        if not checkpoint.is_file():
            raise HTTPException(
                status_code=503,
                detail="Trained 3D U-Net checkpoint unavailable.",
            )

        output_path = root / "tumor_mask.nii.gz"

        with inference_lock:
            predict_real_mri(
                case_dir=case_dir,
                checkpoint_path=checkpoint,
                output_path=output_path,
                device="cpu",
            )

        return FileResponse(
            path=str(output_path),
            filename="tumor_mask.nii.gz",
            media_type="application/gzip",
            background=BackgroundTask(
                shutil.rmtree,
                root,
                ignore_errors=True,
            ),
        )

    except HTTPException:
        shutil.rmtree(root, ignore_errors=True)
        raise

    except ValueError as exc:
        shutil.rmtree(root, ignore_errors=True)
        raise HTTPException(
            status_code=400,
            detail="Invalid or misaligned MRI data.",
        ) from exc

    except Exception:
        shutil.rmtree(root, ignore_errors=True)
        raise HTTPException(
            status_code=500,
            detail="MRI prediction failed.",
        )

