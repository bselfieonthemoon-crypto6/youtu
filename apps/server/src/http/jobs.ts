// @credits-system — Job creation routes with credit balance checks and tier enforcement
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type {
  BackgroundJobStatus,
  BackgroundJobType,
  ImageQualityLevel,
} from "@loomic/shared";
import {
  applicationErrorResponseSchema,
  backgroundJobStatusSchema,
  backgroundJobTypeSchema,
  createImageJobRequestSchema,
  createVideoJobRequestSchema,
  jobListResponseSchema,
  jobResponseSchema,
  normalizeImageGenerationPayload,
  normalizeVideoGenerationPayload,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";

function publicJobError<T extends { error_message?: string | null }>(job: T): T {
  return job.error_message
    ? { ...job, error_message: sanitizeErrorForClient(new Error(job.error_message)) }
    : job;
}

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
  imageResolutionBillingQuality,
} from "../features/credits/tier-guard.js";
import {
  type JobService,
  JobServiceError,
} from "../features/jobs/job-service.js";
import type { WorkspaceModelCatalogService } from "../features/providers/index.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import type { UserSupabaseClient } from "../supabase/user.js";
import { isLocalImageOperation as usesLocalImageBackend } from "../features/images/local-image-operation.js";
import { requiresTransparentForeground, prepareForegroundPolicy } from "../features/images/foreground-policy.js";
import { checkQwenLayerBackend, QwenLayerError, QWEN_LAYER_MODEL } from "../features/images/qwen-layer-separation.js";
import { validateImageGenerationRequestLimits } from "../generation/image-request-limits.js";

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
  app.get("/api/images/layer-backend", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);
    return reply.send(await checkQwenLayerBackend());
  });
  app.get("/api/images/semantic-layer-backend", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);
      // `layer_count: 1` is the box-selection flow: one framed element plus the
      // repaired background. It quotes the same two paid calls as any 1-element
      // split, so the user sees the exact cost before drawing the box.
      const query = z.object({ layer_count: z.coerce.number().int().min(1).max(4), model: z.string().optional() }).parse(request.query);
      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;
      const model = await resolveSemanticLayerModel(options.workspaceModelCatalogService, user, workspaceId, query.model);
      const displayName = (await options.workspaceModelCatalogService?.listPublished(user, workspaceId))
        ?.find(entry => entry.model.id === model)?.model.displayName ?? "GPT Image 2.5";
      const billingModel = await resolveBillingModel(options.workspaceModelCatalogService, user, workspaceId, model, "image");
      let credits = 0;
      if (options.creditService && options.tierGuard) {
        const sub = await options.creditService.getSubscription(workspaceId);
        options.tierGuard.checkModelAccess(sub.plan, billingModel);
        options.tierGuard.checkResolution(sub.plan, "standard");
        credits = options.tierGuard.calculateCreditCost(billingModel, "image_generation",
          { quality: "standard", imageResolution: "1k" }) * (query.layer_count + 1);
      }
      return reply.send({ available: true, model, displayName, calls: query.layer_count + 1,
        credits, quality: "standard", resolution: "1k", layerCount: query.layer_count });
    } catch (error) {
      if (isZodError(error)) return reply.code(400).send({ issues: error.issues, message: "Invalid query" });
      return sendJobError(error, reply, "job_create_failed");
    }
  });
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
        const isLocalImageOperation = usesLocalImageBackend(payload.operation);
        const usesSemanticLayers = payload.operation === "split_layers" && payload.layer_backend === "semantic";
        if (usesSemanticLayers) {
          // The first semantic flow is explicitly quoted at Low + 1K. Reject
          // unquoted higher stages instead of silently increasing paid calls.
          if ((payload.quality && payload.quality !== "standard") ||
              (payload.resolution && payload.resolution !== "1k")) {
            return reply.code(422).send({ error: { code: "layer_quality_unquoted",
              message: "当前语义分层报价仅支持 Low + 1K，请先使用该档位。" } });
          }
          normalizedPayload.quality = "standard";
          normalizedPayload.resolution = "1k";
        }
        const isBackgroundRemoval = payload.operation === "remove_background";
        const usesDedicatedLayers = payload.model === QWEN_LAYER_MODEL;
        if (payload.operation === "split_layers" && /qwen.*layer/i.test(payload.model ?? "") && !usesDedicatedLayers)
          throw new QwenLayerError("invalid_input", "请使用已配置的专用分层模型标识 qwen-image-layered；未回退到本地抠图。", 422);
        if (usesDedicatedLayers) {
          if (payload.operation !== "split_layers") throw new QwenLayerError("invalid_input", "Qwen-Image-Layered 仅用于图片分层。", 422);
          if (payload.input_images?.length !== 1 && normalizedPayload.target?.kind !== "design") throw new QwenLayerError("invalid_input", "专用分层需要单张已选择的原图。", 422);
          const status = await checkQwenLayerBackend();
          if (!status.available) throw new QwenLayerError("layer_backend_unavailable", status.reason);
        }
        let workspaceId = viewer.workspace.id;
        let projectId = payload.project_id;
        let effectiveTarget = normalizedPayload.target;
        if ((isLocalImageOperation || isBackgroundRemoval || payload.operation === "local_repaint") && effectiveTarget?.kind === "design") {
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
        const model = usesSemanticLayers
          ? await resolveSemanticLayerModel(options.workspaceModelCatalogService, user, workspaceId, payload.model)
          : isBackgroundRemoval
          ? await resolveBackgroundRemovalModel(options.workspaceModelCatalogService, user, workspaceId)
          : isLocalImageOperation
          ? usesDedicatedLayers ? QWEN_LAYER_MODEL : "local:feynobg"
          : (payload.model ?? "black-forest-labs/flux-kontext-pro");
        const billingModel = await resolveBillingModel(
          options.workspaceModelCatalogService,
          user,
          workspaceId,
          model,
          "image",
        );
        // Validate documented upstream limits before creating a job or quoting
        // credits. Third-party aliases only inherit this profile when their
        // resolved upstream model is exactly gpt-image-2.
        const limitViolation = validateImageGenerationRequestLimits({
          model,
          upstreamModelId: billingModel,
          prompt: payload.prompt,
          ...(payload.input_images ? { inputImages: payload.input_images } : {}),
        });
        if (limitViolation) {
          return reply.code(422).send({
            error: { code: limitViolation.code, message: limitViolation.message },
          });
        }
        let creditsCost = 0;

        if (
          (!isLocalImageOperation || usesSemanticLayers) &&
          options.creditService &&
          options.tierGuard
        ) {
          const sub = await options.creditService.getSubscription(workspaceId);
          // Provider quality and native pixel resolution are separate. Charge
          // the higher tier, never the plan maximum or a silently lower tier.
          const quality: ImageQualityLevel = imageResolutionBillingQuality(
            normalizedPayload.resolution,
            (normalizedPayload.quality as ImageQualityLevel | undefined) ?? "standard",
          );
          options.tierGuard.checkModelAccess(sub.plan, billingModel);
          options.tierGuard.checkResolution(sub.plan, quality);
          await options.tierGuard.checkConcurrency(workspaceId, sub.plan);
          creditsCost = options.tierGuard.calculateCreditCost(
            billingModel,
            "image_generation",
            { quality, ...(normalizedPayload.resolution ? { imageResolution: normalizedPayload.resolution } : {}) },
          );
          if (usesSemanticLayers) creditsCost *= (payload.layer_names?.length ?? 0) + 1;
        }

        // Direct callers cannot authorize a hidden second paid stage. Native
        // transparency uses the selected gpt-image-2 request with no extra call.
        const needsForeground = requiresTransparentForeground({ ...normalizedPayload, model });
        if (needsForeground && billingModel !== "gpt-image-2") {
          return reply.code(409).send({ error: { code: "foreground_confirmation_required",
            message: "此画板前景需要额外 API 抠图。请先通过 Agent 确认生图与抠图两步及总费用；尚未生成或扣费。" } });
        }
        const foregroundPolicy = needsForeground ? prepareForegroundPolicy({ ...normalizedPayload, model },
          [{ id: model, upstreamModelId: billingModel, displayName: model, description: "", provider: "confirmed" }], () => creditsCost) : undefined;
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
            ...(foregroundPolicy ? { foreground_policy: foregroundPolicy } : {}),
          },
        } as const;
        const creation =
          effectiveTarget?.kind === "design" ||
          ((payload.operation === "local_repaint" ||
            payload.operation === "outpaint") &&
            effectiveTarget?.kind === "canvas" &&
            effectiveTarget.element_id !== undefined)
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
      if (!z.string().uuid().safeParse(jobId).success) {
        return reply.code(400).send({ message: "Invalid job identifier" });
      }
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

      return reply.code(200).send(jobResponseSchema.parse({ job: publicJobError(job) }));
    } catch (error) {
      return sendJobError(error, reply, "job_query_failed");
    }
  });

  app.post("/api/jobs/:jobId/restore-to-canvas", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { jobId } = request.params as { jobId: string };
      if (!z.string().uuid().safeParse(jobId).success) {
        return reply.code(400).send({ message: "Invalid job identifier" });
      }
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
      if (job.target_kind === "design") {
        const finalization = await options.jobService.getTargetFinalization(
          user,
          job.id,
        );
        const applied = finalization?.status === "completed";
        return sendRestoreError(
          reply,
          409,
          applied
            ? "design_job_already_applied"
            : "design_job_requires_attention",
          applied
            ? "图片已经应用到原生设计，不能再恢复为顶层画布元素。"
            : "图片素材已生成，但没有应用到原生设计。请打开原设计，按当前版本重新放置该素材；不要重新生成图片。",
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
      const knownElementId = readNonEmptyString(result.canvas_element_id);
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
          rejectDeletedSourceJob: true,
          ...(knownElementId ? { knownElementId } : {}),
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
          rejectDeletedSourceJob: true,
          ...(knownElementId ? { knownElementId } : {}),
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
      if (hasErrorCode(error, "canvas_result_deleted")) {
        return sendRestoreError(
          reply,
          409,
          "canvas_result_deleted",
          "该生成结果此前已从画布删除，不能恢复。",
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

      const query = request.query as { status?: unknown; job_type?: unknown };
      const parsedStatus = backgroundJobStatusSchema.optional().safeParse(query.status);
      const parsedType = backgroundJobTypeSchema.optional().safeParse(query.job_type);
      if (!parsedStatus.success || !parsedType.success) {
        return reply.code(400).send({ message: "Invalid job filters" });
      }
      const filters: {
        status?: BackgroundJobStatus;
        jobType?: BackgroundJobType;
      } = {};
      if (parsedStatus.data) filters.status = parsedStatus.data;
      if (parsedType.data) filters.jobType = parsedType.data;
      const jobs = await options.jobService.listJobs(user, filters);

      return reply.code(200).send(jobListResponseSchema.parse({ jobs: jobs.map(publicJobError) }));
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
      if (!z.string().uuid().safeParse(jobId).success) {
        return reply.code(400).send({ message: "Invalid job identifier" });
      }
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

      return reply.code(200).send(jobResponseSchema.parse({ job: publicJobError(job) }));
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

export async function resolveBackgroundRemovalModel(
  catalog: WorkspaceModelCatalogService | undefined,
  user: Parameters<WorkspaceModelCatalogService["listPublished"]>[0],
  workspaceId: string,
) {
  const entries = catalog ? await catalog.listPublished(user, workspaceId) : [];
  const match = entries.find(entry => entry.upstreamModelId === "gpt-image-2.5-flare" &&
    entry.model.modality === "image" && entry.model.capabilities.includes("image_generation"));
  if (!match) throw new JobServiceError("job_create_failed", "去除背景需要启用 gpt-image-2.5-flare，请检查后台模型配置。", 409);
  return match.model.id;
}

export async function resolveSemanticLayerModel(
  catalog: WorkspaceModelCatalogService | undefined,
  user: Parameters<WorkspaceModelCatalogService["listPublished"]>[0],
  workspaceId: string,
  requested?: string,
) {
  const entries = catalog ? await catalog.listPublished(user, workspaceId) : [];
  const compatible = entries.filter(entry =>
    entry.model.modality === "image" &&
    entry.model.capabilities.includes("image_generation") &&
    ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].includes(entry.upstreamModelId));
  const match = requested
    ? compatible.find(entry => entry.model.id === requested)
    : compatible.find(entry => entry.upstreamModelId === "gpt-image-2.5-flare") ?? compatible[0];
  if (!match) throw new JobServiceError("job_create_failed",
    "语义图层拆分需要已发布并通过连接测试的 gpt-image-2.5-flare 或 sunburst 模型。", 409);
  return match.model.id;
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
  const compatible = resolved ?? (
    modality === "image" && catalog?.resolveCompatibleImageFallback
      ? await catalog.resolveCompatibleImageFallback(user, workspaceId, modelRef)
      : null
  );
  if (!compatible) {
    throw new JobServiceError(
      "job_create_failed",
      "Workspace model is unavailable or has not passed its connection test.",
      409,
    );
  }
  return compatible.upstreamModelId;
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

function hasErrorCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
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
  if (error instanceof QwenLayerError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
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
