import { z } from "zod";
import { createAgentTool } from "./tool-run-context.js";

import {
  type AvailableVideoModel,
  getAvailableVideoModels,
  resolveVideoProviderName,
} from "../../generation/providers/registry.js";
import { generateVideo } from "../../generation/video-generation.js";
import type { GenerationBillingSummary } from "../image-generation-contracts.js";

const DEFAULT_MODEL = "veo-3.1-fast-generate-preview";

// ── Submit function type ───────────────────────────────────────────────────

export type SubmitVideoJobFn = (input: {
  prompt: string;
  model: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  inputImages?: string[];
  inputVideo?: string;
  enableAudio?: boolean;
}) => Promise<{
  jobId: string;
  elementId?: string;
  videoUrl?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  mimeType?: string;
  error?: string;
  billing?: GenerationBillingSummary;
}>;

// ── Dynamic schema builder ─────────────────────────────────────────────────

function buildVideoGenerateSchema(models: AvailableVideoModel[]) {
  const modelIds = models.map((m) => m.id);
  const defaultModel = modelIds.includes(DEFAULT_MODEL)
    ? DEFAULT_MODEL
    : (modelIds[0] ?? DEFAULT_MODEL);

  const modelDescription = models.length
    ? `Video model to use. Available:\n${models.map((m) => `- ${m.id}: ${m.description}`).join("\n")}`
    : "Model identifier (no video providers currently registered)";

  const modelField =
    modelIds.length >= 1
      ? z
          .enum(modelIds as [string, ...string[]])
          .default(defaultModel as (typeof modelIds)[number])
          .describe(modelDescription)
      : z.string().default(DEFAULT_MODEL).describe(modelDescription);

  return z.object({
    title: z
      .string()
      .min(1)
      .describe(
        "Short descriptive title for the generated video, used as metadata so the video content is understood without re-analysis (e.g. 'Autumn forest bus scene', '恐龙追逐镜头')",
      ),
    prompt: z
      .string()
      .min(1)
      .describe(
        "Detailed video generation prompt. Be specific about motion, camera angles, lighting, mood, action, and scene transitions.",
      ),
    model: modelField,
    duration: z
      .number()
      .int()
      .min(3)
      .max(16)
      .optional()
      .default(5)
      .describe(
        "Video duration in seconds. Use ONLY a value in the selected model's allowedDurations from current_context.availableVideoModels — that list is authoritative and a value outside it is refused by the provider. Do not infer a range from general model families.",
      ),
    resolution: z
      .enum(["480p", "720p", "1080p", "4k"])
      .optional()
      .default("720p")
      .describe(
        "Output resolution. 720p recommended for balance of quality and speed. 1080p/4k supported by Google Veo official models (8s duration required).",
      ),
    aspectRatio: z
      .enum(["1:1", "16:9", "9:16", "4:3", "3:4"])
      .optional()
      .default("16:9")
      .describe(
        "Video aspect ratio. 16:9 for landscape, 9:16 for portrait/mobile.",
      ),
    inputImages: z
      .array(z.string())
      .max(7)
      .optional()
      .describe(
        "Reference image URLs for image-to-video. First image used as first frame. Only for models with I2V capability.",
      ),
    inputVideo: z
      .string()
      .optional()
      .describe(
        "Source video URL for video-to-video editing. Only for Kling O1.",
      ),
    enableAudio: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Generate synchronized audio (dialogue, sound effects, ambient). This option is only sent to models that advertise audio capability.",
      ),
    placementX: z
      .number()
      .optional()
      .describe(
        "Canvas X coordinate for video placement. Use inspect_canvas to find a good position.",
      ),
    placementY: z
      .number()
      .optional()
      .describe(
        "Canvas Y coordinate for video placement. Use inspect_canvas to find a good position.",
      ),
    placementWidth: z
      .number()
      .optional()
      .describe("Width on canvas (default: 640)"),
    placementHeight: z
      .number()
      .optional()
      .describe("Height on canvas (default: 360)"),
  });
}

