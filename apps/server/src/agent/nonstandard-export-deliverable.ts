import sharp, { type ExtendOptions, type OverlayOptions, type Sharp } from "sharp";

import {
  ENCODED_BYTES_AUTHORITY,
  exportDeliverableFormatSchema,
  exportDimensionReceiptSchema,
  type ExportApproximationEvidence,
  type ExportDeliverableFormat,
  type ExportDimensionReceipt,
  type PixelVerificationEvidence,
} from "./export-dimension-contract.js";

/**
 * Exact-size deliverables for targets the image provider cannot emit.
 *
 * The user asked for 320×70. The provider family is limited to 1:3–3:1 native
 * ratios, so what can be generated is a legal-ratio source (e.g. 1280×416 at
 * 3:1) — and the 320×70 artifact has to be COMPOSED here, then VERIFIED from
 * the bytes that were actually encoded.
 *
 * This module is that composition + verification primitive, and nothing more:
 *
 *   1. {@link composeTargetSizeRaster} places generated source image(s) on an
 *      exact-target-size program canvas. It letterboxes (pad) or scales
 *      uniformly (contain); it never stretches a source to fit one axis, and it
 *      never crops. Content is padded with a solid colour or with real
 *      transparency.
 *   2. {@link verifyEncodedImageBytes} reads the EXPORTED bytes back — format,
 *      true pixel dimensions, and whether an alpha channel with real
 *      transparency exists — from the file header plus a second independent
 *      decode of the same bytes. It takes no expected size, so the number it
 *      reports cannot be the number the caller hoped for.
 *   3. {@link evaluateExportDimensionReceipt} turns target + optional claim +
 *      bytes into the delivery-card receipt declared in
 *      `export-dimension-contract.ts`.
 *
 * Two things it deliberately is NOT: it is not wired into the design-export
 * renderer (which still reports the requested budget as the export result
 * rather than reading its own artifact back), and it is not exposed as an agent
 * tool. Both are stated as the remaining work in the delivery report; an
 * unverifiable export cannot become a verified delivery by itself.
 */

/** A positive integer pixel count. Fractions and non-numbers are programming errors, not user input. */
export type PixelSize = { width: number; height: number };

function positivePixel(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`nonstandard_export_invalid_${label}: ${label} must be a positive integer pixel count.`);
  }
  return value;
}

/** Validate a target size once, at the edge of the module. */
export function assertTargetSize(target: PixelSize): PixelSize {
  return { width: positivePixel(target?.width, "target_width"), height: positivePixel(target?.height, "target_height") };
}

/** The exact decimal ratio of a pixel frame, for honest deviation reporting. */
export function pixelRatio(size: PixelSize): number {
  const safe = assertTargetSize(size);
  return safe.width / safe.height;
}

/** Signed deviation of an actual ratio from a target ratio, as a fraction of the target. */
export function ratioDeviation(actual: PixelSize, target: PixelSize): number {
  return pixelRatio(actual) / pixelRatio(target) - 1;
}

// ---------------------------------------------------------------------------
// 1. Program-canvas composition
// ---------------------------------------------------------------------------

/**
 * How the source fills the target canvas.
 * - `contain`: uniform scale (up or down) until one axis touches; remaining space padded.
 * - `fit`: uniform scale only when the source is larger than the target; never enlarged.
 * - `none`: pixels untouched; the whole target beyond the source is padded.
 * `cover` does not exist: covering both axes of a different-ratio target means
 * cropping, and cropping a delivered design is not this module's decision.
 */
export type SourceScale = "contain" | "fit" | "none";

export type ComposeTargetSizeInput = {
  /** Generated source image(s) at a legal native ratio, in placement order. */
  sources: Array<Buffer | Uint8Array>;
  /** The exact frame the user asked for. */
  target: PixelSize;
  format?: ExportDeliverableFormat;
  /** Solid padding colour, or `"transparent"` for a real alpha channel. Default: transparent. */
  padding?: string;
  /** Default `contain`. */
  scale?: SourceScale;
  /** Container alignment when padding is not symmetric; default centred. */
  align?: "center" | "start" | "end";
  /** For jpeg only: the colour an existing alpha channel is flattened onto. */
  background?: string;
  jpegQuality?: number;
};

