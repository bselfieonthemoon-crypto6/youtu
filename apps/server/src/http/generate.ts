// @credits-system — Direct generation routes with credit deduction and tier checks
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
  type ImageQualityLevel,
  type VideoResolution,
} from "@loomic/shared";

import { generateImage } from "../generation/image-generation.js";
import { resolveImageProviderName } from "../generation/providers/registry.js";
import type { CreditService } from "../features/credits/credit-service.js";
import { CreditServiceError } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import { TierGuardError } from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import { JobServiceError } from "../features/jobs/job-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type { AuthenticatedUser, RequestAuthenticator } from "../supabase/user.js";
import { safeDownload } from "../security/safe-download.js";
import { validateImageGenerationRequestLimits } from "../generation/image-request-limits.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";

const generateImageRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
  quality: z.enum(["standard", "hd", "ultra"]).optional(),
});

const generateVideoRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  duration: z.number().int().min(3).max(16).optional(),
  resolution: z.enum(["720p", "1080p", "4k"]).optional(),
  aspectRatio: z.enum(["16:9", "9:16"]).optional(),
  inputImages: z.array(z.string()).max(3).optional(),
});

export function httpVideoSubmissionKey(idempotencyKey?: string): string {
  const identity = idempotencyKey ?? randomUUID();
  return `http:${createHash("sha256").update(identity).digest("hex")}`;
}

