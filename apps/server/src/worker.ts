// @credits-system — Worker process: handles job failure refunds (credit refund on generation error)
import { bootstrap } from "global-agent";

// Enable HTTP proxy for all outbound requests if GLOBAL_AGENT_HTTP_PROXY is set
bootstrap();

// Native fetch() proxy — needed for @google/generative-ai SDK
if (process.env.GLOBAL_AGENT_HTTP_PROXY) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(process.env.GLOBAL_AGENT_HTTP_PROXY));
}

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { loadServerEnv } from "./config/env.js";
import {createBackgroundMaintenance} from './background-maintenance.js';
import {
  type CreditService,
  createCreditService,
} from "./features/credits/credit-service.js";
import {
  type ExecutorContext,
  getExecutor,
} from "./features/jobs/job-executor.js";
import { createJobService, JobServiceError } from "./features/jobs/job-service.js";
import { type PgmqMessage, createPgmqClient } from "./queue/pgmq-client.js";
import { trackTask } from "./queue/track-task.js";
import { createAdminSupabaseClient } from "./supabase/admin.js";
import { createUserSupabaseClientFactory } from "./supabase/user.js";

// Import executors to trigger registration via side effects
import "./features/jobs/executors/image-generation.js";
import "./features/jobs/executors/video-generation.js";

import type { BackgroundJobType } from "@loomic/shared";

import {
  DesignResourceImportService,
  createSupabaseDesignResourceImportRepository,
  runDesignResourceImportPollingLoop,
} from "./features/design-resources/design-resource-import-service.js";
import {
  type DesignPreviewFailureRepository,
  createSupabaseDesignPreviewFailureRepository,
  registerDesignAsyncExecutors,
  requeueQueuedDesignExportJobs,
  requeueQueuedDesignPreviewJobs,
} from "./features/designs/design-async-worker.js";
import { createDesignBindingReconciler } from "./features/designs/design-binding-reconciler.js";
import { collectExpiredDesignExportAssets } from "./features/designs/design-export-gc.js";
import {
  createSupabaseDesignExportRenderer,
  createSupabaseDesignPreviewRenderer,
} from "./features/designs/design-preview-renderer.js";
import {
  DesignPreviewService,
  createSupabaseDesignPreviewRepository,
} from "./features/designs/design-preview-service.js";
import { isLocalImageOperation } from "./features/images/local-image-operation.js";
import {
  DesignJobFinalizer,
  createDesignJobMutationPort,
  createSupabaseDesignFinalizationRepository,
  reconcileSucceededDesignImageJobs,
} from "./features/jobs/design-job-finalizer.js";
import {
  finalizeDesignImageJobChat,
  finalizeSucceededImageJob,
  finalizeTerminalImageJobPlaceholder,
  reconcileSucceededDesignImageChats,
  reconcileSucceededImageJobs,
  reconcileTerminalImageJobChats,
  reconcileTerminalImageJobPlaceholders,
  reconcileTerminalVideoJobPlaceholders,
  finalizeTerminalVideoJobPlaceholder,
  type FinalizableJob,
} from "./features/jobs/job-canvas-finalizer.js";
import { createProviderSnapshotService } from "./features/providers/index.js";
import { runWithGenerationProviderScope } from "./generation/providers/registry.js";
import {
  type WorkspaceProviderResolver,
  createWorkspaceProviderResolver,
} from "./generation/providers/workspace-provider-resolver.js";

// 代码执行由 LocalShellBackend 的内置 execute 工具直接处理，不走 PGMQ。
// The queue list lives in `./queue/queues.ts` so the health probe can name the
// same queues without importing this entry point (which starts polling loops).
export { WORKER_QUEUES } from "./queue/queues.js";
import { WORKER_QUEUES } from "./queue/queues.js";
import {
  startWorkerHeartbeat,
  type WorkerHeartbeatWriter,
} from "./worker-heartbeat.js";

const QUEUE_TO_TYPE: Record<string, BackgroundJobType> = {
  image_generation_jobs: "image_generation",
  video_generation_jobs: "video_generation",
  design_preview_jobs: "design_preview",
  design_export_jobs: "design_export",
};

const VT_BY_QUEUE: Record<string, number> = {
  image_generation_jobs: 120,
  video_generation_jobs: 300,
  design_preview_jobs: 120,
  design_export_jobs: 300,
};