export type ComposeTargetSizeResult = {
  width: number;
  height: number;
  margin: { left: number; right: number; top: number; bottom: number };
  /** The scaled content box actually written, and the scale factor used for it. */
  content: { width: number; height: number; scale: number };
  format: ExportDeliverableFormat;
  padding: string;
  buffer: Buffer;
};

const TRANSPARENT = "transparent";

function normalizeFormat(format: ExportDeliverableFormat): ExportDeliverableFormat {
  const parsed = exportDeliverableFormatSchema.safeParse(format);
  if (!parsed.success) throw new Error(`nonstandard_export_unsupported_format: ${String(format)}`);
  return parsed.data;
}

function applyFormat(pipeline: Sharp, format: ExportDeliverableFormat, quality: number | undefined): Sharp {
  return format === "png" ? pipeline.png({ compressionLevel: 9 }) : pipeline.jpeg({ quality: quality ?? 92 });
}

/**
 * Compose the exact target-size raster without stretching or cropping.
 *
 * Each source is first scaled uniformly to fit INSIDE the target (letterbox
 * padding, not a per-axis squeeze), then padded up to the exact target frame,
 * then placed on the program canvas. Asserting the encoded result is the
 * caller's job ({@link verifyEncodedImageBytes}) — this function's return value
 * is intent plus the bytes, never proof.
 */
export async function composeTargetSizeRaster(input: ComposeTargetSizeInput): Promise<ComposeTargetSizeResult> {
  const target = assertTargetSize(input.target);
  const format = normalizeFormat(input.format ?? "png");
  const sources = (input.sources ?? []).filter(source => source && source.byteLength > 0);
  if (!sources.length) throw new Error("nonstandard_export_no_source: at least one source image is required.");
  const padding = input.padding?.trim() || TRANSPARENT;
  const scaleMode: SourceScale = input.scale ?? "contain";

  // One prepared layer per source: uniform-scaled content padded to the exact
  // target frame and centred, so placement on the canvas is a no-op translation.
  const composites: OverlayOptions[] = [];
  let first: { width: number; height: number; scale: number } | undefined;
  for (const source of sources) {
    const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
    const metadata = await sharp(buffer).metadata();
    if (!metadata.width || !metadata.height) throw new Error("nonstandard_export_source_unreadable");
    // EXIF orientation is applied by rotate(); a rotated source must be measured after it.
    const rotated = metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8
      ? { width: metadata.height, height: metadata.width } : { width: metadata.width, height: metadata.height };
    const box = contentBox(rotated, target, scaleMode);
    const layer = await sharp(buffer).rotate()
      .resize({ width: box.width, height: box.height, fit: "fill" })
      .extend(centerPad(target, box))
      .png().toBuffer();
    composites.push({ input: layer, left: offset(target.width - box.width, input.align),
      top: offset(target.height - box.height, input.align) });
    first ??= box;
  }

  let canvas = sharp({ create: {
    width: target.width, height: target.height,
    // With no alpha in the ground colour this is an opaque canvas, so an
    // all-opaque composition is encoded without an alpha channel at all.
    channels: padding === TRANSPARENT ? 4 : 3,
    background: padding === TRANSPARENT ? { r: 0, g: 0, b: 0, alpha: 0 } : padding,
  } }).composite(composites);
  if (format === "jpeg") {
    // JPEG carries no alpha: flatten deliberately onto the requested colour
    // rather than letting a silent black matte become the delivered background.
    canvas = canvas.flatten({ background: input.background?.trim() || "#ffffff" });
  }
  const buffer = await applyFormat(canvas, format, input.jpegQuality).toBuffer();
  const content = first!;
  const left = offset(target.width - content.width, input.align);
  const top = offset(target.height - content.height, input.align);
  return {
    width: target.width, height: target.height,
    margin: { left, right: target.width - content.width - left, top, bottom: target.height - content.height - top },
    content, format, padding, buffer,
  };
}

