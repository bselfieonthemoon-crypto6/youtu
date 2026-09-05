import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  downloadBoundDesignAsset,
  storeImageAsset,
} from "./image-generation.js";

describe("local image operation asset persistence", () => {
  it("reuses a job-derived layer asset after a post-store crash", async () => {
    const jobId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    let stored: Record<string, unknown> | null = null;
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: stored, error: null })),
      upsert: vi.fn((row: Record<string, unknown>) => {
        stored = row;
        return {
          select: vi.fn(() => ({
            single: vi.fn(async () => ({ data: row, error: null })),
          })),
        };
      }),
    };
    const upload = vi.fn(async () => ({ data: {}, error: null }));
    const createSignedUrl = vi.fn(async () => ({
      data: { signedUrl: "https://signed.test/layer.png" },
      error: null,
    }));
    const admin = {
      from: vi.fn(() => query),
      storage: { from: vi.fn(() => ({ upload, createSignedUrl })) },
    };
    const input = {
      admin: admin as never,
      workspaceId,
      projectId,
      createdBy: randomUUID(),
      jobId,
      buffer: Buffer.from("png"),
      mimeType: "image/png",
      suffix: "0-background",
    };

    const first = await storeImageAsset(input);
    const replay = await storeImageAsset(input);

    expect(replay).toEqual(first);
    expect(first.asset_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.object_path).toBe(
      `${workspaceId}/generated/${jobId}-0-background.png`,
    );
    expect(upload).toHaveBeenCalledTimes(1);
    expect(query.upsert).toHaveBeenCalledTimes(1);
  });

  it("allows a published platform catalog image as a bound design source", async () => {
    const assetId = randomUUID();
    const assetQuery = chainQuery({
      id: assetId,
      scope: "platform",
      workspace_id: null,
      bucket: "platform-assets",
      object_path: "catalog/source.png",
      mime_type: "image/png",
      byte_size: 3,
      deletion_pending_at: null,
    });
    const resourceQuery = chainQuery({ id: randomUUID() });
    const admin = {
      from: vi.fn((table: string) =>
        table === "asset_objects" ? assetQuery : resourceQuery,
      ),
      storage: {
        from: vi.fn(() => ({
          download: vi.fn(async () => ({
            data: new Blob([Buffer.from("png")]),
            error: null,
          })),
        })),
      },
    };

    await expect(
      downloadBoundDesignAsset(admin as never, assetId, randomUUID()),
    ).resolves.toMatchObject({ mimeType: "image/png" });
    expect(admin.from).toHaveBeenCalledWith("design_resources");
  });

  it("rejects an unpublished platform image and a foreign workspace image", async () => {
    const workspaceId = randomUUID();
    for (const asset of [
      {
        id: randomUUID(),
        scope: "platform",
        workspace_id: null,
        bucket: "platform-assets",
        object_path: "draft.png",
        mime_type: "image/png",
        byte_size: 3,
        deletion_pending_at: null,
      },
      {
        id: randomUUID(),
        scope: "workspace",
        workspace_id: randomUUID(),
        bucket: "workspace-assets",
        object_path: "foreign.png",
        mime_type: "image/png",
        byte_size: 3,
        deletion_pending_at: null,
      },
    ]) {
      const admin = {
        from: vi.fn((table: string) =>
          table === "asset_objects" ? chainQuery(asset) : chainQuery(null),
        ),
        storage: { from: vi.fn() },
      };
      await expect(
        downloadBoundDesignAsset(admin as never, asset.id, workspaceId),
      ).rejects.toThrow("source asset is unavailable");
    }
  });
});

function chainQuery(data: Record<string, unknown> | null) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    is: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  return query;
}