async function main() {
  const env = loadServerEnv();

  if (!env.supabaseDbUrl) {
    console.error("SUPABASE_DB_URL is required for worker process.");
    process.exit(1);
  }

  const pgmq = createPgmqClient(env.supabaseDbUrl);
  const createUserClient = createUserSupabaseClientFactory(env);

  let adminClient: ReturnType<typeof createAdminSupabaseClient> | undefined;
  const getAdminClient = () => {
    adminClient ??= createAdminSupabaseClient(env);
    return adminClient;
  };

  const jobService = createJobService({
    createUserClient,
    getAdminClient,
    pgmq,
  });
  const creditService = createCreditService({ getAdminClient });
  const providerSnapshotService = createProviderSnapshotService({
    getAdminClient,
  });
  const workspaceProviderResolver = createWorkspaceProviderResolver({
    env,
    providerSnapshotService,
  });
  const designPreviewRepository =
    createSupabaseDesignPreviewRepository(getAdminClient);
  const designPreviewQueue = new DesignPreviewService(designPreviewRepository, {
    publish: async (message) => {
      await pgmq.send("design_preview_jobs", message);
    },
  });
  const designJobFinalizer = new DesignJobFinalizer(
    createSupabaseDesignFinalizationRepository(getAdminClient),
    createDesignJobMutationPort(getAdminClient),
    designPreviewQueue,
  );
  const designBindingReconciler = createDesignBindingReconciler({
    getAdminClient,
  });
  const designResourceImportService = new DesignResourceImportService(
    createSupabaseDesignResourceImportRepository(getAdminClient),
  );
  const designPreviewFailures =
    createSupabaseDesignPreviewFailureRepository(getAdminClient);
  registerDesignAsyncExecutors({
    previewRepository: designPreviewRepository,
    previewRenderer: createSupabaseDesignPreviewRenderer(),
    exportRenderer: createSupabaseDesignExportRenderer(),
  });

  // Base context — per-message fields (queue, msgId, renewVt) are added in processMessage
  const baseCtx = {
    jobService,
    pgmq,
    getAdminClient,
    env,
  };

  const CONCURRENCY_BY_QUEUE: Record<string, number> = {
    image_generation_jobs: env.workerImageConcurrency ?? 3,
    video_generation_jobs: env.workerVideoConcurrency ?? 2,
    design_preview_jobs: 1,
    design_export_jobs: 1,
  };

  const inFlightByQueue = new Map<string, Set<Promise<void>>>(
    WORKER_QUEUES.map((q) => [q, new Set()]),
  );

  // Server-side long poll: wait up to N seconds inside Postgres for messages,
  // checking every 500ms. This replaces the old client-side sleep(2000) + read()
  // pattern that generated ~340K idle queries per monitoring period.
  const pollTimeoutSeconds = Math.max(
    1,
    Math.floor((env.workerPollIntervalMs ?? 5000) / 1000),
  );
  // WORKER_ID is set by the startup scripts (see `dev:workers:2/3`); when it is
  // absent the id is DERIVED once per process from the host name plus a random
  // suffix, and logged so the heartbeat row can be traced back to this process.
  const workerId = env.workerId ?? `${hostname().slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  const tag = `[worker:${workerId}]`;

  let running = true;
  let designResourceImportPoll: Promise<void> = Promise.resolve();

  // Liveness for `/api/health`. Without this the API cannot distinguish "no work
  // queued" from "no worker consuming", which is why the health check reported a
  // healthy stack while queued jobs never ran.
  const heartbeat: WorkerHeartbeatWriter = startWorkerHeartbeat({
    getAdminClient,
    onError: (error) => console.error(`${tag} Heartbeat write failed:`, error),
    version: env.version,
    workerId,
  });

  // Graceful shutdown — wait for in-flight jobs then exit
  const shutdown = async () => {
    const totalInFlight = [...inFlightByQueue.values()].reduce(
      (n, s) => n + s.size,
      0,
    );
    console.log(
      `${tag} Shutting down, waiting for ${totalInFlight} in-flight jobs...`,
    );
    running = false;
    heartbeat.stop();
    const allTasks = [...inFlightByQueue.values()].flatMap((s) => [...s]);
    if (allTasks.length > 0) {
      await Promise.allSettled(allTasks);
    }
    await designResourceImportPoll;
    await pgmq.shutdown();
    console.log(`${tag} Shutdown complete.`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const concurrencyDesc = WORKER_QUEUES.map(
    (q) => `${q}=${CONCURRENCY_BY_QUEUE[q] ?? 1}`,
  ).join(", ");
  console.log(
    `${tag} Started. concurrency={${concurrencyDesc}}, longPollTimeout=${pollTimeoutSeconds}s, heartbeat=${env.workerId ? "WORKER_ID" : "derived"}`,
  );

  let lastCanvasReconcileAt = 0;
  let lastDesignExportGcAt = 0;
  const reconcileCanvases = async () => {
    if (Date.now() - lastCanvasReconcileAt < 30_000) return;
    lastCanvasReconcileAt = Date.now();
    try {
      const previewJobs = await requeueQueuedDesignPreviewJobs(
        getAdminClient(),
        pgmq,
      );
      if (previewJobs.published > 0 || previewJobs.failed > 0) {
        console.log(
          `${tag} Preview queue recovery published=${previewJobs.published} failed=${previewJobs.failed}`,
        );
      }
      const exportJobs = await requeueQueuedDesignExportJobs(
        getAdminClient(),
        pgmq,
      );
      if (exportJobs.published > 0 || exportJobs.failed > 0) {
        console.log(
          `${tag} Export queue recovery published=${exportJobs.published} failed=${exportJobs.failed}`,
        );
      }
      const outcome = await reconcileSucceededImageJobs(getAdminClient());
      if (outcome.finalized > 0 || outcome.failed > 0) {
        console.log(
          `${tag} Canvas recovery finalized=${outcome.finalized} failed=${outcome.failed}`,
        );
      }
      const terminalImages = await reconcileTerminalImageJobPlaceholders(getAdminClient());
      if (terminalImages.finalized > 0 || terminalImages.failed > 0) {
        console.log(
          `${tag} Terminal canvas recovery finalized=${terminalImages.finalized} failed=${terminalImages.failed}`,
        );
      }
      const terminalVideos = await reconcileTerminalVideoJobPlaceholders(getAdminClient());
      if (terminalVideos.finalized > 0 || terminalVideos.failed > 0) {
        console.log(
          `${tag} Terminal video recovery finalized=${terminalVideos.finalized} failed=${terminalVideos.failed}`,
        );
      }
      const terminalImageChats = await reconcileTerminalImageJobChats(getAdminClient());
      if (terminalImageChats.finalized > 0 || terminalImageChats.failed > 0) {
        console.log(
          `${tag} Terminal image chat recovery finalized=${terminalImageChats.finalized} failed=${terminalImageChats.failed}`,
        );
      }
      const refunds = await reconcileTerminalJobRefunds({ getAdminClient }, creditService, tag);
      if (refunds.refunded > 0 || refunds.failed > 0) {
        console.log(`${tag} Refund recovery refunded=${refunds.refunded} failed=${refunds.failed}`);
      }
      const bindings = await designBindingReconciler.reconcile(50);
      const designJobs = await reconcileSucceededDesignImageJobs(
        getAdminClient(),
        designJobFinalizer,
      );
      if (designJobs.finalized > 0 || designJobs.failed > 0) {
        console.log(
          `${tag} Design job recovery finalized=${designJobs.finalized} failed=${designJobs.failed}`,
        );
      }
      const designChats = await reconcileSucceededDesignImageChats(
        getAdminClient(),
      );
      if (designChats.finalized > 0 || designChats.failed > 0) {
        console.log(
          `${tag} Design chat recovery finalized=${designChats.finalized} failed=${designChats.failed}`,
        );
      }
      if (
        bindings.attached > 0 ||
        bindings.orphaned > 0 ||
        bindings.rejected > 0 ||
        bindings.deleted_nodes > 0 ||
        bindings.normalized > 0
      ) {
        console.log(
          `${tag} Design binding recovery attached=${bindings.attached} orphaned=${bindings.orphaned} rejected=${bindings.rejected} deleted=${bindings.deleted_nodes} normalized=${bindings.normalized}`,
        );
      }
      if (Date.now() - lastDesignExportGcAt >= 5 * 60_000) {
        lastDesignExportGcAt = Date.now();
        try {
          const gc = await collectExpiredDesignExportAssets(getAdminClient());
          if (gc.deleted > 0 || gc.failed > 0) {
            console.log(
              `${tag} Design export GC deleted=${gc.deleted} skipped=${gc.skipped} failed=${gc.failed}`,
            );
          }
        } catch (gcError) {
          console.error(`${tag} Design export GC failed:`, gcError);
        }
      }
    } catch (error) {
      console.error(`${tag} Canvas recovery scan failed:`, error);
    }
  };

  const maintenance=createBackgroundMaintenance(reconcileCanvases,error=>console.error(`${tag} Recovery scan failed:`,error));
  let lastSubmissionRecoveryAt = 0;
  const submissionMaintenance = createBackgroundMaintenance(async () => {
    if (Date.now() - lastSubmissionRecoveryAt < 30_000) return;
    lastSubmissionRecoveryAt = Date.now();
    const admin = getAdminClient();
    const [{ error: imageError }, { error: videoError }] = await Promise.all([
      admin.rpc("loomic_recover_image_submissions" as never),
      admin.rpc("loomic_recover_video_submissions" as never),
    ]);
    if (imageError) throw new Error(imageError.message);
    if (videoError) throw new Error(videoError.message);
  }, error => console.error(`${tag} Submission recovery failed:`, error));
  const pollQueue = async (queue: (typeof WORKER_QUEUES)[number]) => {
    while (running) {
      try {
        if (queue === "image_generation_jobs" || queue === "video_generation_jobs") {
          submissionMaintenance.trigger();
        }
        if (queue === "image_generation_jobs") {
          maintenance.trigger();
        }
        const inFlight = inFlightByQueue.get(queue);
        if (!inFlight) {
          throw new Error(`Missing in-flight registry for queue ${queue}`);
        }
        const cap = CONCURRENCY_BY_QUEUE[queue] ?? 1;
        const available = cap - inFlight.size;
        if (available <= 0) {
          // Wait for capacity instead of spinning while this queue is full.
          await Promise.race(inFlight);
          continue;
        }

        const vt = VT_BY_QUEUE[queue] ?? 120;
        const messages = await pgmq.readWithPoll(
          queue,
          vt,
          available,
          pollTimeoutSeconds,
          500,
        );

        for (const msg of messages) {
          const ctx: ExecutorContext = {
            ...baseCtx,
            queue,
            msgId: msg.msg_id,
            renewVt: async (vtSeconds: number) => {
              try {
                await pgmq.setVt(queue, msg.msg_id, vtSeconds);
              } catch (e) {
                console.warn(`[renewVt] failed for msg ${msg.msg_id}:`, e);
              }
            },
          };
          trackTask(inFlight, () => processMessage(
            queue,
            msg,
            ctx,
            creditService,
            tag,
            workspaceProviderResolver,
            designJobFinalizer,
            designPreviewFailures,
          ), (error) => console.error(
            `${tag} Task infrastructure error queue=${queue} msgId=${msg.msg_id}; retained for recovery:`,
            error,
          ));
        }
      } catch (err) {
        console.error(`${tag} Error polling ${queue}:`, err);
        // Avoid a hot retry loop during transient database/network failures.
        await sleep(500);
      }
    }
  };

  designResourceImportPoll = runDesignResourceImportPollingLoop(
    designResourceImportService,
    {
      isRunning: () => running,
      onError: (error) => {
        console.error(`${tag} Error polling design resource imports:`, error);
      },
    },
  );

  // Each queue owns an independent long poll. A quiet video queue can no
  // longer add up to one full poll cycle to a newly-enqueued image job (and
  // vice versa), while database query volume stays essentially unchanged.
  await Promise.all([
    ...WORKER_QUEUES.map((queue) => pollQueue(queue)),
    designResourceImportPoll,
  ]);
}

export async function processMessage(
  queue: string,
  msg: PgmqMessage,
  ctx: ExecutorContext,
  creditService: CreditService,
  tag: string,
  workspaceProviderResolver?: WorkspaceProviderResolver,
  designJobFinalizer?: DesignJobFinalizer,
  designPreviewFailures?: DesignPreviewFailureRepository,
  terminalImagePlaceholderFinalizer: (
    admin: ReturnType<ExecutorContext["getAdminClient"]>,
    job: FinalizableJob,
  ) => Promise<boolean> = finalizeTerminalImageJobPlaceholder,
  terminalVideoPlaceholderFinalizer: (
    admin: ReturnType<ExecutorContext["getAdminClient"]>,
    job: FinalizableJob,
  ) => Promise<boolean> = finalizeTerminalVideoJobPlaceholder,
) {
  const jobId = msg.message.job_id as string;
  const jobType =
    (msg.message.job_type as BackgroundJobType) ?? QUEUE_TO_TYPE[queue];

  if (!jobId || !jobType) {
    console.error(`${tag} Invalid message in ${queue}:`, msg.message);
    await ctx.pgmq.archive(queue, msg.msg_id);
    return;
  }

  // Extract traceability context from PGMQ message (if present)
  const sessionShort =
    typeof msg.message.session_id === "string"
      ? msg.message.session_id.slice(0, 8)
      : undefined;
  const startTime = Date.now();
  console.log(
    `${tag} Processing job ${jobId} (${jobType})${sessionShort ? ` session:${sessionShort}` : ""}`,
  );
  const settleTerminalPlaceholder = async (job?: FinalizableJob) => {
    if (jobType !== "image_generation" && jobType !== "video_generation") return;
    try {
      const current = job ?? await ctx.jobService.getJobAdmin(jobId) as FinalizableJob;
      // Video jobs had no terminal path at all: a failed or canceled video left
      // the chat card at "processing" and the user with no notice.
      if (jobType === "video_generation") {
        await terminalVideoPlaceholderFinalizer(ctx.getAdminClient(), current);
        return;
      }
      await terminalImagePlaceholderFinalizer(ctx.getAdminClient(), current);
    } catch (settleError) {
      // The terminal job state and refund are already durable. Periodic
      // reconciliation retries only the canvas placeholder convergence.
      console.error(`${tag} Terminal placeholder finalization deferred for job ${jobId}:`, settleError);
    }
  };

  // Claim before doing any work. A cancellation racing with delivery wins because
  // both updates are conditional in Postgres. Duplicate/stale queue messages must
  // never reach a provider.
  const claimed = await ctx.jobService.markRunning(jobId);
  if (!claimed) {
    const job = await ctx.jobService.getJobAdmin(jobId).catch(async (error) => {
      if (error instanceof JobServiceError && error.code === "job_not_found") {
        // A deleted job can leave a queue message behind. Only a confirmed
        // missing row is terminal; transient lookup failures must be retried.
        await ctx.pgmq.archive(queue, msg.msg_id);
        console.warn(`${tag} Archived orphan message ${msg.msg_id} for missing job ${jobId}`);
        return null;
      }
      throw error;
    });
    if (!job) return;
    if (job.status === "canceled") {
      await settleTerminalPlaceholder(job as FinalizableJob);
      await refundTerminalJob(jobId, "canceled", ctx, creditService, tag);
      await ctx.pgmq.archive(queue, msg.msg_id);
    } else if (job.status === "running") {
      // Another worker may still own the job. Keep the message recoverable;
      // markRunning will reclaim it once its durable lease is stale.
      await ctx.pgmq.setVt(queue, msg.msg_id, VT_BY_QUEUE[queue] ?? 120);
      console.log(`${tag} Deferred in-progress job ${jobId} for recovery`);
      return;
    } else if (job.status === "dead_letter") {
      await settleTerminalPlaceholder(job as FinalizableJob);
      await ctx.pgmq.archive(queue, msg.msg_id);
    } else {
      await ctx.pgmq.archive(queue, msg.msg_id);
    }
    console.log(
      `${tag} Skipped unclaimable job ${jobId} (status: ${job.status})`,
    );
    return;
  }

  // Increment only after a successful claim, so duplicate deliveries do not
  // consume retry attempts.
  let attempt_count: number;
  let max_attempts: number;
  try {
    ({ attempt_count, max_attempts } = await ctx.jobService.incrementAttempt(jobId));
  } catch (attemptError) {
    // A provider call is only safe after its retry attempt is durable. Do not
    // infer a counter from a failed or malformed RPC response: preserve the
    // queue message and retry after the job row has been returned to `failed`.
    console.error(
      `${tag} Attempt recording failed for job ${jobId}; execution deferred:`,
      attemptError,
    );
    await ctx.jobService.markFailed(
      jobId,
      "attempt_increment_failed",
      "Job attempt could not be recorded; execution deferred.",
    );
    return;
  }

  const executor = getExecutor(jobType);
  if (!executor) {
    console.error(`${tag} No executor for job type: ${jobType}`);
    const transitioned = await ctx.jobService.markDeadLetter(
      jobId,
      "no_executor",
      `No executor registered for ${jobType}`,
    );
    await ctx.pgmq.archive(queue, msg.msg_id);
    if (transitioned) {
      await settleTerminalPlaceholder();
      await refundTerminalJob(jobId, "dead_letter", ctx, creditService, tag);
      await recordDesignPreviewTerminalFailure(
        jobType,
        jobId,
        "no_executor",
        `No executor registered for ${jobType}`,
        designPreviewFailures,
        tag,
      );
    }
    return;
  }

  try {
    let execute = () =>
      executor(jobId, msg.message as Record<string, unknown>, ctx);
    if (
      workspaceProviderResolver &&
      (jobType === "image_generation" || jobType === "video_generation")
    ) {
      const job = await ctx.jobService.getJobAdmin(jobId);
      const payload = job.payload ?? {};
      const isLocalOperation =
        jobType === "image_generation" &&
        isLocalImageOperation(payload.operation);
      const modelId =
        typeof payload.model === "string"
          ? payload.model
          : jobType === "image_generation"
            ? "black-forest-labs/flux-kontext-pro"
            : "wan-video/wan-2.6";
      if (!isLocalOperation) {
        const requiredUpstream = payload.operation === "remove_background"
          ? { requiredUpstreamModel: ["gpt-image-2", "gpt-image-2.5-flare"] }
          : (payload.foreground_policy as { mode?: string } | undefined)?.mode === "native_transparent"
          ? { requiredUpstreamModel: "gpt-image-2" as const }
          : {};
        const resolution =
          jobType === "image_generation" && modelId.startsWith("workspace:")
            ? await workspaceProviderResolver.resolveImageGenerationPlan({
                workspaceId: job.workspace_id,
                jobId,
                modelId,
                ...requiredUpstream,
              })
            : await workspaceProviderResolver.resolve({
                workspaceId: job.workspace_id,
                jobId,
                modality: jobType === "image_generation" ? "image" : "video",
                modelId,
                ...requiredUpstream,
              });
        const foreground = payload.foreground_policy as { mode?: unknown; mattingModel?: unknown } | undefined;
        if (jobType === "image_generation" && foreground && typeof foreground === "object" && !Array.isArray(foreground) && foreground.mode === "api_matting") {
          if (typeof foreground.mattingModel !== "string") throw new Error("Invalid foreground model binding");
          // Resolve BOTH immutable stage credentials before making any paid call.
          const helper = await workspaceProviderResolver.resolve({ workspaceId: job.workspace_id,
            jobId, modality: "image", modelId: foreground.mattingModel, stage: "foreground_matting" });
          if (!helper.scope.imageProvider) throw new Error("Foreground provider unavailable");
          resolution.scope.auxiliaryImageProviders = [
            ...(resolution.scope.auxiliaryImageProviders ?? []),
            helper.scope.imageProvider,
          ];
        }
        execute = () =>
          runWithGenerationProviderScope(resolution.scope, () =>
            executor(jobId, msg.message as Record<string, unknown>, ctx),
          );
      }
    }
    const result = await execute();
    const transitioned = await ctx.jobService.markSucceeded(jobId, result);
    if (transitioned && jobType === "image_generation") {
      try {
        const completedJob = await ctx.jobService.getJobAdmin(jobId);
        const designOutcome = designJobFinalizer
          ? await designJobFinalizer.finalize(completedJob)
          : null;
        if (designOutcome) {
          await finalizeDesignImageJobChat(
            ctx.getAdminClient(),
            completedJob,
            designOutcome.finalization,
          );
        } else {
          await finalizeSucceededImageJob(ctx.getAdminClient(), jobId);
        }
      } catch (finalizeError) {
        // The job and asset are already durable. The periodic recovery scan will
        // retry this idempotently, so canvas delivery errors must not fail or
        // re-run the paid provider request.
        console.error(
          `${tag} Canvas finalization deferred for job ${jobId}:`,
          finalizeError,
        );
      }
    }
    if (!transitioned) {
      const job = await ctx.jobService.getJobAdmin(jobId);
      if (job.status === "canceled") {
        await settleTerminalPlaceholder(job as FinalizableJob);
        await refundTerminalJob(jobId, "canceled", ctx, creditService, tag);
      }
    }
    await ctx.pgmq.deleteMsg(queue, msg.msg_id);
    console.log(
      transitioned
        ? `${tag} Job ${jobId} succeeded +${Date.now() - startTime}ms`
        : `${tag} Job ${jobId} finished after a terminal state won +${Date.now() - startTime}ms`,
    );
  } catch (err) {
    // A schema violation is deterministic and unreadable in its raw form: a
    // ZodError's message is a JSON issue dump, and retrying the same payload can
    // never succeed. Classify it as `invalid_input` (already non-retryable) with
    // a message a person can act on, instead of retrying `executor_error` three
    // times and handing the user a wall of JSON.
    const issues = (err as { issues?: Array<{ path?: unknown[]; message?: string }> })?.issues;
    const schemaViolation = Array.isArray(issues) && issues.length > 0;
    const errorMessage = schemaViolation
      ? `任务参数校验失败：${issues.slice(0, 3).map(issue =>
          `${(issue.path ?? []).join(".") || "参数"} ${issue.message ?? ""}`.trim()).join("；")}`
      : err instanceof Error ? err.message : String(err);
    const errorCode = schemaViolation
      ? "invalid_input"
      : ((err as { code?: string })?.code ?? "executor_error");

    // Non-retryable errors: retrying with the same input will always fail.
    // Dead-letter immediately so the caller (agent polling) gets fast feedback.
    const NON_RETRYABLE_CODES = new Set([
      "job_canceled",
      "invalid_input",
      "background_removal_invalid_output",
      "foreground_policy_required",
      "foreground_policy_mismatch",
      "layer_backend_unconfigured",
      "layer_backend_config_invalid",
      "layer_backend_remote_not_authorized",
      "layer_backend_model_unavailable",
      "layer_backend_unavailable",
      "layer_backend_timeout",
      "layer_output_invalid",
      "layer_output_overlap",
      "layer_checkpoint_invalid",
      "layer_checkpoint_unavailable",
      "image_generation_checkpoint_invalid",
      "image_generation_result_unknown",
      "image_aspect_ratio_mismatch",
      // A provider frame that does not match the composed frame shape is
      // deterministic: the archived provider bytes are reused on every retry, so
      // another attempt can only repeat the same refusal.
      "local_repaint_geometry_mismatch",
      "outpaint_geometry_mismatch",
      "model_not_found",
      "provider_not_found",
      "provider_snapshot_invalid",
      "provider_rejected",
      // The executor already retried this attempt in-process with backoff; the
      // rejected checkpoint then fences the same provider, so another worker
      // attempt could only repeat the refusal.
      "provider_rate_limited",
      "safety_filter",
      "design_renderer_unavailable",
      "design_export_pixel_budget_exceeded",
      "design_export_source_budget_exceeded",
      "design_export_asset_invalid",
      "design_export_timeout",
      "design_export_forbidden",
      "design_export_revision_missing",
      "design_export_revision_corrupt",
      // The encoder produced bytes that do not answer the request (unreadable
      // artifact, or a format other than the one asked for). Re-running the same
      // deterministic render can only produce the same refusal.
      "design_export_artifact_unverified",
      "design_export_artifact_format_mismatch",
    ]);
    const shouldDeadLetter =
      attempt_count >= max_attempts || NON_RETRYABLE_CODES.has(errorCode);

    if (shouldDeadLetter) {
      const transitioned = await ctx.jobService.markDeadLetter(
        jobId,
        errorCode,
        errorMessage,
      );
      await ctx.pgmq.archive(queue, msg.msg_id);

      if (transitioned) {
        await settleTerminalPlaceholder();
        await refundTerminalJob(jobId, "dead_letter", ctx, creditService, tag);
        await recordDesignPreviewTerminalFailure(
          jobType,
          jobId,
          errorCode,
          errorMessage,
          designPreviewFailures,
          tag,
        );
      } else {
        const job = await ctx.jobService.getJobAdmin(jobId);
        if (job.status === "canceled") {
          await settleTerminalPlaceholder(job as FinalizableJob);
          await refundTerminalJob(jobId, "canceled", ctx, creditService, tag);
        }
      }

      console.error(
        `${tag} Job ${jobId} dead-lettered after ${attempt_count} attempts +${Date.now() - startTime}ms: ${errorMessage}`,
      );
    } else {
      const transitioned = await ctx.jobService.markFailed(
        jobId,
        errorCode,
        errorMessage,
      );
      if (transitioned) {
        // Message will re-appear after VT expires for retry.
        console.warn(
          `${tag} Job ${jobId} failed (attempt ${attempt_count}/${max_attempts}) +${Date.now() - startTime}ms: ${errorMessage}`,
        );
      } else {
        const job = await ctx.jobService.getJobAdmin(jobId);
        if (job.status === "canceled") {
          await settleTerminalPlaceholder(job as FinalizableJob);
          await refundTerminalJob(jobId, "canceled", ctx, creditService, tag);
          await ctx.pgmq.archive(queue, msg.msg_id);
        }
      }
    }
  }
}

/**
 * Refund credits for a terminal job if credits were deducted. A prior refund is
 * checked by job id so redelivered queue messages are idempotent.
 */
export async function refundTerminalJob(
  jobId: string,
  terminalStatus: "canceled" | "dead_letter",
  ctx: Pick<ExecutorContext, "getAdminClient">,
  creditService: CreditService,
  tag: string,
) {
  try {
    const admin = ctx.getAdminClient();
    const { data: jobRow } = await admin
      .from("background_jobs")
      .select("credits_cost, workspace_id, created_by, status")
      .eq("id", jobId)
      .single();

    if (!jobRow || jobRow.status !== terminalStatus) return;

    const creditsCost = jobRow.credits_cost ?? 0;
    const workspaceId = jobRow.workspace_id;
    const createdBy = jobRow.created_by;

    if (creditsCost <= 0 || !workspaceId || !createdBy) return;

    const { data: existingRefund, error: refundQueryError } = await admin
      .from("credit_transactions")
      .select("id")
      .eq("job_id", jobId)
      .eq("transaction_type", "generation_refund")
      .limit(1)
      .maybeSingle();
    if (refundQueryError) throw refundQueryError;
    if (existingRefund) return;

    const txId = await creditService.refundCredits(
      workspaceId,
      createdBy,
      creditsCost,
      jobId,
      terminalStatus === "canceled"
        ? "Auto-refund: job canceled"
        : "Auto-refund: job failed",
    );
    console.log(
      `${tag} Refunded ${creditsCost} credits for job ${jobId} (tx: ${txId})`,
    );
  } catch (refundErr) {
    // Log but don't crash the worker — the job is already dead-lettered
    console.error(
      `${tag} Failed to refund credits for job ${jobId}:`,
      refundErr,
    );
  }
}

/** Recover terminal jobs whose one-shot refund path failed. Refunds are
 * idempotent per job, so concurrent maintenance workers remain safe. */
export async function reconcileTerminalJobRefunds(
  ctx: Pick<ExecutorContext, "getAdminClient">,
  creditService: CreditService,
  tag: string,
  limit = 50,
) {
  const admin = ctx.getAdminClient();
  const { data, error } = await admin.from("background_jobs")
    .select("id,status")
    .in("status", ["canceled", "dead_letter"])
    .gt("credits_cost", 0)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  let refunded = 0;
  let failed = 0;
  for (const row of data ?? []) {
    const before = await admin.from("credit_transactions").select("id")
      .eq("job_id", row.id).eq("transaction_type", "generation_refund")
      .limit(1).maybeSingle();
    if (before.error) { failed += 1; continue; }
    if (before.data) continue;
    await refundTerminalJob(row.id, row.status as "canceled" | "dead_letter", ctx, creditService, tag);
    const after = await admin.from("credit_transactions").select("id")
      .eq("job_id", row.id).eq("transaction_type", "generation_refund")
      .limit(1).maybeSingle();
    if (after.data) refunded += 1;
    else failed += 1;
  }
  return { refunded, failed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (!process.env.VITEST) {
  main().catch((err) => {
    console.error("[worker] Fatal error:", err);
    process.exit(1);
  });
}

async function recordDesignPreviewTerminalFailure(
  jobType: BackgroundJobType,
  jobId: string,
  errorCode: string,
  errorMessage: string,
  repository: DesignPreviewFailureRepository | undefined,
  tag: string,
) {
  if (jobType !== "design_preview" || !repository) return;
  try {
    await repository.markError({ jobId, errorCode, errorMessage });
  } catch (error) {
    console.error(
      `${tag} Failed to persist preview terminal state for job ${jobId}:`,
      error,
    );
  }
}
