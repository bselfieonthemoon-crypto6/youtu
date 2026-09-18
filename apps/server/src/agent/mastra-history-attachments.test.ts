import { describe, expect, it, vi } from "vitest";

import { historicalUploadsFromRows, loadMastraHistoricalUploads } from "./mastra-history-attachments.js";
import { buildMastraImageSourceCandidates, createMastraImageSourceMaterializer } from "./mastra-image-source-grounding.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = id(1);
const canvasId = id(2);
const workspaceId = id(3);
const assetId = id(4);
const messageId = id(5);
const uploadedAt = "2026-09-15T07:40:15.000Z";
const expiredUrl = "https://example.invalid/expired-signed-upload";
const upload = (asset = assetId, message = messageId, name = "plant.png") => ({
  id: message, role: "user", content: "只描述这张植物图", created_at: uploadedAt,
  content_blocks: [{ type: "text", text: "只描述这张植物图" },
    { type: "image", source: "upload", assetId: asset, name, mimeType: "image/png", url: expiredUrl }],
});

function chain(data: any, error: any = null) {
  const query: any = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), contains: vi.fn(), order: vi.fn(),
    limit: vi.fn(), maybeSingle: vi.fn(), single: vi.fn() };
  for (const name of ["select", "eq", "is", "contains", "order"] as const)
    query[name].mockReturnValue(query);
  query.limit.mockResolvedValue({ data, error });
  query.maybeSingle.mockResolvedValue({ data, error });
  query.single.mockResolvedValue({ data, error });
  return query;
}

describe("Mastra historical user uploads", () => {
  it("discovers only real prior user uploads, preserving separate same-name uploads and ignoring old URLs", async () => {
    const rows = [upload(id(6), id(7)), upload(), { ...upload(id(8), id(9)), role: "assistant" },
      { ...upload(id(10), id(11)), content_blocks: [{ type: "image", source: "canvas-ref", assetId: id(10) }] },
      upload(id(12), id(13))];
    const result = historicalUploadsFromRows(rows, id(13));
    expect(result).toEqual([
      { assetId: id(6), messageId: id(7), name: "plant.png", promptExcerpt: "只描述这张植物图", createdAt: uploadedAt },
      { assetId, messageId, name: "plant.png", promptExcerpt: "只描述这张植物图", createdAt: uploadedAt },
    ]);
    expect(JSON.stringify(result)).not.toContain(expiredUrl);

    const messages = chain(rows);
    const client = { from: vi.fn(() => messages) };
    await expect(loadMastraHistoricalUploads({ client, sessionId, currentUserMessageId: id(13) }))
      .resolves.toEqual(result);
    expect(messages.eq.mock.calls).toEqual(expect.arrayContaining([["session_id", sessionId], ["role", "user"]]));
    expect(messages.contains).toHaveBeenCalledWith("content_blocks", JSON.stringify([{ type: "image", source: "upload" }]));
    expect(messages.limit).toHaveBeenCalledWith(80);
  });

  it("puts current images first, then distinct historical originals before generated results", () => {
    const candidates = buildMastraImageSourceCandidates({
      currentAttachments: [{ assetId: id(20), name: "current.png" }],
      historicalAttachments: [
        { assetId, messageId, name: "plant.png", promptExcerpt: "先描述", createdAt: uploadedAt },
        { assetId: id(6), messageId: id(7), name: "plant.png", promptExcerpt: "再次上传", createdAt: uploadedAt },
      ], canvasCandidates: [], recentJobs: [{ id: id(30), status: "succeeded", result: { asset_id: id(31) }, canvasId }],
      canvasId, liveDesignIds: new Set(),
    });
    expect(candidates.map(candidate => candidate.assetId)).toEqual([id(20), assetId, id(6), id(31)]);
    expect(candidates[1]).toMatchObject({ provenance: ["historical_attachment"], messageId,
      title: "plant.png", promptExcerpt: "先描述", createdAt: uploadedAt });
  });

  it("revalidates same-session upload and workspace asset before reading bytes; never uses the expired URL", async () => {
    const canvas = chain({ id: canvasId, content: { elements: [] } });
    const messages = chain(upload());
    const asset = chain({ id: assetId });
    const client = { from: vi.fn((table: string) => ({ canvases: canvas, chat_messages: messages,
      asset_objects: asset } as Record<string, any>)[table]) };
    const resolveAttachment = vi.fn(async () => ({ assetId, mimeType: "image/png", buffer: Buffer.from("image") }));
    const materialize = createMastraImageSourceMaterializer({ client, attachmentMap: {}, userId: id(40),
      workspaceId, sessionId, canvasId, scopeImageJobs: query => query, resolveAttachment });
    const candidate = { candidateKey: "source-1", assetId, provenance: ["historical_attachment"] as const, messageId };
    await expect(materialize([candidate], { signal: new AbortController().signal, usage: "reference" }))
      .resolves.toEqual([{ assetId, inputImage: "data:image/png;base64,aW1hZ2U=" }]);
    expect(messages.eq.mock.calls).toEqual(expect.arrayContaining([
      ["id", messageId], ["session_id", sessionId], ["role", "user"],
    ]));
    expect(asset.eq.mock.calls).toEqual(expect.arrayContaining([["id", assetId], ["workspace_id", workspaceId]]));
    expect(asset.is).toHaveBeenCalledWith("deletion_pending_at", null);
    expect(resolveAttachment).toHaveBeenCalledWith(expect.objectContaining({
      attachment: { assetId, url: "", mimeType: "image/png" },
    }));
  });

  it("blocks deleted session evidence and assets outside the workspace before downloading", async () => {
    const canvas = chain({ id: canvasId, content: { elements: [] } });
    const messages = chain(null);
    const asset = chain(null);
    const client = { from: vi.fn((table: string) => ({ canvases: canvas, chat_messages: messages,
      asset_objects: asset } as Record<string, any>)[table]) };
    const resolveAttachment = vi.fn();
    const materialize = createMastraImageSourceMaterializer({ client, attachmentMap: {}, userId: id(40),
      workspaceId, sessionId, canvasId, scopeImageJobs: query => query, resolveAttachment });
    const candidate = { candidateKey: "source-1", assetId, provenance: ["historical_attachment"] as const, messageId };
    await expect(materialize([candidate], { signal: new AbortController().signal, usage: "edit" }))
      .rejects.toThrow("historical_upload_removed_or_out_of_scope");
    messages.maybeSingle.mockResolvedValue({ data: upload(), error: null });
    await expect(materialize([candidate], { signal: new AbortController().signal, usage: "edit" }))
      .rejects.toThrow("historical_upload_asset_out_of_scope");
    expect(resolveAttachment).not.toHaveBeenCalled();
  });
});