export async function registerGenerateRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService?: CreditService;
    jobService?: JobService;
    tierGuard?: TierGuard;
    uploadService: UploadService;
    viewerService: ViewerService;
  },
) {
  app.post("/api/agent/generate-image", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }

    let payload: z.infer<typeof generateImageRequestSchema>;
    let billingJobId: string | null = null;
    let billingWorkspaceId: string | null = null;
    let chargedAmount = 0;

    try {
      payload = generateImageRequestSchema.parse(request.body);
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid request body.",
          },
        }),
      );
    }

    const model = payload.model ?? "gpt-image-2-all";
    const limitViolation = validateImageGenerationRequestLimits({
      model,
      prompt: payload.prompt,
    });
    if (limitViolation) {
      return reply.code(422).send(
        applicationErrorResponseSchema.parse({
          error: { code: limitViolation.code, message: limitViolation.message },
        }),
      );
    }

    try {
      // ── Tier guard + credit checks ──
      const viewer = await options.viewerService.ensureViewer(user);
      billingWorkspaceId = viewer.workspace.id;
      let creditsCost = 0;

      if (options.creditService && options.tierGuard) {
        const sub = await options.creditService.getSubscription(viewer.workspace.id);
        const quality: ImageQualityLevel = payload.quality ?? "standard";
        options.tierGuard.checkModelAccess(sub.plan, model);
        // Throws TierGuardError (resolution_not_allowed) if plan doesn't allow this quality
        options.tierGuard.checkResolution(sub.plan, quality);
        await options.tierGuard.checkConcurrency(viewer.workspace.id, sub.plan);
        creditsCost = options.tierGuard.calculateCreditCost(model, "image_generation", { quality });

        // Even this legacy synchronous route uses a durable job as the billing
        // identity. It is never published to PGMQ; this request owns execution.
        if (creditsCost > 0) {
          if (!options.jobService) {
            throw new JobServiceError(
              "job_create_failed",
              "Generation billing is temporarily unavailable.",
              503,
            );
          }
          const job = await options.jobService.createJob(user, {
            workspaceId: viewer.workspace.id,
            jobType: "image_generation",
            payload: {
              prompt: payload.prompt,
              model,
              aspectRatio: payload.aspectRatio ?? "1:1",
              quality: payload.quality ?? "standard",
            },
            deferEnqueue: true,
            providerBilling: {
              creditsCost,
              pricingVersion: "credits-v1",
              unit: "image",
            },
          });
          billingJobId = job.id;
          const txId = await options.creditService.deductCredits(
            viewer.workspace.id, user.id, creditsCost, job.id,
            `Direct image generation: ${model}`,
          );
          chargedAmount = creditsCost;
          await options.jobService.setCreditsInfo(job.id, creditsCost, txId);
          const claimed = await options.jobService.markRunning(job.id);
          if (!claimed) {
            throw new JobServiceError(
              "job_create_failed",
              "Generation job could not be started.",
              409,
            );
          }
        }
      }

      const providerName = resolveImageProviderName(model);
      const result = await generateImage(providerName, {
        prompt: payload.prompt,
        model,
        aspectRatio: payload.aspectRatio ?? "1:1",
        ...(payload.quality ? { quality: payload.quality } : {}),
      });

      // Download and persist to Supabase Storage
      const { signedUrl, assetId } = await downloadAndUpload(
        result.url,
        result.mimeType,
        payload.prompt,
        user,
        options,
      );

      if (billingJobId && options.jobService) {
        await options.jobService.markSucceeded(billingJobId, {
          url: signedUrl,
          assetId,
          mimeType: result.mimeType,
          width: result.width,
          height: result.height,
        });
      }

      return reply.code(200).send({
        url: signedUrl,
        assetId,
        prompt: payload.prompt,
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      if (billingJobId && options.jobService) {
        await options.jobService.cancelJob(user, billingJobId).catch(() => {});
        if (
          chargedAmount > 0 &&
          billingWorkspaceId &&
          options.creditService
        ) {
          await options.creditService.refundCredits(
            billingWorkspaceId,
            user.id,
            chargedAmount,
            billingJobId,
            "Auto-refund: direct image generation failed",
          ).catch(() => {});
        }
      }

      // Handle tier/credit errors
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
      if (error instanceof JobServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }

      const message =
        error instanceof Error ? error.message : "Image generation failed.";

      if (message.includes("No provider registered")) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "provider_not_configured",
              message: "Image generation is not available.",
            },
          }),
        );
      }

      return reply.code(502).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "generation_failed",
            message,
          },
        }),
      );
    }
  });

  // ── POST /api/agent/generate-video ──────────────────────────
  app.post("/api/agent/generate-video", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }

    let payload: z.infer<typeof generateVideoRequestSchema>;
    try {
      payload = generateVideoRequestSchema.parse(request.body);
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid request body.",
          },
        }),
      );
    }

    if (!options.jobService) {
      return reply.code(503).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "service_unavailable",
            message: "Video generation is not available (job service not configured).",
          },
        }),
      );
    }

    const model = payload.model ?? "google-official/veo-3.1-generate-preview";
    const rawIdempotencyKey = request.headers["idempotency-key"];
    if (Array.isArray(rawIdempotencyKey)
      || (typeof rawIdempotencyKey === "string"
        && (rawIdempotencyKey.trim().length === 0 || rawIdempotencyKey.length > 200))) {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: { code: "invalid_request", message: "Invalid Idempotency-Key header." },
        }),
      );
    }
    const submissionKey = httpVideoSubmissionKey(
      typeof rawIdempotencyKey === "string" ? rawIdempotencyKey : undefined,
    );

    try {
      // ── Tier guard + credit checks ──
      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;
      const jobPayload = {
        prompt: payload.prompt,
        model,
        ...(payload.duration != null ? { duration: payload.duration } : {}),
        ...(payload.resolution ? { resolution: payload.resolution } : {}),
        ...(payload.aspectRatio ? { aspect_ratio: payload.aspectRatio } : {}),
        ...(payload.inputImages?.length ? { input_images: payload.inputImages } : {}),
      };
      let job = await options.jobService.findVideoSubmission(user, {
        workspaceId, submissionKey, kind: "http", expectedPayload: jobPayload,
      });

      if (!job) {
        let creditsCost = 0;
        if (options.creditService && options.tierGuard) {
          const sub = await options.creditService.getSubscription(workspaceId);
          options.tierGuard.checkModelAccess(sub.plan, model);
          if (payload.resolution) {
            options.tierGuard.checkVideoResolution(
              sub.plan,
              payload.resolution as VideoResolution,
            );
          }
          await options.tierGuard.checkConcurrency(workspaceId, sub.plan);
          creditsCost = options.tierGuard.calculateCreditCost(
            model,
            "video_generation",
            {
              ...(payload.duration != null ? { duration: payload.duration } : {}),
              ...(payload.resolution
                ? { resolution: payload.resolution as VideoResolution }
                : {}),
            },
          );
        }

        const created = await options.jobService.createJobWithReplay(user, {
          workspaceId,
          jobType: "video_generation",
          deferEnqueue: true,
          videoSubmission: { kind: "http", key: submissionKey },
          providerBilling: {
            creditsCost,
            pricingVersion: "credits-v1",
            unit: "second" as const,
          },
          payload: jobPayload,
        });
        job = created.job;
      }

      if (job.status === "queued") {
        const creditsCost = Number(job.payload.video_credits_cost);
        if (!Number.isSafeInteger(creditsCost) || creditsCost < 0)
          throw new JobServiceError("job_create_failed", "Durable video price is invalid.", 409);
        try {
          await options.jobService.commitVideoJob(user, {
            jobId: job.id, submissionKey, creditsCost,
          });
        } catch (commitError) {
          if (commitError instanceof CreditServiceError) {
            const canceled = await options.jobService.cancelUncommittedVideoJob(user, {
              jobId: job.id, submissionKey,
            }).catch(() => false);
            if (canceled) throw commitError;
          }
          if (commitError instanceof JobServiceError
            && commitError.code === "video_commit_rejected") {
            const canceled = await options.jobService.cancelUncommittedVideoJob(user, {
              jobId: job.id, submissionKey,
            });
            if (canceled) throw commitError;
          }
          // The transaction may have committed while its response was lost.
          // Keep polling this durable identity; the worker recovery scan will
          // publish a still-uncommitted row without creating or charging again.
        }
      }

      // ── Poll until terminal state ──
      const POLL_INTERVAL = 3_000;
      const MAX_WAIT = 300_000; // 5 minutes

      const result = await pollJobUntilDone(
        options.jobService,
        job.id,
        POLL_INTERVAL,
        MAX_WAIT,
      );

      if ("error" in result) {
        return reply.code(502).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "generation_failed",
              message: result.error,
            },
          }),
        );
      }

      return reply.code(200).send({
        url: result.signed_url,
        assetId: result.asset_id,
        prompt: payload.prompt,
        mimeType: result.mime_type,
        width: result.width,
        height: result.height,
        durationSeconds: result.duration_seconds,
      });
    } catch (error) {
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
      if (error instanceof JobServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }

      const message =
        error instanceof Error ? error.message : "Video generation failed.";

      return reply.code(502).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "generation_failed",
            message,
          },
        }),
      );
    }
  });
}

