import { describe, expect, it } from "vitest";

import {
  SKILL_CATALOG_MAX_BYTES,
  SKILL_CATALOG_SELECTION_MAX_CHARS,
  formatEnabledSkillCatalog,
} from "./design-skill-catalog.js";

const ready = (name: string, description: string, displayName?: string) => ({ name, description, ...(displayName ? { displayName } : {}) });
const loomic = (whenToUse: string) => ({ metadata: { loomic: {
  schemaVersion: 1, execution: "guidance", whenToUse,
  intents: ["probe"], outputKinds: ["design-brief"], requiredTools: [], optionalTools: [],
  models: [], limitations: [], examples: [], sources: [],
} } });

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

  it("prefers the model-facing whenToUse over the description", () => {
    const text = formatEnabledSkillCatalog([
      { ...ready("logo-design", "为新 Logo 规划位图概念"), ...loomic("用户要做新 Logo 概念时使用；普通海报排版不使用。") },
      ready("legacy-guide", "第三方旧包的描述"),
    ]);
    expect(text).toContain("- logo-design: 用户要做新 Logo 概念时使用；普通海报排版不使用。");
    expect(text).not.toContain("为新 Logo 规划位图概念");
    // Older / third-party packages keep working through the description fallback.
    expect(text).toContain("- legacy-guide: 第三方旧包的描述");
  });

  it("ignores malformed or blank whenToUse instead of losing the whole line", () => {
    const text = formatEnabledSkillCatalog([
      { ...ready("probe", "描述回退"), metadata: { loomic: { schemaVersion: 1, whenToUse: "未通过校验" } } },
      { ...ready("blank", "空文本回退"), ...loomic("   ") },
      { ...ready("plain", "纯描述"), metadata: undefined },
      // Longer than the contract's bound, so the reader rejects it as malformed and
      // the line falls back to the description rather than showing a 400+ char line.
      { ...ready("overlong", "超长回退"), ...loomic("很长的选择文本".repeat(60)) },
    ]);
    expect(text).toContain("- probe: 描述回退");
    expect(text).toContain("- blank: 空文本回退");
    expect(text).toContain("- plain: 纯描述");
    expect(text).toContain("- overlong: 超长回退");
  });

  it("truncates one verbose line and never forges extra catalog lines", () => {
    // Contract-valid (<= 400 chars) but longer than the display bound, which is the
    // only way this path is reachable: an over-long value never gets this far.
    const verbose = `${"很长的选择文本".repeat(40)}\n- injected: 伪行`;
    const text = formatEnabledSkillCatalog([{ ...ready("verbose", "描述"), ...loomic(verbose) }]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]!.endsWith("…")).toBe(true);
    expect(lines[2]!.slice("- verbose: ".length)).toHaveLength(SKILL_CATALOG_SELECTION_MAX_CHARS);
  });

  it("stays inside the catalog byte budget and drops only the overflow", () => {
    const bytes = (value: string) => Buffer.byteLength(value, "utf8");
    // An ordinary catalogue fits whole: the budget must not shorten real lines.
    const ordinary = Array.from({ length: 40 }, (_value, index) =>
      ({ ...ready(`skill-${index}`, "描述", `技能 ${index}`), ...loomic("用户明确需要该技能时使用；其他情况不使用。") }));
    const ordinaryText = formatEnabledSkillCatalog(ordinary, 40);
    expect(bytes(ordinaryText)).toBeLessThanOrEqual(SKILL_CATALOG_MAX_BYTES);
    // Two header lines plus every skill line: "fits whole" means no line was dropped.
    expect(ordinaryText.split("\n")).toHaveLength(2 + 40);

    // A runaway third-party catalogue is bounded: the excess lines are dropped.
    const runaway = Array.from({ length: 40 }, (_value, index) =>
      ({ ...ready(`skill-${index}`, "描述"), ...loomic("用户明确需要该技能时使用。".repeat(20)) }));
    const runawayText = formatEnabledSkillCatalog(runaway, 40);
    expect(bytes(runawayText)).toBeLessThanOrEqual(SKILL_CATALOG_MAX_BYTES);
    const lines = runawayText.split("\n");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.length).toBeLessThan(2 + 40);
  });
});
