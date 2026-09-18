/** Metadata describing a model supported by a provider. */
export interface ModelInfo {
  /** Provider-scoped model ID, e.g. "google/nano-banana-pro" */
  id: string;
  /** Human-readable name shown to users */
  displayName: string;
  /** Short description for LLM model selection */
  description: string;
  /** URL to the model owner's avatar/icon */
  iconUrl?: string;
}

/**
 * Semantic provider quality levels. Pixel dimensions are selected separately
 * through ImageResolution where a native provider supports them.
 */
export type ImageQuality = "standard" | "hd" | "ultra";
export type ImageResolution = "1k" | "2k" | "4k";

export type OutputFormat = "png" | "jpg" | "webp";

export interface ImageGenerateParams {
  prompt: string;
  model: string;
  aspectRatio?: string;
  inputImages?: string[];
  /** PNG alpha mask for image edits; transparent pixels are replaced. */
  maskImage?: string;
  /** Semantic quality level, provider translates to model-specific resolution */
  quality?: ImageQuality;
  /** Native output pixel tier. This is independent of provider quality. */
  resolution?: ImageResolution;
  /** Exact requested output dimensions for providers that support custom sizes. */
  outputWidth?: number;
  outputHeight?: number;
  /** Output format preference */
  outputFormat?: OutputFormat;
  /** Native GPT Image 2 transparency; unsupported adapters must not silently drop it. */
  background?: "transparent" | "opaque" | "auto";
  metadata?: Record<string, unknown>;
}

export interface GeneratedImage {
  url: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface ImageProvider {
  readonly name: string;
  readonly models: readonly ModelInfo[];
  /** Whether this adapter forwards an edit mask instead of silently dropping it. */
  readonly supportsImageMask?: boolean;
  generate(params: ImageGenerateParams): Promise<GeneratedImage>;
}

export interface VideoGenerateParams {
  prompt: string;
  model: string;
  resolution?: "480p" | "720p" | "1080p";
  duration?: number;
  aspectRatio?: string;
  inputImages?: string[];
  inputVideo?: string;
  /** Enable audio generation (only supported by some providers). */
  enableAudio?: boolean;
}

export interface GeneratedVideo {
  url: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
}

export interface VideoProvider {
  readonly name: string;
  readonly models: readonly VideoModelInfo[];
  generate(params: VideoGenerateParams): Promise<GeneratedVideo>;
}

export interface VideoPriceRate {
  /** Loomic's resolution value sent through the public generation API. */
  resolution: "720p" | "1080p";
  /** Provider-native label shown to users, for example 768P or 2K. */
  displayResolution: string;
  providerPointsPerSecond: number;
  cnyPerSecond: {
    min: number;
    max: number;
  };
}

export interface VideoPricingInfo {
  currency: "CNY";
  billingUnit: "generated_second";
  providerPointsName: string;
  evidenceDate: string;
  rates: readonly VideoPriceRate[];
}

/** Extended model info with video-specific capabilities metadata. */
export interface VideoModelInfo extends ModelInfo {
  capabilities: {
    textToVideo: boolean;
    imageToVideo: boolean;
    videoToVideo: boolean;
    audio: boolean;
  };
  limits: {
    maxDuration: number;
    allowedDurations?: number[];
    maxResolution: "480p" | "720p" | "1080p" | "2160p";
    maxInputImages: number;
  };
  /** Verified provider pricing, separate from Loomic's own credit balance. */
  pricing?: VideoPricingInfo;
}
