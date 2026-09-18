"""Offline dynamic-matting adapter. Does not change the other local image tools."""
from contextlib import redirect_stdout
import gc
import os
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageOps

_model = None


def release_model():
    global _model
    _model = None
    gc.collect()


def inference_size(size):
    factor = min(1, 1024 / max(size))
    return tuple(max(32, round(value * factor / 32) * 32) for value in size)


def apply_alpha(source, alpha):
    # Keep original RGB and any existing transparency, including translucent edges.
    cutout = source.convert("RGBA").copy()
    cutout.putalpha(Image.fromarray(np.minimum(alpha, np.asarray(cutout)[:, :, 3])))
    return cutout


def make_cutout(input_path):
    global _model
    import torch
    from transformers import AutoModelForImageSegmentation

    if _model is None:
        default_dir = Path(__file__).resolve().parents[3] / "models" / "birefnet-dynamic-matting-benchmark"
        model_dir = Path(os.environ.get("LOOMIC_BIREFNET_MODEL_DIR", str(default_dir))).resolve()
        for name in ("config.json", "model.safetensors", "birefnet.py", "BiRefNet_config.py"):
            if not (model_dir / name).is_file():
                raise FileNotFoundError(f"BiRefNet_dynamic-matting file missing: {name}")
        torch.set_num_threads(max(1, min(32, int(os.environ.get("LOOMIC_FEYNOBG_CPU_THREADS", "2")))))
        # The local checkpoint's code was reviewed during the pinned-model trial.
        # Library progress must not enter the JSONL stdout protocol.
        with redirect_stdout(sys.stderr):
            _model = AutoModelForImageSegmentation.from_pretrained(
                str(model_dir), trust_remote_code=True, local_files_only=True,
                dtype=torch.float32,
            ).eval().to("cpu")
        print("[matting] loaded ZhengPeng7/BiRefNet_dynamic-matting (offline, CPU float32)", file=sys.stderr)
    with Image.open(input_path) as image:
        source = ImageOps.exif_transpose(image).convert("RGBA")
    rgb = np.asarray(source.convert("RGB").resize(inference_size(source.size), Image.Resampling.BICUBIC)).copy()
    tensor = torch.from_numpy(rgb).permute(2, 0, 1).float().div_(255)
    tensor = (tensor - torch.tensor([.485, .456, .406])[:, None, None]) / torch.tensor([.229, .224, .225])[:, None, None]
    with torch.inference_mode(), redirect_stdout(sys.stderr):
        prediction = _model(tensor.unsqueeze(0))[-1].sigmoid()
        alpha = torch.nn.functional.interpolate(prediction, size=(source.height, source.width), mode="bilinear", align_corners=False)[0, 0]
    return apply_alpha(source, alpha.clamp(0, 1).mul(255).round().byte().numpy())
