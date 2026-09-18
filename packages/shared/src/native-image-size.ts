/** Resolution tiers accepted by APIYI's native GPT Image family. */
export const nativeImageResolutionValues = ["1k", "2k", "4k"] as const;
export type NativeImageResolution = (typeof nativeImageResolutionValues)[number];

export type NativeImageSize = { width: number; height: number; size: string };

const EDGE = 16;
const MIN_AREA = 655_360;
const MAX_AREA = 8_294_400;
const MAX_LONG_SIDE: Record<NativeImageResolution, number> = { "1k": 1280, "2k": 2048, "4k": 3840 };
const TARGET_AREA: Record<NativeImageResolution, number> = { "1k": 1_048_576, "2k": 4_194_304, "4k": MAX_AREA };

function parseAspectRatio(aspectRatio: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(aspectRatio);
  if (!match) throw new Error(`Invalid native image aspect ratio \"${aspectRatio}\". Use a positive W:H ratio.`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid native image aspect ratio \"${aspectRatio}\". Both sides must be positive.`);
  }
  const ratio = width / height;
  if (ratio > 3 || ratio < 1 / 3) throw new Error(`Native image aspect ratio \"${aspectRatio}\" exceeds the supported 3:1 limit.`);
  return ratio;
}

type Candidate = { width: number; height: number; area: number; error: number };

function candidatesFor(ratio: number, maxLong: number): Candidate[] {
  const candidates: Candidate[] = [];
  for (let width = EDGE; width <= maxLong; width += EDGE) for (let height = EDGE; height <= maxLong; height += EDGE) {
    const area = width * height;
    if (area < MIN_AREA || area > MAX_AREA) continue;
    const error = Math.abs(width / height / ratio - 1);
    if (error <= 0.01) candidates.push({ width, height, area, error });
  }
  return candidates;
}

/** Resolves a requested ratio to a native size; it never crops or stretches. */
export function resolveNativeImageSize(aspectRatio: string, resolution: NativeImageResolution = "1k"): NativeImageSize {
  if (!nativeImageResolutionValues.includes(resolution)) throw new Error(`Unsupported native image resolution \"${resolution}\". Use 1k, 2k, or 4k.`);
  const ratio = parseAspectRatio(aspectRatio);
  const candidates = candidatesFor(ratio, MAX_LONG_SIDE[resolution]);
  // At extreme valid ratios, the API minimum area may require exceeding the
  // nominal tier long side. Preserve the user's ratio instead of cropping it.
  const usable = candidates.length ? candidates : candidatesFor(ratio, 3840);
  if (!usable.length) throw new Error(`No native image size can represent \"${aspectRatio}\" within 1% ratio error.`);
  const targetArea = TARGET_AREA[resolution];
  usable.sort((a, b) => Math.abs(a.area - targetArea) - Math.abs(b.area - targetArea) || a.error - b.error || a.area - b.area || a.width - b.width);
  const chosen = usable[0]!;
  return { width: chosen.width, height: chosen.height, size: `${chosen.width}x${chosen.height}` };
}
