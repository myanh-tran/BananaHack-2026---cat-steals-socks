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
    Robust wrapper around PaddleOCR for license plate recognition.
    Supports both custom exported models and standard PaddleOCR fallback.
    """

    def __init__(self, model_dir: str):
        self._ocr = None
        dict_path = str(Path(model_dir).parent / "dict.txt")

        # 1. Try loading custom trained model
        try:
            from paddleocr import PaddleOCR
            self._ocr = PaddleOCR(
                rec_model_dir=str(model_dir),
                rec_char_dict_path=dict_path,
                lang='en',
                show_log=False,
            )
            print("[PlateOCR] Loaded custom model successfully ✓")
        except Exception as e1:
            print(f"[PlateOCR] Custom model failed ({e1}), falling back to standard PaddleOCR...")
            try:
                from paddleocr import PaddleOCR
                self._ocr = PaddleOCR(
                    use_angle_cls=True,
                    lang='en',
                    show_log=False,
                )
                print("[PlateOCR] Loaded standard PaddleOCR successfully ✓")
            except Exception as e2:
                print(f"[PlateOCR] Fallback also failed: {e2}")
                self._ocr = None

    def is_ready(self) -> bool:
        return self._ocr is not None

    def read(self, img_bgr) -> tuple[str, float]:
        """
        Read a license plate from a cropped BGR image (numpy array).
        Returns (text: str, confidence: float).
        """
        if not self.is_ready():
            return "", 0.0

        try:
            # Standard PaddleOCR .ocr() interface
            if hasattr(self._ocr, 'ocr'):
                result = self._ocr.ocr(img_bgr, cls=False)
                if not result or not result[0]:
                    return "", 0.0

                texts = []
                confs = []
                for line in result[0]:
                    if line and len(line) >= 2:
                        txt = line[1][0]
                        conf = float(line[1][1])
                        cleaned = clean_plate_text(txt)
                        if cleaned:
                            texts.append(cleaned)
                            confs.append(conf)

                if not texts:
                    return "", 0.0

                full_text = "".join(texts)
                avg_conf = sum(confs) / len(confs) if confs else 0.0
                return full_text, round(float(avg_conf), 3)

            # Custom .predict() interface if present
            elif hasattr(self._ocr, 'predict'):
                result = self._ocr.predict(img_bgr)
                if not result:
                    return "", 0.0
                res = result[0]
                texts = res.get('rec_texts', [])
                scores = res.get('rec_scores', [])
                if not texts:
                    return "", 0.0
                raw = clean_plate_text("".join(texts))
                conf = float(sum(scores) / len(scores)) if scores else 0.0
                return raw, round(conf, 3)

        except Exception as e:
            print(f"[PlateOCR] Recognition error: {e}")
            return "", 0.0

        return "", 0.0


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

    def is_ready(self) -> bool:
        return self._detector is not None and self._ocr is not None and self._ocr.is_ready()

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
            # Fallback: if YOLO didn't catch the box (e.g. motorbike / angled view),
            # attempt direct OCR on the image.
            plate_text, ocr_conf = self._ocr.read(img)
            if plate_text:
                return {
                    "plate": plate_text,
                    "confidence": round(ocr_conf, 4),
                    "bbox": None,
                    "error": None
                }
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

        # If cropped reading is empty, attempt reading full image
        if not plate_text:
            plate_text, ocr_conf = self._ocr.read(img)

        return {
            "plate": plate_text,
            "confidence": round(det_conf * (ocr_conf if ocr_conf > 0 else 0.8), 4),
            "bbox": [x1, y1, x2, y2],
            "error": None
        }
