import { createHash } from "node:crypto";
import sharp from "sharp";
import { assertImageAspectRatio, readImageDimensions } from "./image-dimensions.js";
import { postprocessDesignImage } from "./design-image-postprocess.js";
import {
  createDurableProviderImagePersistence,
  recoverOrGenerateImageSource,
} from "./image-source-checkpoint.js";
import {
  createImageGenerationCheckpoint,
  deterministicAssetId,
  generationSourceAssetBinding,
} from "./image-generation-checkpoint.js";
import { generateImage } from "../../../generation/image-generation.js";
import {
  getImageProviderAttempts,
  resolveImageProviderName,
} from "../../../generation/providers/registry.js";
import {
  safeDownload,
  validateDownloadedBuffer,
} from "../../../security/safe-download.js";
import { processWithFeynobg } from "../../images/feynobg-service.js";
import { isLocalImageOperation } from "../../images/local-image-operation.js";
import { removeBackgroundWithApi, validateTransparentPng } from "../../images/api-background-removal.js";
import {
  composeLocalRepaint,
  localRepaintRequest,
  prepareLocalRepaint,
  type PreparedLocalRepaint,
} from "../../images/local-repaint.js";
import {
  directOutpaintRequest,
} from "../../images/outpaint.js";
import { normalizePersistedGenerationJob } from "../design-target-normalizer.js";
// Generated images are delivered without platform watermarks during product development.
import { type ExecutorContext, registerExecutor } from "../job-executor.js";

import { imageForegroundPolicySchema } from "@loomic/shared";
import { requiresTransparentForeground } from "../../images/foreground-policy.js";

