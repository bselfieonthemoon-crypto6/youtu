import type { OutpaintMargins } from "@loomic/shared";
import sharp from "sharp";

import { composeLocalRepaint, type PreparedLocalRepaint } from "./local-repaint.js";

const MAX_OUTPUT_EDGE = 3_840;
const MAX_OUTPUT_AREA = 8_294_400;
const MAX_OUTPUT_RATIO = 3;
const MAX_MARGIN = 4_096;

/** Direct image editing: send the unpadded source and target size, no mask or composition. */
export async function directOutpaintRequest(source: Buffer, margins: OutpaintMargins, instruction: string) {
  assertMargins(margins);
  const metadata = await sharp(source).metadata();
  if (!metadata.width || !metadata.height) throw invalidInput("Unreadable outpaint source.");
  // Provider size accepts 16px steps. Normalize once before sending, never resize its result.
  const width = Math.max(16, Math.round((metadata.width + margins.left + margins.right) / 16) * 16);
  const height = Math.max(16, Math.round((metadata.height + margins.top + margins.bottom) / 16) * 16);
  if (width > MAX_OUTPUT_EDGE || height > MAX_OUTPUT_EDGE || width * height > MAX_OUTPUT_AREA || Math.max(width / height, height / width) > MAX_OUTPUT_RATIO) {
    throw invalidInput("Outpaint target dimensions exceed supported limits.");
  }
  const png = await sharp(source).toColourspace("srgb").ensureAlpha().png().toBuffer();
  const stats = await sharp(png).stats();
  return {
    prompt: `将这张图片扩展到 ${width}×${height} 像素，保持主体大小和位置，向外自然延续背景，形成无缝的完整画面。向左扩展 ${margins.left}、右 ${margins.right}、上 ${margins.top}、下 ${margins.bottom} 像素。${instruction.trim() ? `补充要求：${instruction.trim()}` : ""}`,
    inputImages: [`data:image/png;base64,${png.toString("base64")}`],
    outputWidth: width,
    outputHeight: height,
    aspectRatio: `${width}:${height}`,
    outputFormat: "png" as const,
    background: stats.channels[3]!.min < 255 ? "transparent" as const : "opaque" as const,
  };
}

function invalidInput(message: string) {
  return Object.assign(new Error(message), { code: "invalid_input" });
}

function assertMargins(margins: OutpaintMargins) {
  const entries = Object.entries(margins) as Array<
    [keyof OutpaintMargins, number]
  >;
  if (
    entries.length !== 4 ||
    entries.some(
      ([, value]) =>
        !Number.isSafeInteger(value) || value < 0 || value > MAX_MARGIN,
    )
  ) {
    throw invalidInput(
      "Outpaint margins must be non-negative integer pixels no larger than 4096.",
    );
  }
  if (entries.every(([, value]) => value === 0)) {
    throw invalidInput("Outpaint requires at least one positive margin.");
  }
}

/**
 * Builds the synthetic source and edit mask consumed by the existing masked
 * edit path. The original sits at (left, top), the padding is transparent,
 * with a narrow editable overlap inside expanded edges for seamless continuation.
 */
