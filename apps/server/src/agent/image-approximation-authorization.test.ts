import { describe, expect, it } from "vitest";

import {
  approximateImageSizeAuthorized,
  currentApproximateImageSizeAuthorization,
  explicitNonstandardRatio,
  explicitOutOfRangePixelSize,
} from "./tools/image-generate.js";

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
