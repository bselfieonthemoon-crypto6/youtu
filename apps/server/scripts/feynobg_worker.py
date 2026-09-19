#!/usr/bin/env python3
"""Persistent FeyNoBG JSONL worker used by the Loomic image job worker."""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

import numpy as np
from PIL import Image


_runtime = None
_lama_session = None
_sam_runtime = None
_sam_image_cache = None


def load_model(model_dir: Path):
    global _runtime
    if _runtime is None:
        from birefnet_dynamic_matting import release_model
        release_model()
        import torch
        from nobg import BiRefNet, BiRefNetImageProcessor

        default_threads = 2 if sys.platform == "win32" else min(8, os.cpu_count() or 1)
        try:
            configured_threads = int(
                os.environ.get("LOOMIC_FEYNOBG_CPU_THREADS", str(default_threads))
            )
        except ValueError:
            configured_threads = default_threads
        torch.set_num_threads(max(1, min(32, configured_threads)))
        # Inter-op parallelism adds memory-hungry worker pools but provides no
        # benefit while this persistent worker serializes inference requests.
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass  # Another local tool has already initialized the shared pool.
        # AutoModel queries Hub tags before dispatching and therefore mistakes
        # absolute Windows paths for repository ids. The checkpoint is known to
        # be BiRefNet, so use the concrete loader for fully offline operation.
        model = BiRefNet.from_pretrained(str(model_dir)).eval().to("cpu")
        processor = BiRefNetImageProcessor.from_pretrained(
            str(model_dir), local_files_only=True
        )
        _runtime = (model, processor)
    return _runtime


def make_cutout(model_dir: Path, image: str | Image.Image) -> Image.Image:
    import torch
    from loadimg import load_img

    model, processor = load_model(model_dir)
    source = load_img(image).convert("RGB") if isinstance(image, str) else image.convert("RGB")
    inputs = processor(source, return_tensors="pt")
    with torch.inference_mode():
        outputs = model(pixel_values=inputs["pixel_values"])
    alpha = processor.post_process_alpha_matting(
        outputs, target_sizes=[(source.height, source.width)]
    )[0]
    return processor.cutout(source, alpha)


def make_sam2_mask(
    model_dir: Path,
    source: Image.Image,
    box: list[int] | None,
    positive_point: list[int] | None = None,
    points: list[list[int]] | None = None,
    labels: list[int] | None = None,
) -> np.ndarray:
    global _sam_runtime, _sam_image_cache
    import torch
    from transformers import Sam2Model, Sam2Processor

    if _sam_runtime is None:
        # Point-only inference does not load BiRefNet, so configure CPU threads
        # here as well. No additional weights or external service is needed.
        torch.set_num_threads(max(1, min(32, int(os.environ.get("LOOMIC_FEYNOBG_CPU_THREADS", "2")))))
        model = Sam2Model.from_pretrained(
            str(model_dir), local_files_only=True
        ).eval().to("cpu")
        processor = Sam2Processor.from_pretrained(
            str(model_dir), local_files_only=True
        )
        _sam_runtime = (model, processor)
    model, processor = _sam_runtime
    prompt = {"images": source, "return_tensors": "pt"}
    if box is not None:
        prompt["input_boxes"] = [[box]]
    if points is not None:
        prompt["input_points"] = [[points]]
        prompt["input_labels"] = [[labels]]
    elif positive_point is not None:
        prompt["input_points"] = [[[positive_point]]]
        prompt["input_labels"] = [[[1]]]
    inputs = processor(**prompt)
    with torch.inference_mode():
        if points is not None:
            # Cache only one image's features; hover changes rerun the prompt
            # decoder, not the expensive image encoder. Content-addressed so
            # different images/users can never reuse the wrong features.
            import hashlib
            key = (source.size, hashlib.sha256(source.tobytes()).digest())
            if _sam_image_cache is None or _sam_image_cache[0] != key:
                _sam_image_cache = (key, model.get_image_embeddings(inputs["pixel_values"]))
            inputs.pop("pixel_values")
            outputs = model(**inputs, image_embeddings=_sam_image_cache[1])
        else:
            outputs = model(**inputs)
    masks = processor.post_process_masks(
        outputs.pred_masks.cpu(), inputs["original_sizes"]
    )[0][0]
    scores = outputs.iou_scores.detach().cpu()[0, 0]
    best_index = int(torch.argmax(scores).item())
    return masks[best_index].numpy().astype(bool)


