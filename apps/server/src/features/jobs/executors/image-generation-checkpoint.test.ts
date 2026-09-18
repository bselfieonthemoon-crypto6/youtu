import { describe, expect, it, vi } from "vitest";

import {
  createImageGenerationCheckpoint,
  generationSourceAssetBinding,
} from "./image-generation-checkpoint.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const requestFingerprint = "a".repeat(64);

describe("image generation storage checkpoint", () => {
  it("isolates generation-source and background-removal bindings", () => {
    const generated = generationSourceAssetBinding(
      workspaceId,
      jobId,
      "image-generation-source",
    );
    const removed = generationSourceAssetBinding(
      workspaceId,
      jobId,
      "background-removal-foreground",
    );
    expect(generated.objectPath).toBe(
      `${workspaceId}/generated/${jobId}-source-before-matting.png`,
    );
    expect(removed.objectPath).toBe(
      `${workspaceId}/generated/${jobId}-0-foreground.png`,
    );
    expect(removed.assetId).not.toBe(generated.assetId);
  });

  it("uses an exclusive object create as the provider-call claim", async () => {
    const memory = memoryBucket();
    const first = createImageGenerationCheckpoint(memory.admin as never, {
      workspaceId,
      jobId,
      requestFingerprint,
      variant: "image-generation-source",
    });
    const second = createImageGenerationCheckpoint(memory.admin as never, {
      workspaceId,
      jobId,
      requestFingerprint,
      variant: "image-generation-source",
    });

    await expect(first.claim()).resolves.toEqual({ claimed: true });
    await expect(second.claim()).resolves.toMatchObject({
      claimed: false,
      state: { status: "calling", workspaceId, jobId },
    });
    expect(memory.upload.mock.calls[0]?.[2]).toMatchObject({ upsert: false });
  });

  it("recovers a returned provider reference after the exclusive claim", async () => {
    const memory = memoryBucket();
    const checkpoint = createImageGenerationCheckpoint(memory.admin as never, {
      workspaceId,
      jobId,
      requestFingerprint,
      variant: "image-generation-source",
    });
    await checkpoint.claim();
    await checkpoint.saveReturned({
      url: "https://cdn.provider.test/private/result.png?signature=opaque",
      mimeType: "image/png",
    });
    const replay = await checkpoint.claim();
    expect(replay).toMatchObject({
      claimed: false,
      state: {
        status: "returned",
        result: { mimeType: "image/png" },
      },
    });
  });

  it("recovers a persisted provider rejection without claiming another call", async () => {
    const memory = memoryBucket();
    const first = createImageGenerationCheckpoint(memory.admin as never, {
      workspaceId,
      jobId,
      requestFingerprint,
      variant: "image-generation-source",
      attemptOrdinal: 1,
    });
    await first.claim();
    await first.saveRejected("provider_rejected", "No available channel");

    const replay = createImageGenerationCheckpoint(memory.admin as never, {
      workspaceId,
      jobId,
      requestFingerprint,
      variant: "image-generation-source",
      attemptOrdinal: 1,
    });
    await expect(replay.claim()).resolves.toMatchObject({
      claimed: false,
      state: {
        status: "rejected",
        attemptOrdinal: 1,
        errorCode: "provider_rejected",
        errorMessage: "No available channel",
      },
    });
  });

  it("does not share checkpoint paths between fallback attempt ordinals", async () => {
    const memory = memoryBucket();
    const first = createImageGenerationCheckpoint(memory.admin as never, {
      workspaceId,
      jobId,
      requestFingerprint,
      variant: "image-generation-source",
      attemptOrdinal: 1,
    });
    const second = createImageGenerationCheckpoint(memory.admin as never, {
      workspaceId,
      jobId,
      requestFingerprint,
      variant: "image-generation-source",
      attemptOrdinal: 2,
    });

    await expect(first.claim()).resolves.toEqual({ claimed: true });
    await expect(second.claim()).resolves.toEqual({ claimed: true });
    expect([...memory.objects.keys()]).toEqual([
      `${workspaceId}/generated/${jobId}-image-generation-attempt-1-checkpoint.json`,
      `${workspaceId}/generated/${jobId}-image-generation-attempt-2-checkpoint.json`,
    ]);
  });

  it("fails closed when a provider rejection cannot be persisted", async () => {
    const memory = memoryBucket();
    const checkpoint = createImageGenerationCheckpoint(memory.admin as never, {
      workspaceId,
      jobId,
      requestFingerprint,
      variant: "image-generation-source",
      attemptOrdinal: 1,
    });
    await checkpoint.claim();
    memory.upload.mockResolvedValueOnce({
      error: { statusCode: "503", message: "storage unavailable" },
    });

    await expect(
      checkpoint.saveRejected("provider_rejected", "No available channel"),
    ).rejects.toMatchObject({
      code: "image_generation_checkpoint_unavailable",
    });
  });

  it("does not interpret an uncertain claim write as a missing checkpoint", async () => {
    const memory = memoryBucket();
    memory.upload.mockResolvedValueOnce({
      error: { statusCode: "503", message: "response lost" },
    });
    const checkpoint = createImageGenerationCheckpoint(memory.admin as never, {
      workspaceId,
      jobId,
      requestFingerprint,
      variant: "image-generation-source",
    });
    await expect(checkpoint.claim()).rejects.toMatchObject({
      code: "image_generation_checkpoint_unavailable",
    });
    expect(memory.download).not.toHaveBeenCalled();
  });

  it("fails closed when an existing checkpoint cannot be read", async () => {
    const memory = memoryBucket();
    const checkpoint = createImageGenerationCheckpoint(memory.admin as never, {
      workspaceId,
      jobId,
      requestFingerprint,
      variant: "image-generation-source",
    });
    await checkpoint.claim();
    memory.download.mockResolvedValueOnce({
      data: null,
      error: { statusCode: "403", message: "denied" },
    });
    await expect(checkpoint.claim()).rejects.toMatchObject({
      code: "image_generation_checkpoint_unavailable",
    });
  });

  it("rejects corrupt scope, request identity, and arbitrary path input", async () => {
    const memory = memoryBucket();
    const checkpoint = createImageGenerationCheckpoint(memory.admin as never, {
      workspaceId,
      jobId,
      requestFingerprint,
      variant: "image-generation-source",
    });
    memory.objects.set(
      `${workspaceId}/generated/${jobId}-image-generation-checkpoint.json`,
      Buffer.from(
        JSON.stringify({
          version: 1,
          status: "archived",
          workspaceId: "33333333-3333-4333-8333-333333333333",
          jobId,
          requestFingerprint,
          variant: "image-generation-source",
          assetId: generationSourceAssetBinding(
            workspaceId,
            jobId,
            "image-generation-source",
          ).assetId,
          objectPath: "other/path.png",
          mimeType: "image/png",
        }),
      ),
    );
    await expect(checkpoint.claim()).rejects.toMatchObject({
      code: "image_generation_checkpoint_invalid",
    });
    expect(() =>
      createImageGenerationCheckpoint(memory.admin as never, {
        workspaceId,
        jobId: "../../outside",
        requestFingerprint,
        variant: "image-generation-source",
      }),
    ).toThrow("标识无效");
  });
});

function memoryBucket() {
  const objects = new Map<string, Buffer>();
  const upload = vi.fn(
    async (path: string, bytes: Buffer, options: { upsert: boolean }) => {
      if (!options.upsert && objects.has(path)) {
        return { error: { statusCode: "409", message: "resource already exists" } };
      }
      objects.set(path, Buffer.from(bytes));
      return { error: null };
    },
  );
  const download = vi.fn(async (path: string) => {
    const bytes = objects.get(path);
    return bytes
      ? { data: new Blob([bytes]), error: null }
      : { data: null, error: { statusCode: "404", message: "not found" } };
  });
  return {
    objects,
    upload,
    download,
    admin: { storage: { from: vi.fn(() => ({ upload, download })) } },
  };
}
