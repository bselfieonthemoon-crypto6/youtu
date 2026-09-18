import { describe, expect, it } from "vitest";

import { formatEnabledSkillCatalog } from "./design-skill-catalog.js";

const ready = (name: string, description: string, displayName?: string) => ({ name, description, ...(displayName ? { displayName } : {}) });

describe("formatEnabledSkillCatalog", () => {
  it("lists ready skills with slug, display name and description", () => {
    const text = formatEnabledSkillCatalog([
      ready("logo-design", "为新 Logo 规划位图概念", "Logo 与品牌标记"),
      { ...ready("canvas-design", "原生画板"), readiness: { status: "unavailable" } },
    ]);
    expect(text).toContain("logo-design（Logo 与品牌标记）: 为新 Logo 规划位图概念");
    expect(text).not.toContain("canvas-design");
    expect(text).toContain("目录不等于已读");
  });

  it("returns an empty string when nothing is selectable", () => {
    expect(formatEnabledSkillCatalog([])).toBe("");
    expect(formatEnabledSkillCatalog([{ ...ready("x", "x"), readiness: { status: "unavailable" } }])).toBe("");
  });

  it("caps the catalog size deterministically", () => {
    const skills = Array.from({ length: 40 }, (_value, index) => ready(`skill-${index}`, `d${index}`));
    const lines = formatEnabledSkillCatalog(skills, 5).split("\n");
    expect(lines).toHaveLength(2 + 5);
  });
});
