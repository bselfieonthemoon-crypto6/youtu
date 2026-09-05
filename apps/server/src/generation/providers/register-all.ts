/**
 * Centralized provider registration.
 *
 * Both the HTTP server (app.ts) and the background worker (worker.ts) need the
 * same APIYI-backed image/video providers. This module is the single source
 * of truth and intentionally ignores legacy provider credentials.
 */
import type { ServerEnv } from "../../config/env.js";
import { ApiYiVideoProvider } from "./apiyi-video.js";
import { APIYI_IMAGE_MODELS, OpenAIImageProvider } from "./openai-image.js";
import { registerImageProvider, registerVideoProvider } from "./registry.js";
import type { ImageProvider, VideoProvider } from "../types.js";

export type EnvironmentProviders = {
  imageProviders: ImageProvider[];
  videoProviders: VideoProvider[];
};

/** Build immutable env-backed provider instances without mutating the registry. */
export function createEnvironmentProviders(env: ServerEnv): EnvironmentProviders {
  const imageProviders: ImageProvider[] = [];
  const videoProviders: VideoProvider[] = [];

  if (env.apiYiApiKey && env.apiYiApiBase) {
    imageProviders.push(
      new OpenAIImageProvider(env.apiYiApiKey, env.apiYiApiBase, {
        name: "apiyi",
        models: APIYI_IMAGE_MODELS,
      }),
    );
    videoProviders.push(new ApiYiVideoProvider(env.apiYiApiKey, env.apiYiApiBase));
  }
  return { imageProviders, videoProviders };
}

/**
 * Register the single APIYI generation gateway when configured.
 */
export function registerAllProviders(env: ServerEnv): void {
  const providers = createEnvironmentProviders(env);
  for (const provider of providers.imageProviders) registerImageProvider(provider);
  for (const provider of providers.videoProviders) registerVideoProvider(provider);
}
