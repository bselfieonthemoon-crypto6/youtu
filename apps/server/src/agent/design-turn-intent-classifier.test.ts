import { describe, expect, it, vi } from "vitest";

import {
  assessDesignTurnIntent,
  classifyDesignTurnIntent,
  designTurnIntentClassifierSchema,
  describeDesignRouting,
  resolveDesignTurnIntent,
  shouldReplaceSessionSeries,
  type DesignTurnIntentClassifier,
} from "./design-turn-intent.js";

// Genuine conflict: a creation verb AND an edit verb in one turn. The fixed
// regex precedence would silently pick creation, so this is a model case.
const CREATE_AND_EDIT = "做一版活动海报，把标题文字改成蓝色";
// Creation verb plus a hedged negation: the regex says non_design by precedence.
const HEDGED_NEGATION = "别急着生成，我们先讨论一下方向";
// Nothing at all matched, which is the second "genuinely uncertain" case.
const NO_RULE = "嗯……让我再想想";

const classifierReturning = (reply: unknown): DesignTurnIntentClassifier =>
  vi.fn(async () => reply);

function resolve(prompt: string, classifier?: DesignTurnIntentClassifier) {
  return resolveDesignTurnIntent({
    prompt, mentions: [], activeSkill: null, hasSeries: false, hasAttachments: false,
    ...(classifier ? { classifier } : {}),
    signal: new AbortController().signal,
  });
}

describe("assessDesignTurnIntent — deterministic pre-filter", () => {
  it("marks a confidently resolved turn as needing no model call", () => {
    for (const prompt of ["做一张活动海报", "设计一个logo", "把标题的字改一下", "怎么生成一张海报？", "先别做，我们讨论一下"]) {
      const assessment = assessDesignTurnIntent({ prompt, mentions: [], activeSkill: null,
        hasSeries: false, hasAttachments: false });
      expect(assessment.needsModel, prompt).toBe(false);
      expect(assessment.rules.length, prompt).toBeGreaterThan(0);
    }
  });

  it("marks the two genuinely uncertain shapes as needing a model call", () => {
    // A creation signal and an edit signal both fired.
    expect(assessDesignTurnIntent({ prompt: CREATE_AND_EDIT, mentions: [], activeSkill: null,
      hasSeries: false, hasAttachments: false }))
      .toMatchObject({ intent: "new_generation", rule: "generation_verb", needsModel: true,
        rules: expect.arrayContaining(["generation_verb", "edit_verb"]) });
    // A creation signal and a negation signal both fired.
    expect(assessDesignTurnIntent({ prompt: HEDGED_NEGATION, mentions: [], activeSkill: null,
      hasSeries: false, hasAttachments: false }))
      .toMatchObject({ intent: "non_design", rule: "hedged_negation", needsModel: true,
        rules: expect.arrayContaining(["hedged_negation", "generation_verb"]) });
    // No rule matched at all. This deliberately includes small talk: the spec
    // accepts one cheap call rather than guessing on an unmatched turn, and the
    // verdict is clamped to a routing hint either way.
    expect(assessDesignTurnIntent({ prompt: NO_RULE, mentions: [], activeSkill: null,
      hasSeries: false, hasAttachments: false }))
      .toMatchObject({ intent: "non_design", rule: "no_rule", needsModel: true });
    expect(assessDesignTurnIntent({ prompt: "你好呀", mentions: [], activeSkill: null,
      hasSeries: false, hasAttachments: false }))
      .toMatchObject({ intent: "non_design", rule: "no_rule", needsModel: true });
    // A pending clarification with a factual answer is a weak default, not a rule.
    expect(assessDesignTurnIntent({ prompt: "简约现代，黑白配色", mentions: [], activeSkill: null,
      hasSeries: false, hasAttachments: false, clarificationPending: true }))
      .toMatchObject({ intent: "new_generation", rule: "clarification_default", needsModel: true });
  });

  it("keeps the deterministic label identical to the published classifier", () => {
    const prompts = ["做一张活动海报", CREATE_AND_EDIT, HEDGED_NEGATION, NO_RULE, "再来一张", "先别做，我们讨论一下"];
    for (const prompt of prompts) {
      const input = { prompt, mentions: [], activeSkill: null, hasSeries: true, hasAttachments: false };
      expect(assessDesignTurnIntent(input).intent, prompt).toBe(classifyDesignTurnIntent(input));
    }
  });

  it("never lets a negation alone reach the model", () => {
    // No creation/edit verb accompanies it, so the hard floor is already decided.
    expect(assessDesignTurnIntent({ prompt: "先别做，我们讨论一下", mentions: [], activeSkill: null,
      hasSeries: false, hasAttachments: false }))
      .toMatchObject({ intent: "non_design", rule: "hedged_negation", needsModel: false });
  });
});

