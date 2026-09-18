import { describe, expect, it } from "vitest";
import { resolveNativeImageSize } from "./native-image-size.js";

describe("resolveNativeImageSize", () => {
  it.each([
    ["1:1", "1k", { width: 1024, height: 1024, size: "1024x1024" }],
    ["16:9", "1k", { width: 1280, height: 720, size: "1280x720" }],
    ["16:9", "2k", { width: 2048, height: 1152, size: "2048x1152" }],
    ["1:1", "4k", { width: 2880, height: 2880, size: "2880x2880" }],
    ["16:9", "4k", { width: 3840, height: 2160, size: "3840x2160" }],
  ] as const)("maps %s at %s", (ratio, resolution, expected) => {
    expect(resolveNativeImageSize(ratio, resolution)).toEqual(expected);
  });

  it("keeps generic ratios within one percent without cropping", () => {
    const result = resolveNativeImageSize("4:5", "2k");
    expect(result.width % 16).toBe(0);
    expect(result.height % 16).toBe(0);
    expect(result.width * result.height).toBeGreaterThanOrEqual(655_360);
    expect(result.width / result.height).toBeCloseTo(4 / 5, 2);
  });

  it.each(["auto", "0:1", "3.01:1", "1:3.01"])("rejects unsupported ratio %s", (ratio) => {
    expect(() => resolveNativeImageSize(ratio)).toThrow(/native image aspect ratio/i);
  });
});
