"""Convert a supplied local WOFF2 catalog into TTFs for the existing font inspector."""
import json
import sys
from pathlib import Path
from fontTools.ttLib import TTFont

root, output = map(Path, sys.argv[1:3])
output.mkdir(parents=True, exist_ok=True)
fonts = json.loads((root / 'local-data/fonts.json').read_text(encoding='utf8'))['fonts']
for entry in fonts:
    source = (root / entry['file'].lstrip('/')).resolve()
    if not source.is_relative_to(root.resolve()):
        raise ValueError('Font path outside source directory')
    font = TTFont(source)
    font.flavor = None
    font.save(output / (source.stem + '.ttf'))
    print(entry['name'])
