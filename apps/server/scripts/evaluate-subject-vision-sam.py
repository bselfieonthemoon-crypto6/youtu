"""Consume the saved vision probe coordinates; no external calls or canvas writes."""
import json
import time
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from feynobg_worker import make_sam2_mask

root = Path(__file__).resolve().parents[3]
output = root / 'artifacts/subject-vision-20260908'
reports = json.loads((output / 'report.json').read_text(encoding='utf-8'))
results = []
panels = []
for report in reports:
    if 'result' not in report:
        continue
    start = time.monotonic()
    item = report['result']
    source = Image.open(output / f"{report['id']}-source.png").convert('RGBA')
    width, height = source.size
    points = item['positive_points'] + item['negative_points']
    coords = [[min(width - 1, round(x * width)), min(height - 1, round(y * height))] for x, y in points]
    labels = [1] * len(item['positive_points']) + [0] * len(item['negative_points'])
    b = item['bbox']
    box = [round(b[0]*width), round(b[1]*height), min(width-1, round(b[2]*width)), min(height-1, round(b[3]*height))]
    mask = make_sam2_mask(root / 'models/sam2.1-hiera-tiny', source.convert('RGB'), box, points=coords, labels=labels)
    rgba = np.asarray(source).copy()
    rgba[:, :, 3] = np.where(mask, rgba[:, :, 3], 0)
    result = Image.fromarray(rgba)
    result.save(output / f"{report['id']}-cutout.png")
    red = Image.new('RGBA', source.size, (239, 68, 68, 0))
    red.putalpha(Image.fromarray(np.where(mask, 115, 0).astype('uint8')))
    highlighted = Image.alpha_composite(source, red)
    highlighted.save(output / f"{report['id']}-selection.png")
    row = Image.new('RGB', (960, 400), '#eeeeee')
    for index, (image, label) in enumerate([(source, 'Original'), (highlighted, 'Vision + SAM selection'), (result, 'Transparent result')]):
        image = image.copy()
        image.thumbnail((300, 360))
        row.paste(image, (index*320+(320-image.width)//2, 30+(360-image.height)//2), image)
        ImageDraw.Draw(row).text((index*320+10, 8), f"{report['id']}: {label}", fill='black')
    panels.append(row)
    record = {'id': report['id'], 'sam_seconds': round(time.monotonic()-start, 2), 'retained_pixel_fraction': float(mask.mean())}
    results.append(record)
    print(json.dumps(record), flush=True)
sheet = Image.new('RGB', (960, 400*len(panels)), 'white')
for index, panel in enumerate(panels):
    sheet.paste(panel, (0, index*400))
sheet.save(output / 'comparison.png')
(output / 'sam-report.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
