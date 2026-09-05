import { describe, expect, it } from "vitest";

import {
  bindCanvasAssetReference,
  insertImageGenerationPlaceholder,
  insertImageElement,
  markImageGenerationPlaceholderFailed,
  insertVideoElement,
} from "./canvas-element-writer.js";

function createConflictingClient() {
  let row = {
    content: {
      elements: [{ id: "existing", type: "rectangle", version: 1 }],
      appState: {},
      files: {},
    },
    updated_at: "v1",
  };
  let writeAttempts = 0;

  const client = {
    storage: {
      from: () => ({
        download: async () => ({
          data: new Blob([Buffer.from("image")], { type: "image/png" }),
          error: null,
        }),
      }),
    },
    from: () => ({
      select: () => ({
        eq() { return this; },
        single: async () => ({ data: structuredClone(row), error: null }),
      }),
      update: (payload: { content: typeof row.content }) => {
        let expectedVersion: string | undefined;
        const builder = {
          eq(column: string, value: string) {
            if (column === "updated_at") expectedVersion = value;
            return this;
          },
          select() { return this; },
          async maybeSingle() {
            writeAttempts += 1;
            if (writeAttempts === 1) {
              row = {
                content: {
                  ...row.content,
                  elements: [
                    ...row.content.elements,
                    { id: "concurrent", type: "image", version: 1 },
                  ],
                },
                updated_at: "v2",
              };
            }
            if (expectedVersion !== row.updated_at) {
              return { data: null, error: null };
            }
            row = {
              content: structuredClone(payload.content),
              updated_at: `v${writeAttempts + 1}`,
            };
            return { data: { id: "canvas" }, error: null };
          },
        };
        return builder;
      },
    }),
  };

  return { client, getRow: () => row, getWriteAttempts: () => writeAttempts };
}

