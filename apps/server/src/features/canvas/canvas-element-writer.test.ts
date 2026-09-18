import { describe, expect, it } from "vitest";

import {
  bindCanvasAssetReference,
  insertImageGenerationPlaceholder,
  insertImageElement,
  markImageGenerationPlaceholderFailed,
  removeCompletedImagePlaceholder,
  insertVideoElement,
} from "./canvas-element-writer.js";

function createConflictingClient(options: { empty?: boolean; conflict?: boolean } = {}) {
  let row = {
    content: {
      elements: options.empty ? [] : [{ id: "existing", type: "rectangle", version: 1 }],
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
            if (writeAttempts === 1 && options.conflict !== false) {
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

describe("completed split placeholder cleanup", () => {
  it("tombstones only the matching job placeholder, preserves concurrent additions and is idempotent", async () => {
    const mock = createConflictingClient();
    mock.getRow().content.elements.push({ id: "pending", type: "rectangle", version: 1,
      customData: { type: "image-replacement", jobId: "split-job", status: "generating" } } as any);
    expect(await removeCompletedImagePlaceholder(mock.client, "canvas", "pending", "split-job")).toBe(true);
    expect(mock.getRow().content.elements.find(e => e.id === "pending")).toMatchObject({ isDeleted: true, version: 2 });
    expect(mock.getRow().content.elements.some(e => e.id === "concurrent")).toBe(true);
    expect(await removeCompletedImagePlaceholder(mock.client, "canvas", "pending", "split-job")).toBe(false);
  });
  it("does not delete source images or placeholders belonging to other jobs", async () => {
    const mock = createConflictingClient({ conflict: false });
    mock.getRow().content.elements.push({ id: "source", type: "image", version: 1 } as any,
      { id: "pending", type: "rectangle", version: 1, customData: { type: "image-replacement", jobId: "other" } } as any);
    expect(await removeCompletedImagePlaceholder(mock.client, "canvas", "source", "split-job")).toBe(false);
    expect(await removeCompletedImagePlaceholder(mock.client, "canvas", "pending", "split-job")).toBe(false);
    expect(mock.getWriteAttempts()).toBe(0);
  });
});

describe("canvas element writer concurrency", () => {
  it.each([[1672, 941], [941, 1672]])("fits delivered %sx%s pixels into a moved square placeholder without stretching", async (width, height) => {
    const mock = createConflictingClient({ conflict: false });
    (mock.getRow().content.elements as any[]).push({ id: "pending", type: "rectangle", x: 600, y: 120,
      width: 512, height: 512, version: 3, customData: { type: "image-replacement", jobId: "ratio-job" } });
    const options = { canvasId: "canvas", sourceJobId: "ratio-job", assetId: "00000000-0000-4000-8000-000000000003",
      objectPath: "generated/ratio.png", width, height, mimeType: "image/png", replaceElementId: "pending" };
    await insertImageElement(mock.client, options);
    const image = (mock.getRow().content.elements as any[]).find(item => item.id === "pending");
    expect(image).toMatchObject({ type: "image", x: 600, y: 120 });
    expect(image.width / image.height).toBeCloseTo(width / height, 8);
    expect(Math.max(image.width, image.height)).toBe(512);
    await insertImageElement(mock.client, options);
    expect((mock.getRow().content.elements as any[]).filter(item => item.id === "pending")).toHaveLength(1);
  });
  it("places the first generated image inside the default viewport without changing explicit positions", async () => {
    const options = { canvasId: "canvas", elementId: "first", sourceJobId: "job", prompt: "coffee", title: "Coffee",
      model: "image", aspectRatio: "4:5", quality: "hd" };
    const auto = createConflictingClient({ empty: true, conflict: false });
    const placement = await insertImageGenerationPlaceholder(auto.client, options);
    expect(placement.placement).toMatchObject({ x: 80, y: 80, width: 410, height: 512 });
    const explicit = createConflictingClient({ empty: true, conflict: false });
    await expect(insertImageGenerationPlaceholder(explicit.client, options, { x: -205, y: -256, width: 410, height: 512 }))
      .resolves.toMatchObject({ placement: { x: -205, y: -256, width: 410, height: 512 } });
  });
  it.each(["image-replacement", "image-generator"])("finishes two moved %s nodes in place without duplicates on retry", async (pendingType) => {
    const mock = createConflictingClient();
    const elements = mock.getRow().content.elements as any[];
    for (const [index, y] of [200, -300].entries()) elements.push({ id: `p${index}`, type: "rectangle", x: 600, y, width: 390, height: 390, version: 25, isDeleted: false, customData: { type: pendingType, jobId: `job${index}` } });
    for (const index of [1, 0, 1]) {
      const result = await insertImageElement(mock.client, { canvasId: "canvas", sourceJobId: `job${index}`, assetId: "00000000-0000-4000-8000-000000000003", objectPath: `generated/${index}.png`, width: 1024, height: 1024, mimeType: "image/png", replaceElementId: `p${index}` }, { x: 0, y: 0, width: 512, height: 512 });
      expect(result.elementId).toBe(`p${index}`);
    }
    const saved = mock.getRow().content.elements as any[];
    expect(saved.find(e => e.id === "p1")).toMatchObject({ type: "image", x: 600, y: -300, width: 390, isDeleted: false });
    expect(saved.find(e => e.id === "p0")).toMatchObject({ type: "image", y: 200, isDeleted: false });
    expect(saved.filter(e => e.customData?.sourceJobId === "job1")).toHaveLength(1);
    if (pendingType === "image-generator") {
      expect(saved.find(e => e.id === "p1").customData.sourceNodeType).toBe("image-generator");
    }
  });
  it("finishes a deleted generator as a tombstone and never resurrects it on replay", async () => {
    const mock = createConflictingClient();
    (mock.getRow().content.elements as any[]).push({ id: "deleted-node", type: "rectangle", x: 5, y: 9, width: 390, height: 390, version: 25, isDeleted: true,
      customData: { type: "image-generator", jobId: "job-deleted", nodeImageRequest: { requestId: "request-deleted" } } });
    const options = { canvasId: "canvas", sourceJobId: "job-deleted", assetId: "00000000-0000-4000-8000-000000000003", objectPath: "generated/deleted.png", width: 1024, height: 1024, mimeType: "image/png", replaceElementId: "deleted-node" };
    await insertImageElement(mock.client, options);
    expect(await insertImageElement(mock.client, options)).toMatchObject({ elementId: "deleted-node", inserted: false });
    expect(mock.getRow().content.elements.filter(e => e.id === "deleted-node")).toEqual([
      expect.objectContaining({ type: "image", isDeleted: true, x: 5, y: 9,
        customData: expect.objectContaining({ sourceNodeType: "image-generator", sourceRequestId: "request-deleted" }) }),
    ]);
  });
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
      rejectDeletedSourceJob: true,
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
      rejectDeletedSourceJob: true,
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
    expect(result.elementId).toBe(placeholder.elementId);
    expect(
      elements.find((element) => element.id === placeholder.elementId)
        ?.isDeleted,
    ).toBe(false);
    expect(elements.find((element) => element.id === result.elementId)).toMatchObject({
      ...placeholder.placement,
      type: "image",
      isDeleted: false,
    });
  });

  it("keeps a moved live placeholder and refuses to resurrect its tombstone", async () => {
    const mock = createConflictingClient();
    const options = {
      canvasId: "canvas", elementId: "durable-placeholder", sourceJobId: "job-durable",
      prompt: "minimal wordmark", title: "AAAA wordmark", model: "gpt-image-2", aspectRatio: "1:1", quality: "hd",
    };
    await insertImageGenerationPlaceholder(mock.client, options, { x: 10, y: 20, width: 300, height: 300 });
    const saved = (mock.getRow().content.elements as any[]).find(element => element.id === options.elementId);
    Object.assign(saved, { x: 700, y: -40, version: 8 });

    await expect(insertImageGenerationPlaceholder(mock.client, options, { x: 0, y: 0, width: 512, height: 512 }))
      .resolves.toMatchObject({ elementId: options.elementId, placement: { x: 700, y: -40, width: 300, height: 300 } });
    expect((mock.getRow().content.elements as any[]).filter(element => element.id === options.elementId)).toHaveLength(1);

    const current = (mock.getRow().content.elements as any[]).find(element => element.id === options.elementId);
    current.isDeleted = true;
    await expect(insertImageGenerationPlaceholder(mock.client, options))
      .rejects.toMatchObject({ code: "image_generation_placeholder_deleted" });
    expect((mock.getRow().content.elements as any[]).filter(element => element.id === options.elementId)).toEqual([
      expect.objectContaining({ isDeleted: true, x: 700, y: -40, version: 8 }),
    ]);
  });

  it("turns a failed generation placeholder into a durable error state", async () => {
    const mock = createConflictingClient();
    const reference = { id: "reference-image", type: "image", isDeleted: false, version: 7,
      customData: { sourceAssetId: "source-asset" } };
    (mock.getRow().content.elements as any[]).push(reference);
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
      "job-failed",
      "provider failed",
    );

    expect(
      (mock.getRow().content.elements as any[]).find(
        (element) => element.id === "failed-placeholder",
      )?.customData,
    ).toMatchObject({ status: "error", errorMessage: "provider failed" });
    expect((mock.getRow().content.elements as any[]).find(element => element.id === "reference-image"))
      .toEqual(reference);
  });

  it("does not overwrite a successful replacement, deleted placeholder, or another job's element", async () => {
    const cases = [
      { type: "image", isDeleted: false, customData: { sourceJobId: "job-failed", status: "completed" } },
      { type: "rectangle", isDeleted: true, customData: { type: "image-generator", sourceJobId: "job-failed", status: "generating" } },
      { type: "rectangle", isDeleted: false, customData: { type: "image-generator", sourceJobId: "newer-job", status: "generating" } },
    ];
    for (const replacement of cases) {
      const mock = createConflictingClient();
      await insertImageGenerationPlaceholder(mock.client, {
        canvasId: "canvas", elementId: "guarded-placeholder", sourceJobId: "job-failed",
        prompt: "minimal wordmark", title: "AAAA wordmark", model: "gpt-image-2-all", aspectRatio: "1:1", quality: "hd",
      });
      const element = (mock.getRow().content.elements as any[]).find(item => item.id === "guarded-placeholder");
      Object.assign(element, replacement);
      const before = structuredClone(mock.getRow());
      await markImageGenerationPlaceholderFailed(mock.client, "canvas", "guarded-placeholder", "job-failed", "provider failed");
      expect(mock.getRow()).toEqual(before);
    }
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
      rejectDeletedSourceJob: true,
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

  it("rejects restore-only image insertion when the same job has an image tombstone", async () => {
    const mock = createConflictingClient({ conflict: false });
    (mock.getRow().content.elements as any[]).push({
      id: "deleted-image",
      type: "image",
      isDeleted: true,
      customData: { source: "generated", sourceJobId: "job-deleted-image" },
    });

    await expect(insertImageElement(mock.client, {
      canvasId: "canvas",
      sourceJobId: "job-deleted-image",
      assetId: "00000000-0000-4000-8000-000000000003",
      objectPath: "generated/deleted.png",
      width: 1024,
      height: 1024,
      mimeType: "image/png",
      rejectDeletedSourceJob: true,
    })).rejects.toMatchObject({ code: "canvas_result_deleted" });

    expect((mock.getRow().content.elements as any[]).filter(
      element => element.customData?.sourceJobId === "job-deleted-image",
    )).toEqual([expect.objectContaining({ id: "deleted-image", isDeleted: true })]);
  });

  it("rejects restore-only video insertion when the same job has a video tombstone", async () => {
    const mock = createConflictingClient({ conflict: false });
    (mock.getRow().content.elements as any[]).push({
      id: "deleted-video",
      type: "embeddable",
      isDeleted: true,
      // Legacy terminal results may have the authoritative element id but no
      // sourceJobId embedded in the scene element.
      customData: { source: "generated" },
    });

    await expect(insertVideoElement(mock.client, {
      canvasId: "canvas",
      sourceJobId: "job-deleted-video",
      assetId: "00000000-0000-4000-8000-000000000004",
      signedUrl: "https://example.com/deleted.mp4",
      width: 1280,
      height: 720,
      mimeType: "video/mp4",
      rejectDeletedSourceJob: true,
      knownElementId: "deleted-video",
    })).rejects.toMatchObject({ code: "canvas_result_deleted" });

    expect((mock.getRow().content.elements as any[]).filter(
      element => element.id === "deleted-video",
    )).toEqual([expect.objectContaining({ id: "deleted-video", isDeleted: true })]);
  });
});