/** Margins that pad a content-sized layer out to the exact target frame, centred. */
function centerPad(target: PixelSize, content: PixelSize): ExtendOptions {
  const horizontal = target.width - content.width;
  const vertical = target.height - content.height;
  return { left: Math.floor(horizontal / 2), right: horizontal - Math.floor(horizontal / 2),
    top: Math.floor(vertical / 2), bottom: vertical - Math.floor(vertical / 2),
    background: { r: 0, g: 0, b: 0, alpha: 0 } };
}

/** Container offset for leftover space on one axis. */
function offset(leftover: number, align: ComposeTargetSizeInput["align"]): number {
  if (leftover <= 0) return 0;
  if (align === "start") return 0;
  if (align === "end") return leftover;
  return Math.floor(leftover / 2);
}

/**
 * The largest same-ratio box inside `target` that the source may occupy, and the
 * uniform scale factor that puts it there. `contain` scales up or down; `fit`
 * scales down only; `none` keeps the source's own pixels.
 *
 * The box keeps the CONTENT's ratio — that is what makes the scale uniform and
 * prevents a per-axis stretch. The leftover margins are carried separately.
 */
export function contentBox(source: PixelSize, target: PixelSize, scale: SourceScale = "contain"):
  { width: number; height: number; scale: number } {
  const safeSource = assertTargetSize(source);
  const safeTarget = assertTargetSize(target);
  if (scale === "none") return { width: safeSource.width, height: safeSource.height, scale: 1 };
  const sourceRatio = safeSource.width / safeSource.height;
  let width = Math.min(safeTarget.width, safeSource.width);
  let height = Math.max(1, Math.round(width / sourceRatio));
  if (height > safeTarget.height) { height = safeTarget.height; width = Math.max(1, Math.round(height * sourceRatio)); }
  if (scale === "fit" && (width > safeSource.width || height > safeSource.height)) {
    width = safeSource.width; height = safeSource.height;
  }
  return { width, height, scale: width / safeSource.width };
}

// ---------------------------------------------------------------------------
// 2. Encoded-byte verification
// ---------------------------------------------------------------------------

export type EncodedImageVerification = {
  format: ExportDeliverableFormat;
  width: number;
  height: number;
  byteSize: number;
  hasAlphaChannel: boolean;
  /** Lowest alpha sample in the decoded artifact, 0–255; null when there is no alpha channel. */
  minAlpha: number | null;
  alpha: PixelVerificationEvidence["alpha"];
  /** The same bytes parsed independently: `decoded` by the image decoder, `header` by this module. */
  decoded: (PixelSize & { format: string | null }) | null;
  header: PixelSize | null;
};

/**
 * Read the truth about an encoded deliverable out of its own bytes.
 *
 * No size is accepted as input: the two numbers returned are parsed from the
 * container header (PNG IHDR, JPEG SOFn) and cross-checked against an
 * independent decode of the same buffer. A disagreement is raised as
 * `nonstandard_export_verification_conflict` rather than reported as a size.
 *
 * Alpha is a property of the pixels as well as the header: `realTransparency`
 * is true only when an alpha channel exists AND at least one sample is below
 * 255, because "has an alpha channel" and "is actually transparent" are
 * different claims on a delivery card.
 */
export async function verifyEncodedImageBytes(bytes: Buffer | Uint8Array): Promise<EncodedImageVerification> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (!buffer.byteLength) throw new Error("nonstandard_export_empty_bytes");
  const header = parseImageHeader(buffer);
  if (!header) throw new Error("nonstandard_export_unknown_format: only png and jpeg deliverables can be verified here.");
  const format = normalizeFormat(header.format);
  const decoded = await decodeEncodedImage(buffer);
  if (decoded.width !== header.width || decoded.height !== header.height) throw new Error(
    `nonstandard_export_verification_conflict: header ${header.width}x${header.height} disagrees with decoded ${decoded.width}x${decoded.height}; refusing to report either as the export size.`);
  const alpha: PixelVerificationEvidence["alpha"] = decoded.hasAlphaChannel
    ? { channel: true, verdict: decoded.minAlpha < 255 ? "present" : "opaque", minAlpha: decoded.minAlpha, realTransparency: decoded.minAlpha < 255 }
    : { channel: false, verdict: "absent", minAlpha: null, realTransparency: false };
  return {
    format, width: header.width, height: header.height, byteSize: buffer.byteLength,
    hasAlphaChannel: decoded.hasAlphaChannel, minAlpha: decoded.minAlpha, alpha,
    decoded: { width: decoded.width, height: decoded.height, format: decoded.format },
    header: { width: header.width, height: header.height },
  };
}

