import type { BackgroundJobStatus, JobTargetFinalizationDto, Json } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { imageSubmissionReceipt } from "./image-submission-receipt.js";
import { insertImageElement, markImageGenerationPlaceholderFailed, removeCompletedImagePlaceholder } from "../canvas/canvas-element-writer.js";
import { isAgentTaskAttachmentRejected } from "../agent-tasks/agent-task-service.js";

const RECONCILE_BATCH_SIZE = 100;

export type FinalizableJob = {
  id: string;
  workspace_id: string;
  canvas_id: string | null;
  target_kind?: string | null | undefined;
  design_id?: string | null | undefined;
  session_id: string | null;
  job_type: string;
  status: BackgroundJobStatus;
  payload: unknown;
  credits_cost?: number | null;
  result: unknown;
  error_code?: string | null | undefined;
  error_message?: string | null | undefined;
};

const TERMINAL_IMAGE_STATUSES = new Set<BackgroundJobStatus>(["canceled", "dead_letter"]);

export type CanvasFinalizationResult = {
  elementId: string;
  inserted: boolean;
};

export async function finalizeDesignImageJobChat(
  admin: AdminSupabaseClient,
  job: FinalizableJob,
  finalization: JobTargetFinalizationDto,
): Promise<boolean> {
  if (
    job.status !== "succeeded" ||
    job.job_type !== "image_generation" ||
    job.target_kind !== "design" ||
    !job.session_id ||
    !["completed", "needs_attention", "failed"].includes(
      finalization.status,
    )
  )
    return false;
  const result = asRecord(job.result);
  if (typeof result.chat_finalized_at === "string") return false;
  const finalized = asRecord(finalization.result as Json | null);
  const signedUrl = result.signed_url;
  const width = result.width;
  const height = result.height;
  const mimeType = result.mime_type;
  const designId = finalized.design_id ?? job.design_id;
  if (
    typeof signedUrl !== "string" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    typeof mimeType !== "string" ||
    typeof designId !== "string"
  )
    throw new Error(
      `Successful design image job ${job.id} has an incomplete result.`,
    );

  const payload = asRecord(job.payload);
  const applied = finalization.status === "completed";
  const outcomeSummary = applied
    ? "图片生成完成"
    : finalization.status === "needs_attention"
      ? "图片已生成，但未应用到设计，需要处理"
      : "图片已生成，但应用到设计失败";
  const output = {
    status: "succeeded",
    jobId: job.id,
    visualStatus: "unverified",
    viewed: false,
    ...(typeof result.asset_id === "string" ? { assetId: result.asset_id } : {}),
    design_id: designId,
    ...(typeof finalized.object_id === "string"
      ? { object_id: finalized.object_id }
      : {}),
    ...(typeof finalized.revision === "number"
      ? { revision: finalized.revision }
      : {}),
    finalization_status: finalization.status,
    finalization: finalized,
    ...(applied
      ? {}
      : {
          error:
            finalization.error_message ??
            "图片素材已保存，但没有应用到原生设计。请打开原设计并根据当前版本重新放置；不要重新生成图片。",
          ...(finalization.error_code
            ? { error_code: finalization.error_code }
            : {}),
        }),
  };
  const contentBlocks = [
    {
      type: "tool",
      toolCallId: `job-result-${job.id}`,
      toolName: "generate_image",
      status: "completed",
      output,
      outputSummary: outcomeSummary,
      artifacts: [
        {
          type: "image",
          url: signedUrl,
          mimeType,
          width,
          height,
          title:
            typeof payload.title === "string" ? payload.title : "图片生成结果",
          jobId: job.id,
        },
      ],
    },
  ];
  const { error: chatError } = await admin.from("chat_messages").upsert(
    {
      id: job.id,
      session_id: job.session_id,
      role: "assistant",
      content: outcomeSummary,
      content_blocks: contentBlocks as Json,
    },
    { onConflict: "id" },
  );
  if (chatError)
    throw new Error(
      `Failed to persist design image job ${job.id} in chat: ${chatError.message}`,
    );
  const { error: updateError } = await admin
    .from("background_jobs")
    .update({
      result: {
        ...result,
        chat_finalized_at: new Date().toISOString(),
      } as Json,
    })
    .eq("id", job.id)
    .eq("status", "succeeded");
  if (updateError)
    throw new Error(
      `Failed to mark design image chat ${job.id} finalized: ${updateError.message}`,
    );
  return true;
}

