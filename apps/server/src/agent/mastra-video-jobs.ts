import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { VideoResolution } from "@loomic/shared";

import { insertVideoElement } from "../features/canvas/canvas-element-writer.js";
import { CreditServiceError, type CreditService } from "../features/credits/credit-service.js";
import { TierGuardError, type TierGuard } from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { WorkspaceModelCatalogService } from "../features/providers/workspace-model-catalog-service.js";
import type { AuthenticatedUser, UserSupabaseClient } from "../supabase/user.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import type { GenerationBillingSummary } from "./image-generation-contracts.js";

export type MastraVideoJobContext = {
  userId: string;
  accessToken: string;
  workspaceId: string;
  sessionId: string;
  canvasId: string;
  runId: string;
  signal: AbortSignal;
};

/** URLs are internal, already grounded from authenticated asset IDs by the thin tool. */
export type MastraVideoJobInput = {
  title: string;
  prompt: string;
  model: string;
  duration?: number;
  resolution?: VideoResolution;
  aspectRatio?: string;
  inputImages?: string[];
  inputVideo?: string;
  enableAudio?: boolean;
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
};

export type MastraVideoJobResult = {
  status?: "processing" | "succeeded";
  jobId: string;
  elementId?: string;
  videoUrl?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  mimeType?: string;
  error?: string;
  billing?: GenerationBillingSummary;
};

export type MastraVideoJobSubmitter = {
  submit(context: MastraVideoJobContext, input: MastraVideoJobInput): Promise<MastraVideoJobResult>;
};

/** A proven no-write rejection. The tool may accept corrected arguments in the
 * same run; errors at or after durable creation never use this class. */
export class MastraVideoPreflightError extends Error {
  readonly code: string;
  readonly summary: string;

  constructor(code = "video_submission_not_submitted", summary =
    "视频任务在持久化前校验失败，未创建任务、未扣费。请只修正返回的条件后再提交。") {
    super(code);
    this.name = "MastraVideoPreflightError";
    this.code = code;
    this.summary = summary;
  }
}

type BillingFailure = {
  code: string;
  message: string;
  currentBalance?: number;
  requiredAmount?: number;
  plan?: string;
  dailyClaimed?: boolean;
};

