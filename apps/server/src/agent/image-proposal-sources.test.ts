import { describe, expect, it, vi } from "vitest";
import { captureImageProposalSources, imageReferenceHash, resolveCanvasImageProposalSources, verifyImageProposalSources } from "./image-proposal-sources.js";
import { imageProposalInputSchema } from "../features/agent-actions/image-proposal-store.js";

const assetId = "70000000-0000-4000-8000-000000000001";
const assetIdV7 = "70000000-0000-7000-8000-000000000001";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const reference = `data:image/png;base64,${png.toString("base64")}`;
function fixture() {
  const asset = { id: assetId, bucket: "workspace-assets", object_path: "workspace/original.png", mime_type: "image/png", deletion_pending_at: null as string | null };
  const single = vi.fn(async () => ({ data: asset as typeof asset | null, error: null }));
  const eq = vi.fn(() => ({ single }));
  const download = vi.fn(async () => ({ data: new Blob([png], { type: "image/png" }), error: null }));
  const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: "https://storage.test/storage/v1/object/sign/workspace-assets/workspace/original.png?token=new" }, error: null }));
  const client = { from: vi.fn(() => ({ select: () => ({ eq }) })), storage: { from: vi.fn(() => ({ download, createSignedUrl })) } };
  const input = { inputImages: [reference], inputImageSources: captureImageProposalSources([assetId], { [assetId]: reference })! };
  return { asset, single, eq, download, createSignedUrl, client, input };
}