export async function reconcileSucceededDesignImageChats(
  admin: AdminSupabaseClient,
): Promise<{ finalized: number; failed: number }> {
  // PostgreSQL joins terminal target finalizations and live assets before the
  // bounded batch. Missing/pending historical rows cannot starve a later chat
  // outcome that is ready to be closed.
  const { data, error } = await (admin.rpc as any)(
    "loomic_recoverable_design_image_chats",
    { p_limit: RECONCILE_BATCH_SIZE },
  );
  if (error)
    throw new Error(`Failed to scan design image chats: ${error.message}`);
  let finalized = 0;
  let failed = 0;
  for (const raw of data ?? []) {
    const job = raw as unknown as FinalizableJob;
    if (typeof asRecord(job.result).chat_finalized_at === "string") continue;
    const { data: finalization, error: finalizationError } = await admin
      .from("job_target_finalizations")
      .select(
        "job_id,command_id,status,result,error_code,error_message,created_at,updated_at",
      )
      .eq("job_id", job.id)
      .maybeSingle();
    if (finalizationError || !finalization) {
      failed += 1;
      continue;
    }
    try {
      if (
        await finalizeDesignImageJobChat(
          admin,
          job,
          finalization as JobTargetFinalizationDto,
        )
      )
        finalized += 1;
    } catch {
      failed += 1;
    }
  }
  return { finalized, failed };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Converge a terminal image job's persisted chat and canvas placeholder. This
 * never creates or retries provider work; every write is bound to the job id. */
export async function finalizeTerminalImageJobPlaceholder(
  admin: AdminSupabaseClient,
  job: FinalizableJob,
): Promise<boolean> {
  if (job.job_type !== "image_generation" || !TERMINAL_IMAGE_STATUSES.has(job.status)) return false;
  const result = asRecord(job.result);
  const payload = asRecord(job.payload);
  const finalizedResult: Record<string, unknown> = { ...result };
  let changed = false;
  const terminalStatus = job.status === "canceled" ? "canceled" : "failed";
  const retryEligible = job.status === "dead_letter" && job.error_code === "provider_rejected";
  const summary = job.status === "canceled"
    ? "图片生成已取消，未交付新图片。"
    : retryEligible
      ? "当前兼容图片渠道均明确拒绝了本次任务，未交付新图片；可在新一轮明确要求重试。"
      : job.error_code === "image_generation_result_unknown"
        ? "图片生成结果不确定；为避免重复调用或扣费，系统未自动重试。"
        : "图片生成失败，未交付新图片。";

  // Only the direct Mastra submitter creates a job-id chat placeholder. Legacy
  // proposal jobs have a different presentation flow and must not gain a new
  // historical card during reconciliation.
  if (job.session_id && typeof payload.mastra_submission_key === "string"
    && payload.mastra_submission_key && typeof result.chat_terminal_finalized_at !== "string") {
    const { error: chatError } = await admin.from("chat_messages").upsert({
      id: job.id,
      session_id: job.session_id,
      role: "assistant",
      content: summary,
      content_blocks: [{
        type: "tool",
        toolCallId: `job-result-${job.id}`,
        toolName: "generate_image",
        status: terminalStatus,
        output: {
          ...imageSubmissionReceipt(job),
          status: job.status,
          jobId: job.id,
          ...(job.error_code ? { error_code: job.error_code } : {}),
          ...(job.error_message ? { error: job.error_message.slice(0, 2_000) } : {}),
          retryEligible,
        },
        outputSummary: summary,
        retryable: false,
      }],
    }, { onConflict: "id" });
    if (chatError) throw new Error(`Failed to settle terminal image chat ${job.id}: ${chatError.message}`);
    finalizedResult.chat_terminal_finalized_at = new Date().toISOString();
    finalizedResult.chat_terminal_status = job.status;
    changed = true;
  }

  if (job.target_kind === "canvas" && typeof job.canvas_id === "string"
    && typeof result.canvas_terminal_finalized_at !== "string") {
    const target = asRecord(payload.target as Json | null);
    const validTarget = target.kind === undefined
      || (target.kind === "canvas" && target.canvas_id === job.canvas_id);
    const placeholderId = target.element_id ?? payload.placeholder_element_id;
    if (validTarget && typeof placeholderId === "string" && placeholderId) {
      await markImageGenerationPlaceholderFailed(
        admin,
        job.canvas_id,
        placeholderId,
        job.id,
        job.status === "canceled" ? "生成已取消" : "图片生成失败",
      );
      finalizedResult.canvas_terminal_finalized_at = new Date().toISOString();
      finalizedResult.canvas_terminal_status = job.status;
      changed = true;
    }
  }
  if (!changed) return false;
  const { error } = await admin.from("background_jobs").update({ result: {
    ...finalizedResult,
  } as Json }).eq("id", job.id).eq("status", job.status);
  if (error) throw new Error(`Failed to mark terminal image job ${job.id} settled: ${error.message}`);
  return true;
}

/** Recover terminal jobs archived before their placeholder was settled. New
 * terminal jobs are handled synchronously by the worker; this bounded recent
 * scan closes the crash window and repairs existing stale placeholders. */
export async function reconcileTerminalImageJobPlaceholders(
  admin: AdminSupabaseClient,
): Promise<{ checked: number; finalized: number; failed: number }> {
  const { data, error } = await admin.from("background_jobs")
    .select("id,workspace_id,canvas_id,target_kind,design_id,session_id,job_type,status,payload,result,error_code,error_message,updated_at")
    .eq("job_type", "image_generation").eq("target_kind", "canvas")
    .in("status", ["canceled", "dead_letter"])
    .is("result->>canvas_terminal_finalized_at", null)
    .order("updated_at", { ascending: false }).limit(RECONCILE_BATCH_SIZE);
  if (error) throw new Error(`Failed to scan terminal image placeholders: ${error.message}`);
  const jobs = ((data ?? []) as unknown as FinalizableJob[])
    .filter(job => typeof asRecord(job.result).canvas_terminal_finalized_at !== "string");
  let finalized = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      if (await finalizeTerminalImageJobPlaceholder(admin, job)) finalized += 1;
    } catch (settleError) {
      failed += 1;
      console.error(`[canvas-finalizer] Failed to settle terminal job ${job.id}:`, settleError);
    }
  }
  return { checked: jobs.length, finalized, failed };
}

