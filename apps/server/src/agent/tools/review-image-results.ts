import { z } from "zod";

import type { PromptLibraryService } from "../../features/prompt-library/prompt-library-service.js";
import type { AgentTaskService } from "../../features/agent-tasks/agent-task-service.js";
import { agentWorkflowSnapshotSchema } from "../../features/agent-tasks/agent-workflow.js";
import { canvasResultReviewJobId } from "../../features/agent-tasks/canvas-result-review.js";
import type { WorkspaceVisionModel } from "../workspace-vision-model.js";
import { createAgentTool, runContextOf, toolAbortSignalOf } from "./tool-run-context.js";
import {
  MAX_REVIEW_IMAGES,
  MAX_REVIEW_IMAGE_BYTES,
  MAX_REVIEW_TOTAL_BYTES,
  assertImageReviewActive,
  resolvePromptLibraryReviewImages,
  resolveTaskImageJobResult,
  resolveWorkspaceReviewImage,
  reviewImagePixels,
  runWithImageReviewDeadline,
} from "../image-result-verification.js";

const reviewImageResultsSchema = z.object({
  mode: z.enum(["result_verification", "reference_analysis"]).default("result_verification"),
  job_id: z.string().uuid().optional(),
  result_asset_ids: z.array(z.string().uuid()).max(MAX_REVIEW_IMAGES).default([]),
  prompt_library_case_ids: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/)).max(MAX_REVIEW_IMAGES).default([]),
  comparison: z.enum(["individual", "series", "before_after"]).default("individual"),
}).strict().superRefine((value, context) => {
  const resultCount = value.result_asset_ids.length || (value.job_id ? 1 : 0);
  if (!value.job_id && !value.result_asset_ids.length && !value.prompt_library_case_ids.length)
    context.addIssue({ code: "custom", message: "At least one authorized image source is required." });
  if (resultCount + value.prompt_library_case_ids.length > MAX_REVIEW_IMAGES)
    context.addIssue({ code: "custom", message: `At most ${MAX_REVIEW_IMAGES} images may be requested.` });
  if (value.mode === "result_verification" && !value.job_id && !value.result_asset_ids.length)
    context.addIssue({ code: "custom", message: "Result verification requires a result job or at least one result asset." });
  if (value.mode === "reference_analysis" && value.job_id)
    context.addIssue({ code: "custom", message: "A result job may only be used for result verification." });
});

// Local structural shape for the retired legacy durable task runtime. Mastra
// never supplies `task`; this keeps the legacy-only recovery branch compiling
// without importing the deleted design-task-tools module.
type DesignTaskRuntime = {
  phase: string;
  workflowStepId?: string | null;
  requiresDesignVerification?: boolean;
  latestImageResult?: { jobId: string; assetIds: string[] };
  readResultSnapshot?: () => Promise<any>;
  snapshot: any;
  service: AgentTaskService;
};

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const expected = [...right].sort();
  return [...left].sort().every((id, index) => id === expected[index]);
}

function trustedBrief(currentUserPrompt: string | undefined, brief: Record<string, unknown> | null | undefined) {
  const { verification: _oldDesignReview, imageVerification: _oldImageReview, ...requirements } = brief ?? {};
  return { currentUserPrompt: currentUserPrompt ?? "", taskRequirements: requirements };
}