async function decodeEncodedImage(buffer: Buffer): Promise<{
  width: number; height: number; format: string | null; hasAlphaChannel: boolean; minAlpha: number;
}> {
  const image = sharp(buffer, { animated: false, limitInputPixels: false });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error("nonstandard_export_unreadable_pixels");
  const hasAlphaChannel = metadata.hasAlpha === true;
  if (!hasAlphaChannel) return {
    width: metadata.width, height: metadata.height, format: metadata.format ?? null,
    hasAlphaChannel: false, minAlpha: 255,
  };
  const raw = await sharp(buffer, { animated: false, limitInputPixels: false }).ensureAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const channels = raw.info.channels;
  let minAlpha = 255;
  for (let index = channels - 1; index < raw.data.length; index += channels) {
    const value = raw.data[index]!;
    if (value < minAlpha) minAlpha = value;
    if (minAlpha === 0) break;
  }
  return { width: metadata.width, height: metadata.height, format: metadata.format ?? null, hasAlphaChannel: true, minAlpha };
}

/** The header a format claims, parsed from bytes only. `null` for anything unsupported. */
export function parseImageHeader(buffer: Buffer): ({ format: ExportDeliverableFormat } & PixelSize) | null {
  if (buffer.byteLength >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    // IHDR is required to be the first chunk, so the frame is at a fixed offset.
    if (buffer.toString("latin1", 12, 16) !== "IHDR") throw new Error("nonstandard_export_header_invalid: first PNG chunk is not IHDR.");
    return { format: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.byteLength >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const frame = parseJpegFrame(buffer);
    return frame ? { format: "jpeg", ...frame } : null;
  }
  return null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Walk JPEG marker segments to the SOFn frame header, skipping entropy data. */
function parseJpegFrame(buffer: Buffer): PixelSize | null {
  let offset = 2;
  while (offset + 3 < buffer.byteLength) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1]!;
    if (marker === 0xff) { offset++; continue; }
    // Standalone markers carry no length; SOS begins entropy-coded data.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.byteLength) return null;
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 >= buffer.byteLength) return null;
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    if (marker === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Delivery-card receipt
// ---------------------------------------------------------------------------

export type ExportDimensionReceiptInput = {
  /** ① The user's requested frame, in pixels. */
  target: PixelSize;
  /**
   * Optional size someone else asserts for this artifact (a job result, a
   * canvas observation, a model reply). It is reported and compared — never
   * trusted. Omit when nobody claimed a size.
   */
  claim?: PixelSize | null;
  /** The encoded deliverable bytes; the only source of ④. */
  bytes?: Buffer | Uint8Array | null;
  /** Which native legal ratio the composition actually used, when it was not the target ratio. */
  approximation?: { requestedRatio: string; nativeRatio: string } | null;
};

/**
 * Build the delivery-card size block. Every field is either byte-verified or
 * explicitly unknown; `matches` is true only for a verified artifact whose real
 * size equals the target.
 */
export async function evaluateExportDimensionReceipt(input: ExportDimensionReceiptInput): Promise<ExportDimensionReceipt> {
  const target = assertTargetSize(input.target);
  const claim = input.claim ? assertTargetSize(input.claim) : null;
  const mismatches = new Set<ExportDimensionReceipt["mismatches"][number]>();
  const approximation: ExportApproximationEvidence | null = input.approximation
    ? { requestedRatio: input.approximation.requestedRatio, nativeRatio: input.approximation.nativeRatio,
        ratioDeviation: ratioDeviation(sizeFromRatio(input.approximation.nativeRatio), sizeFromRatio(input.approximation.requestedRatio)) }
    : null;
  if (claim && (claim.width !== target.width || claim.height !== target.height)) mismatches.add("size");

  if (!input.bytes || input.bytes.byteLength === 0) {
    mismatches.add("unverified");
    return receipt({ target, claim, actual: null, evidence: null, mismatches, approximation });
  }
  const verified = await verifyEncodedImageBytes(input.bytes);
  const actual = { width: verified.width, height: verified.height };
  if (actual.width !== target.width || actual.height !== target.height) mismatches.add("size");
  if (claim && (claim.width !== actual.width || claim.height !== actual.height)) mismatches.add("size");
  const evidence: PixelVerificationEvidence = {
    source: "encoded_bytes", format: verified.format, actualSize: actual, alpha: verified.alpha,
    decodedSize: verified.decoded ? { width: verified.decoded.width, height: verified.decoded.height } : null,
    headerSize: verified.header,
  };
  return receipt({ target, claim, actual, evidence, mismatches, approximation });
}

/** A ratio string ("3:1") expressed as an integer pixel frame, so deviations use the same math. */
export function sizeFromRatio(ratio: string): PixelSize {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio ?? "");
  if (!match) throw new Error(`nonstandard_export_invalid_ratio: ${String(ratio)} is not a positive W:H ratio.`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`nonstandard_export_invalid_ratio: ${String(ratio)} is not a positive W:H ratio.`);
  }
  return { width: Math.round(width * 1000), height: Math.round(height * 1000) };
}

