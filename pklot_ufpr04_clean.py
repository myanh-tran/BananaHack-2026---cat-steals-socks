"""PKLot UFPR04 Sunny: clean project entry points.

This file separates dataset/annotation loading, YOLO inference, and graph routing.
It deliberately does not invent road connections: confirm Gate/building/walkway
coordinates on the selected image before enabling route edges.

For Google Colab commands such as pip install, use a notebook cell:
    %pip install -q ultralytics networkx opencv-python matplotlib
"""
from __future__ import annotations

import math
import random
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import cv2
import networkx as nx
import numpy as np

# ---------------------------------------------------------------------------
DATA_ROOT = Path("/content/PKLot/PKLot/UFPR04/Sunny")
LOCAL_MODEL = Path(__file__).parent / "backend" / "models" / "occupancy_yolo.pt"
MODEL_PATH = LOCAL_MODEL if LOCAL_MODEL.is_file() else Path("/content/drive/MyDrive/parking_project/best.pt")
OUTPUT_DIR = Path("/content/drive/MyDrive/parking_project")

CLASS_NAMES = {0: "occupied", 1: "empty"}


def find_image_xml_pairs(root: Path = DATA_ROOT) -> list[tuple[Path, Path]]:
    """Return same-stem JPG/XML pairs under the dataset root."""
    if not root.exists():
        raise FileNotFoundError(f"Dataset folder not found: {root}")
    pairs = []
    for xml_path in sorted(root.rglob("*.xml")):
        image_path = xml_path.with_suffix(".jpg")
        if image_path.is_file():
            pairs.append((image_path, xml_path))
    return pairs


def read_parking_annotations(xml_path: str | Path, image_shape: tuple[int, ...]) -> list[dict[str, Any]]:
    """Parse PKLot XML into parking_spots with pixel polygons and centers."""
    xml_path = Path(xml_path)
    root = ET.parse(xml_path).getroot()
    height, width = image_shape[:2]
    parking_spots = []

    for index, space in enumerate(root.findall(".//space"), start=1):
        occupied = space.get("occupied")
        if occupied not in ("0", "1"):
            continue

        # PKLot contours store points under space/contour/point.
        contour = space.find("contour")
        if contour is None:
            continue
        points = []
        for point in contour.findall("point"):
            try:
                x = int(round(float(point.attrib["x"])))
                y = int(round(float(point.attrib["y"])))
            except (KeyError, ValueError):
                continue
            points.append((max(0, min(width - 1, x)), max(0, min(height - 1, y))))

        if len(points) < 3:
            continue
        center = (
            int(round(sum(x for x, _ in points) / len(points))),
            int(round(sum(y for _, y in points) / len(points))),
        )
        parking_spots.append({
            "id": f"S{index:03d}",
            "status": "occupied" if occupied == "1" else "empty",
            "polygon": points,
            "center": center,
        })
    return parking_spots


def select_balanced_example(root: Path = DATA_ROOT, seed: int = 42) -> dict[str, Any]:
    """Select an image/XML pair with occupancy ratio closest to 50%."""
    candidates = []
    for image_path, xml_path in find_image_xml_pairs(root):
        try:
            xml_root = ET.parse(xml_path).getroot()
            spaces = [s for s in xml_root.findall(".//space") if s.get("occupied") in ("0", "1")]
            if not spaces:
                continue
            occupied = sum(s.get("occupied") == "1" for s in spaces)
            empty = sum(s.get("occupied") == "0" for s in spaces)
            candidates.append({
                "score": abs(occupied / len(spaces) - 0.5),
                "image": str(image_path), "xml": str(xml_path),
                "occupied": occupied, "empty": empty, "total": len(spaces),
            })
        except (ET.ParseError, OSError):
            continue
    if not candidates:
        raise FileNotFoundError(f"No matching JPG/XML pairs found under {root}")
    random.Random(seed).shuffle(candidates)
    return min(candidates, key=lambda item: item["score"])


def load_image(image_path: str | Path) -> np.ndarray:
    image = cv2.imread(str(image_path))
    if image is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")
    return image


def draw_annotations(image: np.ndarray, parking_spots: list[dict[str, Any]]) -> np.ndarray:
    """Draw XML ground-truth polygons (green=empty, red=occupied)."""
    canvas = image.copy()
    for spot in parking_spots:
        polygon = np.asarray(spot["polygon"], dtype=np.int32)
        color = (0, 220, 0) if spot["status"] == "empty" else (0, 0, 255)
        cv2.polylines(canvas, [polygon], True, color, 2, cv2.LINE_AA)
    return canvas


# ---------------------------------------------------------------------------
# 2. YOLO segmentation inference (no training)
# ---------------------------------------------------------------------------
def load_yolo_model(model_path: str | Path = MODEL_PATH):
    """Load the existing trained model; requires ultralytics to be installed."""
    from ultralytics import YOLO
    model_path = Path(model_path)
    if not model_path.is_file():
        raise FileNotFoundError(f"Trained checkpoint not found: {model_path}")
    return YOLO(str(model_path))


def predict_image(model, image_path: str | Path, conf: float = 0.25):
    """Run inference on CPU, suitable when Colab GPU quota is unavailable."""
    return model.predict(source=str(image_path), imgsz=640, conf=conf, device="cpu", verbose=False)[0]


# ---------------------------------------------------------------------------
# 3. Graph utilities
# ---------------------------------------------------------------------------
def pixel_distance(a: tuple[int, int], b: tuple[int, int]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def build_weighted_graph(nodes: dict[str, tuple[int, int]], edges: list[tuple[str, str]]) -> nx.Graph:
    """Build a graph only from manually verified, physically valid edges."""
    graph = nx.Graph()
    for node_id, position in nodes.items():
        graph.add_node(node_id, pos=tuple(map(int, position)))
    for u, v in edges:
        if u not in nodes or v not in nodes:
            raise ValueError(f"Edge references unknown node: {(u, v)}")
        graph.add_edge(u, v, weight=pixel_distance(nodes[u], nodes[v]))
    return graph


def shortest_route(graph: nx.Graph, start: str, target: str) -> tuple[list[str], float]:
    """Find shortest weighted route or report that the graph is disconnected."""
    if start not in graph:
        raise KeyError(f"Start node not in graph: {start}")
    if target not in graph:
        raise KeyError(f"Target node not in graph: {target}")
    try:
        route = nx.shortest_path(graph, start, target, weight="weight")
        distance = nx.shortest_path_length(graph, start, target, weight="weight")
    except nx.NetworkXNoPath as exc:
        raise ValueError(f"No route from {start} to {target}; check graph edges.") from exc
    return route, float(distance)


# ---------------------------------------------------------------------------
# 4. Main example: load the selected image and inspect XML annotations
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    selected = select_balanced_example()
    image = load_image(selected["image"])
    parking_spots = read_parking_annotations(selected["xml"], image.shape)
    empty_count = sum(s["status"] == "empty" for s in parking_spots)
    occupied_count = sum(s["status"] == "occupied" for s in parking_spots)

    print("Image:", selected["image"])
    print("XML:", selected["xml"])
    print(f"Spots: {len(parking_spots)} | empty: {empty_count} | occupied: {occupied_count}")
    print("Next: define and visually verify separate vehicle/pedestrian nodes and edges.")
