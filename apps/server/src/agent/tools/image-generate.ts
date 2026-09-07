import { tool } from "langchain";
import { z } from "zod";

import { randomUUID } from "node:crypto";

import { type DesignJobTarget, designJobTargetSchema } from "@loomic/shared";

import type { DestructiveConfirmationService } from "../../features/agent-actions/destructive-confirmation-service.js";
import { generateImage } from "../../generation/image-generation.js";
import {
  type AvailableModel,
  getAvailableImageModels,
  resolveImageProviderName,
} from "../../generation/providers/registry.js";

const DEFAULT_MODEL = "gpt-image-2-all";

/**
 * Build the zod schema dynamically from the models available in the registry.
 * Falls back to a plain string field when no providers are registered.
 */
function buildImageGenerateSchema(models: AvailableModel[]) {
  const modelIds = models.map((m) => m.id);
  const defaultModel = modelIds.includes(DEFAULT_MODEL)
    ? DEFAULT_MODEL
    : (modelIds[0] ?? DEFAULT_MODEL);

  const modelDescription = models.length
    ? `Model to use. Available:\n${models.map((m) => `- ${m.id}: ${m.displayName} — ${m.description}`).join("\n")}`
    : "Model identifier (no providers currently registered)";

  // z.enum needs [string, ...string[]], but we may have 0 models at test time.
  const modelField =
    modelIds.length >= 1
      ? z
          .enum(modelIds as [string, ...string[]])
          .default(defaultModel as (typeof modelIds)[number])
          .describe(modelDescription)
      : z.string().default(DEFAULT_MODEL).describe(modelDescription);

  return z
    .object({
      title: z
        .string()
        .min(1)
        .describe(
          "Short descriptive title for the generated image, used as metadata so the image content is understood without re-analysis",
        ),
      prompt: z.string().min(1).describe("Detailed image generation prompt"),
      model: modelField,
      aspectRatio: z
        .string()
        .optional()
        .default("1:1")
        .describe(
          "Aspect ratio (e.g. 1:1, 16:9, 9:16, 4:3, 3:4, 4:5, 5:4, 2:3, 3:2). Provider auto-normalizes unsupported ratios to nearest match.",
        ),
      quality: z
        .enum(["standard", "hd", "ultra"])
        .optional()
        .default("hd")
        .describe(
          "Image quality/resolution level. standard: ~1K fast preview, hd: ~2K production quality (default), ultra: ~4K print quality (not all models support this, will use max available).",
        ),
      outputFormat: z
        .enum(["png", "jpg", "webp"])
        .optional()
        .describe(
          "Output image format. PNG for transparency, JPG for photos, WebP for web.",
        ),
      inputImages: z
        .array(z.string())
        .optional()
        .describe(
          "Reference image URLs for editing/transformation. Google models accept up to 14, Flux models accept 1. Imagen 4 and Recraft V3 are text-only.",
        ),
      placementX: z
        .number()
        .optional()
        .describe(
          "Legacy infinite-canvas left edge. Omit whenever target is supplied.",
        ),
      placementY: z
        .number()
        .optional()
        .describe(
          "Legacy infinite-canvas top edge. Omit whenever target is supplied.",
        ),
      placementWidth: z
        .number()
        .optional()
        .describe(
          "Legacy infinite-canvas display width. Omit whenever target is supplied; execution defaults to 512 when needed.",
        ),
      placementHeight: z
        .number()
        .optional()
        .describe(
          "Legacy infinite-canvas display height. Omit whenever target is supplied; execution defaults to 512 when needed.",
        ),
      target: z
        .object({
          kind: z.literal("design"),
          design_id: z.string().uuid(),
          expected_revision: z.number().int().min(0),
          idempotency_key: z.string().uuid(),
          placement: z
            .object({
              layer_index: z
                .number()
                .int()
                .nonnegative()
                .optional()
                .describe(
                  "Zero-based insertion index, 0 is back. Clamped to current layer count on delivery; omitted appends on top. Ignored for replacement, which preserves layer order.",
                ),
              x: z.number().finite(),
              y: z.number().finite(),
              width: z.number().positive().optional(),
              height: z.number().positive().optional(),
              replace_object_id: z.string().uuid().optional(),
              fit: z.enum(["contain", "cover", "fill", "original"]).optional(),
              role: z
                .enum([
                  "background",
                  "title",
                  "subtitle",
                  "logo",
                  "product",
                  "decoration",
                ])
                .optional(),
            })
            .strict(),
        })
        .strict()
        .optional()
        .describe(
          "Insert into an exact native design revision. Use inspect_design first.",
        ),
    })
    .superRefine((value, context) => {
      if (
        value.target &&
        (value.placementX !== undefined ||
          value.placementY !== undefined ||
          value.placementWidth !== undefined ||
          value.placementHeight !== undefined)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "target placement and legacy canvas placement cannot be combined",
          path: ["target"],
        });
      }
    });
}