describe("canvas element writer concurrency", () => {
  it("falls back to a direct asset reference write for service-role workers", async () => {
    const upserts: unknown[] = [];
    const client = {
      rpc: async () => ({ data: false, error: null }),
      storage: { from: () => ({}) },
      from: (table: string) => {
        if (table === "canvases") {
          return {
            select: () => ({
              eq() { return this; },
              single: async () => ({ data: { project_id: "project-1" }, error: null }),
            }),
          };
        }
        if (table === "projects") {
          return {
            select: () => ({
              eq() { return this; },
              single: async () => ({ data: { workspace_id: "workspace-1" }, error: null }),
            }),
          };
        }
        return {
          upsert: async (payload: unknown) => {
            upserts.push(payload);
            return { error: null };
          },
        };
      },
    };

    await bindCanvasAssetReference(client, "canvas-1", "asset-1", "element-1");

    expect(upserts).toEqual([{
      asset_id: "asset-1",
      canvas_id: "canvas-1",
      workspace_id: "workspace-1",
      element_id: "element-1",
    }]);
  });

  it("retries an image insert and retains a concurrent element", async () => {
    const mock = createConflictingClient();

    const result = await insertImageElement(mock.client, {
      canvasId: "canvas",
      sourceJobId: "job-1",
      assetId: "00000000-0000-4000-8000-000000000001",
      objectPath: "generated/image.png",
      width: 512,
      height: 512,
      mimeType: "image/png",
      title: "generated image",
      prompt: "minimal geometric logo",
      model: "google/nano-banana-2",
      quality: "ultra",
    });

    expect(mock.getWriteAttempts()).toBe(2);
    expect(mock.getRow().content.elements.map((element) => element.id)).toEqual(
      expect.arrayContaining(["existing", "concurrent", result.elementId]),
    );
    expect(Object.keys(mock.getRow().content.files)).toHaveLength(1);
    const inserted = mock.getRow().content.elements.find((element) => element.id === result.elementId) as any;
    expect(inserted.customData).toMatchObject({
      assetId: "00000000-0000-4000-8000-000000000001",
      mimeType: "image/png",
      originalWidth: 512,
      originalHeight: 512,
      prompt: "minimal geometric logo",
      model: "google/nano-banana-2",
      quality: "ultra",
    });
  });

  it("returns the existing image for the same source job", async () => {
    const mock = createConflictingClient();
    const opts = {
      canvasId: "canvas",
      sourceJobId: "job-image",
      assetId: "00000000-0000-4000-8000-000000000001",
      objectPath: "generated/image.png",
      width: 512,
      height: 512,
      mimeType: "image/png",
    };

    const first = await insertImageElement(mock.client, opts);
    const second = await insertImageElement(mock.client, opts);

    expect(first.inserted).toBe(true);
    expect(second).toEqual({ elementId: first.elementId, inserted: false });
    const generated = mock.getRow().content.elements.filter(
      (element) =>
        (element as any).customData?.sourceJobId === opts.sourceJobId &&
        !(element as any).isDeleted,
    );
    expect(generated).toHaveLength(1);
    expect((generated[0] as any).customData).toMatchObject({
      source: "generated",
      sourceJobId: "job-image",
    });
  });

  it("replaces a durable generation placeholder atomically", async () => {
    const mock = createConflictingClient();
    const result = await insertImageElement(mock.client, {
      canvasId: "canvas",
      sourceJobId: "job-replacement",
      assetId: "00000000-0000-4000-8000-000000000003",
      objectPath: "generated/replacement.png",
      width: 1024,
      height: 1024,
      mimeType: "image/png",
      replaceElementId: "existing",
    }, { x: 600, y: 20, width: 512, height: 512 });

    const elements = mock.getRow().content.elements as any[];
    expect(elements.find((element) => element.id === "existing")?.isDeleted).toBe(true);
    expect(elements.find((element) => element.id === result.elementId)).toMatchObject({
      x: 600,
      y: 20,
      width: 512,
      height: 512,
      isDeleted: false,
    });
  });

  it("persists image generation progress and lets the final image replace it", async () => {
    const mock = createConflictingClient();
    const placeholder = await insertImageGenerationPlaceholder(mock.client, {
      canvasId: "canvas",
      elementId: "generation-placeholder",
      sourceJobId: "job-generating",
      prompt: "minimal wordmark",
      title: "AAAA wordmark",
      model: "gpt-image-2-all",
      aspectRatio: "16:9",
      quality: "hd",
    });

    expect(
      (mock.getRow().content.elements as any[]).find(
        (element) => element.id === placeholder.elementId,
      ),
    ).toMatchObject({
      isDeleted: false,
      customData: {
        type: "image-generator",
        status: "generating",
        jobId: "job-generating",
      },
    });

    const result = await insertImageElement(
      mock.client,
      {
        canvasId: "canvas",
        sourceJobId: "job-generating",
        assetId: "00000000-0000-4000-8000-000000000004",
        objectPath: "generated/final.png",
        width: 1024,
        height: 576,
        mimeType: "image/png",
        replaceElementId: placeholder.elementId,
      },
      placeholder.placement,
    );

    const elements = mock.getRow().content.elements as any[];
    expect(
      elements.find((element) => element.id === placeholder.elementId)
        ?.isDeleted,
    ).toBe(true);
    expect(elements.find((element) => element.id === result.elementId)).toMatchObject({
      ...placeholder.placement,
      type: "image",
      isDeleted: false,
    });
  });

  it("turns a failed generation placeholder into a durable error state", async () => {
    const mock = createConflictingClient();
    await insertImageGenerationPlaceholder(mock.client, {
      canvasId: "canvas",
      elementId: "failed-placeholder",
      sourceJobId: "job-failed",
      prompt: "minimal wordmark",
      title: "AAAA wordmark",
      model: "gpt-image-2-all",
      aspectRatio: "1:1",
      quality: "hd",
    });

    await markImageGenerationPlaceholderFailed(
      mock.client,
      "canvas",
      "failed-placeholder",
      "provider failed",
    );

    expect(
      (mock.getRow().content.elements as any[]).find(
        (element) => element.id === "failed-placeholder",
      )?.customData,
    ).toMatchObject({ status: "error", errorMessage: "provider failed" });
  });

  it("returns the existing video for the same source job", async () => {
    const mock = createConflictingClient();
    const opts = {
      canvasId: "canvas",
      sourceJobId: "job-video",
      assetId: "00000000-0000-4000-8000-000000000002",
      signedUrl: "https://example.com/video.mp4",
      width: 1280,
      height: 720,
      mimeType: "video/mp4",
    };

    const first = await insertVideoElement(mock.client, opts);
    const second = await insertVideoElement(mock.client, opts);

    expect(first.inserted).toBe(true);
    expect(second).toEqual({ elementId: first.elementId, inserted: false });
    const generated = mock.getRow().content.elements.filter(
      (element) => (element as any).customData?.sourceJobId === opts.sourceJobId,
    );
    expect(generated).toHaveLength(1);
    expect((generated[0] as any).customData).toMatchObject({
      source: "generated",
      sourceJobId: "job-video",
    });
  });
});