/** Recover terminal chat cards left running when a worker stopped between the
 * terminal job CAS and its idempotent presentation write. */
export async function reconcileTerminalImageJobChats(
  admin: AdminSupabaseClient,
): Promise<{ checked: number; finalized: number; failed: number }> {
  const { data, error } = await admin.from("background_jobs")
    .select("id,workspace_id,canvas_id,target_kind,design_id,session_id,job_type,status,payload,result,error_code,error_message,updated_at")
    .eq("job_type", "image_generation")
    .in("status", ["canceled", "dead_letter"])
    .not("session_id", "is", null)
    .not("payload->>mastra_submission_key", "is", null)
    .is("result->>chat_terminal_finalized_at", null)
    .order("updated_at", { ascending: false }).limit(RECONCILE_BATCH_SIZE);
  if (error) throw new Error(`Failed to scan terminal image chats: ${error.message}`);
  const jobs = ((data ?? []) as unknown as FinalizableJob[])
    .filter(job => job.session_id && typeof asRecord(job.result).chat_terminal_finalized_at !== "string");
  let finalized = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      if (await finalizeTerminalImageJobPlaceholder(admin, job)) finalized += 1;
    } catch (settleError) {
      failed += 1;
      console.error(`[canvas-finalizer] Failed to settle terminal image chat ${job.id}:`, settleError);
    }
  }
  return { checked: jobs.length, finalized, failed };
}

