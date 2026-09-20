import { designExportResultSchema } from "@loomic/shared";
import { z } from "zod";

/**
 * The FOUR sizes of "one image", and which layer is allowed to state which.
 *
 * The checklist item behind this file is: ①用户要求尺寸 ②AI 原始图片像素
 * ③画布显示尺寸 ④最终导出尺寸. Four different numbers are all legitimately called
 * "the size of that image", and every layer of this system holds exactly one of
 * them, so no single observation can state all four. Two silent defects made
 * that concrete: a status answer reported the canvas element's 381x512 display
 * frame as an 880x1184 PNG's "实际像素", and the canvas layer has no way at all
 * to know the requested frame or the export size.
 *
 * The honest contract, therefore, is not "carry all four everywhere" — it is:
 * every surface NAMES the one size it carries, STATES the others as unknown
 * rather than omitting them, and points at where each one really lives.
 *
 * | # | size | source of truth |
 * |---|---|---|
 * | ① | requested frame | the authenticated submission on the job row (`payload->>aspect_ratio` / `payload->>resolution`) |
 * | ② | AI source pixels | the generation job's own output, `background_jobs.result.width/height` |
 * | ③ | canvas display frame | the canvas element (`element.width/height`) |
 * | ④ | export size | the `design_export` job's result (`design_export_result.width/height`) — same column, different job |
 *
 * This module deliberately contains no heuristics and no new prompt rules: it is
 * an observation/receipt naming contract (repo rule R1), not intent detection.
 */

/**
 * ① REQUESTED — the size/ratio the user asked for, as authenticated at submission.
 *
 * The only durable record of the request is the job payload the server itself
 * wrote when it submitted: the aspect ratio and the resolution tier. It is NOT
 * a pixel size, and it must not be presented as one; the human wording of the
 * request is the model's own context, never re-derived here.
 */
export type ImageRequestedFrame = { aspectRatio: string; resolution: string };

/**
 * ② SOURCE PIXELS — the AI image's real pixel size.
 *
 * Exists only in the generation job's `result` (the provider-returned size that
 * `job_canvas_finalizer` writes onto the row). `public.asset_objects` has no
 * width/height columns, and the canvas element stores only the display frame, so
 * a surface that does not read this receipt must say "unknown" rather than reach
 * for the frame.
 */
export type ImageSourcePixels = { width: number; height: number };

/** ④ EXPORT — the produced artifact's size, and why a receipt cannot report it. */
export const EXPORT_SIZE_AUTHORITY =
  "Export size is a separate question: a generation job receipt cannot answer it, and neither ①requested ②source pixels nor ③canvas frame may be substituted for it. An export artifact's real pixel size exists only on the succeeded design_export job's own result (background_jobs.result.width/height, validated by designExportResultSchema). Those two numbers are read back from the ENCODED deliverable by the export path itself and are carried next to them as result.dimension_receipt (targetSize, actualExportSize, format, hasAlpha, matches, mismatches, approximation); the design's width/height × payload.multiplier is the REQUESTED frame, never the delivered pixels. No export job in scope means the export size is unknown, not equal to any other size here.";

/** ③ CANVAS FRAME — the canvas element carries the display frame, never pixels. */
export const CANVAS_FRAME_AUTHORITY =
  "The canvas element's width/height is the CANVAS DISPLAY FRAME of one placement, not the image's pixels: the same PNG can sit in several differently sized frames on one board, and Excalidraw resizes them on paste. It is never evidence of an image's real pixels.";

/** The one sentence that keeps the four apart on a job receipt. */
export const JOB_RECEIPT_SIZE_NOTE = `Sizes at a glance: image_requested_frame = ① what the user asked for (authenticated submission: aspect ratio + resolution tier, not pixels, surfaced here as requestedFrame); image_source_pixels = ② the AI image's real pixel size, returned by this job and authoritative (sourcePixelWidth/sourcePixelHeight); image_canvas_frame = ③ the display frame of THIS canvas element (the join key is canvasElementId) — a frame, never the image's pixels; image_export_size = ④ not produced by this job. ${EXPORT_SIZE_AUTHORITY}`;

