import { SafeDownloadError, safeDownload } from "../security/safe-download.js";

const KNOWN_RATIOS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
};

function roundTo64(value: number): number {
  return Math.round(value / 64) * 64;
}

export function aspectRatioToDimensions(
  aspectRatio: string,
  baseSize = 1024,
): { width: number; height: number } {
  const known = KNOWN_RATIOS[aspectRatio];
  if (known && baseSize === 1024) return known;

  const [wStr, hStr] = aspectRatio.split(":");
  const w = Number(wStr);
  const h = Number(hStr);
  if (!w || !h) return { width: baseSize, height: baseSize };

  const ratio = w / h;
  if (ratio >= 1) {
    return { width: roundTo64(baseSize), height: roundTo64(baseSize / ratio) };
  }
  return { width: roundTo64(baseSize * ratio), height: roundTo64(baseSize) };
}

/**
 * Fetches a resource from a URL (or data URI) and returns its base64
 * representation and MIME type. Used by Google providers to convert
 * input images/media into inline_data format.
 */
export async function fetchAsBase64(
  providerName: string,
  url: string,
): Promise<{ data: string; mimeType: string }> {
  try {
    const downloaded = await safeDownload(url, {
      kind: "image",
      maxBytes: 20 * 1024 * 1024,
      timeoutMs: 30_000,
      maxRedirects: 2,
      allowDataUri: true,
      allowedMimeTypes: [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/avif",
        "image/bmp",
        "image/tiff",
      ],
    });
    return {
      data: downloaded.buffer.toString("base64"),
      mimeType: downloaded.mimeType,
    };
  } catch (err) {
    throw new GenerationError(
      providerName,
      "input_fetch_error",
      err instanceof SafeDownloadError
        ? `Input image rejected (${err.code}).`
        : "Failed to fetch input image.",
    );
  }
}

export class GenerationError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GenerationError";
  }
}