export function createReviewImageResultsTool(deps: {
  createUserClient: (accessToken: string) => any;
  model: WorkspaceVisionModel;
  currentUserPrompt?: string;
  promptLibraryService?: PromptLibraryService;
  task?: DesignTaskRuntime;
  resultReviewScope?: { jobId: string; assetIds: string[] };
}) {
  return createAgentTool({
    id: "review_image_results",
    description: "Read and inspect the actual pixels of up to four authorized images. Use mode=reference_analysis when examining an existing image as the source for a future edit or related design; do not judge that source against changes that have not been generated yet. Use result_verification only to assess an actual generated result against its applicable requirements. A job_id can recover a succeeded standalone-image result only when its RLS-visible persisted workspace, session, canvas, origin run and source identity all match the current task. result_asset_ids are resolved only through current-workspace storage; prompt_library_case_ids are read-only catalog references, never generation inputs. Acceptance is recorded only for the exact authenticated job result. Reports passed, failed, or unavailable truthfully. This tool never generates, retries, inserts, or charges for an image.",
    inputSchema: reviewImageResultsSchema,
    execute: async (input, toolContext) => {
    const context = runContextOf(toolContext);
    const accessToken = typeof context?.access_token === "string" ? context.access_token : "";
    const workspaceId = typeof context?.workspace_id === "string" ? context.workspace_id : "";
    if (!accessToken || !workspaceId) return {
      status: "unavailable" as const, viewed: false, error: "review_auth_context_missing",
      summary: "缺少当前工作区的认证上下文，未查看图片像素。",
    };

    try {
    return await runWithImageReviewDeadline(toolAbortSignalOf(toolContext), async reviewSignal => {
    const preparedRead = deps.task?.phase === "prepared" && !!deps.task.readResultSnapshot;
    const current = preparedRead ? await deps.task!.readResultSnapshot!()
      : deps.task ? await deps.task.service.assertCurrentRun(deps.task.snapshot.runId) : null;
    assertImageReviewActive(reviewSignal);
    if (deps.task && !current) return {
      status: "unavailable" as const, viewed: false, error: "review_task_superseded",
      summary: "当前任务已失效，未查看图片像素。",
    };
    let expected = deps.task?.snapshot.target.kind === "canvas_image"
      ? deps.task.latestImageResult : undefined;
    let resultAssetIds = input.result_asset_ids;
    const persistedResult = current?.target.kind === "canvas_image" ? current.brief?.imageResult : undefined;
    const persistedJobId = persistedResult && typeof persistedResult === "object" && !Array.isArray(persistedResult)
      ? (persistedResult as Record<string, unknown>).jobId : undefined;
    const scope = input.mode === "result_verification" ? deps.resultReviewScope : undefined;
    const scopedWorkflow = agentWorkflowSnapshotSchema.safeParse(current?.brief?.agentWorkflow);
    const scopedBatchResult = !!scope && !!current && scopedWorkflow.success && scopedWorkflow.data.taskId === current.id
      && scopedWorkflow.data.taskRevision === current.revision && scopedWorkflow.data.steps.some(step => step.jobs.includes(scope.jobId));
    if (scope && ((input.job_id && input.job_id !== scope.jobId) ||
      (resultAssetIds.length && !sameIds(resultAssetIds, scope.assetIds)))) return {
      status: "unavailable" as const, viewed: false, error: "review_continuation_scope_mismatch",
      summary: "请求结果不属于本次服务器接续事件。",
    };
    const requestedJobId = input.job_id ?? scope?.jobId;
    if (input.mode === "result_verification" && persistedResult !== undefined
      && (typeof persistedJobId !== "string" || !z.string().uuid().safeParse(persistedJobId).success)) return {
      status: "unavailable" as const, viewed: false, error: "review_current_result_invalid",
      summary: "当前任务的持久化结果身份无效，未查看像素。",
    };
    if (requestedJobId) {
      if (!deps.task || !current || current.target.kind !== "canvas_image") return {
        status: "unavailable" as const, viewed: false, error: "review_job_requires_image_task",
        summary: "任务结果只能在当前绑定的独立图片任务中按 job_id 恢复核验。",
      };
      // A task can submit more than one image job over its lifetime. The
      // server-authored persisted marker is authoritative across processes;
      // process-local latestImageResult is only a fallback when that marker is
      // absent. Never let an older job from the same run replace either.
      const currentJobId = typeof persistedJobId === "string" ? persistedJobId : expected?.jobId;
      if (currentJobId && requestedJobId !== currentJobId && !scopedBatchResult) return {
        status: "unavailable" as const, viewed: false, error: "review_job_not_current",
        summary: "请求的 job 不是当前任务最新持久化图片结果，未查看像素。",
      };
      const client = deps.createUserClient(accessToken);
      const recovered = await resolveTaskImageJobResult({
        client, workspaceId, jobId: requestedJobId,
        task: {
          runId: current.runId, sessionId: current.sessionId, canvasId: current.canvasId,
          sourceElementId: current.target.elementId, sourceAssetId: current.target.assetId,
          ...(canvasResultReviewJobId(current) ? { deliveredResultJobId: canvasResultReviewJobId(current)! } : {}),
        },
        signal: reviewSignal,
      });
      assertImageReviewActive(reviewSignal);
      if (resultAssetIds.length && !sameIds(resultAssetIds, recovered.assetIds)) return {
        status: "unavailable" as const, viewed: false, error: "review_job_asset_mismatch",
        summary: "请求的图片与该任务的持久化成功结果不一致，未查看像素。",
      };
      resultAssetIds = recovered.assetIds;
      if (scope && !sameIds(resultAssetIds, scope.assetIds)) throw new Error("review_continuation_asset_changed");
      expected = recovered;
      deps.task.latestImageResult = recovered;
      deps.task.requiresDesignVerification = true;
    }
    if (input.mode === "result_verification" && typeof persistedJobId === "string"
      && expected?.jobId !== persistedJobId && !scopedBatchResult) return {
      status: "unavailable" as const, viewed: false, error: "review_job_not_current",
      summary: "当前进程中的图片结果已落后于持久化任务记录，请使用当前 job_id 恢复核验。",
    };
    const canPersistTaskAcceptance = input.mode === "result_verification" && !!expected
      && sameIds(resultAssetIds, expected.assetIds);
    if (input.mode === "result_verification" && deps.task?.snapshot.target.kind === "canvas_image"
      && !canPersistTaskAcceptance) return {
      status: "unavailable" as const, viewed: false, error: expected ? "review_result_identity_mismatch" : "review_result_not_ready",
      summary: expected
        ? "请求的图片不是当前任务最新成功结果，未写入任务验收。"
        : "当前图片任务尚无可核验的成功结果；不会自动重发或生成图片。",
    };

    const client = deps.createUserClient(accessToken);
    const { resultImages, referenceImages } = await (async () => {
      const resultImages = [] as Awaited<ReturnType<typeof resolveWorkspaceReviewImage>>[];
      let remainingBytes = MAX_REVIEW_TOTAL_BYTES;
      for (const assetId of resultAssetIds) {
        const image = await resolveWorkspaceReviewImage({
          client, workspaceId, assetId, role: "result",
          maxBytes: Math.min(MAX_REVIEW_IMAGE_BYTES, remainingBytes),
          signal: reviewSignal,
        });
        assertImageReviewActive(reviewSignal);
        resultImages.push(image);
        remainingBytes -= image.buffer.byteLength;
      }
      const remaining = MAX_REVIEW_IMAGES - resultImages.length;
      let referenceImages = [] as Awaited<ReturnType<typeof resolvePromptLibraryReviewImages>>;
      if (input.prompt_library_case_ids.length) {
        if (!deps.promptLibraryService) throw new Error("review_prompt_library_unavailable");
        referenceImages = await resolvePromptLibraryReviewImages({
          service: deps.promptLibraryService, caseIds: input.prompt_library_case_ids, limit: remaining,
          maxTotalBytes: remainingBytes, signal: reviewSignal,
        });
      }
      return { resultImages, referenceImages };
    })();
    assertImageReviewActive(reviewSignal);
    const brief = trustedBrief(deps.currentUserPrompt, current?.brief);
    const result = await reviewImagePixels({
      images: [...resultImages, ...referenceImages], model: deps.model,
      taskBrief: brief, mode: input.mode, comparison: input.comparison, signal: reviewSignal,
    });
    assertImageReviewActive(reviewSignal);
    const reviewed = [...resultImages, ...referenceImages].map(image => ({
      id: image.id, source: image.source, role: image.role,
    }));
    const isLatestResult = typeof persistedJobId !== "string" || expected?.jobId === persistedJobId;
    if (preparedRead) {
      const latest = await deps.task!.readResultSnapshot!();
      if (!latest || latest.id !== current?.id || latest.revision !== current?.revision
        || (latest.brief?.imageResult as { jobId?: string } | undefined)?.jobId !== persistedJobId)
        throw new Error("review_result_changed");
    }
    if (!preparedRead && canPersistTaskAcceptance && isLatestResult && current?.brief && expected) {
      const latest = await deps.task!.service.assertCurrentRun(deps.task!.snapshot.runId);
      assertImageReviewActive(reviewSignal);
      const currentExpected = deps.task!.latestImageResult;
      if (!latest || latest.revision !== current.revision || !currentExpected
        || ((latest.brief?.imageResult as { jobId?: string } | undefined)?.jobId !== undefined &&
          (latest.brief?.imageResult as { jobId?: string }).jobId !== expected.jobId)
        || currentExpected.jobId !== expected.jobId || !sameIds(currentExpected.assetIds, expected.assetIds))
        return { ...result, status: "unavailable" as const, error: "review_result_changed", summary: "核验期间任务结果已变化，旧结论未写入任务验收。", reviewed };
      const imageVerification = {
        taskRevision: latest.revision, resultAssetIds: [...expected.assetIds], jobId: expected.jobId,
        ...result, checkedAt: new Date().toISOString(),
      };
      deps.task!.snapshot = await deps.task!.service.updateBrief(latest.runId, { ...latest.brief, imageVerification });
      assertImageReviewActive(reviewSignal);
    }
    return {
      ...result, reviewed,
      acceptanceRecorded: !preparedRead && canPersistTaskAcceptance && isLatestResult && !!current?.brief,
      reviewMode: input.mode,
    };
    });
    } catch (error) {
      return {
        status: "unavailable" as const, viewed: false, error: error instanceof Error ? error.message : "image_review_unavailable",
        blockingIssues: [], suggestions: [], uncertainties: [],
        summary: "未能读取并查看全部请求图片的实际像素，不能声称视觉验收通过。",
      };
    }
    },
  });
}
