"""Isolated CPU trial; leaves production configuration and samples untouched."""
import gc
import json
import os
import time
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
import numpy as np
import torch
from PIL import Image, ImageDraw
from transformers import AutoModelForImageSegmentation

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'artifacts' / 'matting-quality-20260908'
MODEL = ROOT / 'models' / 'birefnet-dynamic-matting-benchmark'
REVISION = '074df545be87034e74a96bf71566ecbbc4c15f0a'


def main():
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    started = time.perf_counter()
    print('Loading isolated dynamic-matting checkpoint (CPU, float32)', flush=True)
    model = AutoModelForImageSegmentation.from_pretrained(
        str(MODEL), trust_remote_code=True, local_files_only=True,
        dtype=torch.float32,
    ).eval().to('cpu')
    load_seconds = time.perf_counter() - started
    print(f'Model loaded in {load_seconds:.1f}s', flush=True)
    manifest = json.loads((OUTPUT / 'manifest.json').read_text(encoding='utf8'))
    results = []
    for sample in manifest['samples']:
        name = sample['sample']
        source = Image.open(OUTPUT / f'{name}-source.png').convert('RGBA')
        factor = min(1, 1024 / max(source.size))
        size = tuple(max(32, round(value * factor / 32) * 32) for value in source.size)
        rgb = np.asarray(source.convert('RGB').resize(size, Image.Resampling.BICUBIC)).copy()
        tensor = torch.from_numpy(rgb).permute(2, 0, 1).float().div_(255)
        tensor = (tensor - torch.tensor([.485, .456, .406])[:, None, None]) / torch.tensor([.229, .224, .225])[:, None, None]
        print(f'{name}: inference {size[0]}x{size[1]}', flush=True)
        start = time.perf_counter()
        with torch.inference_mode():
            predictions = model(tensor.unsqueeze(0))[-1].sigmoid()
            alpha = torch.nn.functional.interpolate(predictions, size=(source.height, source.width), mode='bilinear', align_corners=False)[0, 0]
        alpha_bytes = alpha.clamp(0, 1).mul(255).round().byte().numpy()
        raw = source.copy()
        raw.putalpha(Image.fromarray(alpha_bytes))
        raw.save(OUTPUT / f'{name}-precision-raw.png')
        # Existing transparency is an explicit user input, not a model guess.
        final_alpha = np.minimum(alpha_bytes, np.asarray(source)[:, :, 3])
        cutout = source.copy()
        cutout.putalpha(Image.fromarray(final_alpha))
        cutout.save(OUTPUT / f'{name}-precision.png')
        row = dict(sample=name, inferenceWidth=size[0], inferenceHeight=size[1], outputWidth=source.width, outputHeight=source.height, seconds=time.perf_counter() - start, transparentFraction=float(np.mean(final_alpha <= 5)), opaqueFraction=float(np.mean(final_alpha >= 250)), originalTransparencyPreserved=True)
        results.append(row)
        print(json.dumps(row), flush=True)
        (OUTPUT / 'precision-report.json').write_text(json.dumps(dict(model='ZhengPeng7/BiRefNet_dynamic-matting', revision=REVISION, device='cpu', threads=2, dtype='float32', loadSeconds=load_seconds, note='Max inference edge 1024; not a 2K throughput trial or a ground-truth accuracy score. Baselines are stored prior job results.', results=results), indent=2), encoding='utf8')
        del tensor, predictions, alpha
        gc.collect()
    del model
    gc.collect()
    sheet = Image.new('RGB', (1440, len(results) * 460), '#e5e7eb')
    draw = ImageDraw.Draw(sheet)
    for row, sample in enumerate(results):
        name = sample['sample']
        for col, suffix in enumerate(['source', 'current', 'precision']):
            image = Image.open(OUTPUT / f'{name}-{suffix}.png').convert('RGBA')
            background = Image.new('RGBA', image.size, '#ffffff')
            background.alpha_composite(image)
            background.thumbnail((450, 420))
            sheet.paste(background.convert('RGB'), (col * 480 + 15 + (450 - background.width) // 2, row * 460 + 30))
            draw.text((col * 480 + 15, row * 460 + 10), f'{name} / {suffix}', fill='black')
    sheet.save(OUTPUT / 'precision-comparison.png')
    print('Precision trial complete; all results are local files.', flush=True)


if __name__ == '__main__':
    main()