registerExecutor(
  "image_generation",
  async (jobId, _rawPayload, ctx: ExecutorContext) => {
    const t0 = Date.now();

    // Read the full job row including payload from the database.
    // The PGMQ message only contains { job_id, job_type, workspace_id },
    // so we must fetch prompt/model/aspect_ratio from background_jobs.payload.
    const admin = ctx.getAdminClient();
    const jobRow = normalizePersistedGenerationJob(
      await ctx.jobService.getJobAdmin(jobId),
    );
    // Cancellation stops NEW paid stages, even when a previous provider could
    // not be aborted. A terminal CAS in the worker alone is too late: fallback
    // and foreground processing run inside this executor.
    const assertNotCanceled = async () => {
      const latest = await ctx.jobService.getJobAdmin(jobId);
      if (latest.status === "canceled") {
        throw Object.assign(new Error("任务已取消，未开始新的生成或处理请求。"), { code: "job_canceled" });
      }
    };
    await assertNotCanceled();
    if (jobRow.job_type !== "image_generation") {
      throw new Error(`Job ${jobId} is not an image generation job`);
    }

    // Build log tag with traceability context: jobId + sessionId (if available)
    const sessionShort =
      (jobRow.session_id as string)?.slice(0, 8) ?? "no-session";
    const tag = `[image-job:${jobId.slice(0, 8)} session:${sessionShort}]`;
    const lap = (label: string) =>
      console.log(`${tag} ${label} +${Date.now() - t0}ms`);
    lap("db_fetch");

    const payload = jobRow.payload;

    if (!payload.prompt)
      throw new Error(`Job ${jobId} has no prompt in payload`);

    const createdBy: string | null = jobRow.created_by ?? null;
    const workspaceId: string = jobRow.workspace_id ?? jobId;

    const model = payload.model ?? "black-forest-labs/flux-kontext-pro";

    // Renew VT every 60s (half of the 120s image queue VT) to prevent
    // the message from becoming visible while we are still processing.
    const IMAGE_VT_SECONDS = 120;
    const heartbeatTimer = setInterval(() => {
      ctx.renewVt(IMAGE_VT_SECONDS);
    }, 60_000);

    // Log input image format for debugging the data-URI-passthrough pipeline
    if (payload.input_images?.length) {
      const formats = payload.input_images.map((img) =>
        img.startsWith("data:") ? "data-uri" : "url",
      );
      console.log(
        `${tag} input_images formats: [${formats.join(", ")}] (${formats.length} total)`,
      );
    }

    try {
      if (isLocalImageOperation(payload.operation) || payload.operation === "remove_background"
        || payload.operation === "split_layers") {
        // Layer splitting is the semantic flow only. A row written before the local
        // fast split was removed must fail loudly instead of quietly doing nothing.
        if (payload.operation === "split_layers" && payload.layer_backend !== "semantic") {
          const error = new Error(
            "Layer splitting requires the semantic backend; the local fast split was removed.",
          );
          (error as Error & { code?: string }).code = "invalid_input";
          throw error;
        }
        const boundSourceAsset =
          payload.target?.kind === "design"
            ? payload.target.source_asset_object_id
            : undefined;
        const inputImage = payload.input_images?.[0];
        if (!inputImage && !boundSourceAsset) {
          const error = new Error(
            "Background removal requires one input image.",
          );
          (error as Error & { code?: string }).code = "invalid_input";
          throw error;
        }
        const source = boundSourceAsset
          ? await downloadBoundDesignAsset(admin, boundSourceAsset, workspaceId)
          : await safeDownload(inputImage as string, {
              kind: "image",
              maxBytes: 30 * 1024 * 1024,
              timeoutMs: 60_000,
              maxRedirects: 2,
              allowDataUri: true,
              expectedMimeType: "image/png",
              allowedMimeTypes: [
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/avif",
              ],
            });
        lap("image_operation_input_ready");
        if (
          payload.operation === "region_matting" &&
          !payload.selection_region
        ) {
          const error = new Error(
            "Region matting requires a normalized selection region.",
          );
          (error as Error & { code?: string }).code = "invalid_input";
          throw error;
        }
        let maskBuffer: Buffer | undefined;
        if (
          payload.operation === "erase_transparent" ||
          payload.operation === "smart_erase"
        ) {
          if (!payload.mask_image) {
            const error = new Error("Erase operations require a mask image.");
            (error as Error & { code?: string }).code = "invalid_input";
            throw error;
          }
          const mask = await safeDownload(payload.mask_image, {
            kind: "image",
            maxBytes: 10 * 1024 * 1024,
            timeoutMs: 30_000,
            maxRedirects: 0,
            allowDataUri: true,
            expectedMimeType: "image/png",
            allowedMimeTypes: ["image/png"],
          });
          maskBuffer = mask.buffer;
        }
        await assertNotCanceled();
        const processed = payload.operation === "split_layers"
          ? await processSemanticLayers({ source: source.buffer, admin, workspaceId,
              projectId: jobRow.project_id, createdBy, jobId, model,
              layerNames: payload.layer_names!, prompt: payload.prompt,
              ...(payload.selection_region ? { selectionRegion: payload.selection_region } : {}),
              quality: payload.quality ?? "standard", resolution: payload.resolution ?? "1k",
              beforeCall: assertNotCanceled })
          : payload.operation === "remove_background"
          ? await (async () => {
              const suffix = "0-foreground";
              const requestFingerprint = createHash("sha256")
                .update(JSON.stringify({
                  version: 1,
                  operation: "remove_background",
                  model,
                  sourceSha256: createHash("sha256")
                    .update(source.buffer)
                    .digest("hex"),
                }))
                .digest("hex");
              const checkpoint = createImageGenerationCheckpoint(admin, {
                workspaceId,
                jobId,
                requestFingerprint,
                variant: "background-removal-foreground",
              });
              let cached = await loadGeneratedImageAsset({
                admin,
                workspaceId,
                projectId: jobRow.project_id,
                jobId,
                suffix,
              });
              if (cached) {
                await checkpoint.saveArchived(cached.mimeType);
              } else {
                const providerPersistence =
                  createDurableProviderImagePersistence(checkpoint, {
                    definiteNoResultCodes: DEFINITE_NO_PROVIDER_RESULT_CODES,
                    unknownMessage: (detail) =>
                      `付费去背景调用结果未知：${detail}。为避免重复计费，未自动重新调用。`,
                  });
                await assertNotCanceled();
                const result = await removeBackgroundWithApi(
                  source.buffer,
                  model,
                  { providerPersistence },
                );
                const foreground = result.layers[0];
                if (!foreground) {
                  throw Object.assign(
                    new Error("去背景 API 未返回主体图层。"),
                    { code: "background_removal_invalid_output" },
                  );
                }
                cached = {
                  buffer: Buffer.from(foreground.buffer),
                  mimeType: "image/png",
                };
                await storeImageAsset({
                  admin,
                  workspaceId,
                  projectId: jobRow.project_id,
                  createdBy,
                  jobId,
                  buffer: cached.buffer,
                  mimeType: cached.mimeType,
                  suffix,
                });
                await checkpoint.saveArchived(cached.mimeType);
              }
              const dimensions = await readImageDimensions(cached.buffer);
              return { model: "gpt-image-2", ...dimensions, layers: [{ kind: "foreground" as const,
                buffer: cached.buffer, x: 0, y: 0, ...dimensions, index: 0 }] };
            })()
          : await processWithFeynobg(
          source.buffer,
          payload.operation,
          payload.selection_region,
          maskBuffer,
        );
        lap("image_operation_done");
        const storedLayers = [];
        for (const [layerIndex, layer] of processed.layers.entries()) {
          const stored = await storeImageAsset({
            admin,
            workspaceId,
            projectId: jobRow.project_id,
            createdBy,
            jobId,
            buffer: layer.buffer,
            mimeType: "image/png",
            suffix: `${layerIndex}-${layer.kind}`,
          });
          storedLayers.push({
            ...stored,
            kind: layer.kind,
            x: layer.x,
            y: layer.y,
            width: layer.width,
            height: layer.height,
            ...(layer.index !== undefined ? { index: layer.index } : {}),
            ...("name" in layer && typeof layer.name === "string" ? { name: layer.name } : {}),
          });
        }
        const primary = storedLayers[0];
        if (!primary) throw new Error("Image operation did not return an image layer.");
        lap("image_operation_assets_stored");
        return {
          ...primary,
          model: processed.model ?? "local:feynobg",
          operation: payload.operation,
          source_width: processed.width,
          source_height: processed.height,
          visual_status: "unverified",
          viewed: false,
          layers: storedLayers,
        };
      }

      let localRepaint: PreparedLocalRepaint | undefined;
      let outpaint: Awaited<ReturnType<typeof directOutpaintRequest>> | undefined;
      if (
        payload.operation === "local_repaint" ||
        payload.operation === "outpaint"
      ) {
        const boundSourceAsset =
          payload.target?.kind === "design"
            ? payload.target.source_asset_object_id
            : undefined;
        const source = boundSourceAsset
          ? await downloadBoundDesignAsset(admin, boundSourceAsset, workspaceId)
          : await safeDownload(payload.input_images![0]!, {
              kind: "image",
              maxBytes: 30 * 1024 * 1024,
              timeoutMs: 60_000,
              maxRedirects: 2,
              allowDataUri: true,
              expectedMimeType: "image/png",
              allowedMimeTypes: [
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/avif",
              ],
            });
        if (payload.operation === "outpaint") {
          outpaint = await directOutpaintRequest(
            source.buffer,
            payload.outpaint_margins!,
            payload.prompt,
          );
          lap("outpaint_input_ready");
        } else {
          const mask = await safeDownload(payload.mask_image!, {
            kind: "image",
            maxBytes: 10 * 1024 * 1024,
            timeoutMs: 30_000,
            maxRedirects: 0,
            allowDataUri: true,
            expectedMimeType: "image/png",
            allowedMimeTypes: ["image/png"],
          });
          localRepaint = await prepareLocalRepaint(source.buffer, mask.buffer);
          lap("local_repaint_input_ready");
        }
      }

      // Generate image via the registered provider
      // Local image operations return above and must never enter the workspace
      // provider registry. `local:feynobg` is an execution backend, not a model
      // exposed by a third-party provider.
      const providerAttempts = getImageProviderAttempts() ?? [{
        ordinal: 0,
        providerName: resolveImageProviderName(model),
        modelId: model,
        providerModelId: model,
        upstreamModelId: model,
      }];
      const needsMatting = requiresTransparentForeground({ ...payload, model });
      const foregroundPolicy = payload.foreground_policy ? imageForegroundPolicySchema.parse(payload.foreground_policy) : undefined;
      if (needsMatting && (!foregroundPolicy || foregroundPolicy.generationModel !== model)) {
        throw Object.assign(new Error("此画板前景方案未确认透明处理步骤，未开始生图或抠图。请重新创建方案。"), { code: "foreground_policy_required" });
      }
      if (!needsMatting && foregroundPolicy) throw Object.assign(new Error("Unexpected foreground processing policy"), { code: "foreground_policy_mismatch" });
      const repaintRequest = localRepaint
        ? localRepaintRequest(localRepaint, payload.prompt)
        : undefined;
      const baseProviderRequest = {
        prompt: repaintRequest?.prompt ?? payload.prompt,
        ...(payload.output_format ? { outputFormat: payload.output_format } : {}),
        ...(payload.background ? { background: payload.background } : {}),
        ...(payload.background === "transparent" ? { outputFormat: "png" as const } : {}),
        ...(foregroundPolicy?.mode === "native_transparent" ? { background: "transparent" as const, outputFormat: "png" as const } : {}),
        ...(localRepaint
          ? { aspectRatio: `${localRepaint.width}:${localRepaint.height}` }
          : payload.aspect_ratio !== undefined
          ? { aspectRatio: payload.aspect_ratio }
          : {}),
        ...(payload.quality !== undefined
          ? { quality: payload.quality }
          : {}),
        ...(payload.resolution !== undefined
          ? { resolution: payload.resolution }
          : {}),
        ...(payload.operation !== "outpaint" && payload.output_width !== undefined
          ? { outputWidth: payload.output_width }
          : {}),
        ...(payload.operation !== "outpaint" && payload.output_height !== undefined
          ? { outputHeight: payload.output_height }
          : {}),
        ...(repaintRequest
          ? {
              background: repaintRequest.background,
              outputFormat: repaintRequest.outputFormat,
              inputImages: repaintRequest.inputImages,
              maskImage: repaintRequest.maskImage,
            }
          : payload.input_images?.length
          ? { inputImages: payload.input_images }
          : {}),
        ...(outpaint ?? {}),
      };
      const downloadSource = async (generated: {
        url: string;
        mimeType: string;
      }) => {
        // Download the generated image from the provider CDN. The reference
        // itself is already durable before this step begins.
        const downloaded = await safeDownload(generated.url, {
          kind: "image",
          maxBytes: 30 * 1024 * 1024,
          timeoutMs: 60_000,
          maxRedirects: 2,
          // OpenAI-compatible image gateways may return a base64 data URL rather
          // than a CDN URL. safeDownload still enforces MIME, magic bytes and the
          // 30 MB limit before the image reaches storage.
          allowDataUri: true,
          expectedMimeType: generated.mimeType ?? "image/png",
          allowedMimeTypes: [
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/avif",
          ],
        });
        lap("image_download_done");
        return downloaded;
      };
      const sourceSuffix = "source-before-matting";
      const sourceAssetId = generationSourceAssetBinding(
        workspaceId,
        jobId,
        "image-generation-source",
      ).assetId;
      let downloaded: { buffer: Buffer; mimeType: string } | undefined;
      let selectedAttempt: (typeof providerAttempts)[number] | undefined;
      const rejectedAttempts: Array<{ ordinal: number; code: string; message: string }> = [];
      for (const attempt of providerAttempts) {
        await assertNotCanceled();
        const { prompt: requestPrompt, ...providerRequestTail } = baseProviderRequest;
        // Preserve the exact property order and v1 fingerprint for attempt 0,
        // so pre-fallback returned/calling/archive checkpoints remain readable.
        const providerRequest = {
          prompt: requestPrompt,
          model: attempt.modelId,
          ...providerRequestTail,
        };
        const requestFingerprint = createHash("sha256")
          .update(JSON.stringify(attempt.ordinal === 0
            ? { version: 1, providerName: attempt.providerName, ...providerRequest }
            : {
                version: 2,
                attemptOrdinal: attempt.ordinal,
                providerName: attempt.providerName,
                upstreamModelId: attempt.upstreamModelId,
                ...providerRequest,
              }))
          .digest("hex");
        const checkpoint = createImageGenerationCheckpoint(admin, {
          workspaceId,
          jobId,
          requestFingerprint,
          variant: "image-generation-source",
          attemptOrdinal: attempt.ordinal,
        });
        const generateSource = async () => {
          await assertNotCanceled();
          lap(`image_provider_attempt_${attempt.ordinal + 1}_start`);
          let generated: Awaited<ReturnType<typeof generateImage>>;
          try {
            generated = await generateImage(attempt.providerName, providerRequest);
          } catch (genError) {
            const detail = genError instanceof Error ? genError.message : String(genError);
            const upstreamCode = (genError as { code?: string })?.code ?? "executor_error";
            const wrapped = new Error(
              DEFINITE_NO_PROVIDER_RESULT_CODES.has(upstreamCode)
                ? `Image generation failed for model ${model}: ${detail}`
                : `Image generation outcome is unknown for model ${model}: ${detail}. The provider will not be called again automatically.`,
            );
            (wrapped as Error & { code?: string }).code =
              DEFINITE_NO_PROVIDER_RESULT_CODES.has(upstreamCode)
                ? upstreamCode
                : "image_generation_result_unknown";
            throw wrapped;
          }
          lap(`image_provider_attempt_${attempt.ordinal + 1}_done`);
          return { url: generated.url, mimeType: generated.mimeType };
        };
        try {
          downloaded = await recoverOrGenerateImageSource({
            checkpoint,
            loadArchived: () => loadGeneratedImageAsset({
              admin,
              workspaceId,
              projectId: jobRow.project_id,
              jobId,
              suffix: sourceSuffix,
            }),
            generate: generateSource,
            download: downloadSource,
            archive: (source) => storeImageAsset({
              admin,
              workspaceId,
              projectId: jobRow.project_id,
              createdBy,
              jobId,
              buffer: source.buffer,
              mimeType: source.mimeType,
              suffix: sourceSuffix,
            }),
          });
          selectedAttempt = attempt;
          break;
        } catch (error) {
          const code = (error as { code?: string })?.code ?? "executor_error";
          if (code === "image_generation_provider_rejected") {
            rejectedAttempts.push({
              ordinal: attempt.ordinal,
              code: "provider_rejected",
              message: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          if (!FALLBACK_ELIGIBLE_PROVIDER_CODES.has(code)) throw error;
          const detail = error instanceof Error ? error.message : String(error);
          // The durable rejected state is the fence that allows the next paid
          // boundary. If this write is uncertain, saveRejected throws and the
          // worker stops without touching another provider.
          await checkpoint.saveRejected(code, detail);
          rejectedAttempts.push({ ordinal: attempt.ordinal, code, message: detail });
          if (attempt.ordinal < providerAttempts.length - 1) {
            console.warn(`${tag} provider attempt ${attempt.ordinal + 1} rejected; trying frozen fallback`);
          }
        }
      }
      if (!downloaded || !selectedAttempt) {
        const finalError = rejectedAttempts.at(-1)?.message ?? "Provider rejected the request.";
        const failure = new Error(
          providerAttempts.length === 1
            ? finalError
            : `All ${rejectedAttempts.length || providerAttempts.length} compatible image provider attempts were rejected. Final error: ${finalError}`,
        );
        (failure as Error & { code?: string }).code = "provider_rejected";
        throw failure;
      }
      if (localRepaint) {
        downloaded = {
          buffer: await composeLocalRepaint(localRepaint, downloaded.buffer),
          mimeType: "image/png",
        };
        lap(
          payload.operation === "outpaint"
            ? "outpaint_composed"
            : "local_repaint_composed",
        );
      }
      if (payload.aspect_ratio) {
        try {
          assertImageAspectRatio(await readImageDimensions(downloaded.buffer), payload.aspect_ratio);
        } catch (error) {
          if ((error as { code?: string }).code !== "image_aspect_ratio_mismatch") throw error;
          // A usable, paid result must still be delivered at its actual size.
          // Ratio compliance is diagnostic, never a reason to regenerate or hide it.
          console.warn(`${tag} provider aspect ratio differs; delivering original dimensions`, {
            requested: payload.aspect_ratio,
            actual: await readImageDimensions(downloaded.buffer),
          });
        }
      }
      // Keep generation and matting in the same durable job. Do not publish or
      // insert an opaque intermediate image when foreground processing fails.
      const processed = await postprocessDesignImage(
        downloaded.buffer,
        downloaded.mimeType,
        payload.target,
        foregroundPolicy ? { policy: foregroundPolicy, removeBackground: async () => {
          const suffix = "design-foreground";
          const requestFingerprint = createHash("sha256").update(JSON.stringify({ version: 1,
            foregroundPolicy, sourceSha256: createHash("sha256").update(downloaded.buffer).digest("hex") })).digest("hex");
          const helperCheckpoint = createImageGenerationCheckpoint(admin, { workspaceId, jobId,
            requestFingerprint, variant: "design-foreground-matting" });
          let cached = await loadGeneratedImageAsset({ admin, workspaceId, projectId: jobRow.project_id, jobId, suffix });
          if (!cached) {
            const providerPersistence = createDurableProviderImagePersistence(helperCheckpoint, {
              definiteNoResultCodes: DEFINITE_NO_PROVIDER_RESULT_CODES,
              unknownMessage: detail => `前景去背景调用结果未知：${detail}。未自动重新调用，避免重复计费。`,
            });
            await assertNotCanceled();
            const result = await removeBackgroundWithApi(downloaded.buffer, foregroundPolicy.mattingModel, { providerPersistence });
            const foreground = result.layers[0];
            if (!foreground) throw Object.assign(new Error("去背景 API 未返回主体"), { code: "background_removal_invalid_output" });
            cached = { buffer: Buffer.from(foreground.buffer), mimeType: "image/png" };
            await storeImageAsset({ admin, workspaceId, projectId: jobRow.project_id, createdBy, jobId,
              ...cached, suffix });
          }
          await helperCheckpoint.saveArchived(cached.mimeType);
          return cached.buffer;
        } } : undefined,
      ).catch((error: unknown) => {
        if ((error as { code?: string })?.code === "job_canceled") throw error;
        if (!needsMatting) throw error;
        const failure = new Error(
          `图片已生成并保存，但透明前景处理未完成。原图素材 ID：${sourceAssetId}。无需重新生图；若抠图调用结果未知，请先核查供应商结果，不要重复付费。`,
        );
        const upstreamCode = (error as { code?: string })?.code;
        (failure as Error & { code: string }).code = upstreamCode && ["image_generation_result_unknown", "image_generation_checkpoint_invalid", "background_removal_invalid_output", "provider_snapshot_invalid"].includes(upstreamCode)
          ? upstreamCode : "image_postprocess_failed";
        console.warn(
          `${tag} matting failed; source checkpoint retained`,
          error instanceof Error ? error.name : "unknown",
        );
        throw failure;
      });
      const buffer = processed.buffer;
      const outputMimeType = processed.mimeType;
      // The current Agent uses native transparent edit/generate requests. A
      // PNG filename alone cannot prove background removal succeeded. Validate
      // after checkpointing so a retry reuses the paid result instead of
      // silently generating again when the provider ignored transparency.
      if (payload.background === "transparent") {
        await validateTransparentPng(buffer);
      }
      lap("design_postprocess_done");

      // Upload user-owned media to the private workspace-assets bucket.
      const dimensions = await readImageDimensions(buffer);
      const timestamp = Date.now();
      const objectPath = `${workspaceId}/generated/${timestamp}-${jobId}.png`;

      const { error: uploadError } = await admin.storage
        .from("workspace-assets")
        .upload(objectPath, buffer, {
          contentType: outputMimeType,
          upsert: false,
        });

      if (uploadError) {
        throw new Error(`Storage upload failed: ${uploadError.message}`);
      }
      lap("storage_upload_done");

      // Insert asset_objects record — only include created_by if we have a valid user UUID
      const { data: assetRow, error: assetError } = await admin
        .from("asset_objects")
        .insert({
          workspace_id: workspaceId,
          bucket: "workspace-assets",
          object_path: objectPath,
          mime_type: outputMimeType,
          byte_size: buffer.length,
          ...(createdBy ? { created_by: createdBy } : {}),
        })
        .select("id")
        .single();

      if (assetError || !assetRow) {
        throw new Error(
          `Failed to create asset record: ${assetError?.message ?? "unknown error"}`,
        );
      }

      lap("asset_record_done");

      const { data: urlData, error: urlError } = await admin.storage
        .from("workspace-assets")
        .createSignedUrl(objectPath, 900);
      if (urlError || !urlData?.signedUrl) {
        throw new Error("Failed to create a private image URL");
      }

      lap("total");
      return {
        asset_id: (assetRow as { id: string }).id,
        visual_status: "unverified",
        viewed: false,
        signed_url: urlData.signedUrl,
        object_path: objectPath,
        width: dimensions.width,
        height: dimensions.height,
        mime_type: outputMimeType,
        model,
        upstream_model: selectedAttempt.upstreamModelId,
        provider: "workspace",
        provider_model: selectedAttempt.providerModelId ?? selectedAttempt.modelId,
        provider_attempt: selectedAttempt.ordinal + 1,
        provider_fallback_used: selectedAttempt.ordinal > 0,
        provider_attempt_count: selectedAttempt.ordinal + 1,
        ...(payload.operation ? { operation: payload.operation } : {}),
      };
    } finally {
      clearInterval(heartbeatTimer);
    }
  },
);

const DEFINITE_NO_PROVIDER_RESULT_CODES = new Set([
  "invalid_input",
  "model_not_found",
  "provider_not_found",
  "provider_snapshot_invalid",
  "safety_filter",
  "provider_rejected",
]);

// Only errors proving that no image was produced may cross to another frozen
// provider. Safety/invalid-input errors are terminal and unknown outcomes stop.
const FALLBACK_ELIGIBLE_PROVIDER_CODES = new Set(["provider_rejected"]);

type SemanticLayer = {
  kind: "background" | "element";
  buffer: Buffer;
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  name: string;
};

/**
 * Pixel box for the box-selection flow, derived from the user's normalized drag.
 *
 * The model is handed this crop instead of the whole picture, so the rectangle —
 * not a name — decides which element is "the element". A little padding keeps
 * context around an edge-touching selection so the object stays recognizable, and
 * the box is clamped to the decoded image so it can never address pixels that do
 * not exist.
 */
export function semanticSelectionBox(
  region: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const padX = Math.max(2, Math.round(region.width * width * 0.06));
  const padY = Math.max(2, Math.round(region.height * height * 0.06));
  const left = Math.max(0, Math.round(region.x * width) - padX);
  const top = Math.max(0, Math.round(region.y * height) - padY);
  const right = Math.min(width, Math.round((region.x + region.width) * width) + padX);
  const bottom = Math.min(height, Math.round((region.y + region.height) * height) + padY);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Resize the crop-sized element back to the crop and stamp it into a full frame. */
async function placeBoxElementInFrame(
  cropPng: Buffer,
  box: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
): Promise<Buffer> {
  const element = await sharp(cropPng)
    .resize(box.width, box.height, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: element, left: box.left, top: box.top }])
    .png().toBuffer();
}

async function processSemanticLayers(input: {
  source: Buffer;
  admin: ReturnType<ExecutorContext["getAdminClient"]>;
  workspaceId: string;
  projectId: string | null;
  createdBy: string | null;
  jobId: string;
  model: string;
  layerNames: string[];
  /**
   * Box-selection flow. When present, the one element to extract is identified by
   * this normalized rectangle instead of by a name: the model receives that crop
   * rather than the whole picture. The extracted element is placed back at this
   * position in the full frame, so the repaired background and the canvas
   * placement keep working on unchanged coordinates.
   */
  selectionRegion?: { x: number; y: number; width: number; height: number } | undefined;
  prompt: string;
  quality: "standard" | "hd" | "ultra";
  resolution: "1k" | "2k" | "4k";
  beforeCall: () => Promise<void>;
}) {
  if (!input.model.startsWith("workspace:") || input.layerNames.length < 1 || input.layerNames.length > 4) {
    throw Object.assign(new Error("语义分层任务缺少已发布模型或有效层名。"), { code: "invalid_input" });
  }
  const normalized = await sharp(input.source, { limitInputPixels: 8_000_000 })
    .rotate().png().toBuffer({ resolveWithObject: true });
  const { width, height } = normalized.info;
  if (width < 16 || height < 16 || width / height > 3 || height / width > 3 || normalized.data.length > 30 * 1024 * 1024) {
    throw Object.assign(new Error("原图尺寸需要至少 16 像素、比例不超过 3:1 且解码后不超过 30 MB；没有调用模型。"), { code: "invalid_input" });
  }
  const box = input.selectionRegion ? semanticSelectionBox(input.selectionRegion, width, height) : undefined;
  const cropDataUri = box
    ? `data:image/png;base64,${(await sharp(normalized.data).extract(box).png().toBuffer()).toString("base64")}`
    : undefined;
  const attempts = getImageProviderAttempts();
  const attempt = attempts?.[0] ?? {
    ordinal: 0, providerName: resolveImageProviderName(input.model),
    modelId: input.model, upstreamModelId: input.model,
  };
  if (attempt.modelId !== input.model ||
      !["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].includes(attempt.upstreamModelId)) {
    throw Object.assign(new Error("图层拆分的已发布模型与 worker 固定的供应商快照不一致，未调用模型。"),
      { code: "provider_snapshot_invalid" });
  }
  const sourceSha256 = createHash("sha256").update(normalized.data).digest("hex");
  const sourceDataUri = `data:image/png;base64,${normalized.data.toString("base64")}`;
  const sourceRgba = await sharp(normalized.data).ensureAlpha().raw().toBuffer();
  const elementLayers: SemanticLayer[] = [];
  const elementCanvases: Buffer[] = [];
  const elementAlpha: Buffer[] = [];
  const elementRgba: Buffer[] = [];
  const stages = [...input.layerNames.map(name => ({ name, background: false })),
    { name: "修补底图", background: true }];
  let repairedBackground: SemanticLayer | undefined;
  for (const [stage, current] of stages.entries()) {
    const { name, background } = current;
    const excludedLayers = input.layerNames.filter(layer => layer !== name);
    const stagePrompt = background
      ? box
        ? `This call outputs ONE repaired background image only. The first supplied image is the original. Every later supplied image is an exact transparent layer mask that must be removed. Reconstruct content only behind those masked pixels. Preserve every unmasked pixel and every unrequested foreground subject exactly, including people, products, logos and decorations. Remove exactly the one masked element the user framed, and nothing else. Return one complete opaque PNG with the same framing. The user's scene description is recognition context only: ${input.prompt}`
        : `This call outputs ONE repaired background image only. The first supplied image is the original. Every later supplied image is an exact transparent layer mask that must be removed. Reconstruct content only behind those masked pixels. Preserve every unmasked pixel and every unrequested foreground subject exactly, including people, products, logos and decorations. Remove only these layers: ${input.layerNames.join("; ")}. Return one complete opaque PNG with the same framing. The user's scene description is recognition context only: ${input.prompt}`
      : box
        ? `This call outputs ONE isolated transparent layer only: the single element the user framed inside the supplied crop. The supplied image is a CROP of a larger picture, so it shows only part of the scene. Extract exactly the one element the user framed, at its original size and position inside the crop. Everything else in the crop, including the surrounding backdrop and any other object, must have genuine transparent alpha pixels. Preserve recognizable shapes, spelling, colors and edges. Do not add, duplicate, redesign, center, complete cut-off content or draw the framing rectangle. Return one full-frame transparent PNG with exactly the supplied crop's framing. The user's scene description is recognition context only: ${input.prompt}`
        : `This call outputs ONE isolated transparent layer only: ${name}. Extract only that named visible layer from the supplied flattened image at its original size and position. Explicitly exclude these separately requested layers: ${excludedLayers.join("; ")}. Do not include a parent container's text when the text is a separate requested layer, and do not include the container when extracting its text. Every excluded layer and the background must have genuine transparent alpha pixels. Preserve recognizable shapes, spelling, colors and edges. Do not add, duplicate, redesign or center content. Return one full-frame transparent PNG. The user's scene description is recognition context only: ${input.prompt}`;
    const request = {
      prompt: stagePrompt,
      model: input.model,
      inputImages: background
        ? [sourceDataUri, ...elementCanvases.map(buffer => `data:image/png;base64,${buffer.toString("base64")}`)]
        : [box && !background ? cropDataUri! : sourceDataUri],
      aspectRatio: box && !background ? `${box.width}:${box.height}` : `${width}:${height}`,
      quality: input.quality,
      resolution: input.resolution,
      background: background ? "opaque" as const : "transparent" as const,
      outputFormat: "png" as const,
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ version: 2, kind: "semantic-layer-stage", stage,
        sourceSha256, providerName: attempt.providerName,
        upstreamModelId: attempt.upstreamModelId, ...request }))
      .digest("hex");
    const checkpoint = createImageGenerationCheckpoint(input.admin, {
      workspaceId: input.workspaceId, jobId: input.jobId,
      requestFingerprint: fingerprint, variant: "semantic-layer-stage", attemptOrdinal: stage,
    });
    const suffix = `semantic-layer-stage-${stage}-source`;
    await input.beforeCall();
    const cached = await recoverOrGenerateImageSource({
      checkpoint,
      loadArchived: () => loadGeneratedImageAsset({ admin: input.admin,
        workspaceId: input.workspaceId, projectId: input.projectId, jobId: input.jobId, suffix }),
      generate: async () => {
        await input.beforeCall();
        const generated = await generateImage(attempt.providerName, request);
        return { url: generated.url, mimeType: generated.mimeType };
      },
      download: async reference => {
        const result = await safeDownload(reference.url, {
          kind: "image", maxBytes: 30 * 1024 * 1024, timeoutMs: 60_000,
          maxRedirects: 2, allowDataUri: true,
          expectedMimeType: "image/png", allowedMimeTypes: ["image/png"],
        });
        return { buffer: result.buffer, mimeType: result.mimeType };
      },
      archive: source => storeImageAsset({ admin: input.admin,
        workspaceId: input.workspaceId, projectId: input.projectId,
        createdBy: input.createdBy, jobId: input.jobId,
        buffer: source.buffer, mimeType: source.mimeType, suffix }),
    });
    if (background) {
      const metadata = await sharp(cached.buffer).metadata();
      if (metadata.format !== "png" || metadata.width === undefined || metadata.height === undefined) {
        throw Object.assign(new Error("修补底图没有返回有效 PNG。"), { code: "layer_output_invalid" });
      }
      if (metadata.hasAlpha) {
        const alpha = await sharp(cached.buffer).extractChannel("alpha").raw().toBuffer();
        if (alpha.some(value => value < 255)) {
          throw Object.assign(new Error("修补底图不是不透明图像。"), { code: "layer_output_invalid" });
        }
      }
      const generated = await sharp(cached.buffer).resize(width, height, {
        fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 },
      }).png().toBuffer();
      if (!elementAlpha.length) {
        throw Object.assign(new Error("修补底图缺少经过校验的元素遮罩。"), { code: "layer_output_invalid" });
      }
      const union = Buffer.alloc(width * height);
      for (const alpha of elementAlpha) for (let index = 0; index < union.length; index++)
        union[index] = Math.max(union[index]!, alpha[index] ?? 0);
      // Provider edits are generative and may alter unrelated subjects. Apply
      // the generated repair only through the exact union of accepted element
      // masks; every pixel outside that union comes from the original source.
      const repairMask = union;
      const generatedRgb = await sharp(generated).removeAlpha().raw().toBuffer();
      const maskedRgba = Buffer.alloc(width * height * 4);
      for (let index = 0; index < width * height; index++) {
        maskedRgba[index * 4] = generatedRgb[index * 3] ?? 0;
        maskedRgba[index * 4 + 1] = generatedRgb[index * 3 + 1] ?? 0;
        maskedRgba[index * 4 + 2] = generatedRgb[index * 3 + 2] ?? 0;
        maskedRgba[index * 4 + 3] = repairMask[index] ?? 0;
      }
      const maskedRepair = await sharp(maskedRgba, {
        raw: { width, height, channels: 4 },
      }).png().toBuffer();
      const buffer = await sharp(normalized.data).composite([{ input: maskedRepair, blend: "over" }]).png().toBuffer();
      repairedBackground = { kind: "background", buffer, x: 0, y: 0,
        width, height, index: 0, name };
    } else {
      await validateTransparentPng(cached.buffer);
      // The box flow generated the element inside the crop, so put it back where
      // the user framed it. Everything downstream (bounding box, delivery crop,
      // repaired background, canvas placement) then works on the full frame.
      const canvas = box
        ? await placeBoxElementInFrame(cached.buffer, box, width, height)
        : await sharp(cached.buffer).resize(width, height, {
            fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 },
          }).png().toBuffer();
      const alpha = await sharp(canvas).extractChannel("alpha").raw()
        .toBuffer({ resolveWithObject: true });
      const rgba = await sharp(canvas).ensureAlpha().raw().toBuffer();
      let minX = width, minY = height, maxX = -1, maxY = -1;
      let visible = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if ((alpha.data[y * width + x] ?? 0) < 8) continue;
        visible++;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      if (visible === 0 || visible > width * height * 0.98) {
        throw Object.assign(new Error(`元素「${name}」为空或几乎覆盖整个画面，未作为独立图层交付。`),
          { code: "layer_output_invalid" });
      }
      for (const [priorIndex, priorAlpha] of elementAlpha.entries()) {
        let overlap = 0;
        let priorVisible = 0;
        let bothMatchSource = 0;
        const priorRgba = elementRgba[priorIndex]!;
        for (let index = 0; index < alpha.data.length; index++) {
          const prior = priorAlpha[index] ?? 0;
          if (prior >= 8) priorVisible++;
          if (prior >= 8 && (alpha.data[index] ?? 0) >= 8) {
            overlap++;
            const pixel = index * 4;
            const currentDelta = (Math.abs((rgba[pixel] ?? 0) - (sourceRgba[pixel] ?? 0))
              + Math.abs((rgba[pixel + 1] ?? 0) - (sourceRgba[pixel + 1] ?? 0))
              + Math.abs((rgba[pixel + 2] ?? 0) - (sourceRgba[pixel + 2] ?? 0))) / 3;
            const priorDelta = (Math.abs((priorRgba[pixel] ?? 0) - (sourceRgba[pixel] ?? 0))
              + Math.abs((priorRgba[pixel + 1] ?? 0) - (sourceRgba[pixel + 1] ?? 0))
              + Math.abs((priorRgba[pixel + 2] ?? 0) - (sourceRgba[pixel + 2] ?? 0))) / 3;
            if (currentDelta < 40 && priorDelta < 40) bothMatchSource++;
          }
        }
        const overlapRatio = overlap / Math.max(1, Math.min(visible, priorVisible));
        const duplicatedSourceRatio = bothMatchSource / Math.max(1, overlap);
        if (overlapRatio > 0.5 && duplicatedSourceRatio > 0.15) {
          throw Object.assign(new Error(`元素「${name}」与「${input.layerNames[priorIndex]}」内容大面积重复，未交付错误图层。请填写互不重复的视觉元素名称后重试。`),
            { code: "layer_output_overlap" });
        }
      }
      const cropWidth = maxX - minX + 1;
      const cropHeight = maxY - minY + 1;
      const buffer = await sharp(canvas).extract({ left: minX, top: minY,
        width: cropWidth, height: cropHeight }).png().toBuffer();
      elementCanvases.push(canvas);
      elementAlpha.push(alpha.data);
      elementRgba.push(rgba);
      elementLayers.push({ kind: "element", buffer, x: minX, y: minY,
        width: cropWidth, height: cropHeight, index: stage + 1, name });
    }
  }
  if (!repairedBackground) throw Object.assign(new Error("图层拆分没有生成修补底图。"),
    { code: "layer_output_invalid" });
  return { model: input.model, width, height,
    layers: [repairedBackground, ...elementLayers] };
}

