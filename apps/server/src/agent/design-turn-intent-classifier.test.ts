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
    // No rule matched at all, and NOTHING is remembered: measured against the new
    // proof this is provably inert — nothing preloads any more, and with no series
    // there is nothing for a verdict to apply — so the call is skipped instead of
    // being spent "in case". With a series remembered the same turn does need the
    // model, because only a verdict can recognise a continuation; both columns are
    // asserted in the guard block below.
    expect(assessDesignTurnIntent({ prompt: NO_RULE, mentions: [], activeSkill: null,
      hasSeries: false, hasAttachments: false }))
      .toMatchObject({ intent: "non_design", rule: "no_rule", needsModel: false });
    expect(assessDesignTurnIntent({ prompt: "你好呀", mentions: [], activeSkill: null,
      hasSeries: false, hasAttachments: false }))
      .toMatchObject({ intent: "non_design", rule: "no_rule", needsModel: false });
    expect(assessDesignTurnIntent({ prompt: NO_RULE, mentions: [], activeSkill: null,
      hasSeries: true, hasAttachments: false }))
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
    // Typed as the real classifier so `mock.calls[0]` carries the argument this
    // test inspects; an untyped `vi.fn` records a zero-argument call.
    const classifier = vi.fn<DesignTurnIntentClassifier>(async () => ({ intent: "new_generation", reasonCode: "explicit_creation", confidence: 0.5 }));
    await resolveDesignTurnIntent({ prompt: CREATE_AND_EDIT, mentions: [], activeSkill: "campaign-design",
      hasSeries: true, hasAttachments: true, classifier, signal: new AbortController().signal });
    const payload = classifier.mock.calls[0]![0];
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

  it("names the Skill the user's own words point at, and the keywords that matched", () => {
    const notice = describeDesignRouting({
      intent: "new_generation", reasonCode: "explicit_creation", source: "deterministic", confidence: 1,
      primarySkill: { name: "campaign-design", displayName: "活动海报与宣传图" },
      matchedKeywords: ["活动", "海报"],
    });
    // 候选, not 识别为: the runtime no longer selects, so the notice must not imply
    // a decision the model has not made yet.
    expect(notice?.summary).toBe("候选技能：活动海报与宣传图（命中 活动/海报）");
    expect(notice?.primarySkill).toBe("campaign-design");
  });

  it("reports the model verdict, the helper candidates and the size enable", () => {
    const notice = describeDesignRouting({
      intent: "new_generation", reasonCode: "explicit_creation", source: "model", confidence: 0.88,
      primarySkill: { name: "campaign-design", displayName: "活动海报与宣传图" }, matchedKeywords: ["活动"],
      helperSkills: [{ name: "design-copywriting", displayName: "海报文案" }],
      nonstandardSizeSkill: { name: "nonstandard-image-size", displayName: "非标准尺寸" },
      seriesApplied: true,
    });
    expect(notice?.summary).toBe("候选技能：活动海报与宣传图（命中 活动）");
    expect(notice?.detail).toContain("模型判定 · 置信度 88%");
    // The runtime injects no guide text, so it must not claim a preload.
    expect(notice?.detail).toContain("候选助手指南（需模型读取后生效）：海报文案");
    expect(notice?.detail).not.toContain("已预载");
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
    expect(unmatched?.summary).toBe("未匹配到候选技能，由模型从技能目录自行选择");
  });

  it("still speaks up when only a helper candidate matched a non-design turn", () => {
    // A review request points at no deliverable but does name a guide, which the
    // user currently cannot see anywhere.
    const notice = describeDesignRouting({ intent: "non_design", reasonCode: "informational_question",
      source: "deterministic", confidence: 1, helperSkills: [{ name: "design-review", displayName: "设计评审" }] });
    expect(notice?.detail).toContain("候选助手指南（需模型读取后生效）：设计评审");
  });
});

/** The same input shape the runtime uses. */
function assessWith(prompt: string, extra: { activeSkill?: string | null; hasSeries?: boolean } = {}) {
  return assessDesignTurnIntent({
    prompt, mentions: [], activeSkill: extra.activeSkill ?? null, hasSeries: extra.hasSeries ?? false,
    hasAttachments: false,
  });
}

