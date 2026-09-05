import { registerExecutor, type ExecutorContext } from "../job-executor.js";
import { generateVideo } from "../../../generation/video-generation.js";
import { resolveVideoProviderName } from "../../../generation/providers/registry.js";
import { safeDownload } from "../../../security/safe-download.js";
import { normalizePersistedGenerationJob } from "../design-target-normalizer.js";

registerExecutor("video_generation", async (jobId, _rawPayload, ctx: ExecutorContext) => {
  const t0 = Date.now();

  const admin = ctx.getAdminClient();
  const jobRow = normalizePersistedGenerationJob(
    await ctx.jobService.getJobAdmin(jobId),
  );
  if (jobRow.job_type !== "video_generation") {
    throw new Error(`Job ${jobId} is not a video generation job`);
  }

  // Build log tag with traceability context: jobId + sessionId (if available)
  const sessionShort = (jobRow.session_id as string)?.slice(0, 8) ?? "no-session";
  const tag = `[video-job:${jobId.slice(0, 8)} session:${sessionShort}]`;
  const lap = (label: string) => console.log(`${tag} ${label} +${Date.now() - t0}ms`);
  lap("db_fetch");

  const payload = jobRow.payload;

  if (!payload.prompt) throw new Error(`Job ${jobId} has no prompt in payload`);

  const createdBy: string | null = jobRow.created_by ?? null;
  const workspaceId: string = jobRow.workspace_id ?? jobId;

  const model = payload.model ?? "wan-video/wan-2.6";
  const providerName = resolveVideoProviderName(model);

  // Renew VT every 120s (roughly half of the 300s video queue VT) to prevent
  // the message from becoming visible during long video generation.
  const VIDEO_VT_SECONDS = 300;
  const heartbeatTimer = setInterval(() => {
    ctx.renewVt(VIDEO_VT_SECONDS);
  }, 120_000);

  try {
    lap("replicate_call_start");
    const generated = await generateVideo(providerName, {
      prompt: payload.prompt,
      model,
      ...(payload.duration != null ? { duration: payload.duration } : {}),
      ...(payload.resolution ? { resolution: payload.resolution as "480p" | "720p" | "1080p" } : {}),
      ...(payload.aspect_ratio ? { aspectRatio: payload.aspect_ratio } : {}),
      ...(payload.input_images?.length ? { inputImages: payload.input_images } : {}),
      ...(payload.input_video ? { inputVideo: payload.input_video } : {}),
      ...(payload.enable_audio != null ? { enableAudio: payload.enable_audio } : {}),
    });
    lap("replicate_call_done");

    // Vertex AI can return inline data URIs; every path still gets the same
    // byte, MIME and signature checks.
    const downloaded = await safeDownload(generated.url, {
      kind: "video",
      maxBytes: 256 * 1024 * 1024,
      timeoutMs: 180_000,
      maxRedirects: 2,
      allowDataUri: true,
      expectedMimeType: generated.mimeType ?? "video/mp4",
      allowedMimeTypes: ["video/mp4", "video/webm"],
    });
    const buffer = downloaded.buffer;
    const outputMimeType = downloaded.mimeType;
    lap("video_download_done");

    const ext = outputMimeType === "video/webm" ? "webm" : "mp4";
    const timestamp = Date.now();
    const objectPath = `${workspaceId}/generated/${timestamp}-${jobId}.${ext}`;

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
      throw new Error(`Failed to create asset record: ${assetError?.message ?? "unknown error"}`);
    }
    lap("asset_record_done");

    const { data: urlData, error: urlError } = await admin.storage
      .from("workspace-assets")
      .createSignedUrl(objectPath, 900);
    if (urlError || !urlData?.signedUrl) {
      throw new Error("Failed to create a private video URL");
    }

    lap("total");
    return {
      asset_id: (assetRow as { id: string }).id,
      signed_url: urlData.signedUrl,
      object_path: objectPath,
      width: generated.width,
      height: generated.height,
      duration_seconds: generated.durationSeconds,
      mime_type: outputMimeType,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(`Video generation failed for model ${model}: ${detail}`);
    // Preserve the original error code so the worker can distinguish
    // non-retryable errors (e.g. invalid_input) from transient failures.
    (wrapped as Error & { code?: string }).code =
      (err as { code?: string })?.code ?? "executor_error";
    throw wrapped;
  } finally {
    clearInterval(heartbeatTimer);
  }
});
