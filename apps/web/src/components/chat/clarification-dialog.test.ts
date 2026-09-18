import { describe, expect, it } from "vitest";

import {
  parseConfirmationRequest,
  parseToolConfirmationRequest,
  parseClarificationQuestions,
  hasImageExecutionReceipt,
} from "./clarification-dialog";

describe("hasImageExecutionReceipt", () => {
  it("recognizes a submitted image task before its artifact is ready", () => {
    expect(hasImageExecutionReceipt([{
      type: "tool",
      toolCallId: "call-processing",
      toolName: "generate_image",
      status: "completed",
      output: { jobId: "job-1", status: "processing" },
    }])).toBe(true);
  });

  it("does not treat an unsubmitted proposal as an execution receipt", () => {
    expect(hasImageExecutionReceipt([{
      type: "tool",
      toolCallId: "call-proposal",
      toolName: "generate_image",
      status: "completed",
      output: { status: "awaiting_confirmation" },
    }])).toBe(false);
  });
});

describe("parseClarificationQuestions", () => {
  it("shows background choices only when the assistant asks a background question", () => {
    const result = parseClarificationQuestions("请确认这次图片的背景：\n1. 背景：透明底还是有背景？");
    expect(result).toHaveLength(1);
    expect(result[0]!.options).toEqual(["有背景（自动配色）", "透明底", "自动判断"]);
    expect(parseClarificationQuestions("设计方案：\n1. 背景：透明底")).toEqual([]);
    const ordinary = parseClarificationQuestions("请确认几项信息：\n1. 品牌名称：叫什么？\n2. 风格：喜欢什么？");
    expect(ordinary).toHaveLength(2);
    expect(ordinary.some(q => q.title === "背景")).toBe(false);
  });
  it("keeps all five clarification fields regardless of punctuation", () => {
    const questions = parseClarificationQuestions(`我来帮你设计 logo。想先确认几项关键信息：
1. **品牌名称**：logo 上要出现的文字是什么？（中英文、拼写请确认）
2. **行业/用途**：比如餐饮、科技、美妆、教育。
3. **风格倾向**：极简文字标、图形+文字组合。
4. **颜色偏好**：有无指定色系，或让我自由搭配。
5. **logo 类型**：只要图形图标、只要文字，还是图标+文字横版/竖版组合？
如果这些你没有特别想法，也可以直接告诉我品牌名。`);
    expect(questions.map(q => q.title)).toEqual(["品牌名称", "行业/用途", "风格倾向", "颜色偏好", "logo 类型"]);
    expect(questions[0]?.prompt).toContain("拼写请确认");
    expect(questions[4]?.options).toContain("只要文字");
    expect(questions[4]?.prompt).not.toContain("如果这些");
  });

  it("retains indented explanations, original labels, and lists longer than eight", () => {
    const questions = parseClarificationQuestions("请补充以下信息：\n" + Array.from({ length: 9 }, (_, i) => `${i + 1}、字段${i + 1}：说明\n  补充说明`).join("\n\n"));
    expect(questions).toHaveLength(9);
    expect(questions[8]).toMatchObject({ id: 9, title: "字段9", prompt: "字段9：说明\n补充说明" });
  });

  it("does not open a questionnaire for an ordinary numbered design plan", () => {
    expect(parseClarificationQuestions("设计方案：\n1. 品牌名称：AAAA\n2. 风格倾向：极简\n3. 颜色偏好：蓝色")).toEqual([]);
  });

  it("still accepts numbered direct questions without an introduction", () => {
    expect(parseClarificationQuestions("1) 品牌叫什么？\n2) 喜欢什么颜色？")).toHaveLength(2);
  });
});

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
            confirmation: { confirmationId, details: { target: null } },
          },
        },
        { type: "text", text: "设计理念：采用极简风格，将字母 A" },
      ]),
    ).toEqual({
      confirmationId,
      kind: "image_generation",
      title: "确认设计方案",
      prompt: "输出位置：无限画布 · 新增图片，保留原图，不修改画板。是否按此方案生成？",
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
