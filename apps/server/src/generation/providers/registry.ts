import { AsyncLocalStorage } from "node:async_hooks";

import type {
  ImageProvider,
  ModelInfo,
  VideoModelInfo,
  VideoProvider,
} from "../types.js";
import { GenerationError } from "../utils.js";

const imageProviders = new Map<string, ImageProvider>();
const videoProviders = new Map<string, VideoProvider>();
const scopedProviders = new AsyncLocalStorage<GenerationProviderScope>();

export type GenerationProviderScope = {
  imageProvider?: ImageProvider;
  auxiliaryImageProviders?: ImageProvider[];
  imageProviderAttempts?: readonly {
    ordinal: number;
    providerName: string;
    modelId: string;
    providerModelId?: string;
    upstreamModelId: string;
  }[];
  videoProvider?: VideoProvider;
};

export function getImageProviderAttempts() {
  return scopedProviders.getStore()?.imageProviderAttempts;
}

export function runWithGenerationProviderScope<T>(
  scope: GenerationProviderScope,
  fn: () => T,
): T {
  return scopedProviders.run(scope, fn);
}

export function registerImageProvider(provider: ImageProvider): void {
  imageProviders.set(provider.name, provider);
}

export function registerVideoProvider(provider: VideoProvider): void {
  videoProviders.set(provider.name, provider);
}

export function getImageProvider(name: string): ImageProvider {
  const scoped = scopedProviders.getStore()?.imageProvider;
  if (scoped?.name === name) return scoped;
  const auxiliary = scopedProviders.getStore()?.auxiliaryImageProviders?.find(provider => provider.name === name);
  if (auxiliary) return auxiliary;
  const provider = imageProviders.get(name);
  if (!provider) {
    throw new GenerationError(
      name,
      "provider_not_found",
      `No image provider registered: ${name}`,
    );
  }
  return provider;
}

export function getVideoProvider(name: string): VideoProvider {
  const scoped = scopedProviders.getStore()?.videoProvider;
  if (scoped?.name === name) return scoped;
  const provider = videoProviders.get(name);
  if (!provider) {
    throw new GenerationError(
      name,
      "provider_not_found",
      `No video provider registered: ${name}`,
    );
  }
  return provider;
}

/** Model info enriched with its owning provider name. */
export interface AvailableModel extends ModelInfo {
  provider: string;
  /** Published provider model behind a workspace-scoped public alias. */
  upstreamModelId?: string;
}

export interface AvailableVideoModel extends VideoModelInfo {
  provider: string;
}

/** Returns all image models from all registered providers. */
export function getAvailableImageModels(): AvailableModel[] {
  return [...imageProviders.values()].flatMap((p) =>
    p.models.map((m) => ({ ...m, provider: p.name })),
  );
}

/** Returns all video models from all registered providers. */
export function getAvailableVideoModels(): AvailableVideoModel[] {
  return [...videoProviders.values()].flatMap((p) =>
    p.models.map((m) => ({ ...m, provider: p.name })),
  );
}

/** Resolves the provider name that handles a given image model ID. */
export function resolveImageProviderName(modelId: string): string {
  const scoped = scopedProviders.getStore()?.imageProvider;
  if (scoped?.models.some((model) => model.id === modelId)) return scoped.name;
  const auxiliary = scopedProviders.getStore()?.auxiliaryImageProviders?.find(provider => provider.models.some(model => model.id === modelId));
  if (auxiliary) return auxiliary.name;
  for (const provider of imageProviders.values()) {
    if (provider.models.some((m) => m.id === modelId)) {
      return provider.name;
    }
  }
  throw new GenerationError(
    "unknown",
    "model_not_found",
    `No provider registered for image model: ${modelId}`,
  );
}

/** Resolves the provider name that handles a given video model ID. */
export function resolveVideoProviderName(modelId: string): string {
  const scoped = scopedProviders.getStore()?.videoProvider;
  if (scoped?.models.some((model) => model.id === modelId)) return scoped.name;
  for (const provider of videoProviders.values()) {
    if (provider.models.some((m) => m.id === modelId)) {
      return provider.name;
    }
  }
  throw new GenerationError(
    "unknown",
    "model_not_found",
    `No provider registered for video model: ${modelId}`,
  );
}

export function clearProviders(): void {
  imageProviders.clear();
  videoProviders.clear();
}
