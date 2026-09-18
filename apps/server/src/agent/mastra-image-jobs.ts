import { createHash } from "node:crypto";

import type {
  DesignJobTarget,
  ImageQualityLevel,
} from "@loomic/shared";

import { insertImageGenerationPlaceholder, markImageGenerationPlaceholderFailed } from "../features/canvas/canvas-element-writer.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import { imageResolutionBillingQuality } from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import { JobServiceError } from "../features/jobs/job-service.js";
import type { WorkspaceModelCatalogService } from "../features/providers/workspace-model-catalog-service.js";
import type { AuthenticatedUser, UserSupabaseClient } from "../supabase/user.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import type { SubmitImageJobFn } from "./image-generation-contracts.js";
import { imageSubmissionReceipt } from "../features/jobs/image-submission-receipt.js";
import { mastraImageDefaultRunLimit, validateMastraImageExecution, validateMastraImageResolutionSupport } from "./mastra-image-execution-policy.js";

export type MastraImageDesignTargetInput = Omit<DesignJobTarget, "idempotency_key"> & {
  /** Finalizer identity is always derived by the server from the submission key. */
  idempotency_key?: never;
};
export type MastraImageJobInput = Omit<Parameters<SubmitImageJobFn>[0],
  "proposalId" | "replayOnly" | "target" | "foregroundPolicy"> & {
  target?: MastraImageDesignTargetInput;
};
export type MastraImageJobResult = Awaited<ReturnType<SubmitImageJobFn>>;

/** A proven no-write rejection. The tool may accept corrected arguments in the
 * same run; errors at or after durable creation never use this class. */
export class MastraImagePreflightError extends Error {
  readonly code: string;
  readonly summary: string;

  constructor(code = "image_submission_not_submitted", summary =
    "图片任务在持久化前校验失败，未创建任务、未扣费。请只修正返回的条件后再提交；不要静默更换模型、提供商或来源。") {
    super(code);
    this.name = "MastraImagePreflightError";
    this.code = code;
    this.summary = summary;
  }
}

function asPreflightError(error: unknown): MastraImagePreflightError {
  if (error instanceof MastraImagePreflightError) return error;
  if (error instanceof JobServiceError && error.statusCode >= 400 && error.statusCode < 500)
    return new MastraImagePreflightError("image_target_preflight_rejected",
      "目标画板或源对象校验未通过，尚未创建图片任务、未扣费。请重新读取当前画板，并使用最新 revision、object_id、asset_object_id 和 object_version 修正 target；不要更换模型或来源。");
  const candidate = (error as { code?: unknown } | null)?.code;
  const code = typeof candidate === "string" && /^[a-z][a-z0-9_]{1,80}$/.test(candidate)
    ? candidate : "image_submission_not_submitted";
  return new MastraImagePreflightError(code);
}

/** Authenticated server context. None of these fields belong in the model tool schema. */
export type MastraImageJobContext = {
  userId: string;
  accessToken: string;
  workspaceId: string;
  sessionId: string;
  canvasId: string;
  /** Optional UI-open design. When present it narrows the allowable target. */
  activeDesignId?: string;
  runId: string;
  signal?: AbortSignal;
};

export type MastraImageJobSubmitter = {
  submit(context: MastraImageJobContext, input: MastraImageJobInput): Promise<MastraImageJobResult>;
};

type BillingFailure = {
  code: string;
  message: string;
  currentBalance?: number;
  requiredAmount?: number;
  plan?: string;
  dailyClaimed?: boolean;
};

