import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  optimizeAgentVisionAttachment,
  resolveAgentImageAttachment,
} from "./attachment-resolver.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const uuid = "00000000-0000-4000-8000-000000000001";

function clientWithAsset(asset: Record<string, unknown> | null) {
  const download = vi.fn(async () => ({
    data: new Blob([png], { type: "image/png" }),
    error: null,
  }));
  return {
    client: {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            single: async () => asset
              ? { data: asset, error: null }
              : { data: null, error: { message: "not found" } },
          }),
        }),
      })),
      storage: { from: vi.fn(() => ({ download })) },
    },
    download,
  };
}

describe("agent attachment authorization", () => {
  it("loads UUID assets through the RLS-backed metadata and storage clients", async () => {
    const { client, download } = clientWithAsset({
      bucket: "workspace-assets",
      object_path: "workspace/file.png",
      mime_type: "image/png",
    });
    const result = await resolveAgentImageAttachment({
      client,
      attachment: { assetId: uuid, url: "https://attacker.invalid/ignored", mimeType: "image/png" },
    });
    expect(result.buffer).toEqual(png);
    expect(download).toHaveBeenCalledWith("workspace/file.png");
  });

  it("rejects a UUID that RLS does not expose", async () => {
    const { client, download } = clientWithAsset(null);
    await expect(resolveAgentImageAttachment({
      client,
      attachment: { assetId: uuid, url: "https://example.com/image.png", mimeType: "image/png" },
    })).rejects.toThrow("attachment_not_found");
    expect(download).not.toHaveBeenCalled();
  });

  it("accepts bounded inline data only for an element in the authorized canvas", async () => {
    const { client } = clientWithAsset(null);
    const attachment = {
      assetId: "element-1",
      url: `data:image/png;base64,${png.toString("base64")}`,
      mimeType: "image/png",
    };
    await expect(resolveAgentImageAttachment({
      client,
      attachment,
      canvasContent: { elements: [{ id: "element-1", type: "image" }] },
    })).resolves.toMatchObject({ assetId: "element-1", mimeType: "image/png" });

    await expect(resolveAgentImageAttachment({
      client,
      attachment,
      canvasContent: { elements: [] },
    })).rejects.toThrow("attachment_not_authorized");
  });

  it("never falls back to an arbitrary remote attachment URL", async () => {
    const { client } = clientWithAsset(null);
    await expect(resolveAgentImageAttachment({
      client,
      attachment: {
        assetId: "not-a-real-asset",
        url: "https://127.0.0.1/internal",
        mimeType: "image/png",
      },
    })).rejects.toThrow("attachment_not_authorized");
  });
});

describe("agent vision attachment optimization", () => {
  it("creates a bounded webp copy without changing the original tool image", async () => {
    const source = await sharp({
      create: {
        width: 1800,
        height: 1200,
        channels: 4,
        background: { r: 240, g: 180, b: 40, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const result = await optimizeAgentVisionAttachment({
      assetId: uuid,
      buffer: source,
      mimeType: "image/png",
    });
    const metadata = await sharp(result.buffer).metadata();

    expect(result.assetId).toBe(uuid);
    expect(result.mimeType).toBe("image/webp");
    expect(metadata.width).toBe(1024);
    expect(metadata.height).toBeLessThanOrEqual(1024);
    expect(source.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
