import { describe, expect, it } from "vitest";
import type { MessageMention } from "@loomic/shared";

import { classifyDesignTurnIntent, explainPrimarySkillSelection, extractStyleHints, extractTargetSizes, matchedSkillHints, mergeStyleHints, selectHelperSkills, selectPrimarySkill, shouldReplaceSessionSeries } from "./design-turn-intent.js";

const skillMention = (slug: string): MessageMention => ({ mentionType: "skill", id: slug, label: slug, slug });

const route = (name: string, priority: number, keywords: string[]) =>
  ({ name, metadata: { loomic: { routing: { keywords, priority } } } });
/** Mirrors the real `metadata.loomic.routing` blocks in the skill manifests. */
const routingSkills = [
  route("logo-design", 60, ["logo", "字标", "图形标记", "图形标志", "商标", "wordmark", "brand mark", "brandmark", "品牌标志", "标志设计"]),
  route("social-carousel", 50, ["轮播", "多页", "多图", "九宫格", "carousel", "slides", "slide"]),
  route("series-visual-design", 40, ["系列", "多张", "一套", "整套", "series"]),
  route("product-visual", 30, ["商品", "产品", "主图", "ecommerce", "product image", "product shot", "product visual"]),
  route("game-promo-visuals", 20, ["游戏", "棋牌", "抽奖", "礼包", "充值", "bonus", "jackpot", "casino", "game promo", "game event"]),
  route("campaign-design", 10, ["活动", "促销", "海报", "宣传", "推广", "banner", "poster", "promo", "cover", "key visual", "主视觉"]),
];
const select = (prompt: string, mentions: MessageMention[] = []) =>
  selectPrimarySkill({ prompt, mentions, skills: routingSkills });

/** Helper tier: modifiers of a deliverable, declared with tier: "helper". */
const helperRoute = (name: string, keywords: string[]) =>
  ({ name, metadata: { loomic: { routing: { keywords, priority: 0, tier: "helper" } } } });
const helperSkills = [
  helperRoute("background-removal", ["去背景", "去掉背景", "背景去掉", "透明底", "抠图"]),
  helperRoute("design-copywriting", ["文案", "写文案", "标题文案"]),
  helperRoute("design-review", ["评审", "点评"]),
  helperRoute("json-image-prompt", ["提示词", "生图提示"]),
];
const allSkills = [...routingSkills, ...helperSkills];
const selectHelpers = (prompt: string, max?: number) =>
  selectHelperSkills({ prompt, skills: allSkills, ...(max !== undefined ? { max } : {}) });
const selectAny = (prompt: string) => selectPrimarySkill({ prompt, mentions: [], skills: allSkills });

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

  it("keeps an explanatory question out of remembered state even when it names an action verb", () => {
    // Regression: these used to classify as `new_generation`, which preloaded a
    // Skill and replaced the session series from a question.
    for (const prompt of [
      "怎么生成一张高质量的海报？",
      "如何设计一个专业的 logo",
      "为什么这个配色看起来不高级",
      "生成一张海报需要多久",
    ]) {
      expect(classify(prompt, { hasSeries: true }), prompt).toBe("non_design");
    }
    // A permission request is still a request, not an informational question.
    expect(classify("能不能帮我生成一张海报")).toBe("new_generation");
  });

  it("recognizes a bare deliverable brief that has no action verb", () => {
    // Regression: "游戏活动的产品主图" used to stay non_design, so the server
    // neither routed a Skill nor captured the series.
    expect(classify("游戏活动的产品主图")).toBe("new_generation");
    expect(classify("夏日促销主视觉")).toBe("new_generation");
    // An edit verb still outranks the deliverable noun.
    expect(classify("把海报上的文字改成蓝色")).toBe("local_edit");
    // An interrogative mention of the deliverable stays informational.
    expect(classify("这个海报怎么样")).toBe("non_design");
  });

  it("treats a hedged negation as discussion rather than a generation request", () => {
    expect(classify("别急着生成，我们先讨论一下方向")).toBe("non_design");
    expect(classify("先讨论一下方向再决定")).toBe("non_design");
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

  it("scores corroborating and specific keywords above one incidental generic hit", () => {
    // Regression: priority-first-hit routed this to logo-design (priority 60)
    // even though three keywords point at campaign-design.
    expect(select("海报上放我们的 logo，做一个活动主视觉")).toBe("campaign-design");
    // A specific keyword outweighs a short generic one on score.
    expect(select("做一个游戏活动的宣传海报")).toBe("campaign-design");
    // Priority still breaks an exact score tie.
    expect(select("做个logo")).toBe("logo-design");
  });
});