// ── Result type ────────────────────────────────────────────────────────────

// Infer input type from schema — includes the new `title` field
type VideoGenerateInput = z.infer<ReturnType<typeof buildVideoGenerateSchema>>;

type VideoGenerateResult = {
  summary: string;
  title?: string;
  prompt?: string;
  elementId?: string;
  videoUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  placement?: { x: number; y: number; width: number; height: number };
  error?: string;
  jobId?: string;
  jobType?: "video_generation";
  billing?: GenerationBillingSummary;
};

// ── Run function ───────────────────────────────────────────────────────────

export async function runVideoGenerate(
  rawInput: VideoGenerateInput,
  submitVideoJob?: SubmitVideoJobFn,
  availableModels = getAvailableVideoModels(),
): Promise<VideoGenerateResult> {
  const input = rawInput;
  const t0 = Date.now();
  const lap = (label: string, extra?: Record<string, unknown>) => {
    console.log(
      `[generate_video] ${label} +${Date.now() - t0}ms`,
      extra ? JSON.stringify(extra) : "",
    );
  };

  // An unresolved reference must fail the request, not silently downgrade a
  // paid image-to-video submission into a different text-to-video operation.
  if (input.inputImages?.length
    && input.inputImages.some(img =>
      !img.startsWith("http://") && !img.startsWith("https://") && !img.startsWith("data:"))) {
    return {
      summary: "视频参考图尚未解析，未提交生成。请先读取有效图片后重试。",
      error: "video_reference_image_invalid",
    };
  }

  const selectedModel = availableModels.find(
    (candidate) => candidate.id === input.model,
  );
  if (!selectedModel) {
    return {
      summary: `Video generation failed: model ${input.model} is not available`,
      error: `Video model is not available: ${input.model}`,
    };
  }

  const capabilityError = validateCapabilities(input, selectedModel);
  if (capabilityError) {
    return {
      summary: `Video generation failed with model ${input.model}: ${capabilityError}`,
      error: capabilityError,
    };
  }

  const enableAudio = selectedModel.capabilities.audio
    ? input.enableAudio
    : undefined;

  // Job mode: submit to PGMQ and wait for worker
  if (submitVideoJob) {
    try {
      lap("job_submit", { model: input.model });
      const jobResult = await submitVideoJob({
        prompt: input.prompt,
        model: input.model,
        duration: input.duration,
        resolution: input.resolution,
        aspectRatio: input.aspectRatio,
        ...(input.inputImages ? { inputImages: input.inputImages } : {}),
        ...(input.inputVideo ? { inputVideo: input.inputVideo } : {}),
        ...(enableAudio != null ? { enableAudio } : {}),
      });

      if (jobResult.error) {
        lap("job_failed", { error: jobResult.error });
        const isTimeout = jobResult.error.includes("timed out");
        return {
          summary: isTimeout
            ? "Video is still being generated by the server. It will automatically appear on the canvas once ready — no action needed from the user."
            : `Video generation failed with model ${input.model}: ${jobResult.error}. Consider trying a different model or simplifying the prompt.`,
          error: jobResult.error,
          // Expose jobId so frontend can poll for late-arriving results
          // (worker may still succeed after agent poll timeout)
          jobId: jobResult.jobId,
          jobType: "video_generation" as const,
          ...(jobResult.billing ? { billing: jobResult.billing } : {}),
        };
      }
      lap("job_complete", { jobId: jobResult.jobId });

      const result: VideoGenerateResult = {
        summary: `Generated ${jobResult.durationSeconds ?? input.duration}s video (${jobResult.width ?? 0}x${jobResult.height ?? 0}) via ${input.model}`,
        title: input.title,
        prompt: input.prompt,
        ...(jobResult.elementId != null
          ? { elementId: jobResult.elementId }
          : {}),
        mimeType: jobResult.mimeType ?? "video/mp4",
        ...(jobResult.videoUrl != null ? { videoUrl: jobResult.videoUrl } : {}),
        ...(jobResult.width != null ? { width: jobResult.width } : {}),
        ...(jobResult.height != null ? { height: jobResult.height } : {}),
        ...(jobResult.durationSeconds != null
          ? { durationSeconds: jobResult.durationSeconds }
          : {}),
        ...(jobResult.billing ? { billing: jobResult.billing } : {}),
      };
      if (input.placementX != null && input.placementY != null) {
        result.placement = {
          x: input.placementX,
          y: input.placementY,
          width: input.placementWidth ?? 640,
          height: input.placementHeight ?? 360,
        };
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        summary: `Video generation failed with model ${input.model}: ${message}`,
        error: message,
      };
    }
  }

  // Direct mode: call provider directly
  try {
    lap("direct_generate_start", { model: input.model });
    const providerName = resolveVideoProviderName(input.model);
    const result = await generateVideo(providerName, {
      prompt: input.prompt,
      model: input.model,
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      ...(input.resolution
        ? { resolution: input.resolution as "480p" | "720p" | "1080p" }
        : {}),
      ...(input.inputImages ? { inputImages: input.inputImages } : {}),
      ...(input.inputVideo ? { inputVideo: input.inputVideo } : {}),
      ...(enableAudio != null ? { enableAudio } : {}),
    });
    lap("direct_generate_done");

    const directResult: VideoGenerateResult = {
      summary: `Generated ${result.durationSeconds}s video (${result.width}x${result.height}) via ${input.model}`,
      title: input.title,
      prompt: input.prompt,
      videoUrl: result.url,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
      durationSeconds: result.durationSeconds,
    };
    if (input.placementX != null && input.placementY != null) {
      directResult.placement = {
        x: input.placementX,
        y: input.placementY,
        width: input.placementWidth ?? 640,
        height: input.placementHeight ?? 360,
      };
    }
    return directResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      summary: `Video generation failed: ${message}`,
      error: message,
    };
  }
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createVideoGenerateTool(deps?: {
  submitVideoJob?: SubmitVideoJobFn;
  availableModels?: AvailableVideoModel[];
}) {
  const models = deps?.availableModels ?? getAvailableVideoModels();

  const modelSummary = models.length
    ? models.map((m) => `${m.displayName} (${m.id})`).join(", ")
    : "No video models available";

  return createAgentTool({
    id: "generate_video",
    description: `Generate a video using AI. Available models: ${modelSummary}. Supports text-to-video, image-to-video, and video editing. Returns the generated video URL.`,
    inputSchema: buildVideoGenerateSchema(models),
    execute: async (input) => {
      return await runVideoGenerate(input, deps?.submitVideoJob, models);
    },
  });
}