export async function storeImageAsset(input: {
  admin: ReturnType<ExecutorContext["getAdminClient"]>;
  workspaceId: string;
  projectId: string | null;
  createdBy: string | null;
  jobId: string;
  buffer: Buffer;
  mimeType: string;
  suffix: string;
}) {
  const assetId = deterministicAssetId(input.jobId, input.suffix);
  const objectPath = `${input.workspaceId}/generated/${input.jobId}-${input.suffix}.png`;
  const existing = await input.admin
    .from("asset_objects")
    .select("id, workspace_id, project_id, bucket, object_path, mime_type")
    .eq("id", assetId)
    .maybeSingle();
  if (existing.error)
    throw new Error(
      `Failed to read generated asset: ${existing.error.message}`,
    );
  if (existing.data) {
    if (
      existing.data.workspace_id !== input.workspaceId ||
      existing.data.project_id !== input.projectId ||
      existing.data.bucket !== "workspace-assets" ||
      existing.data.object_path !== objectPath ||
      existing.data.mime_type !== input.mimeType
    ) {
      throw new Error("Generated asset id conflicts with another object.");
    }
    return signStoredAsset(input.admin, assetId, objectPath, input.mimeType);
  }
  const { error: uploadError } = await input.admin.storage
    .from("workspace-assets")
    .upload(objectPath, input.buffer, {
      contentType: input.mimeType,
      upsert: true,
    });
  if (uploadError)
    throw new Error(`Storage upload failed: ${uploadError.message}`);

  const { data: assetRow, error: assetError } = await input.admin
    .from("asset_objects")
    .upsert(
      {
        id: assetId,
        scope: "workspace",
        workspace_id: input.workspaceId,
        project_id: input.projectId,
        bucket: "workspace-assets",
        object_path: objectPath,
        mime_type: input.mimeType,
        byte_size: input.buffer.length,
        ...(input.createdBy ? { created_by: input.createdBy } : {}),
      },
      { onConflict: "id" },
    )
    .select("id")
    .single();
  if (assetError || !assetRow) {
    throw new Error(
      `Failed to create asset record: ${assetError?.message ?? "unknown error"}`,
    );
  }
  return signStoredAsset(
    input.admin,
    (assetRow as { id: string }).id,
    objectPath,
    input.mimeType,
  );
}

