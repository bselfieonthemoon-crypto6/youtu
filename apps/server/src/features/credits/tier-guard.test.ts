import { describe, expect, it } from "vitest";

import {
  COMMERCIALIZATION_ENFORCEMENT_ENABLED,
  createTierGuard,
  isModelAccessible,
} from "./tier-guard.js";

describe("commercialization master switch during product validation", () => {
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
