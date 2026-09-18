import { resolveNativeImageSize, type NativeImageResolution } from "./native-image-size.js";

/** Opt-in planning only. Ordinary native requests keep their strict resolver. */
export function planApproximateNativeImageSize(width: number, height: number, resolution: NativeImageResolution = "1k") {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 100_000)) {
    throw new Error("Approximate target dimensions must be positive integer pixels, at most 100000 per side.");
  }
  // Doubling supplies a pixel-scale reference; it never changes aspect ratio,
  // upgrades the resolution tier, or promises the provider this exact size.
  let scaleFactor = 1;
  while (width * height * scaleFactor * scaleFactor < 655_360 || Math.min(width, height) * scaleFactor < 16) scaleFactor *= 2;
  const targetRatio = width / height;
  const aspectRatio = targetRatio > 3 ? "3:1" : targetRatio < 1 / 3 ? "1:3" : `${width}:${height}`;
  const nativeSize = resolveNativeImageSize(aspectRatio, resolution);
  return {
    target: { width, height }, scaleFactor,
    scaledTarget: { width: width * scaleFactor, height: height * scaleFactor },
    aspectRatio, resolution, nativeSize,
    ratioError: Math.abs(nativeSize.width / nativeSize.height / targetRatio - 1),
    substituted: targetRatio > 3 || targetRatio < 1 / 3,
  };
}
