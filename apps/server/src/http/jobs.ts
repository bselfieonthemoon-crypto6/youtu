// @credits-system — Job creation routes with credit balance checks and tier enforcement
import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  BackgroundJobStatus,
  BackgroundJobType,
  ImageQualityLevel,
} from "@loomic/shared";
import {
  applicationErrorResponseSchema,
  createImageJobRequestSchema,
  createVideoJobRequestSchema,
  getPlanConfig,
  jobListResponseSchema,
  jobResponseSchema,
  normalizeImageGenerationPayload,
  normalizeVideoGenerationPayload,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  insertImageElement,
  insertVideoElement,
} from "../features/canvas/canvas-element-writer.js";
import {
  type CreditService,
  CreditServiceError,
} from "../features/credits/credit-service.js";
import {
  type TierGuard,
  TierGuardError,
} from "../features/credits/tier-guard.js";
import {
  type JobService,
  JobServiceError,
} from "../features/jobs/job-service.js";
import type { WorkspaceModelCatalogService } from "../features/providers/index.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import type { UserSupabaseClient } from "../supabase/user.js";

export async function registerJobRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService?: CreditService;
    jobService: JobService;
    tierGuard?: TierGuard;
    viewerService: ViewerService;
    createUserClient?: (accessToken: string) => UserSupabaseClient;
    workspaceModelCatalogService?: WorkspaceModelCatalogService;
  },
) {
  // POST /api/jobs/image-generation — create image generation job
  app.post(
    "/api/jobs/image-generation",
    { bodyLimit: 20 * 1024 * 1024 },
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthenticated(reply);

        const payload = createImageJobRequestSchema.parse(request.body);
        const normalizedPayload = normalizeImageGenerationPayload(request.body);
        const viewer = await options.viewerService.ensureViewer(user);
        const isLocalImageOperation =
          payload.operation === "remove_background" ||
          payload.operation === "region_matting" ||
          payload.operation === "split_layers" ||
          payload.operation === "erase_transparent" ||
          payload.operation === "smart_erase";
        let workspaceId = viewer.workspace.id;
        let projectId = payload.project_id;
        let effectiveTarget = normalizedPayload.target;
        if (isLocalImageOperation && effectiveTarget?.kind === "design") {
          const resolved =
            await options.jobService.resolveDesignOperationTarget(
              user,
              effectiveTarget,
            );
          workspaceId = resolved.workspaceId;
          projectId = resolved.projectId;
          effectiveTarget = resolved.target;
        }
        const { target: _requestTarget, ...jobPayload } = normalizedPayload;

        // Credit checks (skip if credit system not configured)
        const model = isLocalImageOperation
          ? "local:feynobg"
          : (payload.model ?? "black-forest-labs/flux-kontext-pro");
        const billingModel = await resolveBillingModel(
          options.workspaceModelCatalogService,
          user,
          workspaceId,
          model,
          "image",
        );
        let creditsCost = 0;

        if (
          !isLocalImageOperation &&
          options.creditService &&
          options.tierGuard
        ) {
          const sub = await options.creditService.getSubscription(workspaceId);
          const planConfig = getPlanConfig(sub.plan);
          // Use the plan's max resolution as the quality for cost calculation
          const quality: ImageQualityLevel = planConfig.maxResolution;
          options.tierGuard.checkModelAccess(sub.plan, billingModel);
          await options.tierGuard.checkConcurrency(workspaceId, sub.plan);
          creditsCost = options.tierGuard.calculateCreditCost(
            billingModel,
            "image_generation",
            { quality },
          );
        }

        const createInput = {
          workspaceId,
          ...(projectId !== undefined ? { projectId } : {}),
          target: effectiveTarget,
          ...(payload.session_id !== undefined
            ? { sessionId: payload.session_id }
            : {}),
          ...(payload.thread_id !== undefined
            ? { threadId: payload.thread_id }
            : {}),
          jobType: "image_generation",
          deferEnqueue: true,
          providerBilling: {
            creditsCost,
            pricingVersion: "credits-v1",
            unit: "image",
          },
          payload: {
            ...jobPayload,
            model,
          },
        } as const;
        const creation =
          effectiveTarget?.kind === "design"
            ? await options.jobService.createJobWithReplay(user, createInput)
            : {
                job: await options.jobService.createJob(user, createInput),
                replayed: false,
                billingCommitted: false,
              };
        const { job, replayed, billingCommitted } = creation;

        // Publish only after billing commits. A deferred record is invisible to
        // workers, so failed payment can never trigger a provider call.
        let charged = false;
        let publishReady = creditsCost === 0 || billingCommitted;
        try {
          if (options.creditService && creditsCost > 0 && !billingCommitted) {
            const deduction = options.creditService.deductCreditsIdempotent
              ? await options.creditService.deductCreditsIdempotent(
                  workspaceId,
                  user.id,
                  creditsCost,
                  job.id,
                  `Image generation: ${model}`,
                )
              : {
                  transactionId: await options.creditService.deductCredits(
                    workspaceId,
                    user.id,
                    creditsCost,
                    job.id,
                    `Image generation: ${model}`,
                  ),
                  chargedNew: true,
                };
            const txId = deduction.transactionId;
            charged = deduction.chargedNew;
            await options.jobService.setCreditsInfo(job.id, creditsCost, txId);
            publishReady = true;
          }
          if (job.status === "queued") {
            await options.jobService.enqueueJob(user, job.id);
          }
        } catch (billingOrEnqueueError) {
          // A replay never owns the shared durable job. Once billing has
          // committed, a design-target job is also recoverable by the queued
          // job republisher, so an enqueue transport failure must not cancel it.
          const keepForRecovery =
            effectiveTarget?.kind === "design" && publishReady;
          if (!replayed && !keepForRecovery) {
            await options.jobService.cancelJob(user, job.id).catch(() => {});
          }
          if (
            !replayed &&
            !keepForRecovery &&
            charged &&
            options.creditService
          ) {
            await options.creditService
              .refundCredits(
                workspaceId,
                user.id,
                creditsCost,
                job.id,
                "Auto-refund: job was not enqueued",
              )
              .catch((refundError) => {
                request.log.error(
                  refundError,
                  "Failed to refund unqueued image job",
                );
              });
          }
          throw billingOrEnqueueError;
        }

        return reply.code(201).send(jobResponseSchema.parse({ job }));
      } catch (error) {
        if (isZodError(error)) {
          return reply
            .code(400)
            .send({ issues: error.issues, message: "Invalid request body" });
        }
        return sendJobError(error, reply, "job_create_failed");
      }
    },
  );

  // POST /api/jobs/video-generation — create video generation job
  app.post("/api/jobs/video-generation", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const payload = createVideoJobRequestSchema.parse(request.body);
      const normalizedPayload = normalizeVideoGenerationPayload(request.body);
      const viewer = await options.viewerService.ensureViewer(user);

      // Credit checks (skip if credit system not configured)
      const model = payload.model ?? "wan-video/wan-2.6";
      const billingModel = await resolveBillingModel(
        options.workspaceModelCatalogService,
        user,
        viewer.workspace.id,
        model,
        "video",
      );
      let creditsCost = 0;

      if (options.creditService && options.tierGuard) {
        const sub = await options.creditService.getSubscription(
          viewer.workspace.id,
        );
        options.tierGuard.checkModelAccess(sub.plan, billingModel);
        await options.tierGuard.checkConcurrency(viewer.workspace.id, sub.plan);
        creditsCost = options.tierGuard.calculateCreditCost(
          billingModel,
          "video_generation",
          payload.duration != null ? { duration: payload.duration } : {},
        );
      }

      const job = await options.jobService.createJob(user, {
        workspaceId: viewer.workspace.id,
        ...(payload.project_id !== undefined
          ? { projectId: payload.project_id }
          : {}),
        target: normalizedPayload.target,
        ...(payload.session_id !== undefined
          ? { sessionId: payload.session_id }
          : {}),
        ...(payload.thread_id !== undefined
          ? { threadId: payload.thread_id }
          : {}),
        jobType: "video_generation",
        deferEnqueue: true,
        providerBilling: {
          creditsCost,
          pricingVersion: "credits-v1",
          unit: "second",
        },
        payload: normalizedPayload,
      });

      let charged = false;
      try {
        if (options.creditService && creditsCost > 0) {
          const txId = await options.creditService.deductCredits(
            viewer.workspace.id,
            user.id,
            creditsCost,
            job.id,
            `Video generation: ${model}`,
          );
          charged = true;
          await options.jobService.setCreditsInfo(job.id, creditsCost, txId);
        }
        await options.jobService.enqueueJob(user, job.id);
      } catch (billingOrEnqueueError) {
        await options.jobService.cancelJob(user, job.id).catch(() => {});
        if (charged && options.creditService) {
          await options.creditService
            .refundCredits(
              viewer.workspace.id,
              user.id,
              creditsCost,
              job.id,
              "Auto-refund: job was not enqueued",
            )
            .catch((refundError) => {
              request.log.error(
                refundError,
                "Failed to refund unqueued video job",
              );
            });
        }
        throw billingOrEnqueueError;
      }

      return reply.code(201).send(jobResponseSchema.parse({ job }));
    } catch (error) {
      if (isZodError(error)) {
        return reply
          .code(400)
          .send({ issues: error.issues, message: "Invalid request body" });
      }
      return sendJobError(error, reply, "job_create_failed");
    }
  });

  // GET /api/jobs/:jobId — get job status
  app.get("/api/jobs/:jobId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { jobId } = request.params as { jobId: string };
      let job = await options.jobService.getJob(user, jobId);

      // Stored media URLs are deliberately short-lived. Refresh them whenever
      // the owning client reads a completed job so persisted chat previews can
      // recover after their original signed URL expires.
      if (
        job.status === "succeeded" &&
        job.result &&
        options.createUserClient
      ) {
        const assetId =
          readNonEmptyString(job.result.asset_id) ??
          (job.job_type === "design_export"
            ? readNonEmptyString(job.result.asset_object_id)
            : null);
        if (assetId) {
          const client = options.createUserClient(user.accessToken);
          const asset = await resolveRestorableAsset(client, assetId);
          if (asset) {
            const { data } = await client.storage
              .from(asset.bucket)
              .createSignedUrl(asset.objectPath, 900);
            if (data?.signedUrl) {
              job = {
                ...job,
                result: { ...job.result, signed_url: data.signedUrl },
              };
            }
          }
        }
      }

      if (job.status === "succeeded" && job.target_kind === "design") {
        const finalization = await options.jobService.getTargetFinalization(
          user,
          job.id,
        );
        if (finalization) {
          job = {
            ...job,
            result: {
              ...(job.result ?? {}),
              ...(finalization.result ?? {}),
              target_finalization: finalization,
            },
          };
        }
      }

      return reply.code(200).send(jobResponseSchema.parse({ job }));
    } catch (error) {
      return sendJobError(error, reply, "job_query_failed");
    }
  });

  app.post("/api/jobs/:jobId/restore-to-canvas", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { jobId } = request.params as { jobId: string };
      const job = await options.jobService.getJob(user, jobId);
      // Keep ownership enforcement explicit in addition to database RLS so a
      // future service-role implementation cannot expose another user's job.
      if (job.created_by !== user.id) {
        return sendRestoreError(
          reply,
          404,
          "job_not_found",
          "未找到该生成任务。",
        );
      }
      if (job.status !== "succeeded") {
        return sendRestoreError(
          reply,
          409,
          "job_not_succeeded",
          "生成任务尚未成功，暂时无法恢复到画布。",
        );
      }
      if (!job.canvas_id) {
        return sendRestoreError(
          reply,
          422,
          "job_canvas_missing",
          "生成任务没有关联画布，无法恢复。",
        );
      }
      if (!options.createUserClient) {
        return sendRestoreError(
          reply,
          503,
          "restore_unavailable",
          "画布恢复服务暂不可用。",
        );
      }

      const result = job.result;
      if (!result) {
        return sendRestoreError(
          reply,
          422,
          "job_result_invalid",
          "生成结果不完整，无法恢复到画布。",
        );
      }
      const client = options.createUserClient(user.accessToken);
      let restored: { elementId: string; inserted: boolean };

      if (job.job_type === "image_generation") {
        const objectPath = readNonEmptyString(result.object_path);
        const assetId = readNonEmptyString(result.asset_id);
        const width = readPositiveNumber(result.width);
        const height = readPositiveNumber(result.height);
        const mimeType = readNonEmptyString(result.mime_type);
        const title = readNonEmptyString(job.payload.title);
        const prompt = readNonEmptyString(job.payload.prompt);
        const resultModel = readNonEmptyString(job.payload.model);
        const quality = readNonEmptyString(job.payload.quality);
        if (!assetId || !objectPath || !width || !height || !mimeType) {
          return sendRestoreError(
            reply,
            422,
            "job_result_invalid",
            "图片生成结果不完整，无法恢复到画布。",
          );
        }
        const asset = await resolveRestorableAsset(client, assetId);
        if (!asset) {
          return sendRestoreError(
            reply,
            410,
            "asset_deleted",
            "该文件已从画布删除，不能恢复。",
          );
        }
        restored = await insertImageElement(client, {
          canvasId: job.canvas_id,
          sourceJobId: job.id,
          assetId,
          objectPath: asset.objectPath,
          width,
          height,
          mimeType,
          ...(title ? { title } : {}),
          ...(prompt ? { prompt } : {}),
          ...(resultModel ? { model: resultModel } : {}),
          ...(quality ? { quality } : {}),
        });
      } else if (job.job_type === "video_generation") {
        const signedUrl = readNonEmptyString(result.signed_url);
        const assetId = readNonEmptyString(result.asset_id);
        const width = readPositiveNumber(result.width);
        const height = readPositiveNumber(result.height);
        const mimeType = readNonEmptyString(result.mime_type);
        const durationSeconds = readPositiveNumber(result.duration_seconds);
        const title = readNonEmptyString(job.payload.title);
        const prompt = readNonEmptyString(job.payload.prompt);
        if (!assetId || !signedUrl || !width || !height || !mimeType) {
          return sendRestoreError(
            reply,
            422,
            "job_result_invalid",
            "视频生成结果不完整，无法恢复到画布。",
          );
        }
        const asset = await resolveRestorableAsset(client, assetId);
        if (!asset) {
          return sendRestoreError(
            reply,
            410,
            "asset_deleted",
            "该文件已从画布删除，不能恢复。",
          );
        }
        const { data: signedData, error: signedError } = await client.storage
          .from(asset.bucket)
          .createSignedUrl(asset.objectPath, 900);
        if (signedError || !signedData?.signedUrl) {
          return sendRestoreError(
            reply,
            410,
            "asset_deleted",
            "该文件已从画布删除，不能恢复。",
          );
        }
        restored = await insertVideoElement(client, {
          canvasId: job.canvas_id,
          sourceJobId: job.id,
          assetId,
          signedUrl: signedData.signedUrl,
          width,
          height,
          mimeType,
          ...(durationSeconds ? { durationSeconds } : {}),
          ...(title ? { title } : {}),
          ...(prompt ? { prompt } : {}),
        });
      } else {
        return sendRestoreError(
          reply,
          422,
          "job_type_not_restorable",
          "该任务类型不能恢复到画布。",
        );
      }

      return reply.code(200).send({
        jobId: job.id,
        canvasId: job.canvas_id,
        elementId: restored.elementId,
        inserted: restored.inserted,
      });
    } catch (error) {
      if (error instanceof JobServiceError) {
        return sendRestoreError(
          reply,
          error.statusCode,
          error.code,
          error.code === "job_not_found"
            ? "未找到该生成任务。"
            : "查询生成任务失败，请稍后重试。",
        );
      }
      request.log.error(error, "Failed to restore generation job to canvas");
      return sendRestoreError(
        reply,
        500,
        "job_restore_failed",
        "恢复到画布失败，请稍后重试。",
      );
    }
  });

  // GET /api/jobs — list jobs
  app.get("/api/jobs", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const query = request.query as { status?: string; job_type?: string };
      const filters: {
        status?: BackgroundJobStatus;
        jobType?: BackgroundJobType;
      } = {};
      if (query.status) filters.status = query.status as BackgroundJobStatus;
      if (query.job_type) filters.jobType = query.job_type as BackgroundJobType;
      const jobs = await options.jobService.listJobs(user, filters);

      return reply.code(200).send(jobListResponseSchema.parse({ jobs }));
    } catch (error) {
      return sendJobError(error, reply, "job_query_failed");
    }
  });

  // POST /api/jobs/:jobId/cancel — cancel job
  app.post("/api/jobs/:jobId/cancel", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { jobId } = request.params as { jobId: string };
      const job = await options.jobService.cancelJob(user, jobId);

      // Do not depend solely on the worker observing a canceled queue message:
      // refund immediately from the authoritative job billing record. The DB
      // partial unique index makes a concurrent worker refund idempotent.
      if (options.creditService) {
        try {
          const creditsCost = await options.jobService.getCreditsCost(job.id);
          if (creditsCost > 0) {
            await options.creditService.refundCredits(
              job.workspace_id,
              user.id,
              creditsCost,
              job.id,
              "Auto-refund: job canceled by user",
            );
          }
        } catch (refundError) {
          // Cancellation is already durable. A worker may also perform the
          // idempotent refund; do not turn a successful cancel into a 500.
          request.log.error(
            refundError,
            "Failed to refund canceled job immediately",
          );
        }
      }

      return reply.code(200).send(jobResponseSchema.parse({ job }));
    } catch (error) {
      return sendJobError(error, reply, "job_cancel_failed");
    }
  });
}

