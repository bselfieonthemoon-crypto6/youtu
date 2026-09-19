// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock } from "@loomic/shared";

import { ChatMessage } from "../src/components/chat-message";

afterEach(cleanup);

const submittedImageTask = {
  type: "tool",
  toolCallId: "edit",
  toolName: "edit_image",
  status: "completed",
  outputSummary: "图片任务已提交或正在处理；请使用继续等待查询结果",
  output: {
    jobId: "0d1fefb9-0000-4000-8000-000000000000",
    status: "processing",
    jobType: "image_generation",
    creditsCost: 0,
    pricingVersion: "credits-v1",
    actualQuality: "Low",
    actualResolution: "1K",
  },
} as unknown as ContentBlock;

const deliveredImage = {
  type: "tool",
  toolCallId: "generate",
  toolName: "generate_image",
  status: "completed",
  outputSummary: "图片生成完成",
  output: { status: "succeeded" },
  artifacts: [
    { type: "image", url: "https://example.com/image.png", mimeType: "image/png", width: 512, height: 512 },
  ],
} as unknown as ContentBlock;

describe("ChatMessage process grouping", () => {
  it("collapses a submitted image task and its receipt into one row", async () => {
    render(
      <ChatMessage
        role="assistant"
        contentBlocks={[
          { type: "text", text: "图片正在生成，稍等一下。" },
          submittedImageTask,
        ]}
      />,
    );

    // The transcript keeps the words; the job card, its cost receipt and the wait
    // button are behind one quiet row that still says work is in flight.
    expect(screen.getByText("图片正在生成，稍等一下。")).toBeInTheDocument();
    expect(screen.queryByText(/图片任务已提交或正在处理/)).not.toBeInTheDocument();
    expect(screen.queryByText(/本次任务 0 积分/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续等待" })).not.toBeInTheDocument();

    const row = screen.getByRole("button", { name: "过程 · 1 项" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row).toHaveTextContent("正在处理…");

    await userEvent.click(row);

    expect(screen.getByText(/图片任务已提交或正在处理/)).toBeInTheDocument();
    expect(screen.getByText(/本次任务 0 积分/)).toBeInTheDocument();
  });

  it("keeps delivered media, confirmations and failures in the open", () => {
    render(
      <ChatMessage
        role="assistant"
        contentBlocks={[
          deliveredImage,
          {
            type: "tool",
            toolCallId: "confirm",
            toolName: "confirm_image_generation",
            status: "completed",
            output: {
              status: "confirmation_required",
              confirmation: { confirmationId: "c-1", kind: "image_generation", details: { prompt: "一只猫" } },
            },
          } as unknown as ContentBlock,
          {
            type: "tool",
            toolCallId: "failed",
            toolName: "edit_image",
            status: "failed",
            output: { status: "failed", error: "渠道不可用，任务已停止" },
          } as unknown as ContentBlock,
        ]}
        onConfirmAction={vi.fn()}
      />,
    );

    // A delivered image is the result of the turn, a pending confirmation needs an
    // answer, and a failure is a fact about the request: none of them may hide.
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(screen.getByText("生成前确认")).toBeInTheDocument();
    expect(screen.getByText("渠道不可用，任务已停止")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^过程 · / })).not.toBeInTheDocument();
  });

  it("never opens an empty row for a step the transcript does not render", () => {
    render(
      <ChatMessage
        role="assistant"
        contentBlocks={[
          { type: "text", text: "任务已经安排好了。" },
          {
            type: "tool",
            toolCallId: "delegate",
            toolName: "delegate_design_tasks",
            status: "completed",
            output: { delegated: 2 },
          } as unknown as ContentBlock,
        ]}
      />,
    );

    expect(screen.getByText("任务已经安排好了。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^过程 · / })).not.toBeInTheDocument();
  });

  it("keeps conversation order and collapses each run separately", async () => {
    render(
      <ChatMessage
        role="assistant"
        contentBlocks={[
          submittedImageTask,
          { type: "text", text: "第一张图已经提交，我同时准备第二张。" },
          { ...submittedImageTask, toolCallId: "edit-2" } as unknown as ContentBlock,
        ]}
      />,
    );

    const rows = screen.getAllByRole("button", { name: "过程 · 1 项" });
    expect(rows).toHaveLength(2);
    expect(screen.getByText("第一张图已经提交，我同时准备第二张。")).toBeInTheDocument();

    await userEvent.click(rows[0]!);
    expect(rows[0]).toHaveAttribute("aria-expanded", "true");
    expect(rows[1]).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/图片任务已提交或正在处理/)).toBeInTheDocument();
  });
});