const resolveWith = (prompt: string, extra: {
  activeSkill?: string | null; hasSeries?: boolean;
  classifier?: DesignTurnIntentClassifier;
}) => resolveDesignTurnIntent({
  prompt, mentions: [], activeSkill: extra.activeSkill ?? null, hasSeries: extra.hasSeries ?? false,
  hasAttachments: false,
  ...(extra.classifier ? { classifier: extra.classifier } : {}),
  signal: new AbortController().signal,
});

// The natural continuation vocabulary: it matches NO intent pattern and NO Skill
// keyword, so it lands on `no_rule` and the model verdict is the only thing that
// recognises it. Every one of these must keep reaching the model whenever the
// session actually has something to reuse.
const CONTINUATION_PHRASINGS = [
  "还是老样子", "照旧", "老样子", "就按之前的", "跟刚才一样", "上个风格", "保持原样", "用刚才那个风格", "还要那个感觉",
];

describe("a lone generic edit verb is deferred instead of published as decisive", () => {
  // Regression: `EDIT_PATTERN` matches a bare `改`, so "改天再说" (let us talk
  // another day) and "改主意了" (I changed my mind) were published as a confident
  // `local_edit` with NO model call, and the user was told "按局部修改处理" for a
  // turn about nothing of the sort.
  it("drops a bare generic verb to low confidence and asks the model", () => {
    for (const prompt of ["改天再说", "改主意了"]) {
      expect(assessWith(prompt), prompt).toMatchObject({
        intent: "local_edit", reasonCode: "property_edit", rule: "edit_verb",
        confidence: 0.4, needsModel: true,
      });
    }
  });

  it("stays decisive for a real change construction or a named target", () => {
    for (const prompt of [
      "帮我把标题改成蓝色", "把背景改成白色", "把标题改一下", "调整一下颜色",
      // Already decisive through `deliverable_brief` (海报) before this change,
      // and it must stay that way.
      "把海报上的文字改成蓝色",
      // Pinned as decisive by the pre-existing tests: `EDIT_TARGET_PATTERN` must
      // keep matching `改一下` here.
      "把标题的字改一下",
    ]) {
      expect(assessWith(prompt), prompt).toMatchObject({
        intent: "local_edit", confidence: 1, needsModel: false,
      });
    }
  });

  it("honours the model verdict for a deferred verb and falls back to the same label", async () => {
    const classifier = classifierReturning({ intent: "non_design", reasonCode: "unclear", confidence: 0.8 });
    const refined = await resolveWith("改天再说", { classifier });
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(refined).toMatchObject({ intent: "non_design", reasonCode: "unclear", source: "model", clamped: false });
    // The deterministic verdict is unchanged, so a classifier outage still yields
    // the previous behaviour: `local_edit`, only at low confidence.
    expect(refined.assessment).toMatchObject({ intent: "local_edit", rule: "edit_verb", confidence: 0.4 });
    expect(await resolveWith("改天再说", {})).toMatchObject({ intent: "local_edit", source: "fallback" });
    // A decisive edit still never reaches the classifier at all.
    const decisive = vi.fn<DesignTurnIntentClassifier>(async () => ({ intent: "local_edit", reasonCode: "property_edit", confidence: 1 }));
    await resolveWith("把标题改一下", { classifier: decisive });
    expect(decisive).not.toHaveBeenCalled();
  });
});

