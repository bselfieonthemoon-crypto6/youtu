import sharp from "sharp";
import { z } from "zod";

import type { PromptLibraryService } from "../features/prompt-library/prompt-library-service.js";
import { safeDownload, validateDownloadedBuffer } from "../security/safe-download.js";
import { analyzeAgentVisionAttachments } from "./attachment-vision-analyzer.js";
import type { WorkspaceVisionModel } from "./workspace-vision-model.js";

export const MAX_REVIEW_IMAGES = 4;
export const MAX_REVIEW_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_REVIEW_TOTAL_BYTES = 24 * 1024 * 1024;
export const MAX_REVIEW_MODEL_BYTES = 2 * 1024 * 1024;
export const IMAGE_REVIEW_TIMEOUT_MS = 20_000;

const allowedImageMimes = [
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "image/avif", "image/bmp", "image/tiff",
];

type UserAssetClient = {
  from: (table: string) => any;
  storage: { from: (bucket: string) => any };
};

export type TaskImageJobIdentity = {
  /** Exact job from a server-owned delivered-result task marker. */
  deliveredResultJobId?: string;
  runId: string;
  sessionId: string;
  canvasId: string;
  sourceElementId: string;
  sourceAssetId: string;
};

export type ResolvedTaskImageJob = {
  jobId: string;
  assetIds: string[];
};

export type ReviewImage = {
  id: string;
  source: "workspace_asset" | "prompt_library" | "canvas_screenshot";
  role: "result" | "reference";
  mimeType: string;
  buffer: Buffer;
  label?: string;
};

export type ImageReviewStatus = "passed" | "failed" | "unavailable";
function hasContradictoryBlocker(issues: string[]): boolean {
  return issues.some(issue => /符合|准确|正确|\bpass(?:ed)?\b|\bcorrect\b/i.test(issue)
    && !/未|不|缺|错|问题|干扰|裁|遮|越界|多余|额外|但|然而|偏|\bnot\b|\bfail|\bmissing\b|\bextra\b/i.test(issue));
}
export type ImagePixelReview = {
  status: ImageReviewStatus;
  viewed: boolean;
  blockingIssues: string[];
  suggestions: string[];
  uncertainties: string[];
  summary: string;
  error?: string;
};