describe("selectHelperSkills", () => {
  it("preloads a matching helper for the turn's own words", () => {
    // Regression: this used to route nothing at all, so the background-removal
    // guide only reached the model if it discovered it by itself.
    expect(selectHelpers("把这张图的背景去掉")).toEqual(["background-removal"]);
    expect(selectHelpers("写一句海报文案")).toEqual(["design-copywriting"]);
  });

  it("never lets a helper take the primary deliverable slot", () => {
    // A prompt carrying only helper keywords has no deliverable, so it must not
    // be promoted to a primary Skill just because a helper matched.
    expect(selectAny("把这张图的背景去掉")).toBeUndefined();
    expect(selectAny("写一句文案")).toBeUndefined();
    // A real deliverable still wins the primary slot while helpers ride along.
    expect(selectAny("做一张活动海报，写一句文案")).toBe("campaign-design");
    expect(selectHelpers("做一张活动海报，写一句文案")).toEqual(["design-copywriting"]);
  });

  it("caps how many helpers one prompt can pull in", () => {
    const crowded = "做一张海报，写文案，再点评一下，顺便优化提示词";
    expect(selectHelpers(crowded)).toHaveLength(2);
    expect(selectHelpers(crowded, 1)).toHaveLength(1);
    expect(selectHelpers(crowded, 4).length).toBeGreaterThanOrEqual(3);
  });

  it("returns nothing when no helper matches", () => {
    expect(selectHelpers("生成一张促销海报")).toEqual([]);
    expect(selectHelpers("你好呀")).toEqual([]);
  });

  it("resolves helpers independently of the turn label", () => {
    // A review or prompt-optimisation request classifies as non_design yet still
    // needs its guide, so helper resolution cannot be gated on the turn label.
    expect(classify("帮我评审一下这版设计")).toBe("non_design");
    expect(selectHelpers("帮我评审一下这版设计")).toEqual(["design-review"]);
    expect(selectHelpers("优化一下提示词")).toEqual(["json-image-prompt"]);
  });
});

describe("keyword matching", () => {
  /** Score and evidence for one prompt against a purpose-built route set. */
  const match = (prompt: string, keywords: string[]) => {
    const selection = explainPrimarySkillSelection({ prompt, mentions: [], skills: [route("probe", 1, keywords)] });
    return selection ? { score: selection.score, keywords: selection.keywords } : undefined;
  };

  it("matches an ASCII keyword on word boundaries, not inside a longer word", () => {
    // Regression: campaign-design declares the bare `cover`, and a plain
    // `includes` matched it inside "recover" / "discover" / "coverage", so a
    // request to recover an earlier design preloaded the campaign guide.
    expect(match("帮我 recover 上一版的设计", ["cover"])).toBeUndefined();
    expect(match("discover a new direction", ["cover"])).toBeUndefined();
    expect(match("improve the coverage", ["cover"])).toBeUndefined();
    // A real standalone occurrence still matches, including next to Chinese.
    expect(match("做一个cover图", ["cover"])).toEqual({ score: 5, keywords: ["cover"] });
  });

  it("accepts ordinary English plurals without accepting longer words", () => {
    expect(match("做三张 posters", ["poster"])).toEqual({ score: 6, keywords: ["poster"] });
    expect(match("给我几个 logos", ["logo"])).toEqual({ score: 4, keywords: ["logo"] });
    // One trailing `s` only: a longer tail is a different word.
    expect(match("posterity", ["poster"])).toBeUndefined();
  });

  it("counts a nested keyword once instead of crediting the same occurrence twice", () => {
    // Regression: a manifest declaring both `poster` and `posters` was credited
    // for each, so redundant declarations outranked a Skill that genuinely
    // matched more. Only the longest matched form is kept.
    expect(match("做三张 posters", ["poster", "posters"])).toEqual({ score: 7, keywords: ["posters"] });
    expect(match("logo", ["logo", "logotype"])).toEqual({ score: 4, keywords: ["logo"] });
    expect(match("logotype", ["logo", "logotype"])).toEqual({ score: 8, keywords: ["logotype"] });
  });

  it("drops the ASCII false positive from the real manifest set", () => {
    // The whole point: the incidental hit used to win the deliverable slot.
    expect(select("帮我 recover 一下上一版")).toBeUndefined();
    expect(select("discover a direction")).toBeUndefined();
    // Real matches and priority tie-breaks are untouched.
    expect(select("做三张 posters")).toBe("campaign-design");
    expect(select("给我几个 logos")).toBe("logo-design");
  });

  it("leaves CJK substring matching alone, where there is no word boundary", () => {
    expect(match("写一句标题文案", ["文案", "标题文案"])).toEqual({ score: 4, keywords: ["标题文案"] });
    expect(selectHelpers("把这张图的背景去掉")).toEqual(["background-removal"]);
  });
});

