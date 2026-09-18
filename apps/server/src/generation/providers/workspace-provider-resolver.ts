import type { ServerEnv } from "../../config/env.js";
import type { ProviderSnapshotService } from "../../features/providers/index.js";
import type {
  ImageGenerateParams,
  ImageProvider,
  ModelInfo,
  VideoGenerateParams,
  VideoModelInfo,
  VideoProvider,
} from "../types.js";
import { GenerationError } from "../utils.js";
import { ApiYiVideoProvider, APIYI_VIDEO_MODELS } from "./apiyi-video.js";
import { OpenAIImageProvider } from "./openai-image.js";
import { createEnvironmentProviders } from "./register-all.js";
import type { GenerationProviderScope } from "./registry.js";

export type WorkspaceProviderResolver = ReturnType<typeof createWorkspaceProviderResolver>;

export function createWorkspaceProviderResolver(options: {
  env: ServerEnv;
  providerSnapshotService: ProviderSnapshotService;
  createImageProvider?: (apiKey: string, baseUrl: string, name: string, model: ModelInfo) => ImageProvider;
  createVideoProvider?: (apiKey: string, baseUrl: string, model: VideoModelInfo) => VideoProvider;
}) {
  const environment = createEnvironmentProviders(options.env);
  return {
    async resolveImageGenerationPlan(input: {
      workspaceId: string;
      jobId: string;
      modelId: string;
      requiredUpstreamModel?: string | readonly string[];
    }): Promise<{ source: "database_snapshot"; scope: GenerationProviderScope }> {
      if (!input.modelId.startsWith("workspace:") || !options.providerSnapshotService.resolveImageGenerationPlan) {
        throw invalidSnapshot();
      }
      let snapshots;
      try {
        snapshots = await options.providerSnapshotService.resolveImageGenerationPlan({
          workspaceId: input.workspaceId,
          jobId: input.jobId,
        });
      } catch {
        throw invalidSnapshot();
      }
      const providers = snapshots.map((snapshot) => {
        if (
          snapshot.modality !== "image" ||
          !snapshot.capabilities.includes("image_generation") ||
          `workspace:${snapshot.catalogKey}` !== input.modelId ||
          (input.requiredUpstreamModel && ![input.requiredUpstreamModel].flat().includes(snapshot.upstreamModelId)) ||
          snapshot.attemptOrdinal === undefined
        ) {
          throw invalidSnapshot();
        }
        const publicModel: ModelInfo = {
          id: input.modelId,
          displayName: snapshot.upstreamModelId,
          description: "Workspace image model",
        };
        const upstream = options.createImageProvider
          ? options.createImageProvider(
              snapshot.apiKey,
              snapshot.baseUrl,
              `workspace-image:${snapshot.snapshotId}`,
              publicModel,
            )
          : new OpenAIImageProvider(snapshot.apiKey, snapshot.baseUrl, {
              name: `workspace-image:${snapshot.snapshotId}`,
              models: [publicModel],
            });
        return {
          snapshot,
          provider: remapImageModel(upstream, input.modelId, snapshot.upstreamModelId),
        };
      });
      const primary = providers[0]?.provider;
      if (!primary) throw invalidSnapshot();
      return {
        source: "database_snapshot",
        scope: {
          imageProvider: primary,
          auxiliaryImageProviders: providers.slice(1).map((entry) => entry.provider),
          imageProviderAttempts: providers.map(({ provider, snapshot }) => ({
            ordinal: snapshot.attemptOrdinal as number,
            providerName: provider.name,
            modelId: input.modelId,
            providerModelId: snapshot.providerModelCatalogKey
              ? `workspace:${snapshot.providerModelCatalogKey}`
              : input.modelId,
            upstreamModelId: snapshot.upstreamModelId,
          })),
        },
      };
    },
    async resolve(input: {
      workspaceId: string;
      jobId: string;
      modality: "image" | "video";
      modelId: string;
      stage?: "foreground_matting";
      requiredUpstreamModel?: string | readonly string[];
    }): Promise<{ source: "database_snapshot" | "environment"; scope: GenerationProviderScope }> {
      if (!input.modelId.startsWith("workspace:")) {
        if (input.requiredUpstreamModel && ![input.requiredUpstreamModel].flat().includes(input.modelId)) throw invalidSnapshot();
        if (input.stage === "foreground_matting" && (input.modality !== "image" || input.modelId !== "gpt-image-2")) throw invalidSnapshot();
        const provider = input.modality === "image"
          ? environment.imageProviders.find((candidate) => candidate.models.some((model) => model.id === input.modelId))
          : environment.videoProviders.find((candidate) => candidate.models.some((model) => model.id === input.modelId));
        if (!provider) throw invalidSnapshot("No configured provider supports this model.");
        return {
          source: "environment",
          scope: input.modality === "image"
            ? { imageProvider: provider as ImageProvider }
            : { videoProvider: provider as VideoProvider },
        };
      }

      let snapshot;
      try {
        const resolve = input.stage === "foreground_matting"
          ? options.providerSnapshotService.resolveForegroundSnapshot
          : options.providerSnapshotService.resolveJobSnapshot;
        if (!resolve) throw invalidSnapshot();
        snapshot = await resolve({
          workspaceId: input.workspaceId,
          jobId: input.jobId,
        });
      } catch {
        throw invalidSnapshot();
      }
      const expectedCapability = input.modality === "image" ? "image_generation" : "video_generation";
      if (
        snapshot.modality !== input.modality ||
        (input.requiredUpstreamModel !== undefined && ![input.requiredUpstreamModel].flat().includes(snapshot.upstreamModelId)) ||
        !snapshot.capabilities.includes(expectedCapability) ||
        `workspace:${snapshot.catalogKey}` !== input.modelId
        || (input.stage === "foreground_matting" && snapshot.upstreamModelId !== "gpt-image-2")
      ) {
        throw invalidSnapshot();
      }

      if (input.modality === "image") {
        const publicModel: ModelInfo = {
          id: input.modelId,
          displayName: snapshot.upstreamModelId,
          description: "Workspace image model",
        };
        const upstream = options.createImageProvider
          ? options.createImageProvider(snapshot.apiKey, snapshot.baseUrl, `workspace-image:${snapshot.snapshotId}`, publicModel)
          : new OpenAIImageProvider(snapshot.apiKey, snapshot.baseUrl, {
              name: `workspace-image:${snapshot.snapshotId}`,
              models: [publicModel],
            });
        return {
          source: "database_snapshot",
          scope: { imageProvider: remapImageModel(upstream, input.modelId, snapshot.upstreamModelId) },
        };
      }

      const known = APIYI_VIDEO_MODELS.find((model) => model.id === snapshot.upstreamModelId);
      if (!known) throw invalidSnapshot("The workspace video model is not supported.");
      const publicModel: VideoModelInfo = { ...known, id: input.modelId };
      const upstream = options.createVideoProvider
        ? options.createVideoProvider(snapshot.apiKey, snapshot.baseUrl, publicModel)
        : new ApiYiVideoProvider(snapshot.apiKey, snapshot.baseUrl, [{ ...known, id: snapshot.upstreamModelId }]);
      return {
        source: "database_snapshot",
        scope: { videoProvider: remapVideoModel(upstream, publicModel, snapshot.upstreamModelId) },
      };
    },
  };
}

function remapImageModel(provider: ImageProvider, publicModelId: string, upstreamModelId: string): ImageProvider {
  return {
    name: provider.name,
    models: provider.models.map((model) => ({ ...model, id: publicModelId })),
    ...(provider.supportsImageMask !== undefined
      ? { supportsImageMask: provider.supportsImageMask }
      : {}),
    generate(params: ImageGenerateParams) {
      return provider.generate({ ...params, model: upstreamModelId });
    },
  };
}

function remapVideoModel(provider: VideoProvider, publicModel: VideoModelInfo, upstreamModelId: string): VideoProvider {
  return {
    name: provider.name,
    models: [publicModel],
    generate(params: VideoGenerateParams) {
      return provider.generate({ ...params, model: upstreamModelId });
    },
  };
}

function invalidSnapshot(message = "The workspace provider snapshot is invalid or unavailable.") {
  return new GenerationError("workspace", "provider_snapshot_invalid", message);
}
