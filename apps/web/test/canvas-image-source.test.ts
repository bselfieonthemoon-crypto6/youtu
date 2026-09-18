// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCanvasImageOperation, resolveCanvasImageSource } from "../src/lib/canvas-image-source";
import { fetchAssetAsDataURL, fetchCanvasStorageAsDataURL } from "../src/lib/canvas-elements";
import { renderEraseMask } from "../src/lib/image-eraser";

vi.mock("../src/lib/canvas-elements", () => ({
  fetchAssetAsDataURL: vi.fn(), fetchCanvasStorageAsDataURL: vi.fn(), fetchAsDataURL: vi.fn(),
}));
const original = "data:image/png;base64,original";
const preview = "data:image/webp;base64,preview";
const element = { x: 0, y: 0, width: 390, height: 390, fileId: "image", customData: { assetId: "old-asset" } };
const drawImage = vi.fn();
const arc = vi.fn();
const context = { drawImage, translate: vi.fn(), scale: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), arc, fill: vi.fn() };
let canvases: Array<{ width: number; height: number }>;
beforeEach(() => {
  vi.resetAllMocks();
  canvases = [];
  vi.mocked(fetchAssetAsDataURL).mockResolvedValue(original);
  vi.stubGlobal("Image", class {
    naturalWidth = 1024; naturalHeight = 1024;
    onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.spyOn(document, "createElement").mockImplementation(() => {
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => "data:image/png;base64,rendered" };
    canvases.push(canvas);
    return canvas as unknown as HTMLCanvasElement;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("original-resolution toolbar input", () => {
  it("does not crop an unannotated 1024px upload to its 390px display size", async () => {
    const result = await prepareCanvasImageOperation("token", element, { image: { dataURL: original } });
    expect(result).toEqual({ width: 1024, height: 1024, dataURL: original, mimeType: "image/png" });
    expect(drawImage).not.toHaveBeenCalled();
  });
  it("fetches original bytes for a hydrated preview using the file binding", async () => {
    const result = await prepareCanvasImageOperation("token", element, { image: { assetId: "current-asset", dataURL: preview } });
    expect(fetchAssetAsDataURL).toHaveBeenCalledExactlyOnceWith("token", "current-asset");
    expect(result.dataURL).toBe(original);
  });
  it("keeps a new local edit instead of using inherited old asset metadata", async () => {
    expect(await resolveCanvasImageSource("token", element, { image: { dataURL: original } })).toBe(original);
    expect(fetchAssetAsDataURL).not.toHaveBeenCalled();
  });
  it("does not silently process a preview when downloading the original fails", async () => {
    vi.mocked(fetchAssetAsDataURL).mockRejectedValue(new Error("original unavailable"));
    await expect(prepareCanvasImageOperation("token", element, { image: { assetId: "current", dataURL: preview } })).rejects.toThrow("original unavailable");
  });
  it("maps an existing preview-space crop to the actual original pixels", async () => {
    const result = await prepareCanvasImageOperation("token", {
      ...element, crop: { x: 128, y: 64, width: 256, height: 192, naturalWidth: 512, naturalHeight: 512 },
    }, { image: { assetId: "current", dataURL: preview } });
    expect(result).toMatchObject({ width: 512, height: 384, mimeType: "image/png" });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 256, 128, 512, 384, 0, 0, 512, 384);
  });
  it("exports image and erase mask at original resolution independently of display size", async () => {
    const result = await prepareCanvasImageOperation("token", { ...element, width: 80, height: 80 }, { image: { dataURL: original } });
    renderEraseMask([{ points: [{ x: 0.75, y: 0.5 }], radius: 0.05 }], result.width, result.height);
    expect(canvases[0]).toMatchObject({ width: 1024, height: 1024 });
    expect(arc).toHaveBeenCalledWith(768, 512, 51.2, 0, Math.PI * 2);
  });
  it("reflects pixels without adding a rotated export bounding box", async () => {
    const rotated = { ...element, angle: Math.PI / 4, scale: [-1, 1] };
    const result = await prepareCanvasImageOperation("token", rotated, { image: { dataURL: original } });
    expect(result).toMatchObject({ width: 1024, height: 1024 });
    expect(context.translate).toHaveBeenCalledWith(1024, 0);
    expect(context.scale).toHaveBeenCalledWith(-1, 1);
  });
  it("loads a local storage reference directly when inline bytes are missing", async () => {
    vi.mocked(fetchCanvasStorageAsDataURL).mockResolvedValue(original);
    expect(await resolveCanvasImageSource("token", { ...element, customData: {} }, { image: { storageUrl: "http://127.0.0.1:54421/storage/example" } })).toBe(original);
    expect(fetchCanvasStorageAsDataURL).toHaveBeenCalledOnce();
  });
});
