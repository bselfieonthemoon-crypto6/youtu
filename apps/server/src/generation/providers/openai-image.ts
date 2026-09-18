import OpenAI, { toFile } from "openai";

import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageProvider,
  ModelInfo,
} from "../types.js";
import { GenerationError, fetchAsBase64 } from "../utils.js";
import { createSafeProviderFetch } from "../../security/safe-provider-fetch.js";
import { validateImageGenerationRequestLimits } from "../image-request-limits.js";
import {
  isApiYiAggregateGptImageModel,
  isNativeGptImageModel,
  resolveNativeImageSize,
} from "@loomic/shared";

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

// Structured provider identifiers only. Message text is deliberately excluded
// so a translated gateway error cannot turn a safety rejection into failover.
const SAFETY_REJECTION_IDENTIFIERS = new Set([
  "content_filter",
  "content_policy_violation",
  "moderation_blocked",
  "policy_violation",
  "safety_filter",
  "safety_violation",
]);

function structuredErrorIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_.-]{1,100}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function isStructuredSafetyRejection(error: unknown) {
  const candidate = error as { code?: unknown; type?: unknown } | null;
  return [candidate?.code, candidate?.type]
    .map(structuredErrorIdentifier)
    .some(value => value !== undefined && SAFETY_REJECTION_IDENTIFIERS.has(value));
}

function resolveNativeSize(params: ImageGenerateParams): { size: string; width: number; height: number } {
  const hasWidth = params.outputWidth !== undefined;
  const hasHeight = params.outputHeight !== undefined;
  if (hasWidth !== hasHeight) throw new Error("Native image output_width and output_height must be supplied together.");
  if (hasWidth && hasHeight) {
    const width = params.outputWidth!;
    const height = params.outputHeight!;
    const area = width * height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16
      || !Number.isInteger(width) || !Number.isInteger(height) || width % 16 || height % 16
      || Math.max(width, height) > 3840 || area < 655_360 || area > 8_294_400
      || Math.max(width / height, height / width) > 3) {
      throw new Error("Native image dimensions require 16px edges, ratio no wider than 3:1, long side <= 3840, and area 655360..8294400.");
    }
    return { width, height, size: `${width}x${height}` };
  }
  return resolveNativeImageSize(params.aspectRatio ?? "1:1", params.resolution ?? "1k");
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
  readonly supportsImageMask = true;
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
      ...(baseURL ? { baseURL, fetch: createSafeProviderFetch(baseURL) } : {}),
      timeout: 120_000,
      // Image requests cross a paid, potentially non-idempotent boundary. A
      // lost response cannot prove the provider did not create an image, so
      // neither the client default nor an individual model may retry it.
      maxRetries: 0,
    });
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    // APIYI's aggregate GPT Image routes use the same URL-only response
    // contract across point releases (for example 2-all and 2.5-all). They do
    // not accept the native OpenAI size presets used below; sending the generic
    // portrait preset would silently force every portrait request to 2:3.
    const isApiYiAll = isApiYiAggregateGptImageModel(params.model);
    const isNative = isNativeGptImageModel(params.model);
    const limitViolation = validateImageGenerationRequestLimits(params);
    if (limitViolation) {
      throw new GenerationError(this.name, limitViolation.code, limitViolation.message);
    }
    // Ordinary generation forwards background options to the selected endpoint.
    // The dedicated remove-background service owns its separate model policy.
    const outputOptions = {
      ...(params.background ? { background: params.background } : {}),
      ...(params.outputFormat ? { output_format: params.outputFormat === "jpg" ? "jpeg" as const : params.outputFormat } : {}),
    };
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
      prompt = `Output canvas requirement: ${shape} ${w}:${h}, aspect ratio ${w}:${h} (width:height). Compose the complete image within this output ratio; do not substitute another ratio. This specifies the image canvas, not text to draw in the image.\n\n${prompt}`;
    }
    let nativeSize: { size: string; width: number; height: number } | undefined;
    try {
      nativeSize = isNative ? resolveNativeSize(params) : undefined;
    } catch (error) {
      throw new GenerationError(this.name, "invalid_input", error instanceof Error ? error.message : "Invalid native image dimensions.");
    }
    // Keep other adapters' established preset contract unchanged.
    const [ratioWidth = 1, ratioHeight = 1] = (params.aspectRatio ?? "1:1").split(":").map(Number);
    const fallbackSize = ratioWidth > ratioHeight
      ? { size: "1536x1024", width: 1536, height: 1024 }
      : ratioHeight > ratioWidth
        ? { size: "1024x1536", width: 1024, height: 1536 }
        : { size: "1024x1024", width: 1024, height: 1024 };
    const { size, width, height } = nativeSize ?? fallbackSize;
    // Keep the product's billing tiers separate from the OpenAI-compatible
    // quality vocabulary. Every compatible model receives the same mapping;
    // GPT Image 2's native 2K size handling above must not promote `hd` to
    // upstream `high`.
    const quality = params.quality === "ultra"
      ? "high"
      : params.quality === "hd"
        ? "medium"
        : "low";
    const requestOptions = isApiYiAll
      ? { timeout: 300_000, maxRetries: 0 as const }
      : isNative
        ? { timeout: 360_000, maxRetries: 0 as const }
        : { maxRetries: 0 as const };

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
            ...(params.maskImage
              ? {
                  mask: await (async () => {
                    const maskImage = params.maskImage;
                    if (!maskImage) throw new Error("Image edit mask is missing.");
                    const { data, mimeType } = await fetchAsBase64(
                      this.name,
                      maskImage,
                    );
                    return toFile(Buffer.from(data, "base64"), "mask.png", {
                      type: mimeType,
                    });
                  })(),
                }
              : {}),
            ...(isApiYiAll
              ? { response_format: "url" as const, quality, ...outputOptions }
              : { size: size as "1024x1024", quality, n: 1, ...outputOptions }),
          }, requestOptions)
        : await this.client.images.generate({
            model: params.model,
            prompt,
            ...(isApiYiAll
              ? { response_format: "url" as const, quality, ...outputOptions }
              : {
                  size: size as "1024x1024",
                  quality,
                  ...outputOptions,
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
          }, requestOptions);

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
      const upstreamCode = (error as { code?: unknown })?.code;
      const upstreamStatus = (error as { status?: unknown })?.status;
      const detail = error instanceof Error ? error.message : "Unknown OpenAI error";
      // A gateway can return 503 for both an ambiguous transport failure and an
      // explicit pre-dispatch rejection. Only the latter is proof that no image
      // request reached an available channel. Keep ordinary 5xx/timeouts guarded.
      const explicitlyRejectedBeforeDispatch =
        /\bno available channel\b/i.test(detail) &&
        (upstreamCode === "thirdparty503" || (
          /503\s*获取分组\s+default\s+下模型/i.test(detail) &&
          /[（(]distributor[）)]/i.test(detail)
        ));
      const status = typeof upstreamStatus === "number" && Number.isInteger(upstreamStatus)
        ? upstreamStatus : undefined;
      const classification = explicitlyRejectedBeforeDispatch
        ? "provider_rejected"
        : isStructuredSafetyRejection(error)
          ? "safety_filter"
          : status === 401 || status === 404 || status === 429
            ? "provider_rejected"
            : status === 400 || status === 403 || status === 422
              ? "invalid_input"
              : "api_error";
      throw new GenerationError(
        this.name,
        classification,
        detail,
      );
    }
  }
}