export async function loadGeneratedImageAsset(input: {
  admin: ReturnType<ExecutorContext["getAdminClient"]>;
  workspaceId: string;
  projectId: string | null;
  jobId: string;
  suffix: string;
}) {
  const assetId = deterministicAssetId(input.jobId, input.suffix);
  const objectPath = `${input.workspaceId}/generated/${input.jobId}-${input.suffix}.png`;
  const existing = await input.admin
    .from("asset_objects")
    .select(
      "id, scope, workspace_id, project_id, bucket, object_path, mime_type, byte_size, deletion_pending_at",
    )
    .eq("id", assetId)
    .maybeSingle();
  if (existing.error) {
    throw new Error(
      `Failed to read generated asset checkpoint: ${existing.error.message}`,
    );
  }
  if (!existing.data) return null;
  const mimeType = existing.data.mime_type ?? "";
  if (
    existing.data.scope !== "workspace" ||
    existing.data.workspace_id !== input.workspaceId ||
    existing.data.project_id !== input.projectId ||
    existing.data.bucket !== "workspace-assets" ||
    existing.data.object_path !== objectPath ||
    existing.data.deletion_pending_at !== null ||
    !["image/png", "image/jpeg", "image/webp", "image/avif"].includes(
      mimeType,
    ) ||
    (typeof existing.data.byte_size === "number" &&
      existing.data.byte_size > 30 * 1024 * 1024)
  ) {
    throw new Error("Generated image checkpoint conflicts with this job.");
  }
  const downloaded = await input.admin.storage
    .from("workspace-assets")
    .download(objectPath);
  if (downloaded.error || !downloaded.data) {
    throw new Error("Generated image checkpoint could not be downloaded.");
  }
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  validateDownloadedBuffer(buffer, {
    kind: "image",
    maxBytes: 30 * 1024 * 1024,
    mimeType,
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/avif"],
  });
  return { buffer, mimeType };
}

