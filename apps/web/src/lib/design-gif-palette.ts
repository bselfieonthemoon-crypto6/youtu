import { quantize } from "gifenc";

export const GIF_PALETTE_SAMPLE_PIXELS = 262_144;

/** A single RGB565 lookup makes identical source pixels identical in every frame.
 * gifenc's per-call cache uses the first encountered colour in each bin, so
 * merely reusing a palette with per-frame applyPalette still permits flicker.
 */
export function buildStableGifPalette(samples: Uint8Array) {
  const colors = samples.length ? quantize(samples, 255, { format: "rgb444" }) : [[0, 0, 0]];
  // Reserve the logical background index for genuine transparent pixels.
  const palette = [[0, 0, 0], ...colors];
  const lookup = new Uint8Array(65_536);
  for (let key = 0; key < 65_536; key += 1) {
    const r = ((key >>> 11) << 3) | 4;
    const g = (((key >>> 5) & 63) << 2) | 2;
    const b = ((key & 31) << 3) | 4;
    let distance = Infinity;
    for (let index = 0; index < colors.length; index += 1) {
      const color = colors[index]!;
      const candidate = (r - color[0]!) ** 2 + (g - color[1]!) ** 2 + (b - color[2]!) ** 2;
      if (candidate < distance) { distance = candidate; lookup[key] = index; }
    }
  }
  return { palette, lookup };
}

export function indexStableGifFrame(rgba: Uint8ClampedArray, lookup: Uint8Array) {
  const indexed = new Uint8Array(rgba.length / 4);
  for (let pixel = 0; pixel < indexed.length; pixel += 1) {
    const offset = pixel * 4;
    if (rgba[offset + 3]! <= 127) continue;
    const key = ((rgba[offset]! >>> 3) << 11) | ((rgba[offset + 1]! >>> 2) << 5) | (rgba[offset + 2]! >>> 3);
    indexed[pixel] = lookup[key]! + 1;
  }
  return indexed;
}