function validateCapabilities(
  input: VideoGenerateInput,
  model: AvailableVideoModel,
): string | undefined {
  if (input.inputImages?.length && !model.capabilities.imageToVideo) {
    return `${model.displayName} does not support image-to-video input`;
  }
  if ((input.inputImages?.length ?? 0) > model.limits.maxInputImages) {
    return `${model.displayName} accepts at most ${model.limits.maxInputImages} input image(s)`;
  }
  if (input.inputVideo && !model.capabilities.videoToVideo) {
    return `${model.displayName} does not support reference-video input`;
  }
  if (input.duration > model.limits.maxDuration) {
    return `${model.displayName} supports at most ${model.limits.maxDuration} seconds`;
  }
  if (
    model.limits.allowedDurations &&
    !model.limits.allowedDurations.includes(input.duration)
  ) {
    return `${model.displayName} supports durations: ${model.limits.allowedDurations.join(", ")} seconds`;
  }

  const requestedResolution =
    input.resolution === "4k" ? "2160p" : input.resolution;
  const resolutionRank = {
    "480p": 0,
    "720p": 1,
    "1080p": 2,
    "2160p": 3,
  } as const;
  if (
    resolutionRank[requestedResolution] >
    resolutionRank[model.limits.maxResolution]
  ) {
    return `${model.displayName} supports up to ${model.limits.maxResolution}`;
  }

  return undefined;
}
