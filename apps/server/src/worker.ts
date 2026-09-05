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
import { loadServerEnv } from "./config/env.js";
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
  reconcileSucceededDesignImageChats,
  reconcileSucceededImageJobs,
} from "./features/jobs/job-canvas-finalizer.js";
import { createProviderSnapshotService } from "./features/providers/index.js";
import { runWithGenerationProviderScope } from "./generation/providers/registry.js";
import {
  type WorkspaceProviderResolver,
  createWorkspaceProviderResolver,
} from "./generation/providers/workspace-provider-resolver.js";

// 代码执行由 LocalShellBackend 的内置 execute 工具直接处理，不走 PGMQ。
export const WORKER_QUEUES = [
  "image_generation_jobs",
  "video_generation_jobs",
  "design_preview_jobs",
  "design_export_jobs",
] as const;

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
  const workerId = env.workerId ?? randomUUID().slice(0, 8);
  const tag = `[worker:${workerId}]`;

  let running = true;
  let designResourceImportPoll: Promise<void> = Promise.resolve();

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
    `${tag} Started. concurrency={${concurrencyDesc}}, longPollTimeout=${pollTimeoutSeconds}s`,
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

  const pollQueue = async (queue: (typeof WORKER_QUEUES)[number]) => {
    while (running) {
      try {
        if (queue === "image_generation_jobs") {
          await reconcileCanvases();
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
      await refundTerminalJob(jobId, "canceled", ctx, creditService, tag);
      await ctx.pgmq.archive(queue, msg.msg_id);
    } else if (job.status === "running") {
      // Another worker may still own the job. Keep the message recoverable;
      // markRunning will reclaim it once its durable lease is stale.
      await ctx.pgmq.setVt(queue, msg.msg_id, VT_BY_QUEUE[queue] ?? 120);
      console.log(`${tag} Deferred in-progress job ${jobId} for recovery`);
      return;
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
  const { attempt_count, max_attempts } =
    await ctx.jobService.incrementAttempt(jobId);

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
        const resolution = await workspaceProviderResolver.resolve({
          workspaceId: job.workspace_id,
          jobId,
          modality: jobType === "image_generation" ? "image" : "video",
          modelId,
        });
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
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorCode = (err as { code?: string })?.code ?? "executor_error";

    // Non-retryable errors: retrying with the same input will always fail.
    // Dead-letter immediately so the caller (agent polling) gets fast feedback.
    const NON_RETRYABLE_CODES = new Set([
      "invalid_input",
      "model_not_found",
      "provider_not_found",
      "provider_snapshot_invalid",
      "safety_filter",
      "design_renderer_unavailable",
      "design_export_pixel_budget_exceeded",
      "design_export_source_budget_exceeded",
      "design_export_asset_invalid",
      "design_export_timeout",
      "design_export_forbidden",
      "design_export_revision_missing",
      "design_export_revision_corrupt",
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
  ctx: ExecutorContext,
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