function receipt(input: {
  target: PixelSize;
  claim: PixelSize | null;
  actual: PixelSize | null;
  evidence: PixelVerificationEvidence | null;
  mismatches: Set<ExportDimensionReceipt["mismatches"][number]>;
  approximation: ExportApproximationEvidence | null;
}): ExportDimensionReceipt {
  return exportDimensionReceiptSchema.parse({
    targetSize: input.target,
    claimedSize: input.claim,
    actualExportSize: input.actual,
    format: input.evidence?.format ?? null,
    hasAlpha: input.evidence ? input.evidence.alpha.realTransparency : null,
    alphaVerdict: input.evidence?.alpha.verdict ?? null,
    matches: input.actual !== null && input.mismatches.size === 0,
    mismatches: [...input.mismatches],
    approximation: input.approximation,
    pixelVerification: input.evidence,
    authority: { target: "① user-requested frame, in pixels.", actual: ENCODED_BYTES_AUTHORITY },
  });
}

/** One line for a chat card; states "unverified" instead of guessing a size. */
export function describeExportDimensionReceipt(receiptValue: ExportDimensionReceipt): string {
  if (!receiptValue.actualExportSize) return `目标尺寸 ${receiptValue.targetSize.width}×${receiptValue.targetSize.height}：尚无实际导出字节，实际导出尺寸未知（未验证）。`;
  const actual = receiptValue.actualExportSize;
  const alpha = receiptValue.alphaVerdict === "present" ? "含透明通道（有真实透明像素）"
    : receiptValue.alphaVerdict === "opaque" ? "有 alpha 通道但全部不透明"
      : receiptValue.alphaVerdict === "absent" ? "无 alpha 通道" : "alpha 通道未知";
  return [
    `目标尺寸 ${receiptValue.targetSize.width}×${receiptValue.targetSize.height}`,
    `实际导出尺寸 ${actual.width}×${actual.height}`,
    `格式 ${receiptValue.format}`,
    alpha,
    receiptValue.matches ? "与目标一致" : `与目标不一致（${receiptValue.mismatches.join("、")}）`,
    ...(receiptValue.approximation
      ? [`近似比例 ${receiptValue.approximation.nativeRatio} 相对 ${receiptValue.approximation.requestedRatio} 偏差 ${(receiptValue.approximation.ratioDeviation * 100).toFixed(1)}%`]
      : []),
  ].join("；");
}

/** Re-parse a receipt that crossed a JSON boundary (job result, session state, chat payload). */
export function parseExportDimensionReceipt(value: unknown): ExportDimensionReceipt | null {
  const parsed = exportDimensionReceiptSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // A stored receipt is untrusted input: try the object after a JSON round trip
  // so a stringified payload is accepted, and report null (unknown) otherwise.
  if (typeof value !== "string") return null;
  try { return parseExportDimensionReceipt(JSON.parse(value)); } catch { return null; }
}

/** Re-exported so a caller need not import the contract module to type a receipt. */
export { exportDimensionReceiptSchema };
export type { ExportDimensionReceipt };
export const exportDimensionCardNote = (): string => ENCODED_BYTES_AUTHORITY;
