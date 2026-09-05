import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDesignGuidance } from "./design-guidance.js";

afterEach(() => vi.unstubAllEnvs());

describe("bundled design guidance integration", () => {
  it("fully removes the additional prompt when disabled", () => {
    vi.stubEnv("LOOMIC_DESIGN_SKILLS_ENABLED", "false");
    expect(buildDesignGuidance([])).toBe("");
    expect(buildDesignGuidance([{ name: "logo-design" }])).toBe("");
  });

  it("advertises only readable bundled skills and respects workspace overrides", async () => {
    vi.stubEnv("LOOMIC_DESIGN_SKILLS_ENABLED", "true");
    const prompt = buildDesignGuidance([{ name: "logo-design" }]);
    const paths = [...prompt.matchAll(/read_file (\/skills\/[^\s]+\/SKILL\.md)/g)]
      .map((match) => match[1]!);
    expect(paths).toHaveLength(3);
    expect(paths).not.toContain("/skills/logo-design/SKILL.md");
    for (const path of paths) {
      const content = await readFile(new URL(`../../../../..${path}`, import.meta.url), "utf8");
      expect(content).toMatch(/^---\r?\nname: /);
    }
  });
});