type ImageGenerateInput = {
  title: string;
  prompt: string;
  model: string;
  aspectRatio?: string;
  quality?: string;
  outputFormat?: string;
  inputImages?: string[];
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
  target?: DesignJobTarget;
};

type ImageGenerateResult = {
  status?: "processing";
  summary: string;
  title?: string;
  elementId?: string;
  imageUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  error?: string;
  jobId?: string;
  jobType?: "image_generation";
  billing?: GenerationBillingSummary;
  placement?: { x: number; y: number; width: number; height: number };
  confirmation?: Record<string, unknown>;
  design_id?: string;
  object_id?: string;
  revision?: number;
  finalization_status?: "completed" | "needs_attention" | "failed";
  preview_status?: "queued" | "failed" | "unavailable";
};

export type GenerationBillingSummary = {
  estimate: number;
  charged: number;
  balanceAfter: number;
  currency: "credits";
};

/**
 * Optional function to persist a generated image to OSS.
 * Accepts the ephemeral URL and returns a persistent signed URL.
 */
export type PersistImageFn = (
  sourceUrl: string,
  mimeType: string,
  prompt: string,
) => Promise<string>;

/**
 * Submit an image generation job and wait for it to complete.
 * Returns the final result: signed_url on success, error on failure.
 */
export type SubmitImageJobFn = (input: {
  prompt: string;
  title: string;
  model: string;
  aspectRatio: string;
  inputImages?: string[];
  quality?: string;
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
  target?: DesignJobTarget;
}) => Promise<{
  jobId: string;
  elementId?: string;
  imageUrl?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  error?: string;
  billing?: GenerationBillingSummary;
  design_id?: string;
  object_id?: string;
  revision?: number;
  finalization_status?: "completed" | "needs_attention" | "failed";
  preview_status?: "queued" | "failed" | "unavailable";
}>;