/**
 * ④ EXPORT, EXACT-SIZE VARIANT — the extreme-target case the four-size contract
 * above did not yet cover.
 *
 * The contract above keeps four sizes apart. It does not answer the other half
 * of the same question: when the user names an exact pixel frame the provider
 * cannot emit (320×70), the artifact that is DELIVERED is composed locally at
 * that exact size, and every size on the delivery card has to be a size that
 * was actually observed. On that shape:
 *
 * - `target` is ① — the user's requested frame, in pixels, exactly as asked.
 * - `actual` is ④ — and it is NOT the canvas frame, the source pixels, nor the
 *   composed input size. It is read back from the ENCODED deliverable bytes
 *   (see {@link ENCODED_BYTES_AUTHORITY}); the byte-verified dimensions are the
 *   only ones a delivery card may print as "实际导出尺寸".
 * - `matches` is the answer to "did we deliver what was asked", and it is
 *   `false` whenever the byte-verified size differs from the target, or when
 *   the caller's claim about the artifact disagrees with its own bytes.
 * - `approximation` is the only place a ratio deviation may be stated, and it
 *   exists only when the generated source was NOT at the target ratio.
 *
 * The one thing this file must never do is accept a composed or planned size as
 * evidence of the exported pixels: a program canvas can be built at 320×70 and
 * still encode a different size (resize-on-write, a provider re-encode, a
 * mis-set option). Only the encoded bytes settle it.
 */
export const ENCODED_BYTES_AUTHORITY =
  "实际导出尺寸只能来自交付文件自身的编码字节：读取 PNG IHDR / JPEG SOFn 等文件头得到真实像素、格式与是否存在带真实透明的 alpha 通道。程序画布的目标尺寸、生成原图像素、画布显示框和调用方传入的任何数字都不是导出像素的证据；本文件中的 actual 字段必须由读回的字节填充，二者不一致时 matches=false，并如实报告，不得把计划尺寸或缩放后的画布尺寸当作最终像素。";

/** Which layer observed one size in a receipt. Every size must name its own. */
export const exportDimensionSourceAuthority = {
  target: "① 用户要求尺寸：本轮请求原话/界面给出的目标帧，是目标而不是任何已产出像素。",
  claim: "调用方（任务回执、画布或模型）声称的该产物尺寸；claim 与字节不一致本身就是需要报告的证据。",
  actual: ENCODED_BYTES_AUTHORITY,
} as const;

/** Formats a deliverable can be read back as; anything else is not a receipt format. */
export const exportDeliverableFormats = ["png", "jpeg"] as const;
export const exportDeliverableFormatSchema = z.enum(exportDeliverableFormats);
export type ExportDeliverableFormat = z.infer<typeof exportDeliverableFormatSchema>;

const pixelSizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();

/**
 * How an alpha channel was judged, on the delivery card.
 *
 * - `absent`: the format cannot carry alpha at all (JPEG has three channels by
 *   definition), so no pixel could be transparent.
 * - `present`: an alpha channel exists and at least one sample is below 255.
 * - `opaque`: an alpha channel exists and every sample is 255, i.e. the file
 *   carries a channel that promises nothing.
 * - `unknown`: reserved for a receipt with no readable bytes; a receipt built
 *   from bytes never uses it, because those bytes always settle the question.
 */
export const alphaChannelVerdictSchema = z.enum(["present", "opaque", "absent", "unknown"]);
export type AlphaChannelVerdict = z.infer<typeof alphaChannelVerdictSchema>;

/** The measured evidence behind one export dimension receipt. */
export const pixelVerificationEvidenceSchema = z.object({
  source: z.literal("encoded_bytes"),
  format: exportDeliverableFormatSchema,
  actualSize: pixelSizeSchema,
  alpha: z.object({
    channel: z.boolean(),
    verdict: alphaChannelVerdictSchema,
    /** Lowest alpha sample in the decoded artifact, 0–255; null when there is no alpha channel. */
    minAlpha: z.number().int().min(0).max(255).nullable(),
    /** True only for `present`: an alpha channel with at least one non-opaque pixel. */
    realTransparency: z.boolean(),
  }).strict(),
  /** Cross-check evidence: the same bytes parsed independently by two readers. */
  decodedSize: pixelSizeSchema.nullable(),
  headerSize: pixelSizeSchema.nullable(),
}).strict();
export type PixelVerificationEvidence = z.infer<typeof pixelVerificationEvidenceSchema>;

