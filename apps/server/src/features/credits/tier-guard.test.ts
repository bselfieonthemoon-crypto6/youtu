import { afterEach, describe, expect, it, vi } from "vitest";
import { getImageCreditCost } from "@loomic/shared";

import {
  COMMERCIALIZATION_ENFORCEMENT_ENABLED,
  createTierGuard,
  isModelAccessible,
  imageResolutionBillingQuality,
} from "./tier-guard.js";

describe("commercialization master switch during product validation", () => {
  it("never underprices high provider quality when resolution is lower", () => {
    expect(imageResolutionBillingQuality("4k", "standard")).toBe("ultra");
    expect(imageResolutionBillingQuality("1k", "ultra")).toBe("ultra");
  });
  it("disables every commercial generation gate together", async () => {
    expect(COMMERCIALIZATION_ENFORCEMENT_ENABLED).toBe(false);
    expect(isModelAccessible("free", "gpt-image-2-all")).toBe(true);
    expect(isModelAccessible("free", "veo-3.1-fast-generate-preview")).toBe(
      true,
    );
    expect(isModelAccessible(null, "nano-banana-2")).toBe(true);

    const guard = createTierGuard({
      getAdminClient: () => {
        throw new Error("not needed for model access checks");
      },
    });

    expect(() => guard.checkModelAccess("free", "gpt-image-2-all")).not.toThrow();
    expect(() => guard.checkResolution("free", "ultra")).not.toThrow();
    expect(() => guard.checkVideoResolution("free", "4k")).not.toThrow();
    await expect(guard.checkConcurrency("workspace", "free")).resolves.toBeUndefined();
    expect(
      guard.calculateCreditCost("gpt-image-2-all", "image_generation", {
        quality: "ultra",
      }),
    ).toBe(0);
    expect(
      guard.calculateCreditCost("veo-3.1-fast-generate-preview", "video_generation", {
        duration: 16,
        resolution: "4k",
      }),
    ).toBe(0);
  });
});

describe("image price matrix", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  it("keeps every native quality-resolution row and compatible model on the same combined billing tier", async () => {
    vi.stubEnv("LOOMIC_COMMERCIALIZATION_ENABLED", "true");
    vi.resetModules();
    const { createTierGuard: createEnabledGuard, imageResolutionBillingQuality: combined } = await import("./tier-guard.js");
    const guard = createEnabledGuard({ getAdminClient: () => { throw new Error("not used"); } });
    const models = ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2-all", "nano-banana-2"];
    const qualities = ["standard", "hd", "ultra"] as const;
    const resolutions = ["1k", "2k", "4k"] as const;
    for (const model of models) for (const quality of qualities) for (const imageResolution of resolutions) {
      const billedQuality = combined(imageResolution, quality);
      expect(guard.calculateCreditCost(model, "image_generation", { quality, imageResolution }))
        .toBe(getImageCreditCost(model, billedQuality));
    }
  });
  it("returns zero across the same matrix while commercialization is disabled", () => {
    const guard = createTierGuard({ getAdminClient: () => { throw new Error("not used"); } });
    for (const quality of ["standard", "hd", "ultra"] as const) for (const imageResolution of ["1k", "2k", "4k"] as const)
      expect(guard.calculateCreditCost("gpt-image-2.5-flare", "image_generation", { quality, imageResolution })).toBe(0);
  });
});
