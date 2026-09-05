import { describe, expect, it, vi } from "vitest";

import {
  DESIGN_BROWSER_EXPORT_MAX_PIXELS,
  type DesignBrowserExportError,
  type DesignBrowserExportPort,
  exportDesignInBrowser,
} from "../src/lib/design-browser-export";

describe("browser design export", () => {
  it.each([
    ["png", "image/png", false, "海报@1x.png"],
    ["transparent-png", "image/png", true, "海报@1x.png"],
    ["jpeg", "image/jpeg", false, "海报@1x.jpg"],
  ] as const)(
    "exports %s only after resources are ready",
    async (format, mimeType, transparent, filename) => {
      const calls: string[] = [];
      const port = mockPort(calls);
      const createObjectURL = vi.fn(() => "blob:design");
      const revokeObjectURL = vi.fn();
      const clickDownload = vi.fn();
      await expect(
        exportDesignInBrowser(
          { name: "海报", width: 1000, height: 800, multiplier: 1, format },
          port,
          {
            createObjectURL,
            revokeObjectURL,
            clickDownload,
            scheduleRevoke: (callback) => callback(),
          },
        ),
      ).resolves.toEqual({
        status: "downloaded",
        filename,
        renderedPixels: 800_000,
      });
      expect(calls).toEqual([
        "fonts",
        "images",
        `render:${mimeType}:${transparent}:1000x800`,
      ]);
      expect(clickDownload).toHaveBeenCalledWith("blob:design", filename);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:design");
    },
  );

  it("routes an oversized 2x export to Stage 7 without rendering or allocating a URL", async () => {
    const port = mockPort([]);
    const createObjectURL = vi.fn();
    await expect(
      exportDesignInBrowser(
        {
          name: "大图",
          width: 4000,
          height: 3000,
          multiplier: 2,
          format: "png",
        },
        port,
        { createObjectURL },
      ),
    ).resolves.toEqual({
      status: "background_required",
      reason: "pixel_budget_exceeded",
      renderedPixels: 48_000_000,
      maxPixels: DESIGN_BROWSER_EXPORT_MAX_PIXELS,
    });
    expect(port.waitForFonts).not.toHaveBeenCalled();
    expect(port.renderToBlob).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("reports missing assets explicitly and never starts rendering", async () => {
    const port = mockPort([]);
    vi.mocked(port.waitForImages).mockResolvedValue({
      missingAssetObjectIds: ["asset-1"],
    });
    await expect(
      exportDesignInBrowser(
        { name: "设计", width: 100, height: 100, multiplier: 1, format: "png" },
        port,
      ),
    ).rejects.toMatchObject({
      code: "missing_resources",
      missingAssetObjectIds: ["asset-1"],
    } satisfies Partial<DesignBrowserExportError>);
    expect(port.renderToBlob).not.toHaveBeenCalled();
  });
});

function mockPort(calls: string[]): DesignBrowserExportPort {
  return {
    waitForFonts: vi.fn(async () => {
      calls.push("fonts");
    }),
    waitForImages: vi.fn(async () => {
      calls.push("images");
      return { missingAssetObjectIds: [] };
    }),
    renderToBlob: vi.fn(async (options) => {
      calls.push(
        `render:${options.mimeType}:${options.transparent}:${options.logicalWidth}x${options.logicalHeight}`,
      );
      return new Blob(["pixels"], { type: options.mimeType });
    }),
  };
}
