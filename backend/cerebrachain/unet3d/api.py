"""Hospital-local 3D MRI inference API."""

from fastapi import FastAPI

app = FastAPI(
    title="ZKP-CerebraChain MRI API",
    description="Hospital-local 3D MRI segmentation service",
    version="0.1.0",
)



from cerebrachain.unet3d.demo_api import router as demo_router

app.include_router(demo_router)

@app.get("/health")
def health():
    """Report MRI API status."""
    return {
        "status": "ok",
        "service": "ZKP-CerebraChain MRI API",
        "model_type": "3D U-Net",
        "model_loaded": False,
        "inference_available": False,
        "mode": "development",
    }