def point_matting(sam_model_dir: Path, input_path: Path, output_dir: Path, points: list, region: dict | None = None) -> dict:
    """Local interactive SAM2 segmentation; positive/negative clicks are explicit
    constraints, not a box inferred from an unrelated saliency model.
    Return original-sized RGB with the selection mask as alpha. The editor
    intersects this with original transparency once (never square its alpha).
    """
    import math
    if not isinstance(points, list) or not 1 <= len(points) <= 24:
        raise ValueError("Point selection requires 1 to 24 points.")
    for p in points:
        if (not isinstance(p, dict) or p.get("label") not in (0, 1)
                or any(not isinstance(p.get(k), (int, float)) or not math.isfinite(p[k])
                       or not 0 <= p[k] <= 1 for k in ("x", "y"))):
            raise ValueError("Invalid normalized selection point.")
    if not any(p["label"] == 1 for p in points):
        raise ValueError("At least one foreground point is required.")
    if region is not None:
        if (not isinstance(region, dict) or any(not isinstance(region.get(k), (int, float))
                or not math.isfinite(region[k]) or not 0 <= region[k] <= 1 for k in ("x", "y", "width", "height"))
                or region['width'] <= 0 or region['height'] <= 0
                or region['x'] + region['width'] > 1.000001 or region['y'] + region['height'] > 1.000001):
            raise ValueError("Invalid subject box.")
    source = Image.open(input_path).convert("RGBA")
    width, height = source.size
    coords = [[min(width - 1, round(p["x"] * width)), min(height - 1, round(p["y"] * height))] for p in points]
    labels = [p["label"] for p in points]
    box = None if region is None else [round(region['x'] * width), round(region['y'] * height),
        min(width - 1, round((region['x'] + region['width']) * width)),
        min(height - 1, round((region['y'] + region['height']) * height))]
    mask = make_sam2_mask(sam_model_dir, source.convert("RGB"), box, points=coords, labels=labels)
    if not np.any(mask):
        raise ValueError("未识别到主体，请在主体内部补充保留点后重试。")
    rgba = np.asarray(source).copy()
    rgba[:, :, 3] = np.where(mask, 255, 0)
    name = "point-selected-foreground.png"
    Image.fromarray(rgba, mode="RGBA").save(output_dir / name, format="PNG", optimize=True)
    return {"width": width, "height": height,
            "files": [{"kind": "foreground", "name": name, "x": 0, "y": 0,
                       "width": width, "height": height}]}


def remove_background(model_dir: Path, input_path: Path, output_dir: Path) -> dict:
    global _runtime, _sam_runtime, _sam_image_cache, _lama_session
    # This operation does not use selection/inpainting. Do not retain those
    # models while loading a large matting checkpoint on a local workstation.
    import gc
    _sam_runtime = None
    _sam_image_cache = None
    _lama_session = None
    gc.collect()
    backend = os.environ.get("LOOMIC_BACKGROUND_REMOVAL_MODEL", "feynobg")
    if backend == "birefnet-dynamic-matting":
        import gc
        from birefnet_dynamic_matting import make_cutout as make_dynamic_cutout
        _runtime = None  # Avoid retaining both large checkpoints on a local PC.
        gc.collect()
        cutout = make_dynamic_cutout(input_path)
    elif backend == "feynobg":
        cutout = make_cutout(model_dir, str(input_path)).convert("RGBA")
    else:
        raise ValueError(f"Unsupported background-removal model: {backend}")
    output_path = output_dir / "foreground.png"
    cutout.save(output_path, format="PNG", optimize=True)
    return {
        "width": cutout.width,
        "height": cutout.height,
        "model": f"local:{backend}",
        "files": [{"kind": "foreground", "name": output_path.name, "x": 0, "y": 0,
                   "width": cutout.width, "height": cutout.height}],
    }


