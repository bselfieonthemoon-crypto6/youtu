import json
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

folder = Path('artifacts/gif-stability-20260915')
report = {}
for name in ('before', 'fixed'):
    gif = Image.open(folder / f'{name}.gif')
    frames = []
    for i in range(gif.n_frames):
        gif.seek(i)
        frames.append(gif.convert('RGB').copy())
    # Foreground is confined to x=40..220; this background remains untouched.
    region = (300, 30, 550, 240)
    base = frames[0].crop(region)
    changed = [sum(ImageStat.Stat(ImageChops.difference(base, frame.crop(region))).sum) for frame in frames]
    moving = any(ImageChops.difference(frames[0], frame).getbbox() for frame in frames[1:])
    report[name] = dict(frames=len(frames), static_region_total_difference=sum(changed), animation_moves=moving)
assert report['before']['static_region_total_difference'] > 0, 'Old encoder must reproduce background flicker'
assert report['fixed']['static_region_total_difference'] == 0, 'Fixed background must be identical in every decoded frame'
assert report['fixed']['animation_moves'], 'Do not fix flicker by freezing animation'
(folder / 'decoded-result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