function isAutoFinalizable(job: FinalizableJob): boolean {
  const payload = asRecord(job.payload);
  const result = asRecord(job.result);
  const target = asRecord(payload.target as Json | null);
  const isCanvasTarget =
    job.target_kind === "canvas" &&
    typeof job.canvas_id === "string" &&
    (target.kind === undefined ||
      (target.kind === "canvas" && target.canvas_id === job.canvas_id));
  return (
    job.status === "succeeded" &&
    job.job_type === "image_generation" &&
    isCanvasTarget &&
    (typeof result.canvas_finalized_at !== "string" ||
      (typeof job.session_id === "string" &&
        typeof result.chat_finalized_at !== "string"))
  );
}

/**
 * Persist a successful generated image into its canvas. Both the canvas insert
 * and subsequent retries are idempotent by sourceJobId, so a crash between the
 * two database writes cannot duplicate an element.
 */
export async function finalizeImageJobToCanvas(
  admin: AdminSupabaseClient,
  job: FinalizableJob,
): Promise<CanvasFinalizationResult | null> {
  try {
    return await finalizeCurrentImageJobToCanvas(admin, job);
  } catch (error) {
    if (!isAgentTaskAttachmentRejected(error)) throw error;
    // The provider succeeded and its assets remain available. Only attachment
    // was rejected by the transaction guard after the user changed direction.
    const result = asRecord(job.result);
    const attachmentMessage =
      "图片已生成并保留；任务已更新，未应用到当前画布。";
    const finalizedAt = new Date().toISOString();
    if (
      job.session_id &&
      typeof result.chat_finalized_at !== "string"
    ) {
      const payload = asRecord(job.payload);
      const artifact =
        typeof result.signed_url === "string" &&
        typeof result.mime_type === "string" &&
        typeof result.width === "number" &&
        typeof result.height === "number"
          ? [{
              type: "image" as const,
              url: result.signed_url,
              mimeType: result.mime_type,
              width: result.width,
              height: result.height,
              title: typeof payload.title === "string" ? payload.title : "图片生成结果",
              jobId: job.id,
            }]
          : [];
      const { error: chatError } = await admin.from("chat_messages").upsert(
        {
          id: job.id,
          session_id: job.session_id,
          role: "assistant",
          content: attachmentMessage,
          content_blocks: [{
            type: "tool",
            toolCallId: `job-result-${job.id}`,
            toolName: "generate_image",
            status: "completed",
            output: {
              ...imageSubmissionReceipt(job),
              status: "succeeded",
              jobId: job.id,
              ...(typeof result.asset_id === "string" ? { assetId: result.asset_id } : {}),
              source: { jobId: job.id },
              visualStatus: "unverified",
              viewed: false,
              finalization_status: "needs_attention",
              attachment_status: "superseded",
              error_code: "agent_task_superseded",
              error: attachmentMessage,
            },
            outputSummary: attachmentMessage,
            artifacts: artifact,
          }] as Json,
        },
        { onConflict: "id" },
      );
      if (chatError)
        throw new Error(
          `Failed to persist superseded image job ${job.id} in chat: ${chatError.message}`,
        );
    }
    const { error: saveError } = await admin.from("background_jobs")
      .update({ result: {
        ...result,
        attachment_status: "superseded",
        attachment_message: attachmentMessage,
        canvas_finalized_at: finalizedAt,
        ...(!job.session_id || typeof result.chat_finalized_at !== "string"
          ? { chat_finalized_at: finalizedAt }
          : {}),
      } as Json })
      .eq("id", job.id).eq("status", "succeeded");
    if (saveError) throw new Error(`Failed to retain superseded image result: ${saveError.message}`);
    return null;
  }
}

