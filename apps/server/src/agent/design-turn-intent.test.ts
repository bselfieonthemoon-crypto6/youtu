import { describe, expect, it } from "vitest";
import type { MessageMention } from "@loomic/shared";

import { classifyDesignTurnIntent, extractStyleHints, extractTargetSizes, mergeStyleHints, selectPrimarySkill } from "./design-turn-intent.js";

const skillMention = (slug: string): MessageMention => ({ mentionType: "skill", id: slug, label: slug, slug });

const route = (name: string, priority: number, keywords: string[]) =>
  ({ name, metadata: { loomic: { routing: { keywords, priority } } } });
const routingSkills = [
  route("logo-design", 60, ["logo", "字标", "图形标记", "商标", "wordmark", "brand mark"]),
  route("social-carousel", 50, ["轮播", "多页", "多图", "九宫格", "carousel"]),
  route("series-visual-design", 40, ["系列", "多张", "一套"]),
  route("product-visual", 30, ["商品", "产品", "主图"]),
  route("game-promo-visuals", 20, ["游戏", "棋牌", "抽奖", "礼包", "充值", "bonus", "casino"]),
  route("campaign-design", 10, ["活动", "促销", "海报", "宣传", "banner", "poster"]),
];
const select = (prompt: string, mentions: MessageMention[] = []) =>
  selectPrimarySkill({ prompt, mentions, skills: routingSkills });

function classify(prompt: string, options: { mentions?: MessageMention[]; activeSkill?: string | null; hasSeries?: boolean } = {}) {
  return classifyDesignTurnIntent({ prompt, mentions: options.mentions ?? [], activeSkill: options.activeSkill ?? null,
    hasSeries: options.hasSeries ?? false, hasAttachments: false });
}

describe("classifyDesignTurnIntent", () => {
  it("treats an explicit Skill mention as a new generation", () => {
    expect(classify("帮我弄一下这个", { mentions: [skillMention("logo-design")] })).toBe("new_generation");
  });

  it("recognizes explicit creation requests", () => {
    for (const prompt of ["设计一个logo", "做一张活动海报", "生成一张促销横幅", "重新做一版"]) {
      expect(classify(prompt), prompt).toBe("new_generation");
    }
  });

  it("recognizes local edits without treating them as new generations", () => {
    for (const prompt of ["把标题的字改一下", "换个背景颜色", "把 logo 放大一点", "去掉边框"]) {
      expect(classify(prompt), prompt).toBe("local_edit");
    }
  });

  it("continues a series only when one is remembered", () => {
    expect(classify("再来一张，换个主题", { hasSeries: true })).toBe("series_continuation");
    expect(classify("还是这个风格再来一版", { hasSeries: true })).toBe("series_continuation");
    expect(classify("再来一张", { hasSeries: false })).toBe("new_generation");
  });

  it("treats a direction change on a live series as a continuation", () => {
    expect(classify("换成海洋风格", { hasSeries: true })).toBe("series_continuation");
    expect(classify("把配色改成冷色调", { hasSeries: true })).toBe("series_continuation");
    expect(classify("换成海洋风格", { hasSeries: false })).toBe("new_generation");
  });

  it("treats an element/subject re-roll as a continuation, not a property edit", () => {
    expect(classify("换个元素和主体", { hasSeries: true })).toBe("series_continuation");
    expect(classify("换个角色再来一版", { hasSeries: true })).toBe("series_continuation");
    expect(classify("换个元素和主体", { hasSeries: false })).toBe("new_generation");
    expect(classify("换个背景颜色", { hasSeries: true })).toBe("local_edit");
  });

  it("keeps negation and pure questions out of remembered state", () => {
    expect(classify("先不要生成，我们讨论一下")).toBe("non_design");
    expect(classify("这个大概要花多少钱")).toBe("non_design");
  });

  it("never lets a remembered skill turn an edit into generation", () => {
    expect(classify("把这张图的文字改掉", { activeSkill: "game-promo-visuals", hasSeries: true })).toBe("local_edit");
  });

  it("treats an explicit reset as a fresh series even with continuation words", () => {
    for (const prompt of ["重开，换个风格", "不要沿用之前的偏好", "新的系列，再来一张"]) {
      expect(classify(prompt, { hasSeries: true }), prompt).toBe("new_generation");
    }
  });

  it("keeps a continuation that only states a new size as continuation", () => {
    expect(classify("还是这个风格，做成 1200×628", { hasSeries: true })).toBe("series_continuation");
  });

  it("treats a factual answer to a pending clarification as a new generation", () => {
    const pending = (prompt: string) => classifyDesignTurnIntent({ prompt, mentions: [], activeSkill: "logo-design",
      hasSeries: true, hasAttachments: false, clarificationPending: true });
    expect(pending("品牌名称：aaaa 咖啡；用途：店面招牌；风格：简约现代")).toBe("new_generation");
    expect(pending("简约现代，黑白配色")).toBe("new_generation");
    expect(pending("这个大概多少钱")).toBe("non_design");
    expect(pending("先别生成")).toBe("non_design");
  });
});

describe("selectPrimarySkill", () => {
  it("prefers the explicit mention over keywords", () => {
    expect(select("做一张活动海报", [skillMention("logo-design")])).toBe("logo-design");
  });

  it("routes explicit deliverables to their primary Skill by manifest priority", () => {
    expect(select("设计一个咖啡品牌的logo")).toBe("logo-design");
    expect(select("做一张小红书轮播图")).toBe("social-carousel");
    expect(select("做一套五张的产品物料")).toBe("series-visual-design");
    expect(select("做商品主图")).toBe("product-visual");
    expect(select("做一个游戏充值活动图")).toBe("game-promo-visuals");
    expect(select("做一张促销海报")).toBe("campaign-design");
  });

  it("returns nothing when no Skill declares a matching keyword", () => {
    expect(select("你好")).toBeUndefined();
  });
});

describe("extractTargetSizes", () => {
  it("captures pixel and ratio targets", () => {
    expect(extractTargetSizes("目标宽高 656×288")).toEqual(["656:288"]);
    expect(extractTargetSizes("做成 1200:628 的横幅")).toEqual(["1200:628"]);
  });
});

describe("extractStyleHints", () => {
  it("keeps deterministic style and colour descriptors from the user's words", () => {
    expect(extractStyleHints("高端奢华黑金风格，暗黑质感")).toBe("高端、奢华、黑金、暗黑、质感");
    expect(extractStyleHints("简单的蓝色清新风")).toContain("清新");
    expect(extractStyleHints("换成海洋风格")).toBe("海洋");
    expect(extractStyleHints("做个海报")).toBeUndefined();
    expect(mergeStyleHints("高端、奢华", "海洋")).toBe("高端、奢华、海洋");
    expect(mergeStyleHints(undefined, "海洋")).toBe("海洋");
    expect(mergeStyleHints("高端、海洋", "海洋")).toBe("高端、海洋");
  });
});
