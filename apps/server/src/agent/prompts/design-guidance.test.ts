import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDesignGuidance } from "./design-guidance.js";

afterEach(() => vi.unstubAllEnvs());

describe("bundled design guidance integration", () => {
  it("fully removes the additional prompt when disabled", () => {
    vi.stubEnv("LOOMIC_DESIGN_SKILLS_ENABLED", "false");
    expect(buildDesignGuidance([])).toBe("");
    expect(buildDesignGuidance([{ name: "logo-design" }])).toBe("");
  });

  it("does not restore an implicit catalog when all workspace skills are disabled", () => {
    vi.stubEnv("LOOMIC_DESIGN_SKILLS_ENABLED", "true");
    expect(buildDesignGuidance([])).toBe("");
    expect(buildDesignGuidance([{ name: "logo-design" }]).length).toBeGreaterThan(0);
  });
});
