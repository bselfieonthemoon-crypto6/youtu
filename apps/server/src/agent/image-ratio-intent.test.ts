import { describe, expect, it } from "vitest";
import type { AvailableModel } from "../generation/providers/registry.js";
import {
  approximateImageSizeAuthorized,
  currentApproximateImageSizeAuthorization,
  explicitNonstandardRatio,
  explicitOutOfRangePixelSize,
  normalizeImageGenerationAspectRatioProposal,
  validateNativeImageAspectRatio,
} from "./image-ratio-intent.js";

const model = "gpt-image-2";
const base = { title: "Header", prompt: "Blue campaign header", model };

describe("approximate image size authorization", () => {
  it("treats any non-standard explicit ratio as a custom frame", () => {
    expect(explicitNonstandardRatio("做一张 358×176 的图")).toBe(true);
    expect(explicitNonstandardRatio("尺寸 1200x628")).toBe(true);
    expect(explicitNonstandardRatio("16:9")).toBe(false);
    expect(explicitNonstandardRatio("做一张 1:1 的图")).toBe(false);
    expect(explicitNonstandardRatio("21:9 横幅")).toBe(false);
  });

  it("detects unambiguous out-of-range pixel sizes", () => {
    expect(explicitOutOfRangePixelSize("尺寸：658×176")).toBe(true);
    expect(explicitOutOfRangePixelSize("做一张 656*176 的图")).toBe(true);
    expect(explicitOutOfRangePixelSize("做成 1600x400")).toBe(true);
    expect(explicitOutOfRangePixelSize("1024×1024")).toBe(false);
    expect(explicitOutOfRangePixelSize("1200x628")).toBe(false);
    expect(explicitOutOfRangePixelSize("随便做一张")).toBe(false);
  });

  it("accepts either an accepting phrase or an explicit out-of-range size", () => {
    expect(approximateImageSizeAuthorized("尺寸差不多就好")).toBe(true);
    expect(approximateImageSizeAuthorized("尺寸：658×176")).toBe(true);
    expect(approximateImageSizeAuthorized("目标宽高 656×176")).toBe(true);
    expect(approximateImageSizeAuthorized("做一张 358×176 的图")).toBe(true);
    expect(approximateImageSizeAuthorized("必须精确 1024x1024")).toBe(false);
    expect(approximateImageSizeAuthorized("用 16:9 做一张图")).toBe(false);
  });

  it("lets an explicit precision demand override an out-of-range size", () => {
    expect(approximateImageSizeAuthorized("精确尺寸656:176")).toBe(false);
    expect(approximateImageSizeAuthorized("不使用非标准图片尺寸，做656:176")).toBe(false);
    expect(approximateImageSizeAuthorized("做一张 656:176 的图，必须精确")).toBe(false);
  });

  it("keeps the phrase-only helper unchanged", () => {
    expect(currentApproximateImageSizeAuthorization("尺寸：658×176")).toBe(false);
  });
});

describe("native image ratio preflight", () => {
  const nativeModels: AvailableModel[] = [
    { id: "workspace:native", displayName: "Native", description: "", provider: "test", upstreamModelId: "gpt-image-2" },
  ];

  it.each([
    { operation: "generate" as const, inputImages: undefined, sourceUsage: undefined },
    { operation: "generate" as const, inputImages: ["data:image/png;base64,eA=="], sourceUsage: "edit" as const },
  ])("rejects 656:176 for $sourceUsage before a job exists", ({ operation, inputImages, sourceUsage }) => {
    const result = validateNativeImageAspectRatio({
      ...base, operation, aspectRatio: "656:176", resolution: "1k",
      ...(inputImages ? { inputImages } : {}),
      ...(sourceUsage ? { sourceUsage, aspectRatioIntent: "resize" as const } : {}),
    } as Parameters<typeof validateNativeImageAspectRatio>[0], nativeModels);

    expect(result).toMatchObject({ error: "image_native_aspect_ratio_unsupported" });
    expect(result?.summary).toContain("656:176");
    expect(result?.summary).toContain("未创建或提交付费任务");
  });

  it("accepts a representable custom ratio without changing the requested frame", () => {
    expect(validateNativeImageAspectRatio(
      { model, operation: "generate", aspectRatio: "1200:628", resolution: "1k" },
      nativeModels,
    )).toBeNull();
  });

  it("never applies the output-frame contract to background removal or non-native models", () => {
    expect(validateNativeImageAspectRatio(
      { model, operation: "remove_background", aspectRatio: "656:176", resolution: "1k" },
      nativeModels,
    )).toBeNull();
    expect(validateNativeImageAspectRatio(
      { model, operation: "generate", aspectRatio: "656:176", resolution: "1k" },
      [{ id: model, displayName: model, description: "", provider: "test", upstreamModelId: "some-other-model" }],
    )).toBeNull();
  });

  it("keeps the numeric user ratio unless a loaded Skill and current approximation agree on the nearest legal boundary", () => {
    const args = { ...base, aspectRatio: "3:1", aspectRatioIntent: "approximate" };
    expect(normalizeImageGenerationAspectRatioProposal(args, "auto", "做 656:176，尺寸差不多就好")).toMatchObject({
      ok: true, args: { aspectRatio: "656:176" },
    });
    expect(normalizeImageGenerationAspectRatioProposal(args, "auto", "做 656:176，尺寸差不多就好",
      { allowLoadedSkillApproximation: true })).toMatchObject({ ok: true, args: { aspectRatio: "3:1" } });
    expect(normalizeImageGenerationAspectRatioProposal({ ...args, aspectRatio: "2:1" }, "auto", "做 656:176，尺寸差不多就好",
      { allowLoadedSkillApproximation: true })).toMatchObject({ ok: true, args: { aspectRatio: "656:176" } });
    expect(normalizeImageGenerationAspectRatioProposal(args, "auto", "做 656:176，必须精确",
      { allowLoadedSkillApproximation: true })).toMatchObject({ ok: true, args: { aspectRatio: "656:176" } });
    expect(normalizeImageGenerationAspectRatioProposal(args, "16:9", "做 656:176，尺寸差不多就好",
      { allowLoadedSkillApproximation: true })).toMatchObject({ ok: true, args: { aspectRatio: "16:9" } });
  });
});
