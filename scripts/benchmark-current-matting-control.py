"""Same-source remove-background control for the isolated precision trial."""
import importlib.util
import json
import time
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'artifacts' / 'matting-quality-20260908'
spec = importlib.util.spec_from_file_location('loomic_current_worker', ROOT / 'apps/server/scripts/feynobg_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
rows = []
for name in ['sample-1', 'sample-2']:
    started = time.perf_counter()
    print(f'{name}: current production make_cutout control', flush=True)
    result = worker.make_cutout(ROOT / 'models/feynobg', str(OUTPUT / f'{name}-source.png'))
    result.save(OUTPUT / f'{name}-current-control.png')
    row = {'sample': name, 'secondsIncludingLazyLoad': time.perf_counter() - started, 'width': result.width, 'height': result.height}
    rows.append(row)
    print(json.dumps(row), flush=True)
(OUTPUT / 'current-control-report.json').write_text(json.dumps({'mode': 'remove_background', 'model': 'feyninc/FeyNobg', 'input': 'Same exported originals as the precision trial', 'results': rows}, indent=2), encoding='utf8')
sheet = Image.new('RGB', (1440, 920), '#e5e7eb')
draw = ImageDraw.Draw(sheet)
for row, name in enumerate(['sample-1', 'sample-2']):
    for col, suffix in enumerate(['source', 'current-control', 'precision']):
        image = Image.open(OUTPUT / f'{name}-{suffix}.png').convert('RGBA')
        background = Image.new('RGBA', image.size, '#ffffff')
        background.alpha_composite(image)
        background.thumbnail((450, 420))
        sheet.paste(background.convert('RGB'), (col * 480 + 15 + (450 - background.width) // 2, row * 460 + 30))
        draw.text((col * 480 + 15, row * 460 + 10), f'{name} / {suffix}', fill='black')
sheet.save(OUTPUT / 'controlled-model-comparison.png')
print('Controlled comparison complete.', flush=True)
