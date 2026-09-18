import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { generateImage } from "../../generation/image-generation.js";
import { safeDownload } from "../../security/safe-download.js";
import { removeBackgroundWithApi } from "./api-background-removal.js";
vi.mock("../../generation/image-generation.js", () => ({ generateImage: vi.fn() }));
vi.mock("../../generation/providers/registry.js", () => ({ resolveImageProviderName: () => "workspace-provider" }));
vi.mock("../../security/safe-download.js", () => ({ safeDownload: vi.fn() }));
const png = (alpha: number) => sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha } } }).png().toBuffer();
describe("API background removal", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(generateImage).mockResolvedValue({ url: "https://example.com/result.png", mimeType: "image/png", width: 20, height: 10 }); });
  it("uses the pinned model and validates alpha before returning a source-sized foreground", async () => {
    vi.mocked(safeDownload).mockResolvedValue({ buffer: await png(0.5) } as never);
    const result = await removeBackgroundWithApi(await png(1), "workspace:native-model");
    expect(generateImage).toHaveBeenCalledExactlyOnceWith("workspace-provider", expect.objectContaining({ model: "workspace:native-model", background: "transparent", outputFormat: "png", outputWidth: 1536, outputHeight: 768 }));
    expect(result).toMatchObject({ model: "workspace:native-model", width: 20, height: 10 });
    expect((await sharp(result.layers[0]!.buffer).metadata()).hasAlpha).toBe(true);
  });
  it.each([0, 1])("rejects empty or opaque alpha %s", async (alpha) => {
    vi.mocked(safeDownload).mockResolvedValue({ buffer: await png(alpha) } as never);
    await expect(removeBackgroundWithApi(await png(1), "gpt-image-2")).rejects.toThrow("不透明图片或空白图片");
  });
  it("rejects a PNG without an alpha channel", async () => {
    vi.mocked(safeDownload).mockResolvedValue({ buffer: await sharp(await png(1)).removeAlpha().png().toBuffer() } as never);
    await expect(removeBackgroundWithApi(await png(1), "gpt-image-2")).rejects.toThrow("未返回透明 PNG");
  });
  it("persists the provider reference before download and pixels before alpha validation", async () => {
    const events: string[] = [];
    vi.mocked(safeDownload).mockImplementation(async () => {
      events.push("download");
      return { buffer: await png(1), mimeType: "image/png" } as never;
    });
    await expect(removeBackgroundWithApi(await png(1), "gpt-image-2", {
      providerPersistence: {
        getOrCreate: async (invoke) => {
          const result = await invoke();
          events.push("returned");
          return result;
        },
        persistDownloaded: async () => {
          events.push("pixels");
        },
      },
    })).rejects.toMatchObject({ code: "background_removal_invalid_output" });
    expect(events).toEqual(["returned", "download", "pixels"]);
  });
  it("never calls the all model", async () => {
    await expect(removeBackgroundWithApi(await png(1), "gpt-image-2-all")).rejects.toThrow("配置错误");
    expect(generateImage).not.toHaveBeenCalled();
  });
});