async function signStoredAsset(
  admin: ReturnType<ExecutorContext["getAdminClient"]>,
  assetId: string,
  objectPath: string,
  mimeType: string,
) {
  const { data: urlData, error: urlError } = await admin.storage
    .from("workspace-assets")
    .createSignedUrl(objectPath, 900);
  if (urlError || !urlData?.signedUrl)
    throw new Error("Failed to create a private image URL");
  return {
    asset_id: assetId,
    signed_url: urlData.signedUrl,
    object_path: objectPath,
    mime_type: mimeType,
  };
}

export async function downloadBoundDesignAsset(
  admin: ReturnType<ExecutorContext["getAdminClient"]>,
  assetId: string,
  workspaceId: string,
) {
  const result = await admin
    .from("asset_objects")
    .select(
      "id, scope, workspace_id, bucket, object_path, mime_type, byte_size, deletion_pending_at",
    )
    .eq("id", assetId)
    .maybeSingle();
  const asset = result.data;
  const platformAssetIsPublished =
    asset?.scope === "platform"
      ? await hasPublishedPlatformResource(admin, assetId)
      : false;
  if (
    result.error ||
    !asset ||
    !(
      (asset.scope === "workspace" && asset.workspace_id === workspaceId) ||
      platformAssetIsPublished
    ) ||
    asset.deletion_pending_at !== null ||
    !["image/png", "image/jpeg", "image/webp", "image/avif"].includes(
      asset.mime_type ?? "",
    ) ||
    (typeof asset.byte_size === "number" && asset.byte_size > 30 * 1024 * 1024)
  ) {
    throw new Error("The bound design source asset is unavailable.");
  }
  const downloaded = await admin.storage
    .from(asset.bucket)
    .download(asset.object_path);
  if (downloaded.error || !downloaded.data) {
    throw new Error("The bound design source asset could not be downloaded.");
  }
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  if (buffer.byteLength > 30 * 1024 * 1024)
    throw new Error("The bound design source asset is too large.");
  return { buffer, mimeType: asset.mime_type ?? "application/octet-stream" };
}

async function hasPublishedPlatformResource(
  admin: ReturnType<ExecutorContext["getAdminClient"]>,
  assetId: string,
) {
  const result = await admin
    .from("design_resources")
    .select("id")
    .eq("scope", "platform")
    .eq("status", "published")
    .is("deleted_at", null)
    .eq("asset_object_id", assetId)
    .limit(1)
    .maybeSingle();
  return !result.error && result.data !== null;
}
