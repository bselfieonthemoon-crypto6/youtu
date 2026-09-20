import { designExportResultSchema } from "@loomic/shared";

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
  "Export size is a separate question: a generation job receipt cannot answer it, and neither ①requested ②source pixels nor ③canvas frame may be substituted for it. An export artifact's real pixel size exists only on the succeeded design_export job's own result (background_jobs.result.width/height, validated by designExportResultSchema), because the export re-renders the board at payload.multiplier × the design's own width/height. No export job in scope means the export size is unknown, not equal to any other size here.";

/** ③ CANVAS FRAME — the canvas element carries the display frame, never pixels. */
export const CANVAS_FRAME_AUTHORITY =
  "The canvas element's width/height is the CANVAS DISPLAY FRAME of one placement, not the image's pixels: the same PNG can sit in several differently sized frames on one board, and Excalidraw resizes them on paste. It is never evidence of an image's real pixels.";

/** The one sentence that keeps the four apart on a job receipt. */
export const JOB_RECEIPT_SIZE_NOTE = `Sizes at a glance: image_requested_frame = ① what the user asked for (authenticated submission: aspect ratio + resolution tier, not pixels, surfaced here as requestedFrame); image_source_pixels = ② the AI image's real pixel size, returned by this job and authoritative (sourcePixelWidth/sourcePixelHeight); image_canvas_frame = ③ the display frame of THIS canvas element (the join key is canvasElementId) — a frame, never the image's pixels; image_export_size = ④ not produced by this job. ${EXPORT_SIZE_AUTHORITY}`;

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
 * ④ EXPORT — read a design export artifact's real size from its own job result.
 *
 * Exported so the export question has one named answer instead of the image
 * surfaces inventing a fallback: the schema is the same one
 * `createDesignExportExecutor` persisted through `markSucceeded`, so this reads
 * what the worker actually wrote and rejects anything else (including a
 * generation result, which has an `asset_id` and no `format`).
 */
export function projectDesignExportDimensions(result: unknown):
  { source: "design_export_result"; width: number; height: number; format: string; designId: string; revision: number } | null {
  const parsed = designExportResultSchema.safeParse(result);
  return parsed.success
    ? { source: "design_export_result", width: parsed.data.width, height: parsed.data.height,
        format: parsed.data.format, designId: parsed.data.design_id, revision: parsed.data.revision }
    : null;
}