// ── Job polling helper ──────────────────────────────────────

type VideoJobResult = {
  signed_url: string;
  asset_id: string;
  width: number;
  height: number;
  duration_seconds: number;
  mime_type: string;
};

type PollResult = VideoJobResult | { error: string };

async function pollJobUntilDone(
  jobService: JobService,
  jobId: string,
  pollInterval: number,
  maxWait: number,
): Promise<PollResult> {
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const current = await jobService.getJobAdmin(jobId);

    if (current.status === "succeeded" && current.result) {
      const r = current.result as Record<string, unknown>;
      return {
        signed_url: (r.signed_url as string) ?? "",
        asset_id: (r.asset_id as string) ?? "",
        width: (r.width as number) ?? 0,
        height: (r.height as number) ?? 0,
        duration_seconds: (r.duration_seconds as number) ?? 0,
        mime_type: (r.mime_type as string) ?? "video/mp4",
      };
    }

    if (current.status === "dead_letter" || current.status === "canceled") {
      return { error: current.error_message
        ? sanitizeErrorForClient(new Error(current.error_message))
        : `Job ${current.status}` };
    }

    if (
      current.status === "failed" &&
      current.attempt_count >= current.max_attempts
    ) {
      return {
        error: current.error_message
          ? sanitizeErrorForClient(new Error(current.error_message))
          : "Job failed after max retries",
      };
    }

    await delay(pollInterval);
  }

  return { error: `Job timed out after ${maxWait / 1000}s` };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Image download + upload helper ──────────────────────────

async function downloadAndUpload(
  sourceUrl: string,
  mimeType: string,
  prompt: string,
  user: AuthenticatedUser,
  deps: { uploadService: UploadService; viewerService: ViewerService },
): Promise<{ signedUrl: string; assetId: string }> {
  const downloaded = await safeDownload(sourceUrl, {
    kind: "image",
    maxBytes: 30 * 1024 * 1024,
    timeoutMs: 60_000,
    maxRedirects: 2,
    allowDataUri: true,
    expectedMimeType: mimeType,
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/avif"],
  });
  const buffer = downloaded.buffer;
  mimeType = downloaded.mimeType;

  const ext = mimeType === "image/webp" ? "webp" : "png";
  const slug = prompt.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  const fileName = `gen-${slug}-${Date.now()}.${ext}`;

  const viewer = await deps.viewerService.ensureViewer(user);

  const result = await deps.uploadService.uploadFile(user, {
    bucket: "workspace-assets",
    fileName,
    fileBuffer: buffer,
    mimeType,
    workspaceId: viewer.workspace.id,
  });

  return { signedUrl: result.url, assetId: result.asset.id };
}
