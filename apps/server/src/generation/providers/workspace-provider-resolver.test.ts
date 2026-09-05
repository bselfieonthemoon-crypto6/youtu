import { describe, expect, it, vi } from "vitest";

import type { ImageProvider } from "../types.js";
import { createWorkspaceProviderResolver } from "./workspace-provider-resolver.js";

const publicModel = "workspace:11111111-1111-4111-8111-111111111111";

function fakeProvider(): ImageProvider {
  return {
    name: "workspace-image:test",
    models: [{ id: publicModel, displayName: "Workspace image", description: "test" }],
    generate: vi.fn(async (params) => ({
      url: params.model,
      mimeType: "image/png",
      width: 1,
      height: 1,
    })),
  };
}

function snapshot() {
  return {
    snapshotId: "snapshot-1",
    providerConfigId: "config-1",
    providerRevision: 7,
    catalogKey: "11111111-1111-4111-8111-111111111111",
    adapter: "openai_compatible" as const,
    baseUrl: "https://api.example.test/v1",
    upstreamModelId: "gpt-image-2-all",
    modality: "image" as const,
    capabilities: ["image_generation" as const],
    billing: { creditsCost: null, pricingVersion: null, unit: null },
    apiKey: "workspace-secret",
  };
}

const minimalEnv = {
  agentBackendMode: "state",
  agentModel: "gpt-4.1",
  port: 1,
  version: "test",
  webOrigin: "x",
} as const;

describe("workspace provider resolver", () => {
  it("uses the immutable job snapshot and remaps the public model id", async () => {
    const provider = fakeProvider();
    const createImageProvider = vi.fn(() => provider);
    const resolver = createWorkspaceProviderResolver({
      env: minimalEnv,
      providerSnapshotService: {
        resolveJobSnapshot: vi.fn(async () => snapshot()),
      } as never,
      createImageProvider,
    });

    const result = await resolver.resolve({
      workspaceId: "workspace-1",
      jobId: "job-1",
      modality: "image",
      modelId: publicModel,
    });
    expect(result.source).toBe("database_snapshot");
    await result.scope.imageProvider?.generate({ prompt: "test", model: publicModel });
    expect(provider.generate).toHaveBeenCalledWith({ prompt: "test", model: "gpt-image-2-all" });
    expect(createImageProvider).toHaveBeenCalledWith(
      "workspace-secret",
      "https://api.example.test/v1",
      "workspace-image:snapshot-1",
      expect.any(Object),
    );
  });

  it("fails closed when a workspace snapshot cannot be resolved", async () => {
    const resolver = createWorkspaceProviderResolver({
      env: minimalEnv,
      providerSnapshotService: {
        resolveJobSnapshot: vi.fn(async () => { throw new Error("missing"); }),
      } as never,
    });
    await expect(resolver.resolve({
      workspaceId: "workspace-1",
      jobId: "job-1",
      modality: "image",
      modelId: publicModel,
    })).rejects.toMatchObject({ code: "provider_snapshot_invalid" });
  });

  it("rejects a snapshot belonging to another public catalog model", async () => {
    const resolver = createWorkspaceProviderResolver({
      env: minimalEnv,
      providerSnapshotService: {
        resolveJobSnapshot: vi.fn(async () => ({
          ...snapshot(),
          catalogKey: "22222222-2222-4222-8222-222222222222",
        })),
      } as never,
    });
    await expect(resolver.resolve({
      workspaceId: "workspace-1",
      jobId: "job-1",
      modality: "image",
      modelId: publicModel,
    })).rejects.toMatchObject({ code: "provider_snapshot_invalid" });
  });
});
