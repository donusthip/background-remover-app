from __future__ import annotations

import math
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageOps
from scipy.ndimage import find_objects, label


@dataclass
class ProcessReport:
    width: int
    height: int
    people_parts: int
    removed_islands: int
    tiles: int


class BackgroundRemover:
    """High-quality local BEN2 pipeline that preserves original RGB pixels."""

    def __init__(self, model_path: Path):
        self.model_path = Path(model_path)
        self._session: ort.InferenceSession | None = None
        self._lock = threading.Lock()

    def _get_session(self) -> ort.InferenceSession:
        if self._session is None:
            if not self.model_path.exists():
                raise FileNotFoundError(f"BEN2 model not found: {self.model_path}")
            so = ort.SessionOptions()
            so.enable_mem_pattern = False
            so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            so.intra_op_num_threads = 1
            so.inter_op_num_threads = 1
            so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
            self._session = ort.InferenceSession(
                str(self.model_path), sess_options=so, providers=["CPUExecutionProvider"]
            )
        return self._session

    @staticmethod
    def _normalize_prediction(prediction: np.ndarray) -> np.ndarray:
        prediction = np.squeeze(prediction).astype(np.float32)
        low = float(prediction.min())
        high = float(prediction.max())
        prediction = (prediction - low) / max(high - low, 1e-8)
        # Remove low-confidence haze while retaining genuine antialiasing.
        prediction = np.clip((prediction - 0.055) / 0.87, 0.0, 1.0)
        return prediction * prediction * (3.0 - 2.0 * prediction)

    def _infer(self, image: Image.Image) -> np.ndarray:
        import gc
        session = self._get_session()
        resized = image.resize((1024, 1024), Image.Resampling.BILINEAR)
        tensor = np.asarray(resized, dtype=np.float32) / 255.0
        tensor = np.transpose(tensor, (2, 0, 1))[None]
        prediction = session.run(
            None, {session.get_inputs()[0].name: tensor}
        )[0]
        del tensor
        del resized
        gc.collect()
        matte = self._normalize_prediction(prediction)
        matte_image = Image.fromarray(
            np.round(matte * 255.0).astype(np.uint8), "L"
        )
        res = np.asarray(
            matte_image.resize(image.size, Image.Resampling.LANCZOS),
            dtype=np.float32,
        )
        del matte_image
        gc.collect()
        return res

    @staticmethod
    def _valid_components(mask: np.ndarray) -> tuple[np.ndarray, list[int]]:
        labels, count = label(mask > 20)
        if count == 0:
            return labels, []
        sizes = np.bincount(labels.ravel())
        image_area = mask.shape[0] * mask.shape[1]
        minimum = max(300, int(image_area * 0.000025))
        valid = [idx for idx in range(1, count + 1) if sizes[idx] >= minimum]
        if not valid:
            valid = [int(np.argmax(sizes[1:]) + 1)]
        return labels, valid

    @staticmethod
    def _subject_box(labels: np.ndarray, valid: list[int]) -> tuple[int, int, int, int]:
        keep = np.isin(labels, valid)
        ys, xs = np.where(keep)
        if not len(xs):
            return (0, 0, labels.shape[1], labels.shape[0])
        return int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)

    @staticmethod
    def _axis_centers(start: int, end: int, limit: int, tile: int) -> list[int]:
        span = max(1, end - start)
        if span <= tile * 0.72:
            return [max(tile // 2, min(limit - tile // 2, (start + end) // 2))]
        step = int(tile * 0.62)
        first = start + tile // 2
        last = end - tile // 2
        if first >= last:
            return [max(tile // 2, min(limit - tile // 2, (start + end) // 2))]
        count = max(2, math.ceil((last - first) / step) + 1)
        return [
            max(tile // 2, min(limit - tile // 2, round(first + (last - first) * i / (count - 1))))
            for i in range(count)
        ]

    @classmethod
    def _tile_boxes(
        cls, box: tuple[int, int, int, int], width: int, height: int
    ) -> list[tuple[int, int, int, int]]:
        x0, y0, x1, y1 = box
        margin = max(80, round(min(width, height) * 0.035))
        x0, y0 = max(0, x0 - margin), max(0, y0 - margin)
        x1, y1 = min(width, x1 + margin), min(height, y1 + margin)
        
        # ZERO TRUNCATION GUARANTEE:
        # Always extend top boundary to 0 if subject is in upper half of frame
        if y0 < height * 0.5:
            y0 = 0
        tile = min(2400, width, height)
        if max(width, height) <= 2600:
            return [(0, 0, width, height)]
        x_centers = cls._axis_centers(x0, x1, width, tile)
        y_centers = cls._axis_centers(y0, y1, height, tile)
        boxes: list[tuple[int, int, int, int]] = []
        for cy in y_centers:
            for cx in x_centers:
                left = max(0, min(width - tile, cx - tile // 2))
                top = max(0, min(height - tile, cy - tile // 2))
                boxes.append((left, top, min(width, left + tile), min(height, top + tile)))
        return list(dict.fromkeys(boxes))

    @staticmethod
    def _detail_boxes(
        rgb: np.ndarray, base: np.ndarray, limit: int = 8
    ) -> list[tuple[int, int, int, int]]:
        """Find likely face/hand skin regions for an extra fine-detail pass."""
        height, width = base.shape
        r = rgb[:, :, 0].astype(np.float32)
        g = rgb[:, :, 1].astype(np.float32)
        b = rgb[:, :, 2].astype(np.float32)
        skin = (
            (base > 80)
            & (r > 65)
            & (r > g * 1.07)
            & (r > b * 1.04)
            & ((r - np.minimum(g, b)) > 10)
        )
        skin_labels, count = label(skin)
        if count == 0:
            return []
        sizes = np.bincount(skin_labels.ravel())
        boxes = find_objects(skin_labels)
        image_area = width * height
        candidates: list[tuple[int, int, int, int, int]] = []
        for component_id, box in enumerate(boxes, start=1):
            if box is None:
                continue
            size = int(sizes[component_id])
            if size < max(180, image_area * 0.000015) or size > image_area * 0.018:
                continue
            ys, xs = box
            bw, bh = xs.stop - xs.start, ys.stop - ys.start
            if bw > width * 0.28 or bh > height * 0.28:
                continue
            candidates.append((size, (xs.start + xs.stop) // 2, (ys.start + ys.stop) // 2, bw, bh))
        candidates.sort(reverse=True)
        tile = min(1600, width, height)
        output: list[tuple[int, int, int, int]] = []
        for _, cx, cy, _, _ in candidates[:limit]:
            left = max(0, min(width - tile, cx - tile // 2))
            top = max(0, min(height - tile, cy - tile // 2))
            output.append((left, top, min(width, left + tile), min(height, top + tile)))
        return list(dict.fromkeys(output))

    @staticmethod
    def _blend_weight(height: int, width: int, fade: int = 180) -> np.ndarray:
        yy, xx = np.mgrid[0:height, 0:width]
        fade = min(fade, max(1, min(height, width) // 4))
        wx = np.minimum(
            np.clip(xx / fade, 0, 1),
            np.clip((width - 1 - xx) / fade, 0, 1),
        )
        wy = np.minimum(
            np.clip(yy / fade, 0, 1),
            np.clip((height - 1 - yy) / fade, 0, 1),
        )
        weight = np.minimum(wx, wy)
        return weight * weight * (3.0 - 2.0 * weight)

    @staticmethod
    def _remove_detached_islands(
        alpha: np.ndarray, base_labels: np.ndarray, valid_base: list[int]
    ) -> tuple[np.ndarray, int, int]:
        output_labels, output_count = label(alpha > 16)
        if output_count == 0:
            return alpha, 0, 0
        base_seed = np.isin(base_labels, valid_base)
        boxes = find_objects(output_labels)
        removed = 0
        kept = 0
        for component_id, box in enumerate(boxes, start=1):
            if box is None:
                continue
            component = output_labels[box] == component_id
            overlaps_person = bool(np.any(component & base_seed[box]))
            if overlaps_person:
                kept += 1
                continue
            ys, xs = box
            pad = 18
            y0 = max(0, ys.start - pad)
            y1 = min(alpha.shape[0], ys.stop + pad)
            x0 = max(0, xs.start - pad)
            x1 = min(alpha.shape[1], xs.stop + pad)
            alpha[y0:y1, x0:x1] = 0
            removed += 1
        return alpha, kept, removed

    def process(self, input_path: Path, output_path: Path) -> ProcessReport:
        with self._lock:
            source = ImageOps.exif_transpose(Image.open(input_path)).convert("RGB")
            width, height = source.size
            rgb = np.asarray(source)

            base = self._infer(source)
            base_labels, valid_base = self._valid_components(base)
            subject_box = self._subject_box(base_labels, valid_base)
            tiles = self._tile_boxes(subject_box, width, height)
            tiles.extend(box for box in self._detail_boxes(rgb, base) if box not in tiles)

            alpha = base.copy()
            for left, top, right, bottom in tiles:
                local = self._infer(source.crop((left, top, right, bottom)))
                tile_h, tile_w = local.shape
                weight = self._blend_weight(tile_h, tile_w)
                old = alpha[top:bottom, left:right]
                alpha[top:bottom, left:right] = old * (1.0 - weight) + local * weight

            # Never let local refinement erase pixels the whole-frame model
            # considered unquestionably foreground.
            protected = base >= 245
            alpha[protected] = np.maximum(alpha[protected], base[protected])

            alpha_u8 = np.round(np.clip(alpha, 0, 255)).astype(np.uint8)
            alpha_u8, kept_parts, removed = self._remove_detached_islands(
                alpha_u8, base_labels, valid_base
            )
            result = np.dstack((rgb, alpha_u8))
            output_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(result, "RGBA").save(output_path)
            if not np.array_equal(result[:, :, :3], rgb):
                raise RuntimeError("RGB preservation check failed")
            return ProcessReport(
                width=width,
                height=height,
                people_parts=max(kept_parts, len(valid_base)),
                removed_islands=removed,
                tiles=len(tiles),
            )


def make_preview(input_path: Path, output_path: Path, max_size: int = 1100) -> None:
    image = Image.open(input_path).convert("RGBA")
    scale = min(1.0, max_size / max(image.size))
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    image = image.resize(size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", size)
    draw = ImageDraw.Draw(canvas)
    tile = max(12, min(size) // 22)
    for y in range(0, size[1], tile):
        for x in range(0, size[0], tile):
            color = (240, 240, 240, 255) if (x // tile + y // tile) % 2 == 0 else (190, 190, 190, 255)
            draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=color)
    canvas.alpha_composite(image)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(output_path, quality=92)