/** Which native (legal-ratio) frame the composition actually used. */
export const exportApproximationEvidenceSchema = z.object({
  requestedRatio: z.string().min(1),
  nativeRatio: z.string().min(1),
  /** Signed deviation of the native ratio from the requested ratio, as a fraction. */
  ratioDeviation: z.number().finite(),
}).strict();
export type ExportApproximationEvidence = z.infer<typeof exportApproximationEvidenceSchema>;

/**
 * One delivery card's size block: target, actual export size, format, alpha,
 * whether they match, and the ratio deviation when an approximation was used.
 *
 * `actualExportSize` is `null` when nothing has been verified yet (no bytes to
 * read); it is never filled with the target, the claim, or the composed size.
 */
export const exportDimensionReceiptSchema = z.object({
  targetSize: pixelSizeSchema,
  claimedSize: pixelSizeSchema.nullable(),
  actualExportSize: pixelSizeSchema.nullable(),
  format: exportDeliverableFormatSchema.nullable(),
  /**
   * "The delivered pixels contain real transparency" — i.e.
   * `pixelVerification.alpha.realTransparency`, true only for an alpha channel
   * with at least one sample below 255. It is NOT "an alpha channel exists":
   * that is `pixelVerification.alpha.channel`. Read `alphaVerdict` for which of
   * the two a PNG turned out to be.
   */
  hasAlpha: z.boolean().nullable(),
  alphaVerdict: alphaChannelVerdictSchema.nullable(),
  matches: z.boolean(),
  /** Why not, when `matches` is false: named, not a prose guess. */
  mismatches: z.array(z.enum(["size", "format", "alpha", "unverified"])),
  approximation: exportApproximationEvidenceSchema.nullable(),
  pixelVerification: pixelVerificationEvidenceSchema.nullable(),
  authority: z.object({
    target: z.string().min(1),
    actual: z.string().min(1),
  }).strict(),
}).strict();
export type ExportDimensionReceipt = z.infer<typeof exportDimensionReceiptSchema>;

/**
 * The sizes a delivery card must name, and where each one comes from. Kept next
 * to the schema so a card cannot print "尺寸" and mean three different numbers.
 */
export const EXPORT_DIMENSION_CARD_NOTE =
  `交付卡片尺寸字段：targetSize=①用户目标尺寸；actualExportSize=④实际导出尺寸（${ENCODED_BYTES_AUTHORITY}）；format=读回的文件格式；hasAlpha=是否存在带真实透明的 alpha 通道；matches=实际是否等于目标；mismatches=不相符的具体原因；approximation.ratioDeviation=使用近似原生比例时的比例偏差。目标尺寸、画布显示尺寸、生成原图像素与放大参照都不是实际导出尺寸。`;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

export type ImageJobDimensionProjection = {
  sourcePixelWidth?: number;
  sourcePixelHeight?: number;
  canvasElementId?: string;
  /** The board and project/design the placement lives on: the job↔canvas join. */
  canvasId?: string;
  designId?: string;
  requestedFrame?: ImageRequestedFrame;
  /** ④ is never this job's answer; it is stated so the answer cannot invent one. */
  exportSize: null;
  hasSourcePixels: boolean;
  canvasElementIdKnown: boolean;
  sizes: string;
  authorities: { requestedFrame: string; sourcePixels: string; canvasFrame: string; exportSize: string };
};

/**
 * Read ①②③ off one generation job row and state ④ as unknown.
 *
 * Shared by the status tool and the per-turn receipt projection so the two can
 * never drift into naming the same row's numbers differently. Values that the
 * row does not carry are simply absent, and `hasSourcePixels` lets a caller
 * report an unknown explicitly instead of leaving a gap that reads as "none".
 */