describe("resolveDesignTurnIntent — model stage", () => {
  it("does not spend a model call when the regex resolved the turn confidently", async () => {
    const classifier = classifierReturning({ intent: "non_design", reasonCode: "unclear", confidence: 1 });
    for (const prompt of ["做一张活动海报", "怎么生成一张高质量的海报？", "先别做，我们讨论一下", "把标题的字改一下"]) {
      const resolution = await resolve(prompt, classifier);
      expect(classifier, prompt).not.toHaveBeenCalled();
      expect(resolution.source, prompt).toBe("deterministic");
      expect(resolution.intent, prompt).toBe(classifyDesignTurnIntent({ prompt, mentions: [],
        activeSkill: null, hasSeries: false, hasAttachments: false }));
    }
  });

  it("uses the model verdict for an uncertain turn and reports why", async () => {
    const classifier = classifierReturning({ intent: "local_edit", reasonCode: "property_edit", confidence: 0.72 });
    const resolution = await resolve(CREATE_AND_EDIT, classifier);
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(resolution).toMatchObject({ intent: "local_edit", reasonCode: "property_edit",
      confidence: 0.72, source: "model", clamped: false });
    // The deterministic verdict is reported alongside for logging/telemetry.
    expect(resolution.assessment).toMatchObject({ rule: "generation_verb", needsModel: true });
  });

  it("sends only the current request and never the deterministic verdict", async () => {
    const classifier = vi.fn(async () => ({ intent: "new_generation", reasonCode: "explicit_creation", confidence: 0.5 }));
    await resolveDesignTurnIntent({ prompt: CREATE_AND_EDIT, mentions: [], activeSkill: "campaign-design",
      hasSeries: true, hasAttachments: true, classifier, signal: new AbortController().signal });
    const payload = classifier.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      policyVersion: "mastra-design-turn-intent-v1",
      currentRequest: CREATE_AND_EDIT,
      remembered: { activeSkill: "campaign-design", hasSeries: true },
      hasAttachments: true,
      clarificationPending: false,
    });
    // Withholding the regex verdict is deliberate: it must not anchor the model.
    expect(payload).not.toHaveProperty("deterministicIntent");
    expect(payload).not.toHaveProperty("rule");
    expect(JSON.stringify(payload)).not.toContain("generation_verb");
  });

  it("falls back to the regex verdict when the classifier throws, times out or answers invalidly", async () => {
    const throwing = vi.fn(async () => { throw new Error("classifier outage"); });
    const invalid = classifierReturning({ intent: "not_a_label", reasonCode: "nope", confidence: 7 });
    const hanging = vi.fn(() => new Promise(() => {}));
    // Schema-valid but self-contradictory: the notice shows label and reason
    // together, so this is not a usable verdict either.
    const contradictory = classifierReturning({ intent: "new_generation", reasonCode: "declined_or_hedged", confidence: 0.9 });
    const outcomes = await Promise.all([
      resolve(CREATE_AND_EDIT, throwing),
      resolve(CREATE_AND_EDIT, invalid),
      resolve(CREATE_AND_EDIT, contradictory),
      resolveDesignTurnIntent({ prompt: CREATE_AND_EDIT, mentions: [], activeSkill: null, hasSeries: false,
        hasAttachments: false, classifier: hanging, signal: new AbortController().signal, timeoutMs: 25 }),
      // No classifier available at all is the same fallback, not a failure.
      resolve(CREATE_AND_EDIT),
    ]);
    for (const resolution of outcomes) {
      expect(resolution).toMatchObject({ intent: "new_generation", reasonCode: "explicit_creation", source: "fallback" });
    }
  });

  it("keeps a hedged negation out of new_generation even when the model disagrees", async () => {
    const classifier = classifierReturning({ intent: "new_generation", reasonCode: "explicit_creation", confidence: 0.9 });
    const resolution = await resolve(HEDGED_NEGATION, classifier);
    // The model refined, but the safety floor overrode the label.
    expect(resolution).toMatchObject({ intent: "non_design", reasonCode: "declined_or_hedged", source: "model", clamped: true });
  });

  it("lets the model refine a declined turn into a concrete edit", async () => {
    const prompt = "不要重新做一版，把颜色改成蓝色";
    const classifier = classifierReturning({ intent: "local_edit", reasonCode: "property_edit", confidence: 0.8 });
    const resolution = await resolve(prompt, classifier);
    expect(resolution).toMatchObject({ intent: "local_edit", source: "model", clamped: false });
  });

  it("honours the turn's abort signal instead of returning a fallback", async () => {
    const controller = new AbortController();
    const classifier = vi.fn(() => new Promise(() => {}));
    const pending = resolveDesignTurnIntent({ prompt: CREATE_AND_EDIT, mentions: [], activeSkill: null,
      hasSeries: false, hasAttachments: false, classifier, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("designTurnIntentClassifierSchema", () => {
  it("accepts the four labels with a known reason code and rejects anything else", () => {
    for (const intent of ["new_generation", "series_continuation", "local_edit", "non_design"]) {
      expect(designTurnIntentClassifierSchema.safeParse({ intent, reasonCode: "unclear", confidence: 0.5 }).success, intent).toBe(true);
    }
    expect(designTurnIntentClassifierSchema.safeParse({ intent: "generation", reasonCode: "unclear", confidence: 0.5 }).success).toBe(false);
    expect(designTurnIntentClassifierSchema.safeParse({ intent: "non_design", reasonCode: "made_up", confidence: 0.5 }).success).toBe(false);
    expect(designTurnIntentClassifierSchema.safeParse({ intent: "non_design", reasonCode: "unclear", confidence: 2 }).success).toBe(false);
    expect(designTurnIntentClassifierSchema.safeParse({ intent: "non_design", reasonCode: "unclear", confidence: 0.5, execute: true }).success).toBe(false);
  });
});

describe("shouldReplaceSessionSeries — safety guarantees kept", () => {
  it("still refuses to replace the series for a question or a declined turn", async () => {
    for (const prompt of ["怎么生成一张高质量的海报？", HEDGED_NEGATION, "这个配色怎么样"]) {
      const resolution = await resolve(prompt, classifierReturning({ intent: "new_generation", reasonCode: "explicit_creation", confidence: 1 }));
      expect(resolution.intent, prompt).toBe("non_design");
      // Nothing ran, so even a misclassified turn could not wipe remembered state.
      expect(shouldReplaceSessionSeries({ designIntent: resolution.intent, performedDesignWrite: false }), prompt).toBe(false);
    }
  });

  it("still replaces the series only for a real new-generation write", () => {
    expect(shouldReplaceSessionSeries({ designIntent: "new_generation", performedDesignWrite: true })).toBe(true);
    expect(shouldReplaceSessionSeries({ designIntent: "new_generation", performedDesignWrite: false })).toBe(false);
    expect(shouldReplaceSessionSeries({ designIntent: "local_edit", performedDesignWrite: true })).toBe(false);
  });
});

describe("describeDesignRouting — notice copy", () => {
  it("stays silent for a turn with no design decision at all", () => {
    expect(describeDesignRouting({ intent: "non_design", reasonCode: "informational_question",
      source: "deterministic", confidence: 1 })).toBeUndefined();
  });

  it("names the selected Skill and the keywords that selected it", () => {
    const notice = describeDesignRouting({
      intent: "new_generation", reasonCode: "explicit_creation", source: "deterministic", confidence: 1,
      primarySkill: { name: "campaign-design", displayName: "活动海报与宣传图" },
      matchedKeywords: ["活动", "海报"],
    });
    expect(notice?.summary).toBe("识别为：活动海报与宣传图（命中 活动/海报）");
    expect(notice?.primarySkill).toBe("campaign-design");
  });

  it("reports the model verdict, the helpers and the size enable", () => {
    const notice = describeDesignRouting({
      intent: "new_generation", reasonCode: "explicit_creation", source: "model", confidence: 0.88,
      primarySkill: { name: "campaign-design", displayName: "活动海报与宣传图" }, matchedKeywords: ["活动"],
      helperSkills: [{ name: "design-copywriting", displayName: "海报文案" }],
      nonstandardSizeSkill: { name: "nonstandard-image-size", displayName: "非标准尺寸" },
      seriesApplied: true,
    });
    expect(notice?.summary).toBe("识别为：活动海报与宣传图（命中 活动）");
    expect(notice?.detail).toContain("模型判定 · 置信度 88%");
    expect(notice?.detail).toContain("已预载助手指南：海报文案");
    expect(notice?.detail).toContain("已启用非标准尺寸技能：非标准尺寸");
    expect(notice?.detail).toContain("沿用会话中记住的风格与尺寸");
    expect(notice?.helperSkills).toEqual(["design-copywriting"]);
    expect(notice?.nonstandardSizeSkill).toBe("nonstandard-image-size");
  });

  it("discloses a fallback and explains an unmatched brief", () => {
    const fallback = describeDesignRouting({ intent: "new_generation", reasonCode: "explicit_creation",
      source: "fallback", confidence: 1, primarySkill: { name: "campaign-design", displayName: "活动海报与宣传图" },
      matchedKeywords: ["海报"] });
    expect(fallback?.detail).toContain("模型不可用，沿用规则判定");
    const unmatched = describeDesignRouting({ intent: "new_generation", reasonCode: "unclear",
      source: "deterministic", confidence: 0.3 });
    expect(unmatched?.summary).toBe("未匹配到交付物技能，由模型自行选择");
  });

  it("still speaks up when only a helper guide matched a non-design turn", () => {
    // A review request routes no deliverable but does preload a guide, which the
    // user currently cannot see anywhere.
    const notice = describeDesignRouting({ intent: "non_design", reasonCode: "informational_question",
      source: "deterministic", confidence: 1, helperSkills: [{ name: "design-review", displayName: "设计评审" }] });
    expect(notice?.detail).toContain("已预载助手指南：设计评审");
  });
});
