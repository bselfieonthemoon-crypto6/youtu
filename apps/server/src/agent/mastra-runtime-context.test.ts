import { describe, expect, it } from "vitest";

import { createContextBudget } from "./context-budget.js";
import { resolveMastraHistoryLimits, resolveMastraMemoryMode, shouldCommitMastraHistory, MASTRA_RECENT_IMAGE_JOB_PROJECTION, projectMastraImageReceipt } from "./mastra-runtime.js";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";

describe("Mastra runtime context policy", () => {
  it("chooses one memory pipeline and rejects ambiguous configuration", () => {
    expect(resolveMastraMemoryMode({})).toBe("legacy");
    expect(resolveMastraMemoryMode({ LOOMIC_MASTRA_MEMORY_MODE: "observational" })).toBe("observational");
    expect(() => resolveMastraMemoryMode({ LOOMIC_MASTRA_MEMORY_MODE: "both" })).toThrow("mastra_memory_mode_invalid");
  });
  it("preserves actual model from projected database rows without loading binary payloads", () => {
    expect(MASTRA_RECENT_IMAGE_JOB_PROJECTION).toContain("model:payload->>model");
    expect(MASTRA_RECENT_IMAGE_JOB_PROJECTION).toContain("error_code");
    expect(MASTRA_RECENT_IMAGE_JOB_PROJECTION).not.toMatch(/(?:^|,)payload(?:,|$)/);
    expect(projectMastraImageReceipt({ model: "workspace:nano", aspectRatio: "3:4",
      status: "dead_letter", error_code: "provider_rejected", error_message: "no compatible channel" },
    [{ id: "workspace:nano", upstreamModelId: "nano-banana-2" }])).toMatchObject({
      actualSubmittedModel: "workspace:nano", actualSubmittedUpstreamModel: "nano-banana-2",
      requestedAspectRatio: "3:4", errorCode: "provider_rejected", error: "no compatible channel",
    });
  });

  it("derives the history byte ceiling from the current model budget", () => {
    const budget = createContextBudget(undefined, "lean-expandable");
    const limits = resolveMastraHistoryLimits(budget);

    expect(limits.maxContextBytes).toBe(Math.max(128, Math.min(
      48_000,
      budget.targetTokens * 2,
      Math.max(128, budget.inputCeilingTokens - 832),
    )));
    expect(limits.summaryTargetBytes).toBeLessThan(limits.maxContextBytes);
    expect(limits.summarizerInputBytes).toBeLessThanOrEqual(28_000);
  });

  it("commits when coverage changes even if the summary text is identical", () => {
    const snapshot = {
      summary: "same facts",
      coverage: { messageIds: [first], omissions: [] },
    } as never;

    expect(shouldCommitMastraHistory({
      summary: "same facts",
      coverageMessageIds: [first, second],
      omissions: [],
    }, snapshot)).toBe(true);
  });

  it("commits when omissions change even if summary and coverage are identical", () => {
    const snapshot = {
      summary: "same facts",
      coverage: { messageIds: [first], omissions: [] },
    } as never;

    expect(shouldCommitMastraHistory({
      summary: "same facts",
      coverageMessageIds: [first],
      omissions: ["older evidence remains available"],
    }, snapshot)).toBe(true);
  });

  it("does not rewrite an unchanged snapshot or commit an empty summary", () => {
    const snapshot = {
      summary: "same facts",
      coverage: { messageIds: [first], omissions: ["bounded"] },
    } as never;

    expect(shouldCommitMastraHistory({
      summary: "same facts",
      coverageMessageIds: [first],
      omissions: ["bounded"],
    }, snapshot)).toBe(false);
    expect(shouldCommitMastraHistory({
      summary: "",
      coverageMessageIds: [first, second],
      omissions: ["changed"],
    }, snapshot)).toBe(false);
  });
});