describe("matchedSkillHints — candidates, not a selection", () => {
  const hints = (prompt: string, mentions: MessageMention[] = [], max?: number) =>
    matchedSkillHints({ prompt, mentions, skills: allSkills, ...(max !== undefined ? { max } : {}) });
  const slugs = (prompt: string, mentions: MessageMention[] = []) => hints(prompt, mentions).map(hint => hint.skill);

  it("lists EVERY matching Skill instead of picking one winner", () => {
    // Preloading is gone, so a ranking has nothing left to decide. Both Skills the
    // words point at are reported; the model decides what to read.
    expect(slugs("做一张活动海报，配成轮播")).toEqual(["campaign-design", "social-carousel"]);
  });

  it("does not let declared priority reorder or add candidates", () => {
    // logo-design declares priority 60 and campaign-design 10. Membership and order
    // must come from the words and the slug, never from a competitive ranking.
    expect(slugs("做一个 logo 加活动海报")).toEqual(["campaign-design", "logo-design"]);
    const reversed = matchedSkillHints({ prompt: "做一个 logo 加活动海报", mentions: [],
      skills: [...allSkills].reverse() }).map(hint => hint.skill);
    expect(reversed).toEqual(["campaign-design", "logo-design"]);
  });

  it("puts a Skill the user NAMED first and flags it as their choice", () => {
    const result = hints("做一张活动海报", [skillMention("logo-design")]);
    expect(result[0]).toMatchObject({ skill: "logo-design", mentioned: true, keywords: [] });
    expect(result[1]).toMatchObject({ skill: "campaign-design", mentioned: false });
    expect(result[1]!.keywords).toContain("海报");
  });

  it("keeps helper-tier candidates in the same set, distinguished by tier", () => {
    const result = hints("做一张活动海报，写一句文案");
    expect(result.map(hint => [hint.skill, hint.tier])).toEqual([
      ["campaign-design", "primary"], ["design-copywriting", "helper"],
    ]);
  });

  it("bounds the candidate list and reports nothing when nothing matches", () => {
    expect(hints("做一张活动海报，写文案，再来个轮播", [], 2)).toHaveLength(2);
    expect(slugs("你好呀")).toEqual([]);
  });
});

describe("shouldReplaceSessionSeries", () => {
  it("only lets a real design write replace the remembered series", () => {
    expect(shouldReplaceSessionSeries({ designIntent: "new_generation", performedDesignWrite: true })).toBe(true);
    // A misclassified turn that generated nothing must not wipe user context.
    expect(shouldReplaceSessionSeries({ designIntent: "new_generation", performedDesignWrite: false })).toBe(false);
    expect(shouldReplaceSessionSeries({ designIntent: "local_edit", performedDesignWrite: true })).toBe(false);
    expect(shouldReplaceSessionSeries({ designIntent: "non_design", performedDesignWrite: true })).toBe(false);
    // Continuations merge in place and never take the replace branch.
    expect(shouldReplaceSessionSeries({ designIntent: "series_continuation", performedDesignWrite: true })).toBe(false);
  });
});