async function finalizeCurrentImageJobToCanvas(
  admin: AdminSupabaseClient,
  job: FinalizableJob,
): Promise<CanvasFinalizationResult | null> {
  if (!isAutoFinalizable(job) || !job.canvas_id) return null;

  const payload = asRecord(job.payload);
  const target = asRecord(payload.target as Json | null);
  const targetPlacement = asRecord(target.placement as Json | null);
  const result = asRecord(job.result);
  const assetId = result.asset_id;
  const objectPath = result.object_path;
  const width = result.width;
  const height = result.height;
  const mimeType = result.mime_type;

  if (
    typeof assetId !== "string" ||
    typeof objectPath !== "string" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    typeof mimeType !== "string"
  ) {
    throw new Error(`Successful image job ${job.id} has an incomplete result.`);
  }

  const explicitPlacement =
    typeof (targetPlacement.x ?? payload.placement_x) === "number" &&
    typeof (targetPlacement.y ?? payload.placement_y) === "number" &&
    typeof (targetPlacement.width ?? payload.placement_width) === "number" &&
    typeof (targetPlacement.height ?? payload.placement_height) === "number"
      ? {
          x: (targetPlacement.x ?? payload.placement_x) as number,
          y: (targetPlacement.y ?? payload.placement_y) as number,
          width: (targetPlacement.width ?? payload.placement_width) as number,
          height: (targetPlacement.height ??
            payload.placement_height) as number,
        }
      : undefined;
  const imageOptions = {
    canvasId: job.canvas_id,
    sourceJobId: job.id,
    assetId,
    objectPath,
    width,
    height,
    mimeType,
    ...(typeof payload.title === "string" ? { title: payload.title } : {}),
    ...(typeof payload.prompt === "string" ? { prompt: payload.prompt } : {}),
    ...(typeof payload.model === "string" ? { model: payload.model } : {}),
    ...(typeof payload.quality === "string"
      ? { quality: payload.quality }
      : {}),
    ...(typeof (target.element_id ?? payload.placeholder_element_id) ===
    "string"
      ? {
          replaceElementId: (target.element_id ??
            payload.placeholder_element_id) as string,
        }
      : {}),
  };
  let elementId =
    typeof result.canvas_element_id === "string"
      ? result.canvas_element_id
      : null;
  let inserted = false;
  const finalizedResult: Record<string, unknown> = { ...result };

  if (typeof result.canvas_finalized_at !== "string") {
    if (payload.operation === "split_layers" && Array.isArray(result.layers)) {
      const sourceWidth =
        typeof result.source_width === "number" ? result.source_width : width;
      const sourceHeight =
        typeof result.source_height === "number"
          ? result.source_height
          : height;
      const base = explicitPlacement;
      const layerIds: string[] = [];
      for (const [index, rawLayer] of result.layers.entries()) {
        const layer =
          rawLayer && typeof rawLayer === "object" && !Array.isArray(rawLayer)
            ? (rawLayer as Record<string, unknown>)
            : {};
        const layerAssetId = layer.asset_id;
        const layerObjectPath = layer.object_path;
        const layerWidth = layer.width;
        const layerHeight = layer.height;
        const kind = typeof layer.kind === "string" ? layer.kind : "element";
        if (
          typeof layerAssetId !== "string" ||
          typeof layerObjectPath !== "string" ||
          typeof layerWidth !== "number" ||
          typeof layerHeight !== "number"
        )
          continue;
        const layerPlacement = base
          ? {
              x: base.x + ((Number(layer.x) || 0) / sourceWidth) * base.width,
              y: base.y + ((Number(layer.y) || 0) / sourceHeight) * base.height,
              width: (layerWidth / sourceWidth) * base.width,
              height: (layerHeight / sourceHeight) * base.height,
            }
          : undefined;
        const layerResult = await insertImageElement(
          admin,
          {
            canvasId: job.canvas_id,
            sourceJobId: `${job.id}:${kind}:${index}`,
            assetId: layerAssetId,
            objectPath: layerObjectPath,
            width: layerWidth,
            height: layerHeight,
            mimeType: "image/png",
            title: typeof layer.name === "string" ? layer.name :
              kind === "background" ? "修复背景" : `拆分元素 ${index}`,
            model: typeof result.model === "string" ? result.model : "local:feynobg",
            ...(typeof payload.prompt === "string"
              ? { prompt: payload.prompt }
              : {}),
            ...(payload.layer_backend !== "semantic" && index === 0 &&
            typeof (target.element_id ?? payload.placeholder_element_id) ===
              "string"
              ? {
                  replaceElementId: (target.element_id ??
                    payload.placeholder_element_id) as string,
                }
              : {}),
          },
          layerPlacement,
        );
        layerIds.push(layerResult.elementId);
        if (index === 0) {
          elementId = layerResult.elementId;
          inserted = layerResult.inserted;
        }
      }
      if (!layerIds.length)
        throw new Error(`Layer split job ${job.id} has no valid layers.`);
      finalizedResult.canvas_element_id = layerIds[0];
      finalizedResult.canvas_layer_ids = layerIds;
      // The source is preserved; only the job-owned progress placeholder is
      // removed, after every layer was persisted successfully.
      const completedPlaceholderId = target.element_id ?? payload.placeholder_element_id;
      if (payload.layer_backend === "semantic" && typeof completedPlaceholderId === "string") {
        await removeCompletedImagePlaceholder(admin, job.canvas_id, completedPlaceholderId, job.id);
      }
    } else {
      const canvasResult = explicitPlacement
        ? await insertImageElement(admin, imageOptions, explicitPlacement)
        : await insertImageElement(admin, imageOptions);
      elementId = canvasResult.elementId;
      inserted = canvasResult.inserted;
      finalizedResult.canvas_element_id = canvasResult.elementId;
    }
    finalizedResult.canvas_finalized_at = new Date().toISOString();
  }

  if (
    job.session_id &&
    typeof result.chat_finalized_at !== "string" &&
    typeof result.signed_url === "string"
  ) {
    const title =
      typeof payload.title === "string" ? payload.title : "图片生成结果";
    const contentBlocks = [
      {
        type: "tool",
        toolCallId: `job-result-${job.id}`,
        toolName: "generate_image",
        status: "completed",
        output: { ...imageSubmissionReceipt(job), status: "succeeded", jobId: job.id, assetId, visualStatus: "unverified", viewed: false },
        outputSummary: "图片生成完成",
        artifacts: [
          {
            type: "image",
            url: result.signed_url,
            mimeType,
            width,
            height,
            title,
            jobId: job.id,
          },
        ],
      },
    ];
    // The chat card is a PROJECTION of the placeholder row written at submission
    // time (its id is the job id). An "edit and resend" deletes that row, so an
    // upsert here would resurrect the discarded attempt and put its card back on
    // screen. Update-only: when the row is gone, the turn was deliberately
    // discarded and only the canvas result remains — the user paid for that
    // image, so it is kept rather than deleted.
    //
    // Tradeoff: this gives up re-creating a placeholder lost to a crash between
    // job creation and the placeholder insert. That window is milliseconds and
    // the canvas result is still finalized either way, whereas resurrecting a
    // discarded turn is a visible, reproducible bug.
    const { data: chatRows, error: chatError } = await admin.from("chat_messages")
      .update({ content: "图片生成完成", content_blocks: contentBlocks as Json })
      .eq("id", job.id)
      .eq("session_id", job.session_id)
      .select("id");
    if (chatError) {
      throw new Error(
        `Failed to persist image job ${job.id} in chat: ${chatError.message}`,
      );
    }
    if (!chatRows?.length) {
      console.info("[job-finalizer] chat card skipped; turn was discarded", { jobId: job.id });
    }
    // Recorded either way: the placeholder is gone for good, so a recovery scan
    // must not keep trying to write this card.
    finalizedResult.chat_finalized_at = new Date().toISOString();
  }

  const { error } = await admin
    .from("background_jobs")
    .update({ result: finalizedResult as Json })
    .eq("id", job.id)
    .eq("status", "succeeded");
  if (error) {
    throw new Error(
      `Failed to mark image job ${job.id} as canvas-finalized: ${error.message}`,
    );
  }

  return elementId ? { elementId, inserted } : null;
}

