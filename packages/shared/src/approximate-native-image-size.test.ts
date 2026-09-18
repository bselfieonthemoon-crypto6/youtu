import { describe, expect, it } from "vitest";
import { planApproximateNativeImageSize } from "./approximate-native-image-size.js";
import { resolveNativeImageSize } from "./native-image-size.js";

describe("opt-in approximate native size plan", () => {
  it("doubles a small wide target before choosing the closest supported ratio without upgrading 1K", () => {
    const plan = planApproximateNativeImageSize(656, 176);
    expect(plan).toMatchObject({ scaleFactor: 4, scaledTarget: { width: 2624, height: 704 }, aspectRatio: "3:1", resolution: "1k", substituted: true });
    expect(plan.nativeSize).toEqual(resolveNativeImageSize("3:1", "1k"));
    expect(plan.ratioError).toBeGreaterThan(0.18);
    expect(plan.ratioError).toBeLessThan(0.21);
    expect(() => resolveNativeImageSize("656:176")).toThrow();
  });
  it("handles the tall boundary and preserves supported custom proportions", () => {
    expect(planApproximateNativeImageSize(176, 656).aspectRatio).toBe("1:3");
    expect(planApproximateNativeImageSize(656, 288)).toMatchObject({ aspectRatio: "656:288", substituted: false, resolution: "1k" });
    expect(planApproximateNativeImageSize(656, 288).ratioError).toBeLessThanOrEqual(0.01);
  });
  it("honors explicit tiers and rejects invalid targets", () => {
    expect(planApproximateNativeImageSize(656, 176, "2k").nativeSize).toEqual(resolveNativeImageSize("3:1", "2k"));
    for (const value of [0, -1, Infinity, NaN, 0.5, 100001]) expect(() => planApproximateNativeImageSize(value, 176)).toThrow();
  });
});