export async function runImageGenerate(
  input: ImageGenerateInput,
  persistImage?: PersistImageFn,
  submitImageJob?: SubmitImageJobFn,
  attachmentMap?: Record<string, string>,
): Promise<ImageGenerateResult> {
  const t0 = Date.now();
  const lap = (label: string, extra?: Record<string, unknown>) => {
    console.log(
      `[generate_image] ${label} +${Date.now() - t0}ms`,
      extra ? JSON.stringify(extra) : "",
    );
  };

  if (input.target && !submitImageJob) {
    return {
      summary:
        "Image generation was not started because native design delivery is unavailable.",
      error: "design_target_delivery_unavailable",
    };
  }

  // Resolve assetId references in inputImages to base64 data URIs
  if (input.inputImages?.length && attachmentMap) {
    input = {
      ...input,
      inputImages: input.inputImages.map((ref) => attachmentMap[ref] ?? ref),
    };
  }

  // Filter out invalid image references — only keep valid URLs.
  // Agent may pass canvas element IDs or unresolved assetIds that aren't
  // in the attachmentMap. These would cause Replicate 422 errors.
  if (input.inputImages?.length) {
    const validImages = input.inputImages.filter(
      (img) =>
        img.startsWith("http://") ||
        img.startsWith("https://") ||
        img.startsWith("data:"),
    );
    if (validImages.length !== input.inputImages.length) {
      lap("filtered_invalid_refs", {
        before: input.inputImages.length,
        after: validImages.length,
        dropped: input.inputImages.filter(
          (img) =>
            !img.startsWith("http://") &&
            !img.startsWith("https://") &&
            !img.startsWith("data:"),
        ),
      });
    }
    input =
      validImages.length > 0
        ? { ...input, inputImages: validImages }
        : { ...input, inputImages: [] };
  }

  // Job mode: submit to PGMQ and wait for worker to complete
  if (submitImageJob) {
    try {
      lap("job_submit", { model: input.model });
      const jobResult = await submitImageJob({
        prompt: input.prompt,
        title: input.title,
        model: input.model,
        aspectRatio: input.aspectRatio ?? "1:1",
        ...(input.inputImages ? { inputImages: input.inputImages } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
        ...(input.placementX != null ? { placementX: input.placementX } : {}),
        ...(input.placementY != null ? { placementY: input.placementY } : {}),
        ...(input.placementWidth != null
          ? { placementWidth: input.placementWidth }
          : {}),
        ...(input.placementHeight != null
          ? { placementHeight: input.placementHeight }
          : {}),
        ...(input.target
          ? { target: designJobTargetSchema.parse(input.target) }
          : {}),
      });

      if (jobResult.error) {
        lap("job_failed", { error: jobResult.error });
        const isTimeout = jobResult.error.includes("timed out");
        return {
          summary: isTimeout
            ? `Image is still being generated by the server. It will automatically appear on the canvas once ready — no action needed from the user.`
            : `Image generation failed with model ${input.model}: ${jobResult.error}. Consider trying a different model or simplifying the prompt.`,
          ...(isTimeout ? {status:"processing" as const} : {error:jobResult.error}),
          // Expose jobId so frontend can poll for late-arriving results
          // (worker may still succeed after agent poll timeout)
          jobId: jobResult.jobId,
          jobType: "image_generation" as const,
          ...(jobResult.billing ? { billing: jobResult.billing } : {}),
        };
      }
      lap("job_complete", { jobId: jobResult.jobId });

      const result: ImageGenerateResult = {
        summary: `Generated image (${jobResult.width ?? 0}x${jobResult.height ?? 0}) via ${input.model}`,
        title: input.title,
        jobId: jobResult.jobId,
        jobType: "image_generation" as const,
        ...(jobResult.elementId != null
          ? { elementId: jobResult.elementId }
          : {}),
        imageUrl: jobResult.imageUrl ?? "",
        mimeType: jobResult.mimeType ?? "image/png",
        ...(jobResult.width != null ? { width: jobResult.width } : {}),
        ...(jobResult.height != null ? { height: jobResult.height } : {}),
        ...(jobResult.billing ? { billing: jobResult.billing } : {}),
        ...(jobResult.design_id ? { design_id: jobResult.design_id } : {}),
        ...(jobResult.object_id ? { object_id: jobResult.object_id } : {}),
        ...(jobResult.revision !== undefined
          ? { revision: jobResult.revision }
          : {}),
        ...(jobResult.finalization_status
          ? { finalization_status: jobResult.finalization_status }
          : {}),
        ...(jobResult.preview_status
          ? { preview_status: jobResult.preview_status }
          : {}),
      };
      if (input.placementX != null && input.placementY != null) {
        result.placement = {
          x: input.placementX,
          y: input.placementY,
          width: input.placementWidth ?? 512,
          height: input.placementHeight ?? 512,
        };
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        summary: `Image generation failed with model ${input.model}: ${message}. Consider trying a different model or simplifying the prompt.`,
        error: message,
      };
    }
  }

  // Direct generation: resolve provider from model ID via registry
  try {
    lap("direct_generate_start", { model: input.model });
    const providerName = resolveImageProviderName(input.model);
    const result = await generateImage(providerName, {
      prompt: input.prompt,
      model: input.model,
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.quality ? { quality: input.quality as any } : {}),
      ...(input.outputFormat
        ? { outputFormat: input.outputFormat as any }
        : {}),
      ...(input.inputImages?.length ? { inputImages: input.inputImages } : {}),
    });
    lap("direct_generate_done", { width: result.width, height: result.height });

    let imageUrl = result.url;
    if (persistImage) {
      try {
        imageUrl = await persistImage(
          result.url,
          result.mimeType,
          input.prompt,
        );
        lap("persist_image_done");
      } catch {
        // Fall back to ephemeral URL if upload fails
      }
    }

    const directResult: ImageGenerateResult = {
      summary: `Generated image (${result.width}x${result.height}) via ${input.model}`,
      title: input.title,
      imageUrl,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
    };
    if (input.placementX != null && input.placementY != null) {
      directResult.placement = {
        x: input.placementX,
        y: input.placementY,
        width: input.placementWidth ?? 512,
        height: input.placementHeight ?? 512,
      };
    }
    return directResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      summary: `Image generation failed: ${message}`,
      error: message,
    };
  }
}