export type MastraVideoJobDependencies = {
  createUserClient: (accessToken: string) => unknown;
  jobService?: JobService;
  workspaceModelCatalogService?: WorkspaceModelCatalogService;
  creditService?: CreditService;
  tierGuard?: TierGuard;
  connectionManager?: ConnectionManager;
  onBillingFailure?: (context: MastraVideoJobContext, failure: BillingFailure) => void;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  now?: () => string;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function mastraVideoSubmissionKey(runId: string, input: MastraVideoJobInput): string {
  return `${runId}:${createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex")}`;
}

async function assertCurrentRunScope(client: UserSupabaseClient, jobService: JobService,
  user: AuthenticatedUser, context: MastraVideoJobContext) {
  const [run, sessionResult, canvasResult, memberResult] = await Promise.all([
    jobService.assertMastraImageRun(user, { runId: context.runId, sessionId: context.sessionId }),
    client.from("chat_sessions").select("id,canvas_id").eq("id", context.sessionId).maybeSingle(),
    client.from("canvases").select("id,workspace_id").eq("id", context.canvasId).maybeSingle(),
    client.from("workspace_members").select("role").eq("workspace_id", context.workspaceId)
      .eq("user_id", context.userId).maybeSingle(),
  ]);
  const session = sessionResult.data as { canvas_id?: unknown } | null;
  const canvas = canvasResult.data as { workspace_id?: unknown } | null;
  if (sessionResult.error || canvasResult.error || memberResult.error || !memberResult.data
    || !session || session.canvas_id !== context.canvasId || !canvas || canvas.workspace_id !== context.workspaceId)
    throw new MastraVideoPreflightError("mastra_video_run_scope_forbidden");
  const { data: message, error } = await client.from("chat_messages").select("id,session_id,role")
    .eq("id", run.requestMessageId).eq("session_id", context.sessionId).maybeSingle();
  if (error || !message || message.role !== "user") throw new MastraVideoPreflightError("mastra_video_current_user_message_required");
}

function terminalError(job: Awaited<ReturnType<JobService["getJob"]>>): MastraVideoJobResult | null {
  if (["dead_letter", "canceled"].includes(job.status)
    || (job.status === "failed" && job.attempt_count >= job.max_attempts))
    return { jobId: job.id, error: job.error_message
      ? sanitizeErrorForClient(new Error(job.error_message))
      : `Job ${job.status}` };
  return null;
}

/**
 * Run-bound Mastra video submission that preserves the existing durable worker,
 * provider snapshot, billing, polling and Canvas insertion path. It contains no
 * legacy task/proposal approval and never falls back to environment models.
 */
export function createMastraVideoJobSubmitter(deps: MastraVideoJobDependencies): MastraVideoJobSubmitter {
  const active = new Map<string, Promise<MastraVideoJobResult>>();
  const sleep = deps.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  const pollIntervalMs = deps.pollIntervalMs ?? 3_000;
  const maxWaitMs = deps.maxWaitMs ?? 600_000;
  const now = deps.now ?? (() => new Date().toISOString());

  const execute = async (context: MastraVideoJobContext,
    rawInput: MastraVideoJobInput): Promise<MastraVideoJobResult> => {
    if (!deps.jobService || !deps.workspaceModelCatalogService || !deps.creditService || !deps.tierGuard)
      throw new MastraVideoPreflightError("mastra_video_job_dependencies_unavailable");
    context.signal.throwIfAborted();
    const input = structuredClone(rawInput);
    const client = deps.createUserClient(context.accessToken) as UserSupabaseClient;
    const user: AuthenticatedUser = { id: context.userId, accessToken: context.accessToken,
      email: "", userMetadata: {} };
    await assertCurrentRunScope(client, deps.jobService, user, context);
    context.signal.throwIfAborted();

    if (!input.model.startsWith("workspace:")) throw new MastraVideoPreflightError("mastra_video_workspace_model_required");
    const submissionKey = mastraVideoSubmissionKey(context.runId, input);
    const jobPayload = { prompt: input.prompt, model: input.model,
      target: { kind: "canvas" as const, canvas_id: context.canvasId },
      ...(input.duration !== undefined ? { duration: input.duration } : {}),
      ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
      ...(input.aspectRatio !== undefined ? { aspect_ratio: input.aspectRatio } : {}),
      ...(input.inputImages?.length ? { input_images: input.inputImages } : {}),
      ...(input.inputVideo !== undefined ? { input_video: input.inputVideo } : {}),
      ...(input.enableAudio !== undefined ? { enable_audio: input.enableAudio } : {}) };

    let job = await deps.jobService.findVideoSubmission(user, {
      workspaceId: context.workspaceId, sessionId: context.sessionId,
      canvasId: context.canvasId, runId: context.runId,
      submissionKey, kind: "mastra", expectedPayload: jobPayload,
    });
    const priorTerminal = job ? terminalError(job) : null;
    if (priorTerminal) return priorTerminal;

    let creditsCost: number;
    if (job) {
      creditsCost = Number(job.payload.video_credits_cost);
      if (!Number.isSafeInteger(creditsCost) || creditsCost < 0)
        throw new MastraVideoPreflightError("mastra_video_durable_price_invalid");
    } else {
    const published = await deps.workspaceModelCatalogService.resolvePublishedModel(
      user, context.workspaceId, input.model, "video",
    );
    if (!published || !published.capabilities.includes("video_generation"))
      throw new MastraVideoPreflightError("mastra_video_model_unavailable",
        "当前工作区没有经过连接测试的视频模型，未提交视频生成。");

    const subscription = await deps.creditService.getSubscription(context.workspaceId);
    try {
      deps.tierGuard.checkModelAccess(subscription.plan, published.upstreamModelId);
      if (input.resolution) deps.tierGuard.checkVideoResolution(subscription.plan, input.resolution);
      await deps.tierGuard.checkConcurrency(context.workspaceId, subscription.plan);
    } catch (error) {
      if (error instanceof TierGuardError) {
        deps.onBillingFailure?.(context, { code: error.code, message: error.message,
          plan: subscription.plan });
        throw new MastraVideoPreflightError(error.code, error.message);
      }
      throw error;
    }
    creditsCost = deps.tierGuard.calculateCreditCost(published.upstreamModelId,
      "video_generation", { ...(input.duration !== undefined ? { duration: input.duration } : {}),
        ...(input.resolution !== undefined ? { resolution: input.resolution } : {}) });
    const balance = await deps.creditService.getBalance(context.workspaceId);
    if (balance.balance < creditsCost) {
      const failure = { code: "insufficient_credits", message: "Insufficient credits",
        currentBalance: balance.balance, requiredAmount: creditsCost, plan: balance.plan,
        dailyClaimed: balance.dailyClaimed };
      deps.onBillingFailure?.(context, failure);
      throw new MastraVideoPreflightError(failure.code, failure.message);
    }
    context.signal.throwIfAborted();

    const created = await deps.jobService.createJobWithReplay(user, {
      workspaceId: context.workspaceId, canvasId: context.canvasId, sessionId: context.sessionId,
      jobType: "video_generation", deferEnqueue: true,
      videoSubmission: { kind: "mastra", runId: context.runId, key: submissionKey },
      providerBilling: { creditsCost, pricingVersion: "credits-v1", unit: "second" },
      payload: jobPayload,
    });
    job = created.job;
    }
    if (context.signal.aborted) {
      const canceled = await deps.jobService.cancelUncommittedVideoJob(user, {
        jobId: job.id, submissionKey,
      }).catch(() => false);
      return canceled ? { jobId: job.id, error: "Run was canceled" }
        : { jobId: job.id, status: "processing" };
    }

    let billing: GenerationBillingSummary | undefined;
    if (job.status === "queued") {
      try {
        await deps.jobService.commitVideoJob(user, { jobId: job.id, submissionKey,
          creditsCost, runId: context.runId });
        const balanceAfter = (await deps.creditService.getBalance(context.workspaceId)).balance;
        billing = { estimate: creditsCost, charged: creditsCost, balanceAfter, currency: "credits" };
      } catch (error) {
        if (error instanceof CreditServiceError && error.code === "insufficient_credits") {
          const latest = await deps.creditService.getBalance(context.workspaceId).catch(() => null);
          deps.onBillingFailure?.(context, { code: error.code, message: error.message,
            requiredAmount: creditsCost, ...(latest ? { currentBalance: latest.balance,
              plan: latest.plan, dailyClaimed: latest.dailyClaimed } : {}) });
          const canceled = await deps.jobService.cancelUncommittedVideoJob(user, {
            jobId: job.id, submissionKey,
          }).catch(() => false);
          if (canceled) throw error;
        }
        if ((error as { code?: unknown })?.code === "video_commit_rejected") {
          const canceled = await deps.jobService.cancelUncommittedVideoJob(user, {
            jobId: job.id, submissionKey,
          }).catch(() => false);
          if (canceled) return { jobId: job.id, error: "Video submission was rejected before enqueue" };
        }
        // A missing/failed response cannot prove the transaction rolled back.
        // The durable job and recovery scan own the outcome from this point.
        return { jobId: job.id, status: "processing" };
      }
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
      try {
        await sleep(pollIntervalMs, context.signal);
      } catch {
        if (!context.signal.aborted) throw new Error("mastra_video_poll_failed");
      }
      if (context.signal.aborted) {
        // Publication is complete and a third-party call may already be in
        // flight. Canceling here would trigger a user refund after provider
        // cost was incurred. End only the foreground wait; keep the job live.
        return { jobId: job.id, status: "processing", ...(billing ? { billing } : {}) };
      }
      // Keep every long-poll read behind current user RLS. Membership can be
      // revoked while the provider is running; an admin read must not leak the
      // resulting signed URL back into that stale run.
      const current = await deps.jobService.getJob(user, job.id);
      const failed = terminalError(current);
      if (failed) return { ...failed, ...(billing ? { billing } : {}) };
      if (current.status !== "succeeded" || !current.result) continue;
      const result = current.result as Record<string, unknown>;
      let elementId: string | undefined;
      if (typeof result.asset_id === "string" && typeof result.signed_url === "string") {
        try {
          const placement = input.placementX !== undefined && input.placementY !== undefined
            ? { x: input.placementX, y: input.placementY, width: input.placementWidth ?? 640,
              height: input.placementHeight ?? 360 } : undefined;
          const inserted = await insertVideoElement(client, { canvasId: context.canvasId,
            sourceJobId: job.id, assetId: result.asset_id, signedUrl: result.signed_url,
            width: typeof result.width === "number" ? result.width : 1280,
            height: typeof result.height === "number" ? result.height : 720,
            mimeType: typeof result.mime_type === "string" ? result.mime_type : "video/mp4",
            ...(typeof result.duration_seconds === "number" ? { durationSeconds: result.duration_seconds } : {}),
            title: input.title, prompt: input.prompt }, placement);
          elementId = inserted.elementId;
          deps.connectionManager?.pushToCanvas(context.canvasId, {
            type: "canvas.sync", runId: context.runId, timestamp: now(),
          });
        } catch (error) {
          console.error("[mastra-video-jobs] canvas insertion deferred:",
            error instanceof Error ? error.name : "unknown");
        }
      }
      return { jobId: job.id, status: "succeeded",
        ...(elementId ? { elementId } : {}),
        ...(typeof result.signed_url === "string" ? { videoUrl: result.signed_url } : {}),
        width: typeof result.width === "number" ? result.width : 1280,
        height: typeof result.height === "number" ? result.height : 720,
        mimeType: typeof result.mime_type === "string" ? result.mime_type : "video/mp4",
        ...(typeof result.duration_seconds === "number" ? { durationSeconds: result.duration_seconds } : {}),
        ...(billing ? { billing } : {}) };
    }
    return { jobId: job.id, status: "processing", ...(billing ? { billing } : {}) };
  };

  return { submit(context, input) {
    const key = mastraVideoSubmissionKey(context.runId, input);
    const prior = active.get(key);
    if (prior) return prior;
    const submission = execute(context, input);
    active.set(key, submission);
    return submission;
  } };
}
