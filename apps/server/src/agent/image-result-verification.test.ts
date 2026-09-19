import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_REVIEW_IMAGES,
  parseImagePixelReview,
  resolveWorkspaceReviewImage,
  reviewImagePixels,
} from "./image-result-verification.js";

async function png() {
  return sharp({ create: { width: 24, height: 16, channels: 4, background: "#ef4444" } }).png().toBuffer();
}

function userClient(bytes: Buffer, workspaceId = "workspace") {
  const filters = new Map<string, unknown>();
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn((key: string, value: unknown) => { filters.set(key, value); return query; }),
    is: vi.fn((key: string, value: unknown) => { filters.set(key, value); return query; }),
    single: vi.fn(async () => ({
      data: filters.get("workspace_id") === workspaceId ? {
        id: filters.get("id"), bucket: "workspace-assets", object_path: "result.png",
        mime_type: "image/png", byte_size: bytes.byteLength,
        workspace_id: workspaceId, deletion_pending_at: null,
      } : null,
      error: filters.get("workspace_id") === workspaceId ? null : { message: "not found" },
    })),
  };
  const download = vi.fn(async () => ({
    data: { size: bytes.byteLength, type: "image/png", arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    error: null,
  }));
  return { client: { from: vi.fn(() => query), storage: { from: vi.fn(() => ({ download })) } }, query, filters, download };
}

describe("bounded image result pixel review", () => {
  it.each(["reference_analysis", "result_verification"] as const)("scopes only reference batches, retaining real issues (%s)", async mode => {
    const bytes = await png();
    const generate = vi.fn(async (_input: unknown) => ({
      text: '{"blockingIssues":[],"suggestions":[],"uncertainties":["本图文字模糊"]}', usage: {},
    }));
    const result = await reviewImagePixels({
      images: [{ id: "actual-fifth", source: "workspace_asset", role: "reference", mimeType: "image/png", buffer: bytes }],
      model: { generate } as never, taskBrief: { currentUserPrompt: "识别全部9张图" }, mode, comparison: "individual",
    });
    const text = (generate.mock.calls[0]![0] as { user: string }).user;
    expect(text.includes('"reviewScope":')).toBe(mode === "reference_analysis");
    expect(text.includes("识别全部9张图")).toBe(mode !== "reference_analysis");
    if (mode === "reference_analysis") {
      expect(text).toContain('"assetIds":["actual-fifth"]');
      expect(text).toContain('"count":1');
      expect(text).toContain("Other requested images may be in other batches");
    }
    expect(result).toMatchObject({ viewed: true, status: "unavailable", uncertainties: ["本图文字模糊"],
      // status=unavailable must never read as "the image was not inspected".
      statusMeaning: expect.stringContaining("已查看实际像素") });
  });
  it.each([false, true])("rechecks contradictory blockers once and never silently approves (%s)", async repeated => {
    const bytes = await png();
    const contradictory = { text: '{"blockingIssues":["比例符合16:9要求"],"suggestions":[],"uncertainties":[]}', usage: {} };
    const generate = vi.fn().mockResolvedValueOnce(contradictory)
      .mockResolvedValueOnce(repeated ? contradictory : { text: '{"blockingIssues":[],"suggestions":[],"uncertainties":[]}', usage: {} });
    const result = await reviewImagePixels({ images: [{ id: "result", source: "workspace_asset", role: "result", mimeType: "image/png", buffer: bytes }], model: { generate } as never, taskBrief: {}, mode: "result_verification", comparison: "individual" });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(repeated ? "unavailable" : "passed");
  });
  it("uses both RLS and an explicit workspace predicate before downloading an asset", async () => {
    const bytes = await png();
    const fixture = userClient(bytes);
    const image = await resolveWorkspaceReviewImage({
      client: fixture.client, workspaceId: "workspace",
      assetId: "10000000-0000-4000-8000-000000000001", role: "result",
    });
    expect(image.buffer.equals(bytes)).toBe(true);
    expect(fixture.filters).toEqual(new Map([
      ["id", "10000000-0000-4000-8000-000000000001"],
      ["workspace_id", "workspace"],
      ["deletion_pending_at", null],
    ]));
    expect(fixture.download).toHaveBeenCalledOnce();
    await expect(resolveWorkspaceReviewImage({
      client: fixture.client, workspaceId: "foreign-workspace",
      assetId: "10000000-0000-4000-8000-000000000001", role: "result",
    })).rejects.toThrow("review_asset_not_authorized");
  });

  it("sends optimized actual pixels to the vision model and reports a truthful pass", async () => {
    const bytes = await png();
    const generate = vi.fn(async (_input: unknown) => ({
      text: '{"blockingIssues":[],"suggestions":["可选：增加留白"],"uncertainties":[]}', usage: {},
    }));
    const result = await reviewImagePixels({
      images: [{ id: "result", source: "workspace_asset", role: "result", mimeType: "image/png", buffer: bytes }],
      model: { generate } as never, taskBrief: { currentUserPrompt: "标题不能裁切" },
      mode: "result_verification", comparison: "individual",
    });
    expect(result).toMatchObject({ status: "passed", viewed: true, blockingIssues: [] });
    const input = generate.mock.calls[0]![0] as { user: string; images: { dataUri: string }[] };
    // The optimized attachment is still re-encoded to webp before it is sent.
    expect(input.images[0]!.dataUri).toMatch(/^data:image\/webp;base64,/);
    expect(input.user).toContain("标题不能裁切");
  });

  it("fails closed on malformed model output, excess images, and uncertainty", async () => {
    const bytes = await png();
    const image = { id: "result", source: "workspace_asset" as const, role: "result" as const, mimeType: "image/png", buffer: bytes };
    const malformed = await reviewImagePixels({
      images: [image], model: { generate: vi.fn(async () => ({ text: "looks good", usage: {} })) } as never,
      taskBrief: {}, mode: "result_verification", comparison: "individual",
    });
    expect(malformed).toMatchObject({ status: "unavailable", viewed: false });
    const tooMany = await reviewImagePixels({
      images: Array(MAX_REVIEW_IMAGES + 1).fill(image), model: { generate: vi.fn() } as never,
      taskBrief: {}, mode: "series" as never, comparison: "series",
    });
    expect(tooMany).toMatchObject({ status: "unavailable", viewed: false, error: "review_image_count_invalid" });
    const uncertain = await reviewImagePixels({
      images: [image], model: { generate: vi.fn(async () => ({ text: '{"blockingIssues":[],"suggestions":[],"uncertainties":["小字不可辨认"]}', usage: {} })) } as never,
      taskBrief: {}, mode: "result_verification", comparison: "individual",
    });
    expect(uncertain).toMatchObject({ status: "unavailable", viewed: true, uncertainties: ["小字不可辨认"],
      statusMeaning: expect.stringContaining("不代表没有看到图") });
    // A reviewed image that only leaves an acceptance gate open must never be
    // reported as an unread one.
    expect(uncertain.viewed).toBe(true);
  });

  it("parses only the bounded strict review contract", () => {
    expect(parseImagePixelReview('```json\n{"blockingIssues":[],"suggestions":[],"uncertainties":[]}\n```')).toEqual({
      blockingIssues: [], suggestions: [], uncertainties: [],
    });
    expect(() => parseImagePixelReview('{"blockingIssues":[],"suggestions":[],"uncertainties":[],"passed":true}')).toThrow();
  });
});
