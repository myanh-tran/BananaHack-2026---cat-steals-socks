"""
parking_service.py — Resident Lookup and Parking Assignment
=============================================================
Loads residents_database.json and provides:
  - lookup_resident(plate_text) : Fuzzy match OCR output to resident
  - get_db_plates()             : All plate strings for match_plate()

The database MUST have exactly these 3 fields per record:
    license_plate | resident_name | building  (only A, B, C)
"""

import json
from pathlib import Path
from services.plate_pipeline import match_plate


_DB_PATH = Path(__file__).parent.parent / "data" / "residents_database.json"

# ── Load once at import time ──────────────────────────────────────────────────
_residents: list[dict] = []
_plate_index: dict[str, dict] = {}   # plate_string -> resident record

def _load_db():
    global _residents, _plate_index
    with open(_DB_PATH, encoding="utf-8") as f:
        _residents = json.load(f)
    _plate_index = {r["license_plate"]: r for r in _residents}
    print(f"[ParkingService] Loaded {len(_residents)} residents from DB ✓")

_load_db()


def get_db_plates() -> list[str]:
    """Return the list of all plate strings in the DB (for fuzzy matching)."""
    return list(_plate_index.keys())


def lookup_resident(ocr_plate: str, min_ratio: float = 0.80) -> dict:
    """
    Perform fuzzy match of OCR-read plate against resident DB.

    Returns
    -------
    dict:
        {
            "is_resident": bool,
            "license_plate": str,   # matched plate from DB (or raw OCR if guest)
            "resident_name": str | None,
            "building": str | None  # "A", "B", "C", or None for guests
        }
    """
    db_plates = get_db_plates()
    matched = match_plate(ocr_plate, db_plates, min_ratio=min_ratio)

    if matched is None:
        return {
            "is_resident": False,
            "license_plate": ocr_plate,
            "resident_name": None,
            "building": None,
        }

    resident = _plate_index[matched]
    return {
        "is_resident": True,
        "license_plate": matched,
        "resident_name": resident["resident_name"],
        "building": resident["building"],
    }
