import { z } from "zod";

import {
  captureImageProposalSources,
  resolveCanvasImageProposalSources,
} from "./image-proposal-sources.js";
import type { AvailableVideoModel } from "../generation/providers/registry.js";
import {
  MastraVideoPreflightError,
  type MastraVideoJobContext,
  type MastraVideoJobInput,
  type MastraVideoJobSubmitter,
} from "./mastra-video-jobs.js";
import { createAgentTool, runContextOf, toolAbortSignalOf } from "./tools/tool-run-context.js";

const sourceAssetIdsSchema = z.array(z.string().uuid()).min(1).max(7);
const videoInputSchema = z.object({
  title: z.string().trim().min(1).max(500),
  prompt: z.string().trim().min(1).max(20_000),
  model: z.string().trim().min(1).max(300).optional(),
  duration: z.number().int().min(3).max(60).optional(),
  resolution: z.enum(["720p", "1080p", "4k"]).optional(),
  // The APIYI adapter coerces any other ratio to 16:9, so a free string could
  // silently return the wrong aspect ratio for a paid job.
  aspectRatio: z.enum(["16:9", "9:16"]).optional(),
  enableAudio: z.boolean().optional(),
  sourceAssetIds: sourceAssetIdsSchema.optional(),
}).strict();

type VideoToolRunContext = {
  user_id?: unknown; access_token?: unknown; workspace_id?: unknown;
  session_id?: unknown; canvas_id?: unknown; run_id?: unknown;
  user_attachment_map?: unknown;
};

