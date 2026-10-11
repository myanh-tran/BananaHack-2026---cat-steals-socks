"""
plate_pipeline.py — License Plate Recognition Pipeline
=========================================================
Wraps the full AI pipeline developed in Hackathon.ipynb (branch: ngu):
  1. YOLO (best.pt)         : Detect license plate bounding box in a car image
  2. PaddleOCR (inference_model) : Read characters from the cropped plate
  3. match_plate()           : Fuzzy-match the OCR result against the resident DB

Author: Team BananaHack 2026 (AI module by tranhathu07)
Integration: lebano2007-a11y

Usage:
    from services.plate_pipeline import PlatePipeline
    pipeline = PlatePipeline(
        yolo_path="backend/models/best.pt",
        ocr_model_dir="backend/models/inference_model"
    )
    result = pipeline.process_image("path/to/car.jpg")
    # => {"plate": "30F71554", "confidence": 0.97, "matched_plate": "30F71554"}
"""

import cv2
import re
from difflib import SequenceMatcher
from pathlib import Path


VN_PLATE_PATTERN = re.compile(r'^\d{2}[A-Z][A-Z0-9]?\d{4,5}$')


def is_vn_plate(text: str) -> bool:
    """Check whether a string matches the Vietnamese plate format: XX[A-Z][X]XXXXX."""
    return bool(VN_PLATE_PATTERN.match(text))


def clean_plate_text(raw: str) -> str:
    """Strip non-alphanumeric characters and uppercase."""
    return re.sub(r'[^A-Z0-9]', '', raw.upper())


def match_plate(ocr_text: str, db_plates: list[str], min_ratio: float = 0.80, margin: float = 0.10):
    """
    Fuzzy-match an OCR-read plate string against a list of known DB plates.

    Parameters
    ----------
    ocr_text   : The plate string read by OCR (may contain small errors)
    db_plates  : List of known plate strings from the resident database
    min_ratio  : Minimum similarity threshold (0-1). Below this -> treated as Guest.
    margin     : If the top-2 candidates differ by less than this -> ambiguous, needs review.

    Returns
    -------
    str | None  : The best-matched plate string from DB, or None (Guest / ambiguous).
    """
    scored = sorted(
        ((SequenceMatcher(None, ocr_text, p).ratio(), p) for p in db_plates),
        reverse=True
    )
    if not scored or scored[0][0] < min_ratio:
        return None  # Score too low -> Guest
    if len(scored) > 1 and scored[0][0] - scored[1][0] < margin:
        return None  # Too close to 2 candidates -> needs manual confirmation
    return scored[0][1]


class PlateOCR:
    """
    Lightweight wrapper around PaddleOCR inference for license plate recognition.
    Uses the exported PP-OCRv5 Mobile model (inference_model/).
    """

    def __init__(self, model_dir: str):
        """
        Parameters
        ----------
        model_dir : Path to the folder containing inference.json,
                    inference.pdiparams, inference.yml, and dict.txt (../dict.txt).
        """
        from paddleocr import PaddleOCR
        dict_path = str(Path(model_dir).parent / "dict.txt")
        self._ocr = PaddleOCR(
            rec_model_dir=model_dir,
            rec_char_dict_path=dict_path,
            use_textline_orientation=True,
            lang='en',
            enable_mkldnn=False,
            use_gpu=False,
        )

    def read(self, img_bgr) -> tuple[str, float]:
        """
        Read a license plate from a cropped BGR image (numpy array).

        Returns
        -------
        (text: str, confidence: float)
            text        : Cleaned, uppercased plate string
            confidence  : Average character confidence (0.0 – 1.0)
        """
        import numpy as np

        result = self._ocr.predict(img_bgr)
        if not result:
            return "", 0.0

        res = result[0]
        texts = res.get('rec_texts', [])
        scores = res.get('rec_scores', [])
        polys = res.get('rec_polys', [])

        if not texts:
            return "", 0.0

        # Build (center_y, text, score) tuples for multi-line plates
        items = []
        for i, (t, s) in enumerate(zip(texts, scores)):
            cy = float(np.array(polys[i])[:, 1].mean()) if i < len(polys) else 0.0
            items.append((cy, t, s))

        if len(items) == 1:
            raw = clean_plate_text(items[0][1])
            return raw, float(items[0][2])

        # Sort lines by vertical center (top → bottom)
        items.sort(key=lambda it: it[0])

        def clean(t):
            return clean_plate_text(t)

        top = clean(items[0][1])
        bot = "".join(clean(it[1]) for it in items[1:])
        conf = float(sum(it[2] for it in items) / len(items))

        # Try both orderings; pick whichever matches the VN plate format
        cand1 = top + bot
        cand2 = bot + top

        if is_vn_plate(cand1):
            return cand1, conf
        if is_vn_plate(cand2):
            return cand2, conf

        # Neither matches format -> return top+bottom (higher layout probability)
        return cand1, conf


class PlatePipeline:
    """
    End-to-end pipeline:
        Car image  →  YOLO detect plate box  →  OCR read text  →  match_plate DB lookup

    NOTE: This class is designed to be instantiated ONCE at server startup
          (model loading is expensive) and reused for every request.
    """

    def __init__(self, yolo_path: str, ocr_model_dir: str):
        """
        Parameters
        ----------
        yolo_path     : Absolute or relative path to best.pt (YOLOv8 weights)
        ocr_model_dir : Path to the inference_model/ folder (PaddleOCR export)
        """
        from ultralytics import YOLO
        print(f"[Pipeline] Loading YOLO from: {yolo_path}")
        self._detector = YOLO(yolo_path)

        print(f"[Pipeline] Loading PaddleOCR from: {ocr_model_dir}")
        self._ocr = PlateOCR(ocr_model_dir)

        print("[Pipeline] Ready ✓")

    def process_image(self, image_input) -> dict:
        """
        Run the full pipeline on a car image.

        Parameters
        ----------
        image_input : str (file path) | numpy ndarray (BGR)

        Returns
        -------
        dict:
            {
                "plate": str,       # OCR-read plate text (cleaned)
                "confidence": float,# Detection × OCR confidence product
                "bbox": list | None,# [x1, y1, x2, y2] of plate in original image
                "error": str | None # Error message if something went wrong
            }
        """
        # ── 1. Load image ──────────────────────────────────────────────
        if isinstance(image_input, str):
            img = cv2.imread(image_input)
            if img is None:
                return {"plate": "", "confidence": 0.0, "bbox": None,
                        "error": f"Cannot read image: {image_input}"}
        else:
            img = image_input  # Already a numpy array

        # ── 2. YOLO: detect license plate bounding box ─────────────────
        det_result = self._detector(img, verbose=False)[0]
        if len(det_result.boxes) == 0:
            return {"plate": "", "confidence": 0.0, "bbox": None,
                    "error": "No license plate detected in image"}

        # Take the box with the highest confidence
        best_idx = int(det_result.boxes.conf.argmax())
        det_conf = float(det_result.boxes.conf[best_idx])
        x1, y1, x2, y2 = det_result.boxes.xyxy[best_idx].cpu().numpy().astype(int).tolist()

        # ── 3. Crop the plate region ────────────────────────────────────
        plate_crop = img[y1:y2, x1:x2]

        # ── 4. OCR: read plate text ─────────────────────────────────────
        plate_text, ocr_conf = self._ocr.read(plate_crop)

        return {
            "plate": plate_text,
            "confidence": round(det_conf * ocr_conf, 4),
            "bbox": [x1, y1, x2, y2],
            "error": None
        }