describe("provably inert no_rule turns skip the model call", () => {
  it("(a) skips when nothing is remembered for a verdict to act on", () => {
    // PROOF, not a heuristic: the runtime injects no Skill body, so NO verdict can
    // preload anything; and with no remembered series the only verdict that changes
    // behaviour (`series_continuation`, which applies `designContext.series`) has
    // nothing to apply. So all four labels are no-ops and the call is pure latency.
    for (const prompt of ["你好呀", "谢谢", "好的", ...CONTINUATION_PHRASINGS]) {
      expect(assessWith(prompt, {}), prompt).toMatchObject({
        intent: "non_design", reasonCode: "unclear", rule: "no_rule", confidence: 0.3, needsModel: false,
      });
    }
  });

  it("(a) is switched off by remembered state — and by nothing else", () => {
    // The SAME phrasing flips on the remember-state, and both columns are correct:
    // with nothing remembered the call is provably inert, with a series it is the
    // only way to reuse it. Do not "fix" one column into the other.
    for (const prompt of ["多张", ...CONTINUATION_PHRASINGS]) {
      expect(assessWith(prompt, {}), prompt).toMatchObject({ rule: "no_rule", needsModel: false });
      expect(assessWith(prompt, { hasSeries: true }), prompt).toMatchObject({ rule: "no_rule", needsModel: true });
    }
  });

  it("does not keep the call for remember-state that no verdict reads", () => {
    // `activeSkill` is session memory for the notice and the persisted context. No
    // verdict acts on it now that nothing is preloaded, so on its own it must not
    // buy a model call — this is the difference the removal of the keyword evidence
    // made. A matched keyword is likewise no longer routing evidence, for the same
    // reason: there is no preload left for it to gate.
    for (const prompt of ["你好呀", ...CONTINUATION_PHRASINGS]) {
      expect(assessWith(prompt, { activeSkill: "campaign-design" }), prompt)
        .toMatchObject({ rule: "no_rule", needsModel: false });
    }
    expect(assessWith("还是老样子", { activeSkill: "campaign-design", hasSeries: true }))
      .toMatchObject({ rule: "no_rule", needsModel: true });
  });

  it("(b) skips an acknowledgement only when the WHOLE turn is one", () => {
    for (const prompt of ["你好", "您好", "hi", "hello", "好的", "好", "嗯", "嗯嗯", "谢谢", "多谢", "收到", "明白", "ok",
      "好的好的", "OK!", " 你好。 "]) {
      expect(assessWith(prompt, { hasSeries: true }), prompt)
        .toMatchObject({ rule: "no_rule", needsModel: false });
    }
    // `在吗` is in the closed class but never even reaches the skip: the question
    // pattern already resolves it deterministically. Same outcome, other rule.
    expect(assessWith("在吗", { hasSeries: true }))
      .toMatchObject({ intent: "non_design", rule: "informational_question", needsModel: false });
    // Hard requirement: a continuation that merely STARTS with an acknowledgement
    // is not one. With a remembered series (a) cannot fire, so (b) is the only
    // candidate skip here — and it must not fire.
    for (const prompt of ["好的，还是老样子", "嗯嗯，照旧", "谢谢，按之前的来", "你好，帮我看下那个风格"]) {
      expect(assessWith(prompt, { hasSeries: true }), prompt)
        .toMatchObject({ rule: "no_rule", needsModel: true });
    }
    // The closed class is closed: greetings and thanks outside it are not skipped
    // just for looking social.
    for (const prompt of ["你好呀", "多谢啦", "太感谢了"]) {
      expect(assessWith(prompt, { hasSeries: true }), prompt)
        .toMatchObject({ rule: "no_rule", needsModel: true });
    }
    // Declared keywords no longer participate: with nothing preloaded there is no
    // routing decision for them to gate, so (b) is decided by the turn's own words
    // alone. A package that declares an acknowledgement token as a routing keyword
    // has a manifest problem, which the strict schema and the dispatch-outcome log
    // surface — the guard no longer silently compensates for it.
  });

  it("never calls the classifier for a skipped turn and keeps the deterministic verdict", async () => {
    const classifier = vi.fn<DesignTurnIntentClassifier>(async () => ({ intent: "series_continuation", reasonCode: "series_continuation", confidence: 0.9 }));
    for (const prompt of ["你好呀", "谢谢", "好的", ...CONTINUATION_PHRASINGS]) {
      const resolution = await resolveWith(prompt, { classifier });
      expect(resolution, prompt).toMatchObject({ intent: "non_design", reasonCode: "unclear",
        confidence: 0.3, source: "deterministic", clamped: false });
    }
    expect(classifier).not.toHaveBeenCalled();
    // The same phrasing WITH something remembered reaches the model and is
    // refined as usual.
    const remembered = await resolveWith("还是老样子", { activeSkill: "campaign-design",
      hasSeries: true, classifier: classifierReturning({ intent: "series_continuation", reasonCode: "series_continuation", confidence: 0.9 }) });
    expect(remembered).toMatchObject({ intent: "series_continuation", source: "model", clamped: false });
  });
});