def refine_selected_subject_alpha(
    detailed_alpha: np.ndarray,
    subject_mask: np.ndarray,
    selection_box: tuple[int, int, int, int],
) -> np.ndarray:
    """Combine semantic selection with matting and remove detached debris.

    A second full-image background-removal pass cannot distinguish a selected
    logo from visually salient decorations. Instead, SAM constrains the
    semantic subject, BiRefNet supplies its soft edge, and connected-component
    scoring retains the primary object plus only meaningful nearby satellites.
    """
    import cv2

    image_height, image_width = detailed_alpha.shape
    x0, y0, x1, y1 = selection_box
    selection_width = max(1, x1 - x0)
    selection_height = max(1, y1 - y0)
    scope_padding_x = max(2, round(selection_width * 0.03))
    scope_padding_y = max(2, round(selection_height * 0.03))
    scope = np.zeros_like(subject_mask, dtype=bool)
    scope[
        max(0, y0 - scope_padding_y):min(image_height, y1 + scope_padding_y),
        max(0, x0 - scope_padding_x):min(image_width, x1 + scope_padding_x),
    ] = True
    # The rectangle is both a semantic prompt and an explicit extraction
    # scope. SAM may otherwise expand to decorations belonging to the same
    # visual composition even though the user deliberately left them outside.
    subject_mask = subject_mask & scope

    edge_radius = max(1, round(min(image_width, image_height) * 0.0025))
    edge_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (edge_radius * 2 + 1, edge_radius * 2 + 1),
    )
    expanded_subject = cv2.dilate(subject_mask.astype(np.uint8), edge_kernel) > 0
    semantic_alpha = cv2.GaussianBlur(
        (expanded_subject * 255).astype(np.uint8),
        (0, 0),
        max(0.6, edge_radius * 0.55),
    )
    combined = np.minimum(detailed_alpha, semantic_alpha).astype(np.uint8)

    binary = (combined >= 16).astype(np.uint8)
    close_radius = max(1, round(min(image_width, image_height) * 0.008))
    close_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (close_radius * 2 + 1, close_radius * 2 + 1),
    )
    # Opening breaks hairline bridges from glows/splashes before component
    # analysis. The original soft alpha is restored for every retained region,
    # so this does not erode the delivered subject edge.
    connected_binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, close_kernel)
    connected_binary = cv2.morphologyEx(connected_binary, cv2.MORPH_CLOSE, close_kernel)
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(
        connected_binary,
        connectivity=8,
    )
    if count <= 2:
        return combined

    scored_components: list[tuple[float, int, int]] = []
    for label_index in range(1, count):
        area = int(stats[label_index, cv2.CC_STAT_AREA])
        inside = int(np.count_nonzero(labels[y0:y1, x0:x1] == label_index))
        # Prefer the largest component actually crossing the user's box, while
        # still allowing a loosely drawn box to identify an object around it.
        scored_components.append((inside * 2.0 + area, area, label_index))
    _score, main_area, main_label = max(scored_components)
    keep = labels == main_label

    proximity = max(2, round((main_area ** 0.5) * 0.035))
    nearby_main = cv2.dilate(
        keep.astype(np.uint8),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (proximity * 2 + 1, proximity * 2 + 1)),
    ) > 0

    for _score, area, label_index in scored_components:
        if label_index == main_label:
            continue
        component = labels == label_index
        area_ratio = area / max(1, main_area)
        is_near = bool(np.any(component & nearby_main))
        # Large detached parts (for example a ball held by a mascot) remain;
        # tiny flecks must be genuinely adjacent to the primary silhouette.
        if area_ratio >= 0.12 or (area_ratio >= 0.02 and is_near):
            keep |= component

    edge_support = cv2.dilate(keep.astype(np.uint8), edge_kernel) > 0
    return np.where(edge_support, combined, 0).astype(np.uint8)


