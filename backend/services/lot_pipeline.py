"""
lot_pipeline.py — Parking Lot Occupancy Detection Pipeline
==========================================================
Wraps Person 2's PKLot YOLO model (backend/models/occupancy_yolo.pt):
  - Detects parking spots and classifies them as 'occupied' (0) or 'empty' (1).
  - Summarizes lot occupancy statistics for the smart parking campus.

Author: Team BananaHack 2026 (PKLot AI module by myanh-tran)
Integration: Backend Service
"""

from pathlib import Path
from typing import Any, Dict, List, Optional
import numpy as np

CLASS_NAMES = {0: "occupied", 1: "empty"}


class LotPipeline:
    """YOLO-based parking lot occupancy inference pipeline."""

    def __init__(self, model_path: str | Path):
        self.model_path = Path(model_path)
        self.model = None
        self._load_model()

    def _load_model(self):
        """Loads the trained YOLO checkpoint."""
        if not self.model_path.is_file():
            print(f"[LotPipeline] Warning: Checkpoint not found at {self.model_path}. Running in degraded mode.")
            return

        try:
            from ultralytics import YOLO
            self.model = YOLO(str(self.model_path))
            print(f"[LotPipeline] Successfully loaded YOLO occupancy model from {self.model_path}")
        except Exception as e:
            print(f"[LotPipeline] Failed to load YOLO model: {e}")
            self.model = None

    def is_ready(self) -> bool:
        """Returns True if the YOLO model is loaded and ready for inference."""
        return self.model is not None

    def predict_image(self, image: np.ndarray | str | Path, conf: float = 0.25) -> Dict[str, Any]:
        """
        Runs YOLO inference on a parking lot image.

        Parameters
        ----------
        image : numpy BGR array, image path string, or Path object.
        conf  : Confidence threshold (default: 0.25).

        Returns
        -------
        dict containing:
            total_detected : int
            occupied_count : int
            empty_count    : int
            occupancy_rate : float (0.0 – 1.0)
            detections     : list of detected spot boxes
        """
        if not self.is_ready():
            return {
                "error": "Model not loaded",
                "total_detected": 0,
                "occupied_count": 0,
                "empty_count": 0,
                "occupancy_rate": 0.0,
                "detections": []
            }

        try:
            # Predict using CPU or GPU automatically
            results = self.model.predict(
                source=image,
                imgsz=640,
                conf=conf,
                device="cpu",
                verbose=False
            )
            if not results:
                return {
                    "total_detected": 0,
                    "occupied_count": 0,
                    "empty_count": 0,
                    "occupancy_rate": 0.0,
                    "detections": []
                }

            res = results[0]
            boxes = res.boxes
            detections = []
            occupied_count = 0
            empty_count = 0

            if boxes is not None and len(boxes) > 0:
                for idx, box in enumerate(boxes):
                    cls_id = int(box.cls[0].item())
                    score = float(box.conf[0].item())
                    xyxy = [float(v) for v in box.xyxy[0].tolist()]
                    status = CLASS_NAMES.get(cls_id, "unknown")

                    if status == "occupied":
                        occupied_count += 1
                    elif status == "empty":
                        empty_count += 1

                    detections.append({
                        "id": f"S{idx+1:03d}",
                        "status": status,
                        "confidence": round(score, 3),
                        "bbox": [round(c, 1) for c in xyxy]
                    })

            total = len(detections)
            rate = round(occupied_count / total, 3) if total > 0 else 0.0

            return {
                "total_detected": total,
                "occupied_count": occupied_count,
                "empty_count": empty_count,
                "occupancy_rate": rate,
                "detections": detections
            }

        except Exception as e:
            print(f"[LotPipeline] Inference error: {e}")
            return {
                "error": str(e),
                "total_detected": 0,
                "occupied_count": 0,
                "empty_count": 0,
                "occupancy_rate": 0.0,
                "detections": []
            }