describe("extractTargetSizes", () => {
  it("captures pixel and ratio targets", () => {
    expect(extractTargetSizes("目标宽高 656×288")).toEqual(["656:288"]);
    expect(extractTargetSizes("做成 1200:628 的横幅")).toEqual(["1200:628"]);
    // Size wording makes a small colon pair unambiguous.
    expect(extractTargetSizes("比例 16:9")).toEqual(["16:9"]);
    expect(extractTargetSizes("做成 9:16 竖版")).toEqual(["9:16"]);
    // Numbers this large cannot be a clock time.
    expect(extractTargetSizes("尺寸 1080:1920")).toEqual(["1080:1920"]);
  });

  it("never reads a clock time as an output size", () => {
    // Regression: these sedimented into the session series as fake dimensions.
    expect(extractTargetSizes("会议 10:30 开始")).toEqual([]);
    expect(extractTargetSizes("下午 14:00 之前给我")).toEqual([]);
    expect(extractTargetSizes("每天 9:00 发一条")).toEqual([]);
    // A time and a real size in one turn: only the size survives.
    expect(extractTargetSizes("10:30 前给我，尺寸 1200:628")).toEqual(["1200:628"]);
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

  it("records a style the user names, without it being in any table", () => {
    // Regression: the curated list was the GATE, so a real style the list had
    // never heard of was dropped from the series and the next "继续" lost it.
    expect(extractStyleHints("做成莫兰迪色系的主图")).toBe("莫兰迪");
    expect(extractStyleHints("走包豪斯风格")).toBe("包豪斯");
    expect(extractStyleHints("高级灰调性")).toBe("高级灰");
    expect(extractStyleHints("孟菲斯风")).toBe("孟菲斯");
    // A curated hit and a user-named style combine.
    expect(extractStyleHints("做成莫兰迪色系、极简风格的主图")).toBe("极简、莫兰迪");
  });

  it("never lets the label pass swallow the request or read a plain noun as a style", () => {
    // A directive in front of the label is scaffolding, not part of the style, and
    // a capture that still contains one is rejected rather than recorded.
    expect(extractStyleHints("给我来三版莫兰迪色系的主图")).toBe("莫兰迪");
    expect(extractStyleHints("换个风格")).toBeUndefined();
    expect(extractStyleHints("做一个详细的落地页")).toBeUndefined();
    // Plain nouns that merely end in a style label are not styles.
    expect(extractStyleHints("台风天要发的海报")).toBeUndefined();
    expect(extractStyleHints("龙卷风天气的宣传图")).toBeUndefined();
    expect(extractStyleHints("屏风产品的主图")).toBeUndefined();
    // No overlap collapse: three curated tokens stay three.
    expect(extractStyleHints("高端奢华黑金风格")).toBe("高端、奢华、黑金");
  });
});

describe("edit label vocabulary is unchanged by the deferral", () => {
  it("keeps `local_edit` for a weak verb and for a real change alike", () => {
    // Fix ① changes DECISIVENESS (needsModel/confidence), never the published
    // label: `assessDesignTurnIntent` still answers `local_edit` for a bare
    // generic verb, which is also what a classifier outage falls back to. The
    // `edit_verb` rule and the broad `EDIT_PATTERN` are untouched — see
    // `design-turn-intent-classifier.test.ts` for the confidence/model boundary.
    for (const prompt of [
      "改天再说", "改主意了",
      "帮我把标题改成蓝色", "把背景改成白色", "把标题改一下", "调整一下颜色", "把海报上的文字改成蓝色",
    ]) {
      expect(classify(prompt), prompt).toBe("local_edit");
    }
  });
});
