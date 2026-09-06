import OpenAI, { toFile } from "openai";

import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageProvider,
  ModelInfo,
} from "../types.js";
import { GenerationError, fetchAsBase64 } from "../utils.js";

export const OPENAI_IMAGE_MODELS: readonly ModelInfo[] = [
  {
    id: "gpt-image-1-mini",
    displayName: "GPT Image 1 Mini",
    description: "Fast, economical image generation and editing.",
    iconUrl: "https://github.com/openai.png",
  },
  {
    id: "gpt-image-1",
    displayName: "GPT Image 1",
    description:
      "High-quality image generation and editing with strong prompt following.",
    iconUrl: "https://github.com/openai.png",
  },
  {
    id: "gpt-image-2",
    displayName: "GPT Image 2",
    description:
      "Latest premium GPT image model available through the configured gateway.",
    iconUrl: "https://github.com/openai.png",
  },
];

export const APIYI_IMAGE_MODELS: readonly ModelInfo[] = [
  {
    id: "gpt-image-2-all",
    displayName: "GPT Image 2 All",
    description: "APIYI GPT Image 2 generation and editing model.",
    iconUrl: "https://github.com/openai.png",
  },
  {
    id: "nano-banana-2",
    displayName: "Nano Banana 2",
    description: "APIYI Nano Banana 2 image generation model.",
    iconUrl: "https://github.com/google.png",
  },
];

function resolveSize(
  aspectRatio = "1:1",
  options: {
    exactWidth?: number;
    exactHeight?: number;
    use2K?: boolean;
  } = {},
): { size: string; width: number; height: number } {
  if (options.exactWidth && options.exactHeight) {
    return {
      size: `${options.exactWidth}x${options.exactHeight}`,
      width: options.exactWidth,
      height: options.exactHeight,
    };
  }
  const [width = 1, height = 1] = aspectRatio.split(":").map(Number);
  if (options.use2K) {
    if (width > height) {
      const outputHeight = Math.max(16, Math.round((2048 * height / width) / 16) * 16);
      return { size: `2048x${outputHeight}`, width: 2048, height: outputHeight };
    }
    if (height > width) {
      const outputWidth = Math.max(16, Math.round((2048 * width / height) / 16) * 16);
      return { size: `${outputWidth}x2048`, width: outputWidth, height: 2048 };
    }
    return { size: "2048x2048", width: 2048, height: 2048 };
  }
  if (width > height) return { size: "1536x1024", width: 1536, height: 1024 };
  if (height > width) return { size: "1024x1536", width: 1024, height: 1536 };
  return { size: "1024x1024", width: 1024, height: 1024 };
}

function readImageResult(
  data: { url?: string | null; b64_json?: string | null } | undefined,
): string | undefined {
  if (data?.url) return data.url;
  if (data?.b64_json) return `data:image/png;base64,${data.b64_json}`;
  return undefined;
}

export class OpenAIImageProvider implements ImageProvider {
  readonly name: string;
  readonly models: readonly ModelInfo[];
  private client: OpenAI;

  constructor(
    apiKey: string,
    baseURL?: string,
    options: {
      name?: string;
      models?: readonly ModelInfo[];
    } = {},
  ) {
    this.name = options.name ?? "openai";
    this.models = options.models ?? OPENAI_IMAGE_MODELS;
    this.client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      timeout: 120_000,
      maxRetries: 1,
    });
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    const isApiYiAll = params.model === "gpt-image-2-all";
    const isGptImage2 = params.model === "gpt-image-2";
    let prompt = params.prompt;
    if (isApiYiAll) {
      // This gateway branch omits native size fields. Carry the requested ratio
      // into BOTH generation and editing instead of silently discarding it.
      const ratio = params.aspectRatio ?? "1:1";
      const parts = ratio.split(":");
      const [w, h] = parts.map(Number);
      if (parts.length !== 2 || !Number.isFinite(w) || !Number.isFinite(h) || !(w! > 0) || !(h! > 0)) {
        throw new GenerationError(this.name, "invalid_input", "Invalid image aspect ratio.");
      }
      const shape = w === h ? "square" : w! > h! ? "landscape" : "portrait";
      prompt += `\n\nOutput canvas requirement: aspect ratio ${w}:${h} (width:height), ${shape} image. Compose the complete image within this output ratio; do not substitute another ratio. This specifies the image canvas, not text to draw in the image.`;
    }
    const { size, width, height } = resolveSize(params.aspectRatio, {
      ...(isGptImage2 && params.outputWidth && params.outputHeight
        ? { exactWidth: params.outputWidth, exactHeight: params.outputHeight }
        : {}),
      use2K: isGptImage2 && params.quality === "hd",
    });
    const quality =
      isGptImage2 && params.quality === "hd"
        ? "high"
        : params.quality === "ultra"
        ? "high"
        : params.quality === "standard"
          ? "low"
          : "medium";

    try {
      const response = params.inputImages?.length
        ? await this.client.images.edit({
            model: params.model,
            prompt,
            image: await Promise.all(
              params.inputImages.map(async (input, index) => {
                const { data, mimeType } = await fetchAsBase64(
                  this.name,
                  input,
                );
                return toFile(
                  Buffer.from(data, "base64"),
                  `input-${index}.png`,
                  {
                    type: mimeType,
                  },
                );
              }),
            ),
            ...(isApiYiAll
              ? { response_format: "url" as const }
              : { size: size as "1024x1024", quality, n: 1 }),
          }, isApiYiAll
            ? { timeout: 300_000, maxRetries: 0 }
            : isGptImage2
              ? { timeout: 360_000, maxRetries: 0 }
              : undefined)
        : await this.client.images.generate({
            model: params.model,
            prompt,
            ...(isApiYiAll
              ? { response_format: "url" as const }
              : {
                  size: size as "1024x1024",
                  quality,
                  ...(params.outputFormat
                    ? {
                        output_format:
                          params.outputFormat === "jpg"
                            ? "jpeg"
                            : params.outputFormat,
                      }
                    : {}),
                  n: 1,
                }),
          }, isApiYiAll
            ? { timeout: 300_000, maxRetries: 0 }
            : isGptImage2
              ? { timeout: 360_000, maxRetries: 0 }
              : undefined);

      const url = readImageResult(response.data?.[0]);
      if (!url) {
        throw new GenerationError(
          this.name,
          "no_output",
          "OpenAI returned no image URL",
        );
      }

      return { url, mimeType: "image/png", width, height };
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      throw new GenerationError(
        this.name,
        "api_error",
        error instanceof Error ? error.message : "Unknown OpenAI error",
      );
    }
  }
}
