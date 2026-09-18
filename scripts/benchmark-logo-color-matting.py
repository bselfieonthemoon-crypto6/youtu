"""Offline solid-background experiment; never used by the production worker.

Only background-coloured pixels connected to the border/transparency may be
removed. Enclosed dark logo details are intentionally not globally keyed out.
"""
from pathlib import Path
import json
import time
import cv2
import numpy as np
from PIL import Image, ImageDraw


def connected_color_cutout(source: Image.Image, tolerance: float) -> Image.Image:
    rgba = np.asarray(source.convert('RGBA')).copy()
    rgb = rgba[:, :, :3].astype(np.float32)
    original_alpha = rgba[:, :, 3]
    height, width = original_alpha.shape
    border = np.zeros((height, width), dtype=bool)
    band = max(1, min(height, width) // 20)
    border[:band] = border[-band:] = True
    border[:, :band] = border[:, -band:] = True
    samples = rgb[border & (original_alpha > 240)]
    if not len(samples):
        raise ValueError('No opaque border pixels for estimating background colour')
    color = np.median(samples, axis=0)
    distance = np.max(np.abs(rgb - color), axis=2)
    candidate = ((distance < tolerance) | (original_alpha == 0)).astype(np.uint8)
    count, labels = cv2.connectedComponents(candidate, connectivity=8)
    seed_labels = np.unique(np.concatenate((labels[0], labels[-1], labels[:, 0], labels[:, -1], labels[original_alpha == 0])))
    lookup = np.zeros(count, dtype=bool)
    lookup[seed_labels] = True
    lookup[0] = False
    background = lookup[labels]
    # Small transition confined to the connected background, without changing
    # the source RGB. This is not a substitute for trained edge decontamination.
    transition = np.clip((distance - tolerance * .6) / (tolerance * .4), 0, 1)
    alpha = np.where(background, original_alpha * transition, original_alpha)
    rgba[:, :, 3] = np.rint(alpha).astype(np.uint8)
    return Image.fromarray(rgba)


def main():
    root = Path(__file__).resolve().parents[1] / 'artifacts' / 'matting-quality-20260908'
    source = Image.open(root / 'sample-1-source.png').convert('RGBA')
    current = Image.open(root / 'sample-1-current.png').convert('RGBA')
    variants = [('Current model', current)]
    timings = []
    for tolerance in [12, 24, 40]:
        start = time.perf_counter()
        output = connected_color_cutout(source, tolerance)
        output.save(root / f'logo-color-{tolerance}.png')
        variants.append((f'Connected background / {tolerance}', output))
        timings.append({'tolerance': tolerance, 'seconds': time.perf_counter() - start})
    sheet = Image.new('RGB', (1000, len(variants) * 460), '#e5e7eb')
    draw = ImageDraw.Draw(sheet)
    for row, (name, output) in enumerate(variants):
        for col, color in enumerate(['#ffffff', '#368ee6']):
            display = Image.new('RGBA', output.size, color)
            display.alpha_composite(output)
            display.thumbnail((440, 420))
            sheet.paste(display.convert('RGB'), (col * 500 + 25, row * 460 + 32))
            draw.text((col * 500 + 25, row * 460 + 12), name + (' / white' if col == 0 else ' / blue'), fill='black')
    sheet.save(root / 'logo-color-comparison.png')
    (root / 'color-experiment.json').write_text(json.dumps({'note': 'Offline hypothesis test on one logo; not a general quality score or production feature.', 'timings': timings}, indent=2), encoding='utf8')
    print(json.dumps(timings))


if __name__ == '__main__':
    main()
