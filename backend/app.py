"""
app.py — SmartPark AI Backend API Server
==========================================
FastAPI server that exposes AI endpoints to the web frontend (index.html).

Endpoints:
  GET  /api/health              — Check if server + models are loaded
  POST /api/gate/scan           — Upload an image → get plate + resident info
  POST /api/gate/scan/plate     — Submit a raw plate string (manual input / mock)

Run:
    cd BananaHack-2026---cat-steals-socks/backend
    uvicorn app:app --host 0.0.0.0 --port 8000 --reload

Dependencies:
    pip install fastapi uvicorn paddlepaddle paddleocr ultralytics opencv-python python-multipart
"""

import io
import sys
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Path resolution: make sure "services/" is importable ──────────────────────
sys.path.insert(0, str(Path(__file__).parent))

from services.plate_pipeline import PlatePipeline
from services.parking_service import lookup_resident

# ── Constants ──────────────────────────────────────────────────────────────────
MODELS_DIR   = Path(__file__).parent / "models"
YOLO_PATH    = MODELS_DIR / "best.pt"
OCR_DIR      = MODELS_DIR / "inference_model"

# ── App init ───────────────────────────────────────────────────────────────────
app = FastAPI(
    title="SmartPark AI API",
    description="License plate recognition + resident lookup for SmartPark Campus",
    version="1.0.0",
)

# Allow requests from the frontend (any origin in dev, lock down in prod)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Load pipeline once at startup ──────────────────────────────────────────────
# NOTE: This is intentionally done at module level so the models are loaded
#       exactly once when uvicorn starts. Do NOT move inside request handlers.
try:
    pipeline = PlatePipeline(
        yolo_path=str(YOLO_PATH),
        ocr_model_dir=str(OCR_DIR),
    )
    _pipeline_ready = True
except Exception as e:
    print(f"[WARNING] Could not load AI models: {e}")
    print("[WARNING] Server will start in DEGRADED mode — /api/gate/scan will be unavailable")
    pipeline = None
    _pipeline_ready = False


# ── Pydantic schemas ───────────────────────────────────────────────────────────

class GateScanResponse(BaseModel):
    """Unified response for both image-upload and manual plate-input endpoints."""
    license_plate: str
    confidence: float
    is_resident: bool
    resident_name: str | None
    building: str | None           # "A", "B", "C", or None (guest)
    bbox: list[int] | None         # [x1, y1, x2, y2] in original image, None if manual
    error: str | None


class ManualPlateRequest(BaseModel):
    plate: str


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health_check():
    """Returns server status and model availability."""
    return {
        "status": "ok",
        "pipeline_ready": _pipeline_ready,
        "models": {
            "yolo": str(YOLO_PATH),
            "ocr":  str(OCR_DIR),
        }
    }


@app.post("/api/gate/scan", response_model=GateScanResponse)
async def scan_from_image(file: UploadFile = File(...)):
    """
    Main endpoint: Upload a car image, get plate + resident info.

    - Accepts: multipart/form-data with field name `file`
    - Returns: GateScanResponse JSON

    Flow:
        Image → YOLO detect plate → OCR read text → fuzzy match DB
    """
    if not _pipeline_ready:
        raise HTTPException(
            status_code=503,
            detail="AI models are not loaded. Server running in degraded mode."
        )

    # Read uploaded image bytes → decode to numpy BGR array
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        raise HTTPException(status_code=400, detail="Invalid image file — could not decode.")

    # Run AI pipeline
    ai_result = pipeline.process_image(img)

    if ai_result["error"]:
        return GateScanResponse(
            license_plate="",
            confidence=0.0,
            is_resident=False,
            resident_name=None,
            building=None,
            bbox=None,
            error=ai_result["error"],
        )

    # Resident DB lookup
    ocr_plate = ai_result["plate"]
    resident_info = lookup_resident(ocr_plate)

    return GateScanResponse(
        license_plate=resident_info["license_plate"],
        confidence=ai_result["confidence"],
        is_resident=resident_info["is_resident"],
        resident_name=resident_info["resident_name"],
        building=resident_info["building"],
        bbox=ai_result["bbox"],
        error=None,
    )


@app.post("/api/gate/scan/plate", response_model=GateScanResponse)
def scan_from_plate_text(body: ManualPlateRequest):
    """
    Fallback endpoint: Submit a plate string manually (no image required).
    Used by the web frontend for:
      - Custom Simulator mode (user types a plate)
      - Preset Demo scenarios

    Flow:
        plate string → fuzzy match DB → return resident info
    """
    plate = body.plate.strip().upper()
    if not plate:
        raise HTTPException(status_code=400, detail="Plate string cannot be empty.")

    resident_info = lookup_resident(plate)

    return GateScanResponse(
        license_plate=resident_info["license_plate"],
        confidence=1.0,  # Manual input: confidence = 100% (no OCR noise)
        is_resident=resident_info["is_resident"],
        resident_name=resident_info["resident_name"],
        building=resident_info["building"],
        bbox=None,
        error=None,
    )