function contextFromToolContext(context: unknown): MastraVideoJobContext | null {
  const runContext = runContextOf(context) as VideoToolRunContext;
  const values = {
    userId: runContext.user_id, accessToken: runContext.access_token,
    workspaceId: runContext.workspace_id, sessionId: runContext.session_id,
    canvasId: runContext.canvas_id, runId: runContext.run_id,
  };
  const signal = toolAbortSignalOf(context);
  if (!Object.values(values).every(value => typeof value === "string" && value.length > 0)
    || !signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function") return null;
  return { ...(values as Omit<MastraVideoJobContext, "signal">), signal };
}

export type MastraVideoToolDependencies = {
  createUserClient: (accessToken: string) => any;
  submitter: MastraVideoJobSubmitter;
  /** Current workspace-published aliases only; no registry/environment fallback. */
  availableVideoModels: readonly AvailableVideoModel[];
};

type UnknownSubmissionReceipt = { status: "unknown"; error: "video_submission_unknown"; summary: string };

function resolutionRank(value: "720p" | "1080p" | "4k" | "480p" | "2160p") {
  return ({ "480p": 0, "720p": 1, "1080p": 2, "4k": 3, "2160p": 3 })[value];
}

function validateModel(input: z.infer<typeof videoInputSchema>, models: readonly AvailableVideoModel[]) {
  if (!models.length) return { ok: false as const, code: "video_model_unavailable", summary: "当前工作区没有已发布的视频模型，未提交视频生成。" };
  const model = input.model
    ? models.find(candidate => candidate.id === input.model)
    : models.length === 1 ? models[0] : undefined;
  if (!model || !model.id.startsWith("workspace:"))
    return { ok: false as const, code: "video_model_required", summary: "请选择当前工作区已发布的视频模型，未提交视频生成。" };
  if (!input.sourceAssetIds?.length && !model.capabilities.textToVideo)
    return { ok: false as const, code: "video_text_to_video_unsupported", summary: "所选模型不支持纯文字视频生成，未提交。" };
  if (input.sourceAssetIds?.length && !model.capabilities.imageToVideo)
    return { ok: false as const, code: "video_image_to_video_unsupported", summary: "所选模型不支持参考图生成视频，未提交。" };
  if (input.sourceAssetIds && input.sourceAssetIds.length > model.limits.maxInputImages)
    return { ok: false as const, code: "video_reference_limit_exceeded", summary: "参考图数量超过所选模型上限，未提交。" };
  if (input.duration && (input.duration > model.limits.maxDuration
    || (model.limits.allowedDurations && !model.limits.allowedDurations.includes(input.duration))))
    return { ok: false as const, code: "video_duration_unsupported", summary: "所选模型不支持该视频时长，未提交。" };
  if (input.resolution && resolutionRank(input.resolution) > resolutionRank(model.limits.maxResolution))
    return { ok: false as const, code: "video_resolution_unsupported", summary: "所选模型不支持该视频分辨率，未提交。" };
  if (input.enableAudio && !model.capabilities.audio)
    return { ok: false as const, code: "video_audio_unsupported", summary: "所选模型不支持音频生成，未提交。" };
  return { ok: true as const, model };
}

/**
 * Direct Mastra video submission. URLs, legacy task delegation and approval
 * identity are intentionally absent: sources must be owned asset IDs resolved
 * against the authenticated current canvas before the durable submitter sees them.
 */
export function createMastraVideoTool(deps: MastraVideoToolDependencies) {
  // A thrown submitter call may have persisted/enqueued a job before a poll or
  // transport read failed. Keep one receipt per run-bound tool instance so a
  // changed model prompt cannot spend again in the same run.
  let unknownReceipt: UnknownSubmissionReceipt | undefined;
  return createAgentTool({
    id: "generate_video",
    description: "Submit a video from text or 1–7 explicit authenticated sourceAssetIds. Obtain IDs from current attachments or current canvas inspection; never use URLs. Choose only a currently published workspace model. processing means queued/running, not completed.",
    inputSchema: videoInputSchema,
    execute: async (input, context) => {
    if (unknownReceipt) return unknownReceipt;
    const jobContext = contextFromToolContext(context);
    if (!jobContext) return { status: "failed" as const, error: "video_context_unavailable",
      summary: "当前视频任务缺少经过认证的运行上下文，未提交生成。" };
    if (jobContext.signal.aborted) return { status: "failed" as const, error: "video_submission_canceled",
      summary: "本轮已取消，未提交视频生成。" };
    const selected = validateModel(input, deps.availableVideoModels);
    if (!selected.ok) return { status: "failed" as const, error: selected.code, summary: selected.summary };
    const sourceAssetIds = input.sourceAssetIds ?? [];
    let attachmentMap = (runContextOf(context) as VideoToolRunContext).user_attachment_map as Record<string, string> | undefined;
    const unresolved = sourceAssetIds.filter(reference => !captureImageProposalSources([reference], attachmentMap));
    if (unresolved.length) {
      try {
        const resolved = await resolveCanvasImageProposalSources({
          client: deps.createUserClient(jobContext.accessToken), canvasId: jobContext.canvasId, references: unresolved,
        });
        if (Object.keys(resolved).length !== new Set(unresolved).size) throw new Error("canvas_reference_not_found");
        attachmentMap = { ...(attachmentMap ?? {}), ...resolved };
      } catch {
        return { status: "failed" as const, error: "invalid_video_reference",
          summary: "参考图必须是本轮认证附件或当前画布的存活 assetId；不能传 URL 或历史链接。未提交视频生成。" };
      }
    }
    const sources = captureImageProposalSources(sourceAssetIds, attachmentMap);
    if (sourceAssetIds.length && (!sources || sources.length !== sourceAssetIds.length))
      return { status: "failed" as const, error: "invalid_video_reference", summary: "参考图来源无法绑定到当前认证资产，未提交视频生成。" };
    const inputImages = sources?.map(source => attachmentMap?.[source.assetId]);
    if (inputImages && !inputImages.every((value): value is string => typeof value === "string"))
      return { status: "failed" as const, error: "invalid_video_reference", summary: "参考图来源无法绑定到当前认证资产，未提交视频生成。" };
    const submission: MastraVideoJobInput = {
      title: input.title, prompt: input.prompt, model: selected.model.id,
      ...(input.duration !== undefined ? { duration: input.duration } : {}),
      ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
      ...(input.aspectRatio !== undefined ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.enableAudio !== undefined ? { enableAudio: input.enableAudio } : {}),
      ...(inputImages?.length ? { inputImages } : {}),
    };
    try {
      const result = await deps.submitter.submit(jobContext, submission);
      return { ...result, status: result.error ? "failed" as const : result.status ?? "processing" as const,
        jobType: "video_generation" as const, ...(sources ? { sourceAssetIds: sources.map(source => source.assetId) } : {}),
        summary: result.error ? "视频任务未完成；未自动重试或创建新任务。"
          : result.status === "succeeded" ? "视频任务已由服务端完成。"
          : "视频任务已提交或正在处理；请使用返回的 jobId 查询结果，不要重复提交。" };
    } catch (error) {
      if (error instanceof MastraVideoPreflightError) {
        return { status: "failed" as const, error: error.code, summary: error.summary };
      }
      const diagnostic = error as { name?: string; code?: string; stack?: string };
      console.warn("[mastra-video-submit]", {
        name: diagnostic.name,
        code: typeof diagnostic.code === "string" && /^[a-z_]+$/.test(diagnostic.code) ? diagnostic.code : "unknown",
        frames: diagnostic.stack?.split("\n").slice(1, 4).map(line => line.replace(/https?:\/\/[^\s)]+/g, "[url]")),
      });
      unknownReceipt = { status: "unknown", error: "video_submission_unknown",
        summary: "视频提交状态未知，可能已创建持久任务；本轮不会再次提交。即使暂未查到任务，也不能据此重新提交。" };
      return unknownReceipt;
    }
    },
  });
}
