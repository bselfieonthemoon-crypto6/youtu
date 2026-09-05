import { createHash } from "node:crypto";
import { readImageDimensions } from "./image-dimensions.js";
import { generateImage } from "../../../generation/image-generation.js";
import { resolveImageProviderName } from "../../../generation/providers/registry.js";
import { safeDownload } from "../../../security/safe-download.js";
import { applyWatermark } from "../../credits/watermark.js";
import { processWithFeynobg } from "../../images/feynobg-service.js";
import { isLocalImageOperation } from "../../images/local-image-operation.js";
import { normalizePersistedGenerationJob } from "../design-target-normalizer.js";
// @credits-system — Image generation executor: applies watermark for free-tier users
import { type ExecutorContext, registerExecutor } from "../job-executor.js";

import type { SubscriptionPlan } from "@loomic/shared";

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
      if (isLocalImageOperation(payload.operation)) {
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
        lap("feynobg_input_ready");
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
        const processed = await processWithFeynobg(
          source.buffer,
          payload.operation,
          payload.selection_region,
          maskBuffer,
        );
        lap("feynobg_inference_done");
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
          });
        }
        const primary = storedLayers[0];
        if (!primary) throw new Error("FeyNoBG did not return an image layer.");
        lap("feynobg_assets_stored");
        return {
          ...primary,
          model: "local:feynobg",
          operation: payload.operation,
          source_width: processed.width,
          source_height: processed.height,
          layers: storedLayers,
        };
      }

      // Generate image via the registered provider
      // Local image operations return above and must never enter the workspace
      // provider registry. `local:feynobg` is an execution backend, not a model
      // exposed by a third-party provider.
      const providerName = resolveImageProviderName(model);
      lap(`${providerName}_call_start`);
      let generated: Awaited<ReturnType<typeof generateImage>>;
      try {
        generated = await generateImage(providerName, {
          prompt: payload.prompt,
          model,
          ...(payload.aspect_ratio !== undefined
            ? { aspectRatio: payload.aspect_ratio }
            : {}),
          ...(payload.quality !== undefined
            ? { quality: payload.quality }
            : {}),
          ...(payload.output_width !== undefined
            ? { outputWidth: payload.output_width }
            : {}),
          ...(payload.output_height !== undefined
            ? { outputHeight: payload.output_height }
            : {}),
          ...(payload.input_images?.length
            ? { inputImages: payload.input_images }
            : {}),
        });
      } catch (genError) {
        const detail =
          genError instanceof Error ? genError.message : String(genError);
        const wrapped = new Error(
          `Image generation failed for model ${model}: ${detail}`,
        );
        (wrapped as Error & { code?: string }).code =
          (genError as { code?: string })?.code ?? "executor_error";
        throw wrapped;
      }
      lap(`${providerName}_call_done`);

      // Download the generated image from the provider CDN
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
      let buffer = downloaded.buffer;
      const outputMimeType = downloaded.mimeType;
      lap("image_download_done");

      // Apply watermark for free-plan users
      if (workspaceId) {
        try {
          const { data: sub } = await admin
            .from("subscriptions")
            .select("plan")
            .eq("workspace_id", workspaceId)
            .maybeSingle();

          const plan: SubscriptionPlan =
            (sub?.plan as SubscriptionPlan) ?? "free";
          if (plan === "free") {
            buffer = await applyWatermark(buffer, outputMimeType);
            lap("watermark_applied");
          }
        } catch (wmErr) {
          // Non-fatal: log and continue without watermark rather than failing the job
          console.warn(`${tag} Watermark failed, continuing without:`, wmErr);
        }
      }

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
        signed_url: urlData.signedUrl,
        object_path: objectPath,
        width: dimensions.width,
        height: dimensions.height,
        mime_type: outputMimeType,
      };
    } finally {
      clearInterval(heartbeatTimer);
    }
  },
);

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

function deterministicAssetId(jobId: string, suffix: string) {
  const bytes = Buffer.from(
    createHash("sha256").update(`${jobId}:${suffix}`).digest().subarray(0, 16),
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
