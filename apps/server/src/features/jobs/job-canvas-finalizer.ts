import type { JobTargetFinalizationDto, Json } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { insertImageElement } from "../canvas/canvas-element-writer.js";

const RECONCILE_BATCH_SIZE = 100;

type FinalizableJob = {
  id: string;
  canvas_id: string | null;
  target_kind?: string | null | undefined;
  design_id?: string | null | undefined;
  session_id: string | null;
  job_type: string;
  status: string;
  payload: unknown;
  result: unknown;
};

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
    finalization.status !== "completed"
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
  const output = {
    status: "succeeded",
    jobId: job.id,
    design_id: designId,
    ...(typeof finalized.object_id === "string"
      ? { object_id: finalized.object_id }
      : {}),
    ...(typeof finalized.revision === "number"
      ? { revision: finalized.revision }
      : {}),
    finalization: finalized,
  };
  const contentBlocks = [
    {
      type: "tool",
      toolCallId: `job-result-${job.id}`,
      toolName: "generate_image",
      status: "completed",
      output,
      outputSummary: "图片生成完成",
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
      content: "图片生成完成",
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
  const { data, error } = await admin
    .from("background_jobs")
    .select(
      "id,canvas_id,target_kind,design_id,session_id,job_type,status,payload,result",
    )
    .eq("job_type", "image_generation")
    .eq("status", "succeeded")
    .eq("target_kind", "design")
    .not("session_id", "is", null)
    .is("result->>chat_finalized_at", null)
    .order("created_at", { ascending: true })
    .limit(RECONCILE_BATCH_SIZE);
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
            title: kind === "background" ? "修复背景" : `拆分元素 ${index}`,
            model: "local:feynobg",
            ...(typeof payload.prompt === "string"
              ? { prompt: payload.prompt }
              : {}),
            ...(index === 0 &&
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
        output: { status: "succeeded", jobId: job.id },
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
    const { error: chatError } = await admin.from("chat_messages").upsert(
      {
        id: job.id,
        session_id: job.session_id,
        role: "assistant",
        content: "图片生成完成",
        content_blocks: contentBlocks as Json,
      },
      { onConflict: "id" },
    );
    if (chatError) {
      throw new Error(
        `Failed to persist image job ${job.id} in chat: ${chatError.message}`,
      );
    }
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
      "id, canvas_id, target_kind, design_id, session_id, job_type, status, payload, result",
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
  const { data, error } = await admin
    .from("background_jobs")
    .select(
      "id, canvas_id, target_kind, design_id, session_id, job_type, status, payload, result",
    )
    .eq("status", "succeeded")
    .eq("job_type", "image_generation")
    .eq("target_kind", "canvas")
    .order("completed_at", { ascending: false })
    .limit(RECONCILE_BATCH_SIZE);
  if (error)
    throw new Error(
      `Failed to reconcile successful image jobs: ${error.message}`,
    );

  let finalized = 0;
  let failed = 0;
  for (const job of data ?? []) {
    if (!isAutoFinalizable(job)) continue;
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
  return { checked: data?.length ?? 0, finalized, failed };
}