async function resolveRestorableAsset(
  client: UserSupabaseClient,
  assetId: string,
): Promise<{ bucket: string; objectPath: string } | null> {
  const { data, error } = await client
    .from("asset_objects")
    .select("bucket, object_path, deletion_pending_at")
    .eq("id", assetId)
    .is("deletion_pending_at", null)
    .maybeSingle();
  if (error || !data) return null;
  return { bucket: data.bucket, objectPath: data.object_path };
}

async function resolveBillingModel(
  catalog: WorkspaceModelCatalogService | undefined,
  user: Parameters<WorkspaceModelCatalogService["resolvePublishedModel"]>[0],
  workspaceId: string,
  modelRef: string,
  modality: "image" | "video",
) {
  if (!modelRef.startsWith("workspace:")) return modelRef;
  const resolved = catalog
    ? await catalog.resolvePublishedModel(user, workspaceId, modelRef, modality)
    : null;
  if (!resolved) {
    throw new JobServiceError(
      "job_create_failed",
      "Workspace model is unavailable or has not passed its connection test.",
      409,
    );
  }
  return resolved.upstreamModelId;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function sendRestoreError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
) {
  return reply.code(statusCode).send({ error: { code, message } });
}

function sendUnauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

type JobErrorFallbackCode =
  | "job_not_found"
  | "job_create_failed"
  | "job_query_failed"
  | "job_cancel_failed";

function sendJobError(
  error: unknown,
  reply: FastifyReply,
  fallbackCode: JobErrorFallbackCode,
) {
  if (error instanceof JobServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  if (error instanceof TierGuardError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  if (error instanceof CreditServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: fallbackCode,
        message: "An unexpected error occurred.",
      },
    }),
  );
}

function isZodError(
  error: unknown,
): error is { issues: unknown[]; name: string } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}