export function projectImageJobDimensions(
  job: Record<string, unknown> | null | undefined,
  result: Record<string, unknown> | null | undefined = record(job?.result),
): ImageJobDimensionProjection {
  const sourcePixelWidth = positiveInteger(result?.width);
  const sourcePixelHeight = positiveInteger(result?.height);
  const canvasElementId = typeof result?.canvas_element_id === "string" && result.canvas_element_id.trim()
    ? result.canvas_element_id : undefined;
  const aspectRatio = typeof job?.requestedAspectRatio === "string" && job.requestedAspectRatio.trim()
    ? job.requestedAspectRatio : (typeof job?.aspectRatio === "string" && job.aspectRatio.trim() ? job.aspectRatio : undefined);
  const resolution = typeof job?.resolution === "string" && job.resolution.trim() ? job.resolution : undefined;
  const canvasId = typeof job?.canvas_id === "string" && job.canvas_id ? job.canvas_id : undefined;
  const designId = typeof job?.design_id === "string" && job.design_id ? job.design_id : undefined;
  return {
    ...(sourcePixelWidth !== undefined && sourcePixelHeight !== undefined
      ? { sourcePixelWidth, sourcePixelHeight } : {}),
    ...(canvasElementId ? { canvasElementId } : {}),
    ...(canvasId ? { canvasId } : {}),
    ...(designId ? { designId } : {}),
    ...(aspectRatio
      ? { requestedFrame: { aspectRatio, resolution: resolution ?? "unspecified" } }
      : {}),
    exportSize: null,
    hasSourcePixels: sourcePixelWidth !== undefined && sourcePixelHeight !== undefined,
    canvasElementIdKnown: canvasElementId !== undefined,
    sizes: JOB_RECEIPT_SIZE_NOTE,
    authorities: {
      requestedFrame: "Authenticated job submission (payload aspect_ratio + resolution tier). Not a pixel size.",
      sourcePixels: "The generation job's own result (background_jobs.result.width/height). The authoritative pixel size.",
      canvasFrame: CANVAS_FRAME_AUTHORITY,
      exportSize: EXPORT_SIZE_AUTHORITY,
    },
  };
}

/**
 * Re-parse a receipt that crossed a JSON boundary (a job result, session state,
 * a chat payload) using the same schema the export path validates against.
 *
 * Deliberately defined here rather than imported from
 * `nonstandard-export-deliverable.ts`: that module imports THIS one for the
 * schema, so the dependency must not run both ways.
 */
export function parseExportDimensionReceipt(value: unknown): ExportDimensionReceipt | null {
  const parsed = exportDimensionReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * ④ EXPORT — read a design export artifact's real size from its own job result.
 *
 * Exported so the export question has one named answer instead of the image
 * surfaces inventing a fallback: the schema is the same one
 * `createDesignExportExecutor` persisted through `markSucceeded`, so this reads
 * what the worker actually wrote and rejects anything else (including a
 * generation result, which has an `asset_id` and no `format`).
 *
 * The receipt is not decoration. When a result carries one, its byte-verified
 * `actualExportSize` must be the same size the result reports — a receipt that
 * disagrees with the numbers beside it means the row is not a trustworthy size
 * source at all, and this returns null rather than picking one of the two. A
 * result WITHOUT a receipt is an older row written before the read-back existed;
 * it still carries the export job's own numbers, which is what this accessor has
 * always returned, so it is not rejected. Callers that need the verified card
 * read `result.dimension_receipt`.
 */
export function projectDesignExportDimensions(result: unknown):
  { source: "design_export_result"; width: number; height: number; format: string; designId: string; revision: number } | null {
  const parsed = designExportResultSchema.safeParse(result);
  if (!parsed.success) return null;
  const receipt = parseExportDimensionReceipt(parsed.data.dimension_receipt);
  if (parsed.data.dimension_receipt !== undefined && !receipt) return null;
  if (receipt?.actualExportSize
    && (receipt.actualExportSize.width !== parsed.data.width || receipt.actualExportSize.height !== parsed.data.height)) return null;
  return { source: "design_export_result", width: parsed.data.width, height: parsed.data.height,
    format: parsed.data.format, designId: parsed.data.design_id, revision: parsed.data.revision };
}
