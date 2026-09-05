import { describe, expect, it } from "vitest";

import {
  parseConfirmationRequest,
  parseToolConfirmationRequest,
} from "./clarification-dialog";

describe("parseConfirmationRequest", () => {
  it("detects a natural-language request to confirm generation", () => {
    expect(
      parseConfirmationRequest(
        "设计方案已经准备就绪。请问你对这个构思满意吗？是否确认按照此方案进行生成？",
      ),
    ).toEqual({
      title: "确认设计方案",
      prompt: "方案已经准备好，是否按上述计划继续？",
    });
  });

  it("does not turn an informational design description into a confirmation", () => {
    expect(
      parseConfirmationRequest("这是本次的设计思路和配色方案。"),
    ).toBeNull();
  });
});

describe("parseToolConfirmationRequest", () => {
  it("uses the pending generate_image result when assistant prose is truncated", () => {
    const confirmationId = crypto.randomUUID();
    expect(
      parseToolConfirmationRequest([
        {
          type: "tool",
          toolCallId: "call-1",
          toolName: "generate_image",
          status: "completed",
          output: {
            status: "awaiting_confirmation",
            confirmation: { confirmationId },
          },
        },
        { type: "text", text: "设计理念：采用极简风格，将字母 A" },
      ]),
    ).toEqual({
      confirmationId,
      kind: "image_generation",
      title: "确认设计方案",
      prompt: "方案已经准备好，是否按上述计划继续？",
    });
  });

  it("recognizes a structured design template confirmation", () => {
    const confirmationId = crypto.randomUUID();
    expect(
      parseToolConfirmationRequest([
        {
          type: "tool",
          toolCallId: "call-template",
          toolName: "apply_design_template",
          status: "completed",
          output: {
            status: "confirmation_required",
            confirmation_id: confirmationId,
            design_id: crypto.randomUUID(),
            template_id: crypto.randomUUID(),
          },
        },
      ]),
    ).toEqual({
      confirmationId,
      kind: "design_template_apply",
      title: "确认套用设计模板",
      prompt: "套用后会替换当前设计场景，是否继续？",
    });
  });

  it("ignores ordinary completed image generation results", () => {
    expect(
      parseToolConfirmationRequest([
        {
          type: "tool",
          toolCallId: "call-1",
          toolName: "generate_image",
          status: "completed",
          output: { status: "completed" },
        },
      ]),
    ).toBeNull();
  });
});
