import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ safeDownload: vi.fn() }));
vi.mock("../security/safe-download.js", async importOriginal => ({
  ...await importOriginal<typeof import("../security/safe-download.js")>(),
  safeDownload: mocks.safeDownload,
}));

import { resolvePromptLibraryReviewImages, reviewImagePixels } from "./image-result-verification.js";

describe("prompt-library image pixel review boundary", () => {
  it("fetches only previews returned by an exact catalog case lookup and actually sends pixels to vision", async () => {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 4, background: "#f59e0b" } }).png().toBuffer();
    mocks.safeDownload.mockResolvedValue({ buffer: bytes, mimeType: "image/png" });
    const getById = vi.fn(async (id: string) => id === "selected-case" ? {
      version: "test", source: { id: "source", name: "Source", url: "https://source.example/case", license: "test", attribution: "test", status: "available", note: "", entryCount: 1 },
      item: { id, title: "Selected case", prompt: "untrusted catalog prompt", category: "poster", tags: [], sourceId: "source",
        sourceUrl: "https://source.example/case", modelHints: [], requiresReference: false,
        previewImageUrls: ["https://cdn.example/selected.png"] },
    } : null);
    const images = await resolvePromptLibraryReviewImages({ service: { getById } as never, caseIds: ["selected-case"], limit: 4 });
    expect(getById).toHaveBeenCalledWith("selected-case");
    expect(mocks.safeDownload).toHaveBeenCalledWith("https://cdn.example/selected.png", expect.objectContaining({
      maxRedirects: 0, allowedHosts: ["cdn.example"], maxBytes: 8 * 1024 * 1024,
    }));
    const generate = vi.fn(async (_input: unknown) => ({
      text: '{"blockingIssues":[],"suggestions":[],"uncertainties":[]}', usage: {},
    }));
    const review = await reviewImagePixels({ images, model: { generate } as never,
      taskBrief: { currentUserPrompt: "分析所选案例的构图" }, mode: "reference_analysis", comparison: "individual" });
    expect(review).toMatchObject({ status: "passed", viewed: true });
    expect((generate.mock.calls[0]![0] as { images: unknown[] }).images.length).toBeGreaterThan(0);
  });

  it("takes one representative preview from every requested case instead of crowding later cases out", async () => {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#111827" } }).png().toBuffer();
    mocks.safeDownload.mockResolvedValue({ buffer: bytes, mimeType: "image/png" });
    const getById = vi.fn(async (id: string) => ({
      version: "test", source: {},
      item: { id, title: id, previewImageUrls: [`https://cdn.example/${id}-one.png`, `https://cdn.example/${id}-two.png`] },
    }));
    const images = await resolvePromptLibraryReviewImages({ service: { getById } as never, caseIds: ["first", "second"], limit: 2 });
    expect(images.map(image => image.id)).toEqual(["first:1", "second:1"]);
    expect(mocks.safeDownload.mock.calls.slice(-2).map(call => call[0])).toEqual([
      "https://cdn.example/first-one.png", "https://cdn.example/second-one.png",
    ]);
  });
});
