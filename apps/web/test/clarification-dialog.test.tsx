// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClarificationDialog,
  ConfirmationDialog,
  parseClarificationQuestions,
  parseStructuredClarificationQuestions,
  parseConfirmationRequest,
} from "../src/components/chat/clarification-dialog";

afterEach(cleanup);

describe("clarification dialog", () => {
  const text = `为了设计 logo，请补充：
1. 品牌名称是什么？
2. 所属行业或主要业务是什么？
3. 你希望给人的第一印象是什么样的？（例如：简约、科技感、亲切、高端、复古）
4. 有没有特别喜欢的配色或图形元素？`;

  it("recognizes a numbered question list", () => {
    const questions = parseClarificationQuestions(text);
    expect(questions).toHaveLength(4);
    expect(questions.map((question) => question.title)).toEqual([
      "品牌名称",
      "所属行业",
      "品牌风格",
      "配色偏好",
    ]);
  });

  it("keeps logo usage scenarios separate from industry choices", () => {
    const questions = parseClarificationQuestions(`请补充以下问题：
1. 品牌名称：Logo 上要出现什么文字？
2. 用途：主要用在 App 图标、门头、名片还是社媒头像？（影响留白和小尺寸识别）`);

    expect(questions[1]).toMatchObject({
      title: "用途",
      options: ["App 图标", "门头 / 招牌", "名片 / 印刷品", "社媒头像"],
    });
    expect(questions[1]?.options).not.toContain("科技 / 互联网");
  });

  it("renders the server-provided structured choices without inferring them from prose", () => {
    const questions = parseStructuredClarificationQuestions([{
      type: "tool",
      toolCallId: "ask-1",
      toolName: "ask_clarification",
      status: "completed",
      output: {
        status: "awaiting_user_input",
        questions: [{
          id: 1,
          title: "用途",
          prompt: "主要用在 App 图标、门头、名片还是社媒头像？",
          options: ["App 图标", "门头", "名片", "社媒头像"],
          allowCustom: true,
        }],
      },
    }]);

    expect(questions).toEqual([{
      id: 1,
      title: "用途",
      prompt: "主要用在 App 图标、门头、名片还是社媒头像？",
      options: ["App 图标", "门头", "名片", "社媒头像"],
      allowCustom: true,
    }]);
  });

  it("supports choices, custom answers, navigation, and submission", async () => {
    const onSubmit = vi.fn();
    render(
      <ClarificationDialog
        questions={parseClarificationQuestions(text).slice(0, 2)}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    await userEvent.type(
      screen.getByPlaceholderText("输入自定义回答..."),
      "Loomic",
    );
    await userEvent.click(screen.getByRole("button", { name: "下一个" }));
    await userEvent.click(
      screen.getByRole("button", { name: /科技 \/ 互联网/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "提交" }));

    expect(onSubmit).toHaveBeenCalledWith(
      "1. 品牌名称：Loomic\n2. 所属行业：科技 / 互联网",
    );
  });

  it("anchors over the composer instead of above it", () => {
    render(
      <ClarificationDialog
        questions={parseClarificationQuestions(text)}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("heading", { name: "品牌名称" }).closest(
      "[data-chat-floating-dialog]",
    );
    expect(dialog).toHaveClass("bottom-3");
    expect(dialog).toHaveClass("inset-x-3");
    expect(dialog).not.toHaveClass("bottom-0");
    expect(dialog).not.toHaveClass("bottom-full");
  });
});

describe("proposal confirmation dialog", () => {
  const proposal = `设计构思：以字母 A 为基础进行几何化设计。

设计计划：
1. 调用 generate_image 创建两个方案。
2. 确认与调整：向你展示设计思路，等待你的确认。`;

  it("recognizes a proposal that pauses for confirmation", () => {
    expect(parseConfirmationRequest(proposal)).toEqual({
      title: "确认设计方案",
      prompt: "方案已经准备好，是否按上述计划继续？",
    });
    expect(parseConfirmationRequest("方案已经生成完成。")).toBeNull();
  });

  it("can confirm a proposal directly", async () => {
    const request = parseConfirmationRequest(proposal);
    const onSubmit = vi.fn();
    expect(request).not.toBeNull();
    if (!request) return;

    render(
      <ConfirmationDialog
        request={request}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /确认方案，继续生成/ }),
    );
    expect(onSubmit).toHaveBeenCalledWith(
      "确认，请按上述方案继续执行并生成预览。",
    );
  });

  it("executes a structured image confirmation without sending another agent message", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    const onConfirmAction = vi.fn().mockResolvedValue({ status: "applied" });

    render(
      <ConfirmationDialog
        request={{
          confirmationId: crypto.randomUUID(),
          title: "确认设计方案",
          prompt: "方案已经准备好，是否按上述计划继续？",
        }}
        onClose={onClose}
        onConfirmAction={onConfirmAction}
        onSubmit={onSubmit}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /确认方案，继续生成/ }),
    );

    expect(onConfirmAction).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes as soon as a slow image task is accepted", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    const onConfirmAction = vi.fn().mockResolvedValue({ status: "accepted" });

    render(
      <ConfirmationDialog
        request={{
          confirmationId: crypto.randomUUID(),
          title: "确认设计方案",
          prompt: "方案已经准备好，是否按上述计划继续？",
        }}
        onClose={onClose}
        onConfirmAction={onConfirmAction}
        onSubmit={onSubmit}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /确认方案，继续生成/ }),
    );

    expect(onConfirmAction).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