describe("trusted persisted proposal source identities", () => {
  it("resolves only requested live assets on the authenticated current canvas", async () => {
    const f = fixture();
    const canvas = { elements: [{ id: "logo-element", type: "image", isDeleted: false,
      customData: { assetId } }], files: {} };
    const canvasSingle = vi.fn(async () => ({ data: { content: canvas }, error: null }));
    const canvasEq = vi.fn(() => ({ single: canvasSingle }));
    (f.client.from as any).mockImplementation((table: string) => table === "canvases"
      ? ({ select: () => ({ eq: canvasEq }) } as any)
      : ({ select: () => ({ eq: f.eq }) } as any));
    expect(await resolveCanvasImageProposalSources({ client: f.client, canvasId: "canvas", references: [assetId] }))
      .toEqual({ [assetId]: reference });
    expect(canvasEq).toHaveBeenCalledWith("id", "canvas");
    expect(f.download).toHaveBeenCalledOnce();

    canvas.elements[0]!.isDeleted = true;
    await expect(resolveCanvasImageProposalSources({ client: f.client, canvasId: "canvas", references: [assetId] }))
      .rejects.toThrow("canvas_reference_not_found");
    await expect(resolveCanvasImageProposalSources({ client: f.client, canvasId: "canvas",
      references: ["70000000-0000-4000-8000-000000000099"] })).rejects.toThrow("canvas_reference_not_found");
  });

  it("captures only unambiguous server-map identities and not arbitrary model URLs", () => {
    expect(captureImageProposalSources([assetId], { [assetId]: reference })).toEqual([{ assetId, referenceHash: imageReferenceHash(reference) }]);
    expect(captureImageProposalSources([reference], { [assetId]: reference })).toEqual([{ assetId, referenceHash: imageReferenceHash(reference) }]);
    expect(captureImageProposalSources(["https://untrusted.test/source.png"], { [assetId]: reference })).toBeUndefined();
    expect(captureImageProposalSources([assetId], undefined)).toBeUndefined();
    expect(captureImageProposalSources([reference], { [assetId]: reference, "70000000-0000-4000-8000-000000000002": reference })).toBeUndefined();
    expect(captureImageProposalSources([assetIdV7], { [assetIdV7]: reference }))
      .toEqual([{ assetId: assetIdV7, referenceHash: imageReferenceHash(reference) }]);
  });

  it("rechecks RLS asset identity and actual bytes without returning image contents", async () => {
    const f = fixture();
    expect(await verifyImageProposalSources(f.client, f.input)).toEqual([assetId]);
    expect(f.eq).toHaveBeenCalledWith("id", assetId);
    expect(f.download).toHaveBeenCalledExactlyOnceWith("workspace/original.png");
  });

  it("validates a previously bound URL against the asset's canonical storage path, never guesses the ID from URL", async () => {
    const f = fixture();
    const url = "https://storage.test/storage/v1/object/sign/workspace-assets/workspace/original.png?token=original";
    const input = { inputImages: [url], inputImageSources: captureImageProposalSources([assetId], { [assetId]: url })! };
    expect(await verifyImageProposalSources(f.client, input)).toEqual([assetId]);
    expect(f.createSignedUrl).toHaveBeenCalledOnce();
    const foreign = "https://foreign.test/storage/v1/object/sign/workspace-assets/workspace/original.png";
    await expect(verifyImageProposalSources(f.client, { inputImages: [foreign], inputImageSources: [{ assetId, referenceHash: imageReferenceHash(foreign) }] })).rejects.toThrow("source_changed");
    const transformed = `${url}&width=20`;
    await expect(verifyImageProposalSources(f.client, { inputImages: [transformed], inputImageSources: [{ assetId, referenceHash: imageReferenceHash(transformed) }] })).rejects.toThrow("source_changed");
  });

  it("fails closed for legacy unbound references, altered execution references and inaccessible sources", async () => {
    const f = fixture();
    await expect(verifyImageProposalSources(f.client, { inputImages: [reference] })).rejects.toThrow("binding_missing");
    await expect(verifyImageProposalSources(f.client, { ...f.input, inputImages: [reference + "changed"] })).rejects.toThrow("binding_changed");
    f.single.mockResolvedValue({ data: null, error: null });
    await expect(verifyImageProposalSources(f.client, f.input)).rejects.toThrow("source_unavailable");
    expect(f.download).not.toHaveBeenCalled();
  });

  it("rejects deletion-pending assets and a replaced original even if the persisted binding claims the same asset", async () => {
    const f = fixture();
    f.asset.deletion_pending_at = "2026-09-09T00:00:00Z";
    await expect(verifyImageProposalSources(f.client, f.input)).rejects.toThrow("source_unavailable");
    f.asset.deletion_pending_at = null;
    const changed = Buffer.from(png); changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    f.download.mockResolvedValue({ data: new Blob([changed], { type: "image/png" }), error: null });
    await expect(verifyImageProposalSources(f.client, f.input)).rejects.toThrow("source_changed");
  });

  it("retains the bounded original reader's 20 MB limit", async () => {
    const f = fixture();
    f.download.mockResolvedValue({ data: { size: 20 * 1024 * 1024 + 1 } as Blob, error: null });
    await expect(verifyImageProposalSources(f.client, f.input)).rejects.toThrow("too_large");
  });

  it("bounds a stalled source read to ten seconds without a retry", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.single.mockImplementation(() => new Promise(() => {}));
      const result = expect(verifyImageProposalSources(f.client, f.input)).rejects.toThrow("source_timeout");
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(f.single).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("does not start another asset read after a timed-out download eventually completes", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let release!: (value: { data: Blob; error: null }) => void;
      f.download.mockImplementation(() => new Promise(resolve => { release = resolve; }));
      const input = { inputImages: [reference, reference], inputImageSources: [...f.input.inputImageSources, ...f.input.inputImageSources] };
      const result = expect(verifyImageProposalSources(f.client, input)).rejects.toThrow("source_timeout");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.download).toHaveBeenCalledOnce();
      const reads = f.single.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      release({ data: new Blob([png], { type: "image/png" }), error: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.single).toHaveBeenCalledTimes(reads);
      expect(f.download).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("persists the server binding without rewriting execution references, rejects inconsistent stored input", () => {
    const f = fixture();
    const input = { ...f.input, operation: "remove_background", title: "Cutout", prompt: "Background only", model: "gpt-image-2" };
    expect(imageProposalInputSchema.parse(input)).toMatchObject({ inputImages: [reference], inputImageSources: f.input.inputImageSources, outputFormat: "png" });
    expect(imageProposalInputSchema.safeParse({ ...input, inputImages: ["https://changed.test/original.png"] }).success).toBe(false);
    expect(imageProposalInputSchema.safeParse({ ...input, inputImageSources: [] }).success).toBe(false);
  });
});