export async function finalizeSucceededImageJob(
  admin: AdminSupabaseClient,
  jobId: string,
): Promise<CanvasFinalizationResult | null> {
  const { data, error } = await admin
    .from("background_jobs")
    .select(
      "id, workspace_id, canvas_id, target_kind, design_id, session_id, job_type, status, payload, result, credits_cost",
    )
    .eq("id", jobId)
    .maybeSingle();
  if (error)
    throw new Error(`Failed to load image job ${jobId}: ${error.message}`);
  if (!data) return null;
  return finalizeImageJobToCanvas(admin, data);
}

/** Recover successful jobs whose worker stopped after upload but before canvas write. */
export async function reconcileSucceededImageJobs(
  admin: AdminSupabaseClient,
): Promise<{ checked: number; finalized: number; failed: number }> {
  // Eligibility is filtered transactionally in PostgreSQL before LIMIT. A
  // missing/deletion-pending asset can therefore never occupy the bounded
  // recovery batch or permanently hide a later live job.
  // Generated database types lag unapplied migrations in source control; the
  // SQL contract test owns this service-role-only function signature.
  const { data, error } = await (admin.rpc as any)(
    "loomic_recoverable_canvas_image_jobs",
    { p_limit: RECONCILE_BATCH_SIZE },
  );
  if (error)
    throw new Error(
      `Failed to reconcile successful image jobs: ${error.message}`,
    );
  const jobs = (Array.isArray(data) ? data : []) as FinalizableJob[];

  // A successful historical job is not permission to resurrect a deleted
  // asset. Manual restore already rejects deletion-pending assets; background
  // recovery must apply the same lifecycle rule before writing any canvas.
  const resultAssetIds = (job: FinalizableJob) => {
    const result = asRecord(job.result);
    const layers = Array.isArray(result.layers) ? result.layers : [];
    return [result.asset_id, ...layers.map(layer => asRecord(layer).asset_id)]
      .filter((id): id is string => typeof id === "string");
  };
  const candidateAssetIds = [...new Set(jobs.filter(isAutoFinalizable).flatMap(resultAssetIds))];
  const liveAssetKeys = new Set<string>();
  if (candidateAssetIds.length) {
    const assets = await admin.from("asset_objects").select("id,workspace_id")
      .in("id", candidateAssetIds).is("deletion_pending_at", null);
    if (assets.error) throw new Error("Failed to check image recovery asset lifecycle; no canvas was modified.");
    for (const asset of assets.data ?? [])
      liveAssetKeys.add(`${asset.workspace_id}:${asset.id}`);
  }

  let finalized = 0;
  let failed = 0;
  for (const job of jobs) {
    if (!isAutoFinalizable(job)) continue;
    if (resultAssetIds(job).some(
      assetId => !liveAssetKeys.has(`${job.workspace_id}:${assetId}`),
    )) continue;
    try {
      const outcome = await finalizeImageJobToCanvas(admin, job);
      if (outcome) finalized += 1;
    } catch (finalizeError) {
      failed += 1;
      console.error(
        `[canvas-finalizer] Failed to finalize job ${job.id}:`,
        finalizeError,
      );
    }
  }
  return { checked: jobs.length, finalized, failed };
}