export function createImageGenerateTool(deps?: {
  validateDesignTarget?: (
    target: NonNullable<ImageGenerateInput["target"]>,
    context: Record<string, any>,
  ) => Promise<void>;
  confirmationService?: DestructiveConfirmationService;
  persistImage?: PersistImageFn;
  submitImageJob?: SubmitImageJobFn;
  /** Override for testing — defaults to querying the provider registry. */
  availableModels?: AvailableModel[];
}) {
  const models = deps?.availableModels ?? getAvailableImageModels();

  const modelSummary = models.length
    ? models.map((m) => `${m.displayName} (${m.id})`).join(", ")
    : "No models available";

  return tool(
    async (input: ImageGenerateInput, config) => {
      const configurable = (config as any)?.configurable;
      const attachmentMap = configurable?.user_attachment_map as
        | Record<string, string>
        | undefined;
      const userId = configurable?.user_id;
      const canvasId = configurable?.canvas_id;
      const runId = configurable?.run_id;

      if (
        !deps?.confirmationService ||
        typeof userId !== "string" ||
        typeof canvasId !== "string"
      ) {
        return {
          summary:
            "Image generation was not started because user confirmation is unavailable.",
          error: "confirmation_unavailable",
        };
      }

      if (
        !input.target &&
        /设计画板|原生设计/.test(String(configurable?.user_prompt ?? ""))
      ) {
        return {
          error: "design_target_required",
          summary:
            "用户指定了原生设计画板。请先 list_designs、inspect_design，再指定真实 target；未提交任何生成任务。",
        };
      }
      if (input.target) {
        try {
          if (input.target.design_id === "00000000-0000-0000-0000-000000000000")
            throw new Error(
              "无效画板 ID，请先调用 list_designs、inspect_design 获取真实画板",
            );
          if (!deps.validateDesignTarget)
            throw new Error("画板校验服务不可用，未创建生成方案");
          await deps.validateDesignTarget(input.target, configurable);
        } catch (error) {
          return {
            error: "design_target_invalid",
            summary:
              error instanceof Error
                ? error.message
                : "请重新读取真实画板后生成方案",
          };
        }
      }
      const frozenInput = structuredClone({
        ...input,
        ...(input.target
          ? { target: designJobTargetSchema.parse(input.target) }
          : {}),
      });
      const frozenAttachmentMap = attachmentMap
        ? structuredClone(attachmentMap)
        : undefined;
      const confirmation = deps.confirmationService.proposeAction({
        userId,
        canvasId,
        kind: "image_generation",
        ...(typeof runId === "string" ? { originRunId: runId } : {}),
        details: {
          title: frozenInput.title,
          description: frozenInput.prompt,
          model: frozenInput.model,
          aspectRatio: frozenInput.aspectRatio ?? "1:1",
          quality: frozenInput.quality ?? "hd",
          outputFormat: frozenInput.outputFormat ?? "png",
          referenceImageCount: frozenInput.inputImages?.length ?? 0,
          target: frozenInput.target ?? null,
          placement:
            frozenInput.placementX != null && frozenInput.placementY != null
              ? {
                  x: frozenInput.placementX,
                  y: frozenInput.placementY,
                  width: frozenInput.placementWidth ?? 512,
                  height: frozenInput.placementHeight ?? 512,
                }
              : null,
        },
        execute: async () => {
          if (frozenInput.target) {
            try {
              await deps.validateDesignTarget!(
                frozenInput.target,
                configurable,
              );
            } catch (error) {
              return {
                error: "design_target_invalid",
                summary:
                  error instanceof Error
                    ? error.message
                    : "画板已改变，请重新读取后生成方案",
              };
            }
          }
          return runImageGenerate(
            structuredClone(frozenInput),
            deps.persistImage,
            deps.submitImageJob,
            frozenAttachmentMap
              ? structuredClone(frozenAttachmentMap)
              : undefined,
          );
        },
      });

      return {
        summary:
          "图片尚未开始生成。请用自然、详细的中文向用户复述准备生成的画面，并询问是否确认生成。",
        status: "awaiting_confirmation",
        confirmation,
      };
    },
    {
      name: "generate_image",
      description: `Prepare a detailed image generation proposal for conversational user confirmation. This tool never starts generation immediately. After it returns, explain the proposed image in natural Chinese and ask whether the user confirms; do not show a parameter card and do not claim generation started. Available models: ${modelSummary}.`,
      schema: buildImageGenerateSchema(models),
    },
  );
}
