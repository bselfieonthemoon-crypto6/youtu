import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { classifyDesignTurnIntent, matchedSkillHints, type SkillRouteSource } from "./design-turn-intent.js";

const skillRoot = new URL("../../../../skills/", import.meta.url);

/** Routing is manifest-declared, so the eval runs against the real packages. */
async function loadRoutingSkills(): Promise<SkillRouteSource[]> {
  const entries = await readdir(skillRoot, { withFileTypes: true });
  const skills: SkillRouteSource[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(new URL(`${entry.name}/manifest.json`, skillRoot), "utf8")) as
        { slug?: unknown; metadata?: Record<string, unknown> };
      if (manifest.slug === entry.name && manifest.metadata && typeof manifest.metadata === "object")
        skills.push({ name: entry.name, metadata: manifest.metadata });
    } catch {
      // Directory without a manifest is not a Skill package.
    }
  }
  return skills;
}

/**
 * Deterministic intent -> deliverable CANDIDATE evaluation set. No model call is made.
 *
 * The runtime no longer picks a winner — selection belongs to the model, which reads
 * the catalog — so these cases assert the property a Skill package has to get right to
 * be reachable at all: its own declared keywords fire for the requests it is for, and it
 * therefore appears in the candidate set. Extend the table when a new package is added.
 */
const ROUTING_CASES: ReadonlyArray<{ prompt: string; skill: string }> = [
  { prompt: "设计一个咖啡品牌的logo", skill: "logo-design" },
  { prompt: "帮我做个字标，简单一点", skill: "logo-design" },
  { prompt: "design a brand mark for a casino", skill: "logo-design" },
  { prompt: "做一张小红书轮播图", skill: "social-carousel" },
  { prompt: "做个九宫格介绍页", skill: "social-carousel" },
  { prompt: "做一套五张的物料", skill: "series-visual-design" },
  { prompt: "做一个系列海报", skill: "series-visual-design" },
  { prompt: "做商品主图", skill: "product-visual" },
  { prompt: "来一张产品场景图", skill: "product-visual" },
  { prompt: "做一个游戏充值活动图", skill: "game-promo-visuals" },
  { prompt: "生成 casino bonus 图片", skill: "game-promo-visuals" },
  { prompt: "做一张促销海报", skill: "campaign-design" },
  { prompt: "做一个活动 banner", skill: "campaign-design" },
];

const NO_ROUTE_CASES = ["你好", "帮我把这段文字翻译成英文", "先不要生成，我们讨论一下"];

const INTENT_CASES: ReadonlyArray<{ prompt: string; hasSeries: boolean; intent: string }> = [
  { prompt: "设计一个logo", hasSeries: false, intent: "new_generation" },
  { prompt: "做一张活动海报", hasSeries: false, intent: "new_generation" },
  { prompt: "生成一张促销横幅", hasSeries: false, intent: "new_generation" },
  { prompt: "再来一张", hasSeries: false, intent: "new_generation" },
  { prompt: "再来一张，换个主题", hasSeries: true, intent: "series_continuation" },
  { prompt: "还是这个风格再来一版", hasSeries: true, intent: "series_continuation" },
  { prompt: "继续", hasSeries: true, intent: "series_continuation" },
  { prompt: "重开，换个风格", hasSeries: true, intent: "new_generation" },
  { prompt: "不要沿用之前的偏好", hasSeries: true, intent: "new_generation" },
  { prompt: "把标题的字改一下", hasSeries: true, intent: "local_edit" },
  { prompt: "换个背景颜色", hasSeries: true, intent: "local_edit" },
  { prompt: "把 logo 放大一点", hasSeries: true, intent: "local_edit" },
  { prompt: "先不要生成", hasSeries: false, intent: "non_design" },
  { prompt: "这个大概要花多少钱", hasSeries: false, intent: "non_design" },
];

const candidatesFor = async (prompt: string) =>
  matchedSkillHints({ prompt, mentions: [], skills: await loadRoutingSkills() });

describe("design skill candidate evaluation set", () => {
  it("surfaces the expected deliverable Skill, through its own declared keywords", async () => {
    for (const { prompt, skill } of ROUTING_CASES) {
      const match = (await candidatesFor(prompt)).find(hint => hint.skill === skill);
      expect(match, `${prompt} → ${skill}`).toBeDefined();
      // The candidate surfaced because the package's OWN declaration fired, which is
      // the property a newly added package has to get right to be reachable.
      expect(match!.keywords.length, prompt).toBeGreaterThan(0);
    }
  });

  it("surfaces every Skill the words point at instead of hiding all but one", async () => {
    // "做一个游戏充值活动图" reaches two packages — the campaign guide (活动) and the
    // game-promo guide (游戏/充值). A ranking used to report only its winner, so the
    // model was never told the other applicable guide existed.
    expect((await candidatesFor("做一个游戏充值活动图")).map(hint => hint.skill).sort())
      .toEqual(["campaign-design", "game-promo-visuals"]);
  });

  it("surfaces nothing for a non-deliverable request, and puts a named Skill first", async () => {
    const skills = await loadRoutingSkills();
    for (const prompt of NO_ROUTE_CASES)
      expect(matchedSkillHints({ prompt, mentions: [], skills }).map(hint => hint.skill), prompt).toEqual([]);
    const named = matchedSkillHints({ prompt: "你好", mentions: [{ mentionType: "skill", id: "logo-design",
      label: "logo-design", slug: "logo-design" }], skills });
    expect(named[0]).toMatchObject({ skill: "logo-design", mentioned: true });
  });

  it("classifies turns so remembered state is applied or reset correctly", () => {
    for (const { prompt, hasSeries, intent } of INTENT_CASES) {
      expect(classifyDesignTurnIntent({ prompt, mentions: [], activeSkill: null, hasSeries, hasAttachments: false }), prompt)
        .toBe(intent);
    }
  });
});
