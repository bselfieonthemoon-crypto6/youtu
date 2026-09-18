import type {
  GeneratedVideo,
  VideoGenerateParams,
  VideoModelInfo,
  VideoProvider,
} from "../types.js";
import { GenerationError, fetchAsBase64 } from "../utils.js";
import {
  createSafeProviderFetch,
  type SafeProviderFetchDependencies,
} from "../../security/safe-provider-fetch.js";

const PROVIDER_NAME = "apiyi";
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 8_000;
const MAX_WAIT_MS = 5 * 60_000;

export const APIYI_VIDEO_MODELS: readonly VideoModelInfo[] = [
  {
    id: "veo-3.1-fast-generate-preview",
    displayName: "Veo 3.1 Fast",
    description:
      "Fast Veo 3.1 text-to-video and image-to-video with native audio.",
    iconUrl: "https://github.com/google.png",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      videoToVideo: false,
      audio: true,
    },
    limits: {
      maxDuration: 8,
      allowedDurations: [4, 6, 8],
      maxResolution: "1080p",
      maxInputImages: 1,
    },
  },
];

type TaskResponse = {
  id?: string;
  task_id?: string;
  status?: string;
  code?: string | number;
  message?: string;
  error?: { message?: string } | string;
};

export class ApiYiVideoProvider implements VideoProvider {
  readonly name = PROVIDER_NAME;
  readonly models: readonly VideoModelInfo[];

  private readonly baseUrl: string;
  private readonly providerFetch: typeof fetch;

  constructor(
    private readonly apiKey: string,
    baseUrl: string,
    models: readonly VideoModelInfo[] = APIYI_VIDEO_MODELS,
    transport: SafeProviderFetchDependencies = {},
  ) {
    if (!apiKey.trim())
      throw new GenerationError(
        PROVIDER_NAME,
        "invalid_config",
        "API key is required",
      );
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.providerFetch = createSafeProviderFetch(this.baseUrl, transport);
    this.models = models;
  }

  async generate(params: VideoGenerateParams): Promise<GeneratedVideo> {
    const model = this.models.find(
      (candidate) => candidate.id === params.model,
    );
    if (!model)
      throw new GenerationError(
        PROVIDER_NAME,
        "model_not_found",
        `Unknown API易 video model: ${params.model}`,
      );
    if (params.inputVideo)
      throw new GenerationError(
        PROVIDER_NAME,
        "invalid_input",
        "API易 Veo does not support video-to-video input",
      );
    if ((params.inputImages?.length ?? 0) > model.limits.maxInputImages)
      throw new GenerationError(
        PROVIDER_NAME,
        "invalid_input",
        `Model accepts at most ${model.limits.maxInputImages} input images`,
      );
    if ((params.inputImages?.length ?? 0) > 0 && !model.capabilities.imageToVideo)
      throw new GenerationError(
        PROVIDER_NAME,
        "invalid_input",
        "Model does not declare image-to-video support",
      );
    if (params.enableAudio === true && !model.capabilities.audio)
      throw new GenerationError(
        PROVIDER_NAME,
        "invalid_input",
        "Model does not declare audio generation support",
      );

    const allowedDurations = model.limits.allowedDurations;
    const duration =
      params.duration ?? allowedDurations?.[0] ?? Math.min(4, model.limits.maxDuration);
    if (
      duration > model.limits.maxDuration ||
      (allowedDurations && !allowedDurations.includes(duration))
    )
      throw new GenerationError(
        PROVIDER_NAME,
        "invalid_input",
        "Requested duration is not supported by this model",
      );
    const resolution =
      params.resolution === "1080p" &&
      ["1080p", "2160p"].includes(model.limits.maxResolution)
        ? "1080p"
        : "720p";
    if (resolution === "1080p" && duration !== 8) {
      throw new GenerationError(
        PROVIDER_NAME,
        "invalid_input",
        "API易 Veo requires an 8-second duration for 1080p video",
      );
    }
    const aspectRatio = params.aspectRatio === "9:16" ? "9:16" : "16:9";
    const size =
      resolution === "1080p"
        ? aspectRatio === "9:16"
          ? "1080x1920"
          : "1920x1080"
        : aspectRatio === "9:16"
          ? "720x1280"
          : "1280x720";

    let body: NonNullable<RequestInit["body"]>;
    let headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (params.inputImages?.[0]) {
      const input = await fetchAsBase64(PROVIDER_NAME, params.inputImages[0]);
      const form = new FormData();
      form.set("model", params.model);
      form.set("prompt", params.prompt);
      form.set("duration", String(duration));
      form.set("resolution", resolution);
      form.set("aspectRatio", aspectRatio);
      form.set("size", size);
      form.set(
        "input_reference",
        new Blob([Buffer.from(input.data, "base64")], { type: input.mimeType }),
        "input.png",
      );
      body = form;
    } else {
      headers = { ...headers, "Content-Type": "application/json" };
      body = JSON.stringify({
        model: params.model,
        prompt: params.prompt,
        duration: String(duration),
        size,
        metadata: { resolution, aspectRatio },
      });
    }

    const created = await this.requestJson("/videos", {
      method: "POST",
      headers,
      body,
    });
    const taskId = created.task_id ?? created.id;
    if (!taskId)
      throw new GenerationError(
        PROVIDER_NAME,
        "malformed_response",
        "API易 video response is missing task_id",
      );

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const task = await this.requestJson(
        `/videos/${encodeURIComponent(taskId)}`,
        { method: "GET" },
      );
      const status = task.status?.toLowerCase();
      if (status === "completed" || status === "succeeded") {
        const video = await this.downloadContent(taskId);
        const [width, height] = size.split("x").map(Number) as [number, number];
        return {
          url: `data:video/mp4;base64,${video.toString("base64")}`,
          mimeType: "video/mp4",
          width,
          height,
          durationSeconds: duration,
        };
      }
      if (status === "failed" || status === "cancelled") {
        const detail =
          typeof task.error === "string" ? task.error : task.error?.message;
        throw new GenerationError(
          PROVIDER_NAME,
          status,
          detail ?? `API易 video task ${status}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new GenerationError(
      PROVIDER_NAME,
      "timeout",
      "API易 video generation timed out after 5 minutes",
    );
  }

  private async requestJson(
    path: string,
    init: RequestInit,
  ): Promise<TaskResponse> {
    const response = await this.providerFetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response
      .json()
      .catch(() => null)) as TaskResponse | null;
    if (!response.ok) {
      const detail =
        typeof body?.error === "string"
          ? body.error
          : (body?.error?.message ?? body?.message);
      throw new GenerationError(
        PROVIDER_NAME,
        `http_${response.status}`,
        detail ?? `API易 request failed with HTTP ${response.status}`,
      );
    }
    if (!body)
      throw new GenerationError(
        PROVIDER_NAME,
        "malformed_response",
        "API易 returned invalid JSON",
      );
    return body;
  }

  private async downloadContent(taskId: string): Promise<Buffer> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await this.providerFetch(
        `${this.baseUrl}/videos/${encodeURIComponent(taskId)}/content`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(180_000),
        },
      );
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      if (attempt < 4)
        await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
    throw new GenerationError(
      PROVIDER_NAME,
      "download_failed",
      "API易 video content download failed",
    );
  }
}
