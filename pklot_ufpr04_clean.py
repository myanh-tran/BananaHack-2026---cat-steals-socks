"""PKLot UFPR04 Sunny: clean project entry points.

This file separates dataset/annotation loading, YOLO inference, and routing.
Routing gồm 2 loại:
  - Người đi bộ: từ ô trống đến tòa nhà đích, được đi qua ô trống xe.
  - Xe: từ Gate đến ô trống, chỉ đi trên lane (vùng không phải ô đỗ xe).

Tọa độ được hardcode cho ảnh UFPR04 gốc 1280×720:
  Gate  : giữa-dưới ảnh  (640, 700)
  Tòa A : bên trái ảnh   (160, 360)
  Tòa B : trên cùng ảnh  (640,  50)
  Tòa C : bên phải ảnh  (1120, 360)

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
# 1. Paths and setup
# ---------------------------------------------------------------------------
DATA_ROOT = Path("/content/PKLot/PKLot/UFPR04/Sunny")
MODEL_PATH = Path("/content/drive/MyDrive/parking_project/best.pt")
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
# 3. Graph utilities (giữ nguyên để tương thích)
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
# 4. Routing: tìm đường đi ngắn nhất
# ---------------------------------------------------------------------------

# --- Hardcode tọa độ cố định cho ảnh UFPR04 1280×720 ---
IMG_W, IMG_H = 1280, 720

# Vị trí cổng vào: giữa-dưới cùng ảnh
GATE: tuple[int, int] = (640, 700)

# Vị trí lối vào các tòa nhà (thang máy / sảnh)
BUILDINGS: dict[str, tuple[int, int]] = {
    "A": (160, 360),   # tòa A: bên trái ảnh
    "B": (640,  50),   # tòa B: trên cùng ảnh
    "C": (1120, 360),  # tòa C: bên phải ảnh
}

# Scale lưới BFS (mỗi cell = GRID_SCALE pixel)
GRID_SCALE = 8


def _poly_to_mask(polygons: list[list[tuple[int, int]]], h: int, w: int) -> np.ndarray:
    """Vẽ danh sách polygon vào mask uint8 (255 = bên trong polygon)."""
    mask = np.zeros((h, w), dtype=np.uint8)
    for poly in polygons:
        pts = np.array(poly, dtype=np.int32).reshape(-1, 1, 2)
        cv2.fillPoly(mask, [pts], 255)
    return mask


def _build_pedestrian_walkable(parking_spots: list[dict[str, Any]]) -> np.ndarray:
    """
    Lưới đi bộ (True = có thể đi qua).
    Người được phép đi qua ô trống xe; ô có xe là vật cản.
    """
    occupied_polys = [
        spot["polygon"] for spot in parking_spots if spot["status"] == "occupied"
    ]
    obstacle_mask = _poly_to_mask(occupied_polys, IMG_H, IMG_W)
    small = cv2.resize(
        obstacle_mask,
        (IMG_W // GRID_SCALE, IMG_H // GRID_SCALE),
        interpolation=cv2.INTER_NEAREST,
    )
    return small == 0  # True = có thể đi


def _build_vehicle_walkable(parking_spots: list[dict[str, Any]]) -> np.ndarray:
    """
    Lưới xe (True = có thể đi qua).
    Xe chỉ được đi trên lane (vùng không phải ô đỗ xe).
    Mọi ô đỗ xe (dù trống hay có xe) đều là vật cản cho xe.
    """
    all_polys = [spot["polygon"] for spot in parking_spots]
    slot_mask = _poly_to_mask(all_polys, IMG_H, IMG_W)
    small = cv2.resize(
        slot_mask,
        (IMG_W // GRID_SCALE, IMG_H // GRID_SCALE),
        interpolation=cv2.INTER_NEAREST,
    )
    return small == 0  # True = lane (không phải ô đỗ)


def _pixel_to_cell(px: int, py: int, grid_shape: tuple[int, int]) -> tuple[int, int]:
    """Chuyển tọa độ pixel sang cell trong lưới BFS (row, col)."""
    rows, cols = grid_shape
    row = min(max(py // GRID_SCALE, 0), rows - 1)
    col = min(max(px // GRID_SCALE, 0), cols - 1)
    return row, col


def _cell_to_pixel(row: int, col: int) -> tuple[int, int]:
    """Chuyển cell lưới BFS về pixel tâm cell."""
    px = col * GRID_SCALE + GRID_SCALE // 2
    py = row * GRID_SCALE + GRID_SCALE // 2
    return px, py


def _open_around(walkable: np.ndarray, row: int, col: int, radius: int = 2) -> None:
    """Mở vùng nhỏ quanh một cell để tránh bị kẹt ngay điểm xuất phát."""
    rows, cols = walkable.shape
    r0, r1 = max(row - radius, 0), min(row + radius + 1, rows)
    c0, c1 = max(col - radius, 0), min(col + radius + 1, cols)
    walkable[r0:r1, c0:c1] = True


def _bfs(walkable: np.ndarray, start_cell: tuple[int, int]) -> np.ndarray:
    """
    BFS từ start_cell trên lưới walkable.
    Trả về mảng dist (int32), -1 = không đến được.
    """
    from collections import deque
    rows, cols = walkable.shape
    dist = np.full((rows, cols), -1, dtype=np.int32)
    sr, sc = start_cell
    if not (0 <= sr < rows and 0 <= sc < cols):
        return dist
    dist[sr, sc] = 0
    q: deque[tuple[int, int]] = deque([(sr, sc)])
    while q:
        r, c = q.popleft()
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < rows and 0 <= nc < cols and walkable[nr, nc] and dist[nr, nc] < 0:
                dist[nr, nc] = dist[r, c] + 1
                q.append((nr, nc))
    return dist


def _traceback_path(
    dist: np.ndarray,
    end_cell: tuple[int, int],
) -> list[tuple[int, int]]:
    """Truy vết đường đi từ end_cell về start (nơi dist == 0)."""
    path = [end_cell]
    cur = end_cell
    while dist[cur] > 0:
        r, c = cur
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = r + dr, c + dc
            if (
                0 <= nr < dist.shape[0]
                and 0 <= nc < dist.shape[1]
                and dist[nr, nc] == dist[r, c] - 1
            ):
                cur = (nr, nc)
                path.append(cur)
                break
    path.reverse()
    return path


def _best_reachable_cell(
    dist: np.ndarray,
    center_cell: tuple[int, int],
    search_radius: int = 2,
) -> tuple[tuple[int, int] | None, int]:
    """
    Tìm cell tốt nhất (dist nhỏ nhất, >= 0) trong vùng lân cận của center_cell.
    Trả về (cell, dist_value) hoặc (None, -1) nếu không có.
    """
    cr, cc = center_cell
    rows, cols = dist.shape
    best_cell, best_d = None, -1
    for dr in range(-search_radius, search_radius + 1):
        for dc in range(-search_radius, search_radius + 1):
            nr, nc = cr + dr, cc + dc
            if 0 <= nr < rows and 0 <= nc < cols:
                d = dist[nr, nc]
                if d >= 0 and (best_d < 0 or d < best_d):
                    best_cell, best_d = (nr, nc), d
    return best_cell, best_d


def find_pedestrian_route(
    parking_spots: list[dict[str, Any]],
    empty_spot: dict[str, Any],
    building: str,
) -> dict[str, Any] | None:
    """
    Tìm đường đi ngắn nhất cho NGƯỜI từ ô trống đến tòa nhà đích.
    Người được đi qua các ô trống xe.

    Args:
        parking_spots: danh sách tất cả ô đỗ (từ read_parking_annotations).
        empty_spot   : ô trống được chọn để đỗ.
        building     : tên tòa ('A', 'B', hoặc 'C').

    Returns:
        dict với keys: slot_id, building, pixel_path, distance_cells, distance_px
        hoặc None nếu không tìm được đường.
    """
    if building not in BUILDINGS:
        raise ValueError(f"Tòa không hợp lệ: {building}. Chọn: {list(BUILDINGS.keys())}")

    walkable = _build_pedestrian_walkable(parking_spots)
    bx, by = BUILDINGS[building]
    start_cell = _pixel_to_cell(bx, by, walkable.shape)
    _open_around(walkable, *start_cell, radius=3)

    dist = _bfs(walkable, start_cell)

    # Tâm ô trống
    cx, cy = empty_spot["center"]
    spot_cell = _pixel_to_cell(cx, cy, dist.shape)
    end_cell, d = _best_reachable_cell(dist, spot_cell)
    if end_cell is None:
        return None

    path_cells = _traceback_path(dist, end_cell)
    pixel_path = [_cell_to_pixel(r, c) for r, c in path_cells]

    return {
        "slot_id": empty_spot["id"],
        "building": building,
        "pixel_path": pixel_path,         # list[(px, py)] từ tòa → ô đỗ
        "distance_cells": int(d),
        "distance_px": int(d) * GRID_SCALE,
    }


def find_vehicle_route(
    parking_spots: list[dict[str, Any]],
    empty_spot: dict[str, Any],
) -> dict[str, Any] | None:
    """
    Tìm đường đi ngắn nhất cho XE từ Gate đến ô trống.
    Xe chỉ được đi trên lane (không qua ô đỗ xe).

    Args:
        parking_spots: danh sách tất cả ô đỗ.
        empty_spot   : ô trống được chọn.

    Returns:
        dict với keys: slot_id, pixel_path, distance_cells, distance_px
        hoặc None nếu không tìm được đường.
    """
    walkable = _build_vehicle_walkable(parking_spots)
    gx, gy = GATE
    start_cell = _pixel_to_cell(gx, gy, walkable.shape)
    _open_around(walkable, *start_cell, radius=3)

    dist = _bfs(walkable, start_cell)

    cx, cy = empty_spot["center"]
    spot_cell = _pixel_to_cell(cx, cy, dist.shape)
    # Mở vùng lân cận ô đỗ để xe có thể tiếp cận từ lane gần nhất
    end_cell, d = _best_reachable_cell(dist, spot_cell, search_radius=3)
    if end_cell is None:
        return None

    path_cells = _traceback_path(dist, end_cell)
    pixel_path = [_cell_to_pixel(r, c) for r, c in path_cells]

    return {
        "slot_id": empty_spot["id"],
        "pixel_path": pixel_path,         # list[(px, py)] từ Gate → ô đỗ
        "distance_cells": int(d),
        "distance_px": int(d) * GRID_SCALE,
    }


def draw_routes(
    image: np.ndarray,
    parking_spots: list[dict[str, Any]],
    empty_spot: dict[str, Any],
    pedestrian_result: dict[str, Any] | None,
    vehicle_result: dict[str, Any] | None,
    building: str,
) -> np.ndarray:
    """
    Vẽ lên ảnh:
      - Polygon ô đỗ (xanh=trống, đỏ=có xe)
      - Ô đỗ được chọn (highlight vàng)
      - Đường người đi bộ (tím/magenta)
      - Đường xe (xanh dương)
      - Vị trí Gate và các tòa nhà
    """
    canvas = image.copy()

    # 1. Vẽ tất cả ô đỗ
    for spot in parking_spots:
        poly = np.array(spot["polygon"], dtype=np.int32)
        color = (0, 200, 0) if spot["status"] == "empty" else (0, 0, 220)
        cv2.polylines(canvas, [poly], True, color, 2, cv2.LINE_AA)

    # 2. Highlight ô đỗ được chọn
    poly_sel = np.array(empty_spot["polygon"], dtype=np.int32)
    overlay = canvas.copy()
    cv2.fillPoly(overlay, [poly_sel], (0, 255, 255))
    canvas = cv2.addWeighted(overlay, 0.45, canvas, 0.55, 0)
    cv2.polylines(canvas, [poly_sel], True, (0, 220, 220), 3, cv2.LINE_AA)

    # 3. Đường xe (Gate → ô đỗ): màu xanh dương
    if vehicle_result and vehicle_result["pixel_path"]:
        vpts = np.array(vehicle_result["pixel_path"], dtype=np.int32).reshape(-1, 1, 2)
        cv2.polylines(canvas, [vpts], False, (255, 100, 0), 4, cv2.LINE_AA)
        cv2.putText(
            canvas,
            f"Xe: {vehicle_result['distance_px']}px",
            (vehicle_result["pixel_path"][-1][0] + 6, vehicle_result["pixel_path"][-1][1]),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 100, 0), 2, cv2.LINE_AA,
        )

    # 4. Đường người đi bộ (tòa → ô đỗ): màu tím
    if pedestrian_result and pedestrian_result["pixel_path"]:
        ppts = np.array(pedestrian_result["pixel_path"], dtype=np.int32).reshape(-1, 1, 2)
        cv2.polylines(canvas, [ppts], False, (220, 0, 220), 4, cv2.LINE_AA)
        cv2.putText(
            canvas,
            f"Nguoi: {pedestrian_result['distance_px']}px",
            (pedestrian_result["pixel_path"][-1][0] + 6, pedestrian_result["pixel_path"][-1][1]),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (220, 0, 220), 2, cv2.LINE_AA,
        )

    # 5. Vẽ Gate
    gx, gy = GATE
    cv2.circle(canvas, (gx, gy), 14, (0, 140, 255), -1)
    cv2.putText(canvas, "GATE", (gx + 16, gy + 5),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 100, 255), 2, cv2.LINE_AA)

    # 6. Vẽ các tòa nhà
    for name, (bx, by) in BUILDINGS.items():
        is_target = (name == building)
        color = (255, 80, 0) if is_target else (120, 120, 120)
        cv2.circle(canvas, (bx, by), 14, color, -1)
        cv2.putText(canvas, f"Toa {name}", (bx + 16, by + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2, cv2.LINE_AA)

    return canvas


# ---------------------------------------------------------------------------
# 5. Main example: load ảnh, chạy routing, lưu kết quả
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # --- Bước 1: chọn ảnh và đọc annotations ---
    selected = select_balanced_example()
    image = load_image(selected["image"])
    parking_spots = read_parking_annotations(selected["xml"], image.shape)

    empty_spots   = [s for s in parking_spots if s["status"] == "empty"]
    occupied_spots = [s for s in parking_spots if s["status"] == "occupied"]

    print("Image:", selected["image"])
    print(f"Spots: {len(parking_spots)} | empty: {len(empty_spots)} | occupied: {len(occupied_spots)}")

    if not empty_spots:
        print("Không có ô trống nào!")
    else:
        # --- Bước 2: tìm đường cho từng tòa ---
        for building in BUILDINGS:
            print(f"\n=== Tòa {building} ===")

            # Tìm ô trống gần tòa nhất (Euclidean) để demo
            bx, by = BUILDINGS[building]
            best_spot = min(
                empty_spots,
                key=lambda s: pixel_distance(s["center"], (bx, by)),
            )

            # Route người đi bộ: tòa → ô trống
            ped = find_pedestrian_route(parking_spots, best_spot, building)
            if ped:
                print(f"  [Người] {building} → {ped['slot_id']}: "
                      f"{ped['distance_px']} px ({ped['distance_cells']} cells)")
            else:
                print(f"  [Người] Không tìm được đường đến tòa {building}")

            # Route xe: Gate → ô trống
            veh = find_vehicle_route(parking_spots, best_spot)
            if veh:
                print(f"  [Xe]    Gate → {veh['slot_id']}: "
                      f"{veh['distance_px']} px ({veh['distance_cells']} cells)")
            else:
                print(f"  [Xe]    Không tìm được đường xe đến {best_spot['id']}")

            # --- Bước 3: vẽ và lưu ảnh kết quả ---
            result_img = draw_routes(
                image, parking_spots, best_spot, ped, veh, building
            )
            out_path = OUTPUT_DIR / f"route_toa_{building}.jpg"
            cv2.imwrite(str(out_path), result_img)
            print(f"  Đã lưu: {out_path}")
