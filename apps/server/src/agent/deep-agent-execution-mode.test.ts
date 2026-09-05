import { describe, expect, it } from "vitest";

import { getGoogleThinkingConfig } from "./deep-agent.js";
import {
  LOOMIC_FAST_MODE_PROMPT,
  LOOMIC_THINKING_MODE_PROMPT,
} from "./prompts/loomic-main.js";

describe("agent execution modes", () => {
  it("uses an explicit zero budget for Gemini 2.5 Flash in Fast mode", () => {
    expect(getGoogleThinkingConfig("fast", "gemini-2.5-flash")).toEqual({
      includeThoughts: false,
      thinkingBudget: 0,
    });
  });

  it("uses dynamic thoughts for Gemini 2.5 Flash-Lite in Thinking mode", () => {
    expect(
      getGoogleThinkingConfig("thinking", "gemini-2.5-flash-lite-preview"),
    ).toEqual({
      includeThoughts: true,
      thinkingBudget: -1,
    });
  });

  it.each([
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
    "gemini-future-model",
  ])("does not send an unsafe thinking budget to %s", (modelName) => {
    expect(getGoogleThinkingConfig("fast", modelName)).toEqual({
      includeThoughts: false,
    });
    expect(getGoogleThinkingConfig("thinking", modelName)).toEqual({
      includeThoughts: true,
    });
  });

  it("keeps behavior prompts focused on visible work instead of hidden reasoning", () => {
    expect(LOOMIC_FAST_MODE_PROMPT).toContain("Fast");
    expect(LOOMIC_THINKING_MODE_PROMPT).toContain("Thinking");
    expect(LOOMIC_FAST_MODE_PROMPT).toContain("不要展示或编造隐藏思维链");
    expect(LOOMIC_THINKING_MODE_PROMPT).toContain("可见计划");
  });
});
