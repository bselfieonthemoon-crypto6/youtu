import { describe, expect, it } from "vitest";

import { validateImageGenerationRequestLimits } from "./image-request-limits.js";

describe("image request limits", () => {
  it("allows all 16 documented GPT Image 2 input images", () => {
    expect(validateImageGenerationRequestLimits({
      model: "gpt-image-2",
      prompt: "Combine the references",
      inputImages: Array.from({ length: 16 }, () => "reference"),
    })).toBeNull();
  });

  it("recognizes the precise upstream model behind a workspace alias", () => {
    expect(validateImageGenerationRequestLimits({
      model: "workspace:configured-image-model",
      upstreamModelId: "gpt-image-2",
      prompt: "Combine the references",
      inputImages: Array.from({ length: 17 }, () => "reference"),
    })?.code).toBe("image_reference_limit_exceeded");
  });

  it("does not infer OpenAI limits for an unverified gateway alias", () => {
    expect(validateImageGenerationRequestLimits({
      model: "gpt-image-2-all",
      prompt: "x".repeat(32_001),
      inputImages: Array.from({ length: 17 }, () => "reference"),
    })).toBeNull();
  });
});