def region_matting(
    model_dir: Path,
    sam_model_dir: Path,
    input_path: Path,
    output_dir: Path,
    region: dict,
) -> dict:
    """Extract the foreground selected by a user-provided bounding box.

    BiRefNet supplies detailed alpha edges while GrabCut uses the box as an
    explicit foreground constraint. This prevents globally salient text or
    decorations outside the box from winning over the subject the user chose.
    """
    import cv2

    source = Image.open(input_path).convert("RGB")
    rgb = np.asarray(source)
    width, height = source.size
    left = max(0.0, min(1.0, float(region.get("x", 0.0))))
    top = max(0.0, min(1.0, float(region.get("y", 0.0))))
    right = max(left, min(1.0, left + float(region.get("width", 0.0))))
    bottom = max(top, min(1.0, top + float(region.get("height", 0.0))))
    x0 = max(0, min(width - 1, int(round(left * width))))
    y0 = max(0, min(height - 1, int(round(top * height))))
    x1 = max(x0 + 2, min(width, int(round(right * width))))
    y1 = max(y0 + 2, min(height, int(round(bottom * height))))
    if x1 - x0 < 4 or y1 - y0 < 4:
        raise ValueError("The selected region is too small for foreground extraction.")

    cutout = make_cutout(model_dir, source).convert("RGBA")
    alpha = np.asarray(cutout)[:, :, 3]

    # SAM2 treats the rectangle as an object prompt and can follow the selected
    # subject beyond a loosely drawn box. BiRefNet then supplies detailed alpha
    # edges and transparent holes inside that semantic mask.
    try:
        selected_binary = (alpha[y0:y1, x0:x1] >= 48).astype(np.uint8)
        if np.any(selected_binary):
            distance = cv2.distanceTransform(selected_binary, cv2.DIST_L2, 5)
            point_y, point_x = np.unravel_index(int(np.argmax(distance)), distance.shape)
            positive_point = [x0 + int(point_x), y0 + int(point_y)]
        else:
            positive_point = [round((x0 + x1) / 2), round((y0 + y1) / 2)]
        subject_mask = make_sam2_mask(
            sam_model_dir,
            source,
            [x0, y0, x1, y1],
            positive_point,
        )
        subject_pixels = int(np.count_nonzero(subject_mask))
        if subject_pixels < 16:
            raise ValueError("SAM2 returned an empty subject mask.")
        biref_coverage = float(np.count_nonzero((alpha >= 16) & subject_mask)) / subject_pixels
        if biref_coverage >= 0.35:
            final_full_alpha = refine_selected_subject_alpha(
                alpha,
                subject_mask,
                (x0, y0, x1, y1),
            )
        else:
            final_full_alpha = cv2.GaussianBlur(
                (subject_mask * 255).astype(np.uint8),
                (0, 0),
                0.7,
            )
        ys, xs = np.where(final_full_alpha >= 8)
        padding = max(2, round(min(width, height) * 0.005))
        output_x0 = max(0, int(xs.min()) - padding)
        output_y0 = max(0, int(ys.min()) - padding)
        output_x1 = min(width, int(xs.max()) + padding + 1)
        output_y1 = min(height, int(ys.max()) + padding + 1)
        rgba = np.dstack((
            rgb[output_y0:output_y1, output_x0:output_x1],
            final_full_alpha[output_y0:output_y1, output_x0:output_x1],
        ))
        output_path = output_dir / "selected-foreground.png"
        Image.fromarray(rgba, mode="RGBA").save(output_path, format="PNG", optimize=True)
        return {
            "width": output_x1 - output_x0,
            "height": output_y1 - output_y0,
            "files": [{"kind": "foreground", "name": output_path.name,
                       "x": output_x0, "y": output_y0,
                       "width": output_x1 - output_x0,
                       "height": output_y1 - output_y0}],
        }
    except Exception as sam_error:
        print(f"SAM2 region segmentation unavailable, using GrabCut fallback: {sam_error}", file=sys.stderr)

    # Work with some surrounding context so pixels outside the user's box are
    # strong background examples, while only pixels inside can become foreground.
    margin_x = max(4, int(round((x1 - x0) * 0.15)))
    margin_y = max(4, int(round((y1 - y0) * 0.15)))
    rx0, ry0 = max(0, x0 - margin_x), max(0, y0 - margin_y)
    rx1, ry1 = min(width, x1 + margin_x), min(height, y1 + margin_y)
    roi = rgb[ry0:ry1, rx0:rx1]
    roi_alpha = alpha[ry0:ry1, rx0:rx1]
    sx0, sy0 = x0 - rx0, y0 - ry0
    sx1, sy1 = x1 - rx0, y1 - ry0

    mask = np.full(roi.shape[:2], cv2.GC_BGD, dtype=np.uint8)
    mask[sy0:sy1, sx0:sx1] = cv2.GC_PR_FGD
    selected_alpha = roi_alpha[sy0:sy1, sx0:sx1]
    selected_mask = mask[sy0:sy1, sx0:sx1]
    selected_mask[selected_alpha <= 10] = cv2.GC_PR_BGD
    selected_mask[selected_alpha >= 160] = cv2.GC_FGD

    # GrabCut requires at least one definite foreground sample. When BiRefNet
    # is uncertain, seed a small patch around its strongest selected pixel.
    if not np.any(mask == cv2.GC_FGD):
        peak_y, peak_x = np.unravel_index(int(np.argmax(selected_alpha)), selected_alpha.shape)
        seed_radius = max(1, min(x1 - x0, y1 - y0) // 80)
        seed_x0, seed_x1 = max(0, peak_x - seed_radius), min(x1 - x0, peak_x + seed_radius + 1)
        seed_y0, seed_y1 = max(0, peak_y - seed_radius), min(y1 - y0, peak_y + seed_radius + 1)
        mask[sy0 + seed_y0:sy0 + seed_y1, sx0 + seed_x0:sx0 + seed_x1] = cv2.GC_FGD

    background_model = np.zeros((1, 65), np.float64)
    foreground_model = np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(
            roi,
            mask,
            None,
            background_model,
            foreground_model,
            5,
            cv2.GC_INIT_WITH_MASK,
        )
        grab_foreground = np.isin(mask, (cv2.GC_FGD, cv2.GC_PR_FGD))
    except cv2.error:
        # A nearly uniform selection can make GrabCut's colour models singular.
        # The BiRefNet mask remains a safe deterministic fallback.
        grab_foreground = roi_alpha >= 24

    selected_grab = grab_foreground[sy0:sy1, sx0:sx1]
    detailed_alpha = selected_alpha.copy()
    final_alpha = np.where(selected_grab, detailed_alpha, 0).astype(np.uint8)
    if int(np.count_nonzero(final_alpha >= 16)) < max(16, int(final_alpha.size * 0.0005)):
        grab_alpha = cv2.GaussianBlur((selected_grab * 255).astype(np.uint8), (0, 0), 0.8)
        final_alpha = grab_alpha

    rgba = np.dstack((rgb[y0:y1, x0:x1], final_alpha))
    output_path = output_dir / "selected-foreground.png"
    Image.fromarray(rgba, mode="RGBA").save(output_path, format="PNG", optimize=True)
    return {
        "width": x1 - x0,
        "height": y1 - y0,
        "files": [{"kind": "foreground", "name": output_path.name, "x": x0, "y": y0,
                   "width": x1 - x0, "height": y1 - y0}],
    }


def repair_background(
    source: Image.Image,
    binary: np.ndarray,
    lama_model: Path,
    preserve_unmasked: bool = False,
) -> Image.Image:
    global _lama_session
    import cv2

    width, height = source.size
    rgb = np.asarray(source)
    border_width = max(4, round(min(width, height) * 0.03))
    border_selector = np.zeros((height, width), dtype=bool)
    border_selector[:border_width, :] = True
    border_selector[-border_width:, :] = True
    border_selector[:, :border_width] = True
    border_selector[:, -border_width:] = True
    clean_border = rgb[border_selector & (binary == 0)]
    # Product shots and logos commonly use a uniform studio background. In
    # that case a robust border colour is both faster and far more faithful
    # than asking an inpainting network to invent texture inside a huge mask.
    if clean_border.size and float(clean_border.std(axis=0).mean()) < 14.0:
        fill_colour = np.median(clean_border, axis=0).astype(np.uint8)
        generated = np.broadcast_to(fill_colour, rgb.shape).copy()
        # Alpha matting intentionally leaves cast shadows behind. For a studio
        # or logo background, returning the sampled colour as the full layer is
        # the only deterministic way to avoid keeping a faint subject imprint.
        if not preserve_unmasked:
            return Image.fromarray(generated, mode="RGB")
        expanded = cv2.dilate((binary * 255), np.ones((7, 7), np.uint8), iterations=1)
        blend = cv2.GaussianBlur(expanded, (0, 0), 1.4).astype(np.float32)[:, :, None] / 255.0
        repaired = rgb.astype(np.float32) * (1.0 - blend) + generated.astype(np.float32) * blend
        return Image.fromarray(np.clip(repaired, 0, 255).astype(np.uint8), mode="RGB")

    import onnxruntime as ort

    if _lama_session is None:
        _lama_session = ort.InferenceSession(
            str(lama_model), providers=["CPUExecutionProvider"]
        )

    scale = min(512 / width, 512 / height)
    target_w, target_h = max(1, round(width * scale)), max(1, round(height * scale))
    offset_x, offset_y = (512 - target_w) // 2, (512 - target_h) // 2
    resized = cv2.resize(rgb, (target_w, target_h), interpolation=cv2.INTER_AREA)
    resized_mask = cv2.resize(binary, (target_w, target_h), interpolation=cv2.INTER_NEAREST)
    canvas = np.zeros((512, 512, 3), dtype=np.uint8)
    mask_canvas = np.zeros((512, 512), dtype=np.uint8)
    canvas[offset_y:offset_y + target_h, offset_x:offset_x + target_w] = resized
    mask_canvas[offset_y:offset_y + target_h, offset_x:offset_x + target_w] = resized_mask
    image_input = np.transpose(canvas.astype(np.float32) / 255.0, (2, 0, 1))[None]
    mask_input = mask_canvas.astype(np.float32)[None, None]
    inputs = _lama_session.get_inputs()
    output = _lama_session.run(None, {
        inputs[0].name: image_input,
        inputs[1].name: mask_input,
    })[0][0]
    generated = np.clip(np.transpose(output, (1, 2, 0)), 0, 255).astype(np.uint8)
    generated = generated[offset_y:offset_y + target_h, offset_x:offset_x + target_w]
    generated = cv2.resize(generated, (width, height), interpolation=cv2.INTER_CUBIC)

    expanded = cv2.dilate((binary * 255), np.ones((7, 7), np.uint8), iterations=1)
    blend = cv2.GaussianBlur(expanded, (0, 0), 1.4).astype(np.float32)[:, :, None] / 255.0
    repaired = rgb.astype(np.float32) * (1.0 - blend) + generated.astype(np.float32) * blend
    return Image.fromarray(np.clip(repaired, 0, 255).astype(np.uint8), mode="RGB")


def load_erase_mask(mask_path: Path, size: tuple[int, int]) -> np.ndarray:
    import cv2

    mask = Image.open(mask_path).convert("L")
    if mask.size != size:
        mask = mask.resize(size, Image.Resampling.BILINEAR)
    values = np.asarray(mask, dtype=np.uint8)
    if int(values.max()) < 8:
        raise ValueError("The erase mask is empty.")
    # A subtle feather prevents jagged edges for transparent erasing without
    # expanding the user's stroke beyond its chosen brush radius.
    feathered = cv2.GaussianBlur(values, (0, 0), 0.65)
    # Gaussian blur has support outside the stroke. Preserve truly unselected
    # pixels, otherwise even a transparent erase changes neighboring alpha.
    feathered[values == 0] = 0
    return feathered


def erase_transparent(input_path: Path, mask_path: Path, output_dir: Path) -> dict:
    source = Image.open(input_path).convert("RGBA")
    mask = load_erase_mask(mask_path, source.size)
    rgba = apply_transparent_erase(source, mask)
    output_path = output_dir / "erased-transparent.png"
    Image.fromarray(rgba, mode="RGBA").save(output_path, format="PNG", optimize=True)
    return {
        "width": source.width,
        "height": source.height,
        "files": [{"kind": "foreground", "name": output_path.name, "x": 0, "y": 0,
                   "width": source.width, "height": source.height}],
    }


def apply_transparent_erase(source: Image.Image, mask: np.ndarray) -> np.ndarray:
    rgba = np.asarray(source.convert("RGBA")).copy()
    source_alpha = rgba[:, :, 3].astype(np.float32)
    rgba[:, :, 3] = np.clip(source_alpha * (1.0 - mask.astype(np.float32) / 255.0), 0, 255).astype(np.uint8)
    # Fully transparent pixels must not retain colourful hidden RGB data. Some
    # renderers temporarily flatten such pixels while decoding or resizing;
    # clearing RGB prevents erased decorations from flashing back into view.
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return rgba


def smart_erase(input_path: Path, mask_path: Path, output_dir: Path, lama_model: Path) -> dict:
    source_rgba = Image.open(input_path).convert("RGBA")
    mask = load_erase_mask(mask_path, source_rgba.size)
    output_path = output_dir / "smart-erased.png"
    source_alpha = np.asarray(source_rgba)[:, :, 3]
    transparent_ratio = float(np.count_nonzero(source_alpha < 250)) / source_alpha.size
    if transparent_ratio >= 0.001:
        # A transparent cutout has no background for LaMa to reconstruct. RGB
        # conversion would expose hidden colours as a black/coloured backdrop,
        # so smart erase deliberately behaves as alpha erasing for this input.
        result = Image.fromarray(apply_transparent_erase(source_rgba, mask), mode="RGBA")
    else:
        source_rgb = source_rgba.convert("RGB")
        binary = (mask >= 24).astype(np.uint8)
        repaired = np.asarray(
            repair_background(source_rgb, binary, lama_model, preserve_unmasked=True)
        ).copy()
        original_rgb = np.asarray(source_rgb)
        repaired[mask < 1] = original_rgb[mask < 1]
        result = Image.fromarray(repaired, mode="RGB")
    result.save(output_path, format="PNG", optimize=True)
    return {
        "width": source_rgba.width,
        "height": source_rgba.height,
        "files": [{"kind": "foreground", "name": output_path.name, "x": 0, "y": 0,
                   "width": source_rgba.width, "height": source_rgba.height}],
    }


def handle(request: dict, model_dir: Path, lama_model: Path, sam_model_dir: Path) -> dict:
    request_id = str(request.get("id", ""))
    input_path = Path(request["input_path"]).resolve()
    output_dir = Path(request["output_dir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    mode = request.get("mode")
    if mode == "remove_background":
        result = remove_background(model_dir, input_path, output_dir)
    elif mode == "region_matting":
        selection_region = request.get("selection_region")
        if request.get("selection_points") is not None:
            result = point_matting(sam_model_dir, input_path, output_dir, request["selection_points"], selection_region)
        elif not isinstance(selection_region, dict):
            raise ValueError("Region matting requires selection_region.")
        else:
            result = region_matting(model_dir, sam_model_dir, input_path, output_dir, selection_region)
    elif mode in ("erase_transparent", "smart_erase"):
        mask_path_value = request.get("mask_path")
        if not isinstance(mask_path_value, str) or not mask_path_value:
            raise ValueError("Erase operations require mask_path.")
        mask_path = Path(mask_path_value).resolve()
        if not mask_path.is_file():
            raise FileNotFoundError(f"Erase mask is missing at {mask_path}")
        result = (
            erase_transparent(input_path, mask_path, output_dir)
            if mode == "erase_transparent"
            else smart_erase(input_path, mask_path, output_dir, lama_model)
        )
    elif mode == "split_layers":
        # The local fast split was removed; layer splitting is the semantic flow
        # handled by the paid executor, never by this worker.
        raise ValueError("split_layers is no longer a local operation.")
    else:
        raise ValueError(f"Unsupported FeyNoBG mode: {mode}")
    return {"id": request_id, "ok": True, **result}


def serve(model_dir: Path, lama_model: Path, sam_model_dir: Path) -> None:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            response = handle(request, model_dir, lama_model, sam_model_dir)
        except Exception as error:
            response = {
                "id": str(locals().get("request", {}).get("id", "")),
                "ok": False,
                "error": str(error),
            }
            traceback.print_exc(file=sys.stderr)
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--lama-model", required=True)
    parser.add_argument("--sam-model-dir", required=True)
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()
    model_dir = Path(args.model_dir).resolve()
    lama_model = Path(args.lama_model).resolve()
    required = (model_dir / "config.json", model_dir / "model.safetensors")
    if not all(path.is_file() for path in required):
        raise FileNotFoundError(f"FeyNoBG model is incomplete at {model_dir}")
    if not lama_model.is_file():
        raise FileNotFoundError(f"LaMa model is missing at {lama_model}")
    sam_model_dir = Path(args.sam_model_dir).resolve()
    if args.serve:
        serve(model_dir, lama_model, sam_model_dir)


if __name__ == "__main__":
    main()