export async function runWithImageReviewDeadline<T>(
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = IMAGE_REVIEW_TIMEOUT_MS,
): Promise<T> {
  const deadline = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline.signal]) : deadline.signal;
  if (signal.aborted) throw new Error("image_review_canceled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        deadline.abort();
        reject(new Error("image_review_timeout"));
      }, timeoutMs);
    });
    return await Promise.race([operation(signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function assertImageReviewActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("image_review_timeout");
}

const reviewResponseSchema = z.object({
  blockingIssues: z.array(z.string().trim().min(1).max(500)).max(10),
  suggestions: z.array(z.string().trim().min(1).max(500)).max(10),
  uncertainties: z.array(z.string().trim().min(1).max(500)).max(10),
}).strict();

export function parseImagePixelReview(text: string) {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return reviewResponseSchema.parse(JSON.parse(normalized));
}

/**
 * Read immutable image assets only through the caller's RLS-bound client and
 * an explicit workspace predicate. Signed/public URLs are deliberately not
 * accepted: storage bytes must match the authorized asset row.
 */
export async function resolveWorkspaceReviewImage(input: {
  client: UserAssetClient;
  workspaceId: string;
  assetId: string;
  role: ReviewImage["role"];
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<ReviewImage> {
  assertImageReviewActive(input.signal);
  const maxBytes = Math.min(input.maxBytes ?? MAX_REVIEW_IMAGE_BYTES, MAX_REVIEW_IMAGE_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("review_total_size_exceeded");
  const query = input.client.from("asset_objects")
    .select("id,bucket,object_path,mime_type,byte_size,workspace_id,deletion_pending_at")
    .eq("id", input.assetId)
    .eq("workspace_id", input.workspaceId)
    .is("deletion_pending_at", null);
  const { data: asset, error } = await query.single();
  assertImageReviewActive(input.signal);
  if (error || !asset || asset.workspace_id !== input.workspaceId) throw new Error("review_asset_not_authorized");
  // Fail closed when the stored size is unknown: downloading first could read an
  // unbounded object into memory before the post-download check runs.
  if (!Number.isSafeInteger(asset.byte_size) || (asset.byte_size as number) < 0)
    throw new Error("review_asset_size_unknown");
  if ((asset.byte_size as number) > maxBytes)
    throw new Error("review_asset_too_large");
  const { data, error: downloadError } = await input.client.storage.from(asset.bucket).download(asset.object_path);
  assertImageReviewActive(input.signal);
  if (downloadError || !data) throw new Error("review_asset_download_failed");
  if (data.size > maxBytes) throw new Error("review_asset_too_large");
  const buffer = Buffer.from(await data.arrayBuffer());
  const mimeType = asset.mime_type || data.type || "application/octet-stream";
  validateDownloadedBuffer(buffer, {
    kind: "image", maxBytes,
    allowedMimeTypes: allowedImageMimes, mimeType,
  });
  return { id: input.assetId, source: "workspace_asset", role: input.role, mimeType, buffer };
}

/**
 * Recover the immutable result identity for an asynchronous standalone-image
 * task. The lookup stays behind the caller's RLS client and binds every
 * server-authored source field, so a model cannot nominate an unrelated job
 * or turn the original source image into a generated result.
 */
export async function resolveTaskImageJobResult(input: {
  client: UserAssetClient;
  workspaceId: string;
  jobId: string;
  task: TaskImageJobIdentity;
  signal?: AbortSignal;
}): Promise<ResolvedTaskImageJob> {
  assertImageReviewActive(input.signal);
  const { data: job, error } = await input.client.from("background_jobs")
    .select("id,status,job_type,workspace_id,session_id,canvas_id,payload,result")
    .eq("id", input.jobId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  assertImageReviewActive(input.signal);
  if (error || !job || job.id !== input.jobId || job.workspace_id !== input.workspaceId)
    throw new Error("review_job_not_authorized");
  if (job.status !== "succeeded") throw new Error("review_job_not_succeeded");
  if (job.job_type !== "image_generation") throw new Error("review_job_type_invalid");
  if (job.session_id !== input.task.sessionId || job.canvas_id !== input.task.canvasId)
    throw new Error("review_job_task_mismatch");
  const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
    ? job.payload as Record<string, unknown> : {};
  const result = job.result && typeof job.result === "object" && !Array.isArray(job.result)
    ? job.result as Record<string, unknown> : {};
  const deliveredResult = input.task.deliveredResultJobId === job.id
    && result.canvas_element_id === input.task.sourceElementId
    && result.asset_id === input.task.sourceAssetId && typeof result.canvas_finalized_at === "string";
  if (!deliveredResult && (payload.origin_run_id !== input.task.runId
    || payload.source_element_id !== input.task.sourceElementId
    || payload.source_asset_id !== input.task.sourceAssetId))
    throw new Error("review_job_task_mismatch");
  const parsedAsset = z.string().uuid().safeParse(result.asset_id);
  if (!parsedAsset.success) throw new Error("review_job_result_invalid");
  if (!deliveredResult && parsedAsset.data === input.task.sourceAssetId) throw new Error("review_job_result_is_source");
  return { jobId: input.jobId, assetIds: [parsedAsset.data] };
}

/** Resolve only URLs declared by the bundled reviewed catalog entry. */
export async function resolvePromptLibraryReviewImages(input: {
  service: PromptLibraryService;
  caseIds: string[];
  limit: number;
  maxTotalBytes?: number;
  signal?: AbortSignal;
}): Promise<ReviewImage[]> {
  const output: ReviewImage[] = [];
  let remainingBytes = Math.min(input.maxTotalBytes ?? MAX_REVIEW_TOTAL_BYTES, MAX_REVIEW_TOTAL_BYTES);
  for (const caseId of input.caseIds) {
    assertImageReviewActive(input.signal);
    const entry = await input.service.getById(caseId);
    assertImageReviewActive(input.signal);
    if (!entry) throw new Error("review_case_not_found");
    const urls = [...new Set(entry.item.previewImageUrls?.length
      ? entry.item.previewImageUrls
      : entry.item.imageUrl ? [entry.item.imageUrl] : [])];
    if (!urls.length) throw new Error("review_case_has_no_image");
    if (output.length >= input.limit) throw new Error("review_case_limit_exceeded");
    if (remainingBytes <= 0) throw new Error("review_total_size_exceeded");
    // One representative preview per explicitly requested case. Otherwise a
    // gallery-heavy first case could silently crowd out later requested cases.
    const url = urls[0]!;
    const host = new URL(url).hostname;
    const downloaded = await safeDownload(url, {
      kind: "image", maxBytes: Math.min(MAX_REVIEW_IMAGE_BYTES, remainingBytes),
      timeoutMs: 8_000, maxRedirects: 0, allowedHosts: [host],
      allowedMimeTypes: allowedImageMimes,
    });
    assertImageReviewActive(input.signal);
    output.push({
      id: `${caseId}:1`, source: "prompt_library", role: "reference",
      mimeType: downloaded.mimeType, buffer: downloaded.buffer,
      label: `catalog_case=${caseId} title=${entry.item.title}`,
    });
    remainingBytes -= downloaded.buffer.byteLength;
  }
  return output;
}

export async function resolveCanvasScreenshotReviewImage(dataUri: string): Promise<ReviewImage> {
  const downloaded = await safeDownload(dataUri, {
    kind: "image", maxBytes: MAX_REVIEW_IMAGE_BYTES, allowDataUri: true,
    allowedMimeTypes: allowedImageMimes,
  });
  return {
    id: "current-canvas-screenshot", source: "canvas_screenshot", role: "result",
    mimeType: downloaded.mimeType, buffer: downloaded.buffer,
  };
}

export async function reviewImagePixels(input: {
  images: ReviewImage[];
  model: WorkspaceVisionModel;
  taskBrief: unknown;
  mode: "result_verification" | "reference_analysis" | "canvas_verification";
  comparison: "individual" | "series" | "before_after";
  signal?: AbortSignal;
}): Promise<ImagePixelReview> {
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = (async (): Promise<ImagePixelReview> => {
      if (!input.images.length || input.images.length > MAX_REVIEW_IMAGES) throw new Error("review_image_count_invalid");
      const totalBytes = input.images.reduce((sum, image) => sum + image.buffer.byteLength, 0);
      if (input.images.some(image => image.buffer.byteLength > MAX_REVIEW_IMAGE_BYTES)
        || totalBytes > MAX_REVIEW_TOTAL_BYTES) throw new Error("review_images_too_large");
      const optimized = await Promise.all(input.images.map(async image => {
        const metadata = await sharp(image.buffer, { animated: false }).metadata();
        const buffer = await sharp(image.buffer, { animated: false }).rotate().resize({
          width: 1024, height: 1024, fit: "inside", withoutEnlargement: true,
        }).webp({ effort: 3, quality: 78 }).toBuffer();
        if (buffer.byteLength > MAX_REVIEW_MODEL_BYTES) throw new Error("review_model_image_too_large");
        // `.rotate()` applies EXIF orientation, so the pre-rotation metadata
        // dimensions are swapped for orientations 5-8.
        const swaps = typeof metadata.orientation === "number"
          && metadata.orientation >= 5 && metadata.orientation <= 8;
        return { ...image, mimeType: "image/webp", buffer,
          originalWidth: swaps ? metadata.height : metadata.width,
          originalHeight: swaps ? metadata.width : metadata.height };
      }));
      const signal = input.signal
        ? AbortSignal.any([input.signal, deadline.signal])
        : deadline.signal;
      const analyze = (reviewContractCorrection?: string) => analyzeAgentVisionAttachments({
        model: input.model,
        purpose: input.mode === "reference_analysis" ? "reference_observation" : "image_verification",
        prompt: JSON.stringify({
          mode: input.mode, comparison: input.comparison,
          // The parent agent owns task completion. A batch observer receives
          // pixels, not global acceptance criteria for images it cannot see.
          ...(input.mode === "reference_analysis" ? {} : { taskBrief: input.taskBrief }),
          ...(input.mode === "reference_analysis" ? { reviewScope: {
            kind: "reference_batch", assetIds: optimized.map(image => image.id), count: optimized.length,
            completeness: "Only this batch is in scope. Other requested images may be in other batches; do not report their absence as a blocker or uncertainty. Do not claim the full request was covered.",
          } } : {}),
          ...(reviewContractCorrection ? { reviewContractCorrection } : {}),
          dimensionEvidence: "originalWidth/originalHeight are server-read original file pixels, not visual guesses. Use them to check requested aspect ratio; do not claim dimensions cannot be checked when these values are present.",
          sources: optimized.map(image => ({ id: image.id, source: image.source, role: image.role, label: image.label, originalWidth: image.originalWidth, originalHeight: image.originalHeight })),
        }),
        images: optimized.map(image => ({
          assetId: image.id,
          ...(image.label ? { name: image.label } : {}),
          dataUri: `data:${image.mimeType};base64,${image.buffer.toString("base64")}`,
        })),
        signal,
      });
      let parsed = parseImagePixelReview(await analyze());
      if (hasContradictoryBlocker(parsed.blockingIssues)) {
        // Recheck the same pixels once, within the original deadline. Never
        // silently turn a contradictory model verdict into an approved image.
        parsed = parseImagePixelReview(await analyze("上一轮把符合要求的通过项列进了blockingIssues，输出自相矛盾。请重新查看同一图片，blockingIssues只列实际违反要求的问题；全部符合则返回空数组，不要列通过清单。"));
        if (hasContradictoryBlocker(parsed.blockingIssues)) throw new Error("image_review_contradictory_verdict");
      }
      const status: ImageReviewStatus = parsed.blockingIssues.length ? "failed"
        : parsed.uncertainties.length ? "unavailable" : "passed";
      return {
        status, viewed: true, ...parsed,
        summary: input.mode === "reference_analysis"
          ? (status === "passed" ? "已查看本批参考图像素；本回执不代表全部参考图或生成结果已验收。" : "已查看本批参考图像素，存在本批需要说明的问题；不代表其他批次缺失。")
          : status === "passed" ? "已查看实际像素，未发现违背当前明确要求的客观问题。"
          : status === "failed" ? "已查看实际像素，发现违背当前明确要求的客观问题。"
            : "已查看实际像素，但存在无法确认项，不能声称视觉验收通过。",
      };
    })();
    const timedOut = new Promise<ImagePixelReview>((_resolve, reject) => {
      timer = setTimeout(() => {
        deadline.abort();
        reject(new Error("image_review_timeout"));
      }, IMAGE_REVIEW_TIMEOUT_MS);
    });
    return await Promise.race([operation, timedOut]);
  } catch (error) {
    return {
      status: "unavailable", viewed: false, blockingIssues: [], suggestions: [], uncertainties: [],
      error: error instanceof Error ? error.message : "image_review_unavailable",
      summary: "未能完成实际像素查看，不能声称视觉验收通过。",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