export async function prepareOutpaint(
  source: Buffer,
  margins: OutpaintMargins,
): Promise<PreparedLocalRepaint> {
  assertMargins(margins);
  const metadata = await sharp(source).metadata();
  if (!metadata.width || !metadata.height) {
    throw invalidInput("Outpaint source has no readable dimensions.");
  }

  const width = metadata.width + margins.left + margins.right;
  const height = metadata.height + margins.top + margins.bottom;
  const area = width * height;
  const ratio = Math.max(width / height, height / width);
  if (
    width > MAX_OUTPUT_EDGE ||
    height > MAX_OUTPUT_EDGE ||
    area > MAX_OUTPUT_AREA ||
    ratio > MAX_OUTPUT_RATIO
  ) {
    throw invalidInput(
      "Outpaint canvas must have a long side no larger than 3840px, an area no larger than 8294400px, and an aspect ratio no wider than 3:1.",
    );
  }

  // Background policy is intentionally read before padding: the synthetic
  // transparent border must not turn an originally opaque image transparent.
  const originalPng = await sharp(source)
    .toColourspace("srgb")
    .ensureAlpha()
    .png()
    .toBuffer();
  const originalStats = await sharp(originalPng).stats();
  const background =
    originalStats.channels[3]!.min < 255 ? "transparent" : "opaque";

  const sourcePng = await sharp(originalPng)
    .extend({
      top: margins.top,
      right: margins.right,
      bottom: margins.bottom,
      left: margins.left,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // Local repaint composition uses white=replace. The provider mask uses the
  // equivalent alpha contract: transparent=replace, opaque=preserve.
  const maskPixels = Buffer.alloc(width * height, 255);
  const overlap = Math.min(96, Math.floor(Math.min(metadata.width, metadata.height) * 0.08));
  for (let y = 0; y < metadata.height; y += 1) {
    const rowStart = (y + margins.top) * width + margins.left;
    for (let x = 0; x < metadata.width; x += 1) {
      const distance = Math.min(
        margins.left > 0 ? x : Infinity,
        margins.right > 0 ? metadata.width - 1 - x : Infinity,
        margins.top > 0 ? y : Infinity,
        margins.bottom > 0 ? metadata.height - 1 - y : Infinity,
      );
      const t = overlap > 0 ? Math.max(0, 1 - distance / overlap) : 0;
      // Smoothstep: generated at the outer seam, original at the inner edge.
      maskPixels[rowStart + x] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }
  const providerMaskPixels = Buffer.alloc(width * height * 4, 255);
  for (let index = 0; index < maskPixels.length; index += 1) {
    // Give the provider a binary edit area; feather only during final composition.
    providerMaskPixels[index * 4 + 3] = maskPixels[index]! > 0 ? 0 : 255;
  }
  const providerMaskPng = await sharp(providerMaskPixels, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  return {
    width,
    height,
    sourcePng,
    providerMaskPng,
    maskPixels,
    background,
  };
}

export function outpaintRequest(
  prepared: PreparedLocalRepaint,
  instruction: string,
) {
  return {
    prompt: [
      "Produce one continuous expanded image, never a smaller picture pasted on a larger background. The transparent mask covers the new outside area AND a narrow overlap inside the original edges; regenerate this overlap to connect the scene seamlessly. Opaque mask pixels are the unchanged protected center.",
      "Continue perspective, lighting, colors, textures and lines across the former frame boundary. There must be no inset rectangle, border, tonal step or duplicated background. Preserve the protected center and subject; the editable edge overlap may change to make the transition continuous.",
      "Do not crop, move, resize, rescale, duplicate, or redraw the original subject. Do not treat the transparent padding or mask as visible image content.",
      prepared.background === "transparent"
        ? "The original contains real alpha transparency. Return PNG alpha where the extended scene is still intentionally transparent; never add a checkerboard or black fill."
        : "The original is opaque. Extend it as an opaque scene without introducing transparency.",
      `User's outpaint instruction: ${instruction}`,
    ].join("\n"),
    background: prepared.background,
    outputFormat: "png" as const,
    aspectRatio: `${prepared.width}:${prepared.height}`,
    inputImages: [
      `data:image/png;base64,${prepared.sourcePng.toString("base64")}`,
    ],
    maskImage: `data:image/png;base64,${prepared.providerMaskPng.toString("base64")}`,
  };
}

export async function composeOutpaint(prepared: PreparedLocalRepaint, generated: Buffer): Promise<Buffer> {
  const metadata = await sharp(generated).metadata();
  if (!metadata.width || !metadata.height ||
      Math.abs((metadata.width / metadata.height) / (prepared.width / prepared.height) - 1) > 0.01) {
    throw Object.assign(new Error("扩图返回比例与目标不一致，已停止合成，避免拉伸和接缝。"), { code: "outpaint_geometry_mismatch" });
  }
  return composeLocalRepaint(prepared, generated);
}
