import { describe, expect, it } from "vitest";

import {
  BEHAVIOR_SCENARIOS,
  activeSkillIs,
  aspectRatioIs,
  combine,
  evaluateBehavior,
  imageGenerationSucceeded,
  minReferences,
  noImageGeneration,
  promptContains,
  type BehaviorEvidence,
  type BehaviorJob,
} from "./behavior-eval.js";

const job = (overrides: Partial<BehaviorJob> = {}): BehaviorJob => ({
  id: "job-1", jobType: "image_generation", status: "succeeded", prompt: "a banner", referenceCount: 0, ...overrides,
});

const evidence = (overrides: Partial<BehaviorEvidence> = {}): BehaviorEvidence => ({
  sessionId: "session", tools: [], assistantTexts: [], jobs: [], session: null, ...overrides,
});

describe("behavior evaluators", () => {
  it("checks image presence, status and job shape", () => {
    expect(noImageGeneration(evidence())).toEqual([]);
    expect(noImageGeneration(evidence({ jobs: [job()] }))).toHaveLength(1);
    expect(imageGenerationSucceeded(evidence())).toHaveLength(1);
    expect(imageGenerationSucceeded(evidence({ jobs: [job({ status: "running" })] }))).toHaveLength(1);
    expect(imageGenerationSucceeded(evidence({ jobs: [job()] }))).toEqual([]);
  });

  it("checks literal copy, references, ratio and sticky skill", () => {
    expect(promptContains("限时五折")(evidence({ jobs: [job({ prompt: "海报 限时五折 x" })] }))).toEqual([]);
    expect(promptContains("限时五折")(evidence({ jobs: [job({ prompt: "海报" })] }))).toHaveLength(1);
    expect(minReferences(1)(evidence({ jobs: [job({ referenceCount: 2 })] }))).toEqual([]);
    expect(minReferences(1)(evidence({ jobs: [job({ referenceCount: 0 })] }))).toHaveLength(1);
    expect(aspectRatioIs("656:288")(evidence({ jobs: [job({ aspectRatio: "656:288" })] }))).toEqual([]);
    expect(aspectRatioIs("3:1")(evidence({ jobs: [job({ aspectRatio: "656:288" })] }))).toHaveLength(1);
    expect(activeSkillIs("logo-design")(evidence({ session: { activeSkill: "logo-design", series: null } }))).toEqual([]);
    expect(activeSkillIs("logo-design")(evidence({ session: null }))).toHaveLength(1);
  });

  it("aggregates violations from combined checks", () => {
    const check = combine(imageGenerationSucceeded, activeSkillIs("game-promo-visuals"));
    const violations = check(evidence());
    expect(violations).toHaveLength(2);
  });

  it("keeps the scenario catalog well formed", () => {
    const ids = BEHAVIOR_SCENARIOS.map(scenario => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of BEHAVIOR_SCENARIOS) {
      expect(scenario.turns.length, scenario.id).toBeGreaterThan(0);
      expect(Array.isArray(evaluateBehavior(evidence(), scenario)), scenario.id).toBe(true);
    }
  });
});