export type MastraImageJobDependencies = {
  createUserClient: (accessToken: string) => unknown;
  jobService?: JobService | undefined;
  workspaceModelCatalogService?: WorkspaceModelCatalogService | undefined;
  creditService?: CreditService | undefined;
  tierGuard?: TierGuard | undefined;
  connectionManager?: ConnectionManager | undefined;
  onBillingFailure?: (context: MastraImageJobContext, failure: BillingFailure) => void;
  now?: () => string;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function mastraImageSubmissionKey(runId: string, input: MastraImageJobInput): string {
  const digest = createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
  return `${runId}:${digest}`;
}

function stablePlaceholderId(submissionKey: string): string {
  const hex = createHash("sha256").update(`canvas-placeholder:${submissionKey}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const compact = hex.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

async function assertCurrentRunScope(client: UserSupabaseClient, jobService: JobService,
  user: AuthenticatedUser, context: MastraImageJobContext) {
  const [run, sessionResult, canvasResult, memberResult] = await Promise.all([
    jobService.assertMastraImageRun(user, { runId: context.runId, sessionId: context.sessionId }),
    // Session access follows its workspace-member RLS. The run itself remains
    // owned by the current user; a collaborator need not have created the
    // shared session in order to use it.
    client.from("chat_sessions").select("id,canvas_id")
      .eq("id", context.sessionId).maybeSingle(),
    client.from("canvases").select("id,workspace_id").eq("id", context.canvasId).maybeSingle(),
    client.from("workspace_members").select("role").eq("workspace_id", context.workspaceId)
      .eq("user_id", context.userId).maybeSingle(),
  ]);
  const session = sessionResult.data as { canvas_id?: unknown } | null;
  const canvas = canvasResult.data as { workspace_id?: unknown } | null;
  if (sessionResult.error || canvasResult.error || memberResult.error || !memberResult.data
    || !session || session.canvas_id !== context.canvasId || !canvas || canvas.workspace_id !== context.workspaceId)
    throw new MastraImagePreflightError("mastra_image_run_scope_forbidden");
  const { data: message, error } = await client.from("chat_messages").select("id,session_id,role,content")
    .eq("id", run.requestMessageId).eq("session_id", context.sessionId).maybeSingle();
  if (error || !message || message.role !== "user") throw new MastraImagePreflightError("mastra_image_current_user_message_required");
  return typeof message.content === "string" ? message.content : "";
}

async function resolveBillingModel(catalog: WorkspaceModelCatalogService, user: AuthenticatedUser,
  workspaceId: string, modelRef: string) {
  if (!modelRef.startsWith("workspace:")) return modelRef;
  const resolved = await catalog.resolvePublishedModel(user, workspaceId, modelRef, "image");
  if (!resolved) {
    const error = new Error("Workspace image model is unavailable or has not passed its connection test.");
    (error as Error & { code?: string }).code = "provider_snapshot_invalid";
    throw error;
  }
  return resolved.upstreamModelId;
}

function terminalResult(job: Awaited<ReturnType<JobService["getJobAdmin"]>>): MastraImageJobResult | null {
  if (job.status === "succeeded" && job.result) {
    const result = job.result as Record<string, unknown>;
    return { ...mastraImageJobReceipt(job), status: "succeeded", jobId: job.id,
      ...(typeof result.asset_id === "string" ? { assetId: result.asset_id } : {}),
      ...(typeof result.canvas_element_id === "string" ? { elementId: result.canvas_element_id } : {}),
      ...(typeof result.signed_url === "string" ? { imageUrl: result.signed_url } : {}),
      ...(typeof result.width === "number" ? { width: result.width } : {}),
      ...(typeof result.height === "number" ? { height: result.height } : {}),
      ...(typeof result.mime_type === "string" ? { mimeType: result.mime_type } : {}),
    };
  }
  if (["failed", "dead_letter", "canceled"].includes(job.status)) return {
    ...mastraImageJobReceipt(job),
    jobId: job.id,
    error: job.error_message ?? `Job ${job.status}`,
    // The wrapper derives a failed display status from `error`; retain the
    // durable classification so it does not collapse an unknown outcome into a
    // definite rejection on terminal replay.
    ...(typeof job.error_code === "string" ? { errorCode: job.error_code } : {}),
    retryEligible: job.status === "dead_letter" && job.error_code === "provider_rejected",
  };
  return null;
}

export const mastraImageJobReceipt = imageSubmissionReceipt;

/**
 * Durable direct image submission for the Mastra runtime. The caller supplies
 * the current authenticated run context, while the model supplies only image
 * arguments. This service deliberately contains no phrase-based confirmation,
 * unattended task gate, provider execution, or canvas success insertion.
 */
export function createMastraImageJobSubmitter(deps: MastraImageJobDependencies): MastraImageJobSubmitter {
  const now = deps.now ?? (() => new Date().toISOString());
  return { async submit(context, rawInput) {
    const { jobService, workspaceModelCatalogService, creditService, tierGuard } = deps;
    if (!jobService || !workspaceModelCatalogService || !creditService || !tierGuard)
      throw new MastraImagePreflightError("mastra_image_job_dependencies_unavailable");
    if ((rawInput as Record<string, unknown>).proposalId !== undefined
      || (rawInput as Record<string, unknown>).replayOnly !== undefined
      || (rawInput.target as { idempotency_key?: unknown } | undefined)?.idempotency_key !== undefined)
      throw new MastraImagePreflightError("mastra_image_legacy_submission_identity_forbidden");
    if ((rawInput as Record<string, unknown>).foregroundPolicy !== undefined)
      throw new MastraImagePreflightError("mastra_image_foreground_policy_unsupported");
    // Agent image generation writes exclusively to the infinite canvas. Reject
    // every legacy native-design target before scope, catalog, or billing work;
    // historical design jobs remain recoverable through their own job UI.
    if (rawInput.target !== undefined) throw new MastraImagePreflightError(
      "mastra_image_canvas_target_required",
      "Agent 图片生成只能提交到无限画布。未创建任务、未扣费；请移除 target 后重新提交。",
    );
    const signal = context.signal;
    if (!signal) throw new MastraImagePreflightError("mastra_image_run_signal_required");
    signal.throwIfAborted();
    const client = deps.createUserClient(context.accessToken) as UserSupabaseClient;
    const user: AuthenticatedUser = { id: context.userId, accessToken: context.accessToken, email: "", userMetadata: {} };
    const currentUserText = await assertCurrentRunScope(client, jobService, user, context);
    signal.throwIfAborted();

    const input = structuredClone(rawInput);
    const executionViolation = validateMastraImageExecution(input, currentUserText);
    if (executionViolation) throw new MastraImagePreflightError(executionViolation.code, executionViolation.summary);
    const submissionKey = mastraImageSubmissionKey(context.runId, input);
    const prior = await jobService.findMastraImageSubmission(user, {
      workspaceId: context.workspaceId, sessionId: context.sessionId, canvasId: context.canvasId,
      runId: context.runId, submissionKey,
    });
    if (prior) {
      const replayResult = terminalResult(prior);
      return replayResult ?? { ...mastraImageJobReceipt(prior), jobId: prior.id, status: "processing" };
    }
    input.quality ??= "standard";
    input.resolution ??= "1k";
    const preflight = await (async () => {
      try {
        const billingModel = await resolveBillingModel(workspaceModelCatalogService,
          user, context.workspaceId, input.model);
        const resolutionSupportViolation = validateMastraImageResolutionSupport(billingModel, input.resolution);
        if (resolutionSupportViolation) throw new MastraImagePreflightError(resolutionSupportViolation.code, resolutionSupportViolation.summary);
        if (input.operation === "remove_background") {
          if (billingModel !== "gpt-image-2" || input.inputImages?.length !== 1
            || (input.outputFormat !== undefined && input.outputFormat !== "png"))
            throw Object.assign(new Error("mastra_image_background_removal_invalid"),
              { code: "mastra_image_background_removal_invalid" });
          input.outputFormat = "png";
        }
        const quality = imageResolutionBillingQuality(input.resolution, (input.quality as ImageQualityLevel | undefined) ?? "standard");
        const pricing = (model: string, pricedQuality: ImageQualityLevel) =>
          tierGuard.calculateCreditCost(model, "image_generation", { quality: pricedQuality, ...(input.resolution ? { imageResolution: input.resolution } : {}) });
        const subscription = await creditService.getSubscription(context.workspaceId);
        tierGuard.checkModelAccess(subscription.plan, billingModel);
        tierGuard.checkResolution(subscription.plan, quality);
        await tierGuard.checkConcurrency(context.workspaceId, subscription.plan);
        const creditsCost = pricing(billingModel, quality);
        const balance = await creditService.getBalance(context.workspaceId);
        if (balance.balance < creditsCost) {
          const failure = { code: "insufficient_credits", message: "Insufficient credits",
            currentBalance: balance.balance, requiredAmount: creditsCost, plan: balance.plan,
            dailyClaimed: balance.dailyClaimed };
          deps.onBillingFailure?.(context, failure);
          throw Object.assign(new Error(failure.message), { code: failure.code });
        }
        signal.throwIfAborted();
        return { quality, creditsCost };
      } catch (error) {
        // findMastraImageSubmission already proved that this normalized input
        // has no prior job. No write is attempted until createJobWithReplay
        // below, so every failure in this block is accurately recoverable.
        throw asPreflightError(error);
      }
    })();
    const { quality, creditsCost } = preflight;

    const placeholderElementId = stablePlaceholderId(submissionKey);
    const requestedPlacement = input.placementX != null && input.placementY != null ? {
      x: input.placementX, y: input.placementY,
      width: input.placementWidth ?? 512, height: input.placementHeight ?? 512,
    } : undefined;
    let creation: Awaited<ReturnType<JobService["createJobWithReplay"]>>;
    try {
      creation = await jobService.createJobWithReplay(user, {
      workspaceId: context.workspaceId, sessionId: context.sessionId,
      canvasId: context.canvasId,
      jobType: "image_generation", deferEnqueue: true,
      providerBilling: { creditsCost, pricingVersion: "credits-v1", unit: "image" },
      mastraSubmission: { runId: context.runId, key: submissionKey, defaultRunLimit: mastraImageDefaultRunLimit() },
      payload: {
        prompt: input.prompt, title: input.title, model: input.model,
        aspect_ratio: input.aspectRatio,
        ...(input.operation ? { operation: input.operation } : {}),
        ...(input.outputFormat ? { output_format: input.outputFormat } : {}),
        ...(input.background ? { background: input.background } : {}),
        ...(input.background === "transparent" ? { output_format: "png" } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        auto_finalize_canvas: true, placeholder_element_id: placeholderElementId,
        ...(requestedPlacement ? { placement_x: requestedPlacement.x, placement_y: requestedPlacement.y,
          placement_width: requestedPlacement.width, placement_height: requestedPlacement.height } : {}),
        ...(input.inputImages ? { input_images: input.inputImages } : {}),
      },
      });
    } catch (error) {
      // The INSERT trigger rejected before any durable write. These errors
      // are safe to correct; transport and post-insert failures remain unknown.
      if (error instanceof JobServiceError && ["image_generation_run_limit", "image_quality_not_authorized", "image_resolution_not_authorized", "image_generation_requested_count_unsupported", "image_execution_tier_invalid", "image_legacy_background_removal_contract_required"].includes(error.code))
        throw new MastraImagePreflightError(error.code, error.message);
      throw error;
    }
    const { job, replayed } = creation;
    const receipt = mastraImageJobReceipt(job);

    const existingTerminal = terminalResult(job);
    if (existingTerminal) return existingTerminal;
    if (placeholderElementId) {
      try {
        await insertImageGenerationPlaceholder(client, { canvasId: context.canvasId,
          elementId: placeholderElementId, sourceJobId: job.id, prompt: input.prompt,
          title: input.title, model: input.model, aspectRatio: input.aspectRatio,
          quality }, requestedPlacement);
        deps.connectionManager?.pushToCanvas(context.canvasId, { type: "canvas.sync", runId: context.runId, timestamp: now() });
      } catch (error) {
        // Only cancel a job whose enqueue receipt was never written; a plain
        // cancelJob could refund/abort an already-charged, committed job.
        if (!replayed) await jobService.cancelUncommittedMastraImageJob(user, {
          jobId: job.id, runId: context.runId, submissionKey,
        }).catch(() => false);
        throw error;
      }
    }
    if (!replayed) {
      const { error } = await client.from("chat_messages").upsert({ id: job.id,
        session_id: context.sessionId, role: "assistant", content: "图片任务正在提交或排队",
        content_blocks: [{ type: "tool", toolCallId: `job-result-${job.id}`, toolName: "generate_image",
          status: "running", input: { title: input.title, model: input.model, aspectRatio: input.aspectRatio },
          output: { ...receipt, status: "queued", jobId: job.id, jobType: "image_generation" },
          outputSummary: "图片任务正在提交或排队" }] }, { onConflict: "id" });
      if (error) console.error("[mastra-image-jobs] failed to persist chat placeholder:", error);
    }
    if (signal.aborted) {
      // A replay can refer to a job whose commit succeeded even if its caller
      // never received the RPC response. Only the enqueue-receipt CAS may
      // compensate here; ordinary cancellation could refund provider work that
      // has already started.
      const canceled = await jobService.cancelUncommittedMastraImageJob(user, {
        jobId: job.id, runId: context.runId, submissionKey,
      }).catch(() => false);
      if (!canceled) return { ...receipt, jobId: job.id, status: "processing" };
      if (placeholderElementId) await markImageGenerationPlaceholderFailed(client, context.canvasId,
        placeholderElementId, job.id, "生成已取消").catch(() => false);
      return { ...receipt, jobId: job.id, error: "Run was canceled" };
    }
    try {
      await jobService.commitMastraImageJob(user, { jobId: job.id, runId: context.runId,
        submissionKey, creditsCost });
    } catch (error) {
      if (error instanceof JobServiceError && error.code === "mastra_commit_rejected") {
        try {
          const canceled = await jobService.cancelUncommittedMastraImageJob(user, {
            jobId: job.id, runId: context.runId, submissionKey,
          });
          if (!canceled) return { ...receipt, jobId: job.id, status: "processing" };
          if (placeholderElementId) await markImageGenerationPlaceholderFailed(client, context.canvasId,
            placeholderElementId, job.id, "提交校验失败，未开始生成");
          return { ...receipt, jobId: job.id, error: "Image submission was rejected before enqueue" };
        } catch {
          // Compensation itself became uncertain. Keep the durable id queryable
          // and let recovery settle it; do not create or cancel anything else.
        }
      }
      // The RPC may have committed even when the transport outcome is unknown.
      // Never cancel or create another job here: the durable recovery scan owns
      // any still-queued record and the stable job id remains queryable.
      return { ...receipt, jobId: job.id, status: "processing" };
    }
    return { ...receipt, jobId: job.id, status: "processing" };
  } };
}
