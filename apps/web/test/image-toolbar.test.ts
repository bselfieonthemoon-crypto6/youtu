import { describe, expect, it } from "vitest";

import {
  buildImageActionPrompt,
  calculate2KResolution,
} from "../src/components/canvas/image-action-dialog";
import {
  DEFAULT_IMAGE_TOOLBAR_PREFERENCES,
  IMAGE_TOOLBAR_ACTIONS,
  normalizeImageToolbarPreferences,
} from "../src/hooks/use-image-toolbar-preferences";

describe("image toolbar preferences", () => {
  it("normalizes duplicates, unavailable actions and excess pinned items", () => {
    expect(normalizeImageToolbarPreferences({
      pinned: ["download", "download", "erase", "crop", "details"],
      showLabels: false,
    })).toEqual({ pinned: ["download", "erase", "crop", "details"], showLabels: false });
  });

  it("falls back safely for invalid storage values", () => {
    expect(normalizeImageToolbarPreferences(null)).toEqual(DEFAULT_IMAGE_TOOLBAR_PREFERENCES);
  });

  it("removes the retired subject-preview entry from saved preferences", () => {
    expect(normalizeImageToolbarPreferences({ pinned: ["region-matting", "remove-background", "erase"], showLabels: true }))
      .toEqual({ pinned: ["remove-background", "erase"], showLabels: true });
  });

  it("keeps upscale and removes the retired agent actions", () => {
    const ids = IMAGE_TOOLBAR_ACTIONS.map((action) => action.id);
    expect(ids).toContain("upscale");
    expect(ids).toContain("remove-background");
    expect(ids).not.toContain("region-matting");
    expect(ids).toContain("split-layers");
    expect(ids).toContain("erase");
    expect(IMAGE_TOOLBAR_ACTIONS.find((action) => action.id === "remove-background")?.available).toBe(true);
    expect(IMAGE_TOOLBAR_ACTIONS.find((action) => action.id === "split-layers")?.available).toBe(true);
    expect(IMAGE_TOOLBAR_ACTIONS.find((action) => action.id === "erase")?.available).toBe(true);
    expect(ids).not.toContain("relight");
    expect(ids).not.toContain("change-view");
    expect(ids).not.toContain("animate");
  });
});

describe("image toolbar direct-task prompts", () => {
  it("builds a concrete regeneration instruction", () => {
    const prompt = buildImageActionPrompt("regenerate", { notes: "保持透明背景" });
    expect(prompt).toContain("重新生成");
    expect(prompt).toContain("仅输出新的图片版本");
    expect(prompt).toContain("保持透明背景");
  });

  it("builds a constrained upscale instruction", () => {
    const image = {
      id: "image-1",
      fileId: "file-1",
      x: 0,
      y: 0,
      width: 512,
      height: 292,
      originalWidth: 1024,
      originalHeight: 584,
      mimeType: "image/png",
    };
    expect(calculate2KResolution(image)).toEqual({
      sourceWidth: 1024,
      sourceHeight: 584,
      targetWidth: 2048,
      targetHeight: 1168,
    });
    const prompt = buildImageActionPrompt("upscale", { notes: "保持透明背景" }, image);
    expect(prompt).toContain("保持原始宽高比");
    expect(prompt).toContain("2K");
    expect(prompt).toContain("保持透明背景");
  });

  it("uses the display size only when the actual size is unavailable", () => {
    expect(calculate2KResolution({
      id: "image-2",
      fileId: "file-2",
      x: 0,
      y: 0,
      width: 600,
      height: 600,
      mimeType: "image/png",
    })).toEqual({
      sourceWidth: 600,
      sourceHeight: 600,
      targetWidth: 2048,
      targetHeight: 2048,
    });
  });
});
