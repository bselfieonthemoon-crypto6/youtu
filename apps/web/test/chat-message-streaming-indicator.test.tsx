// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentBlock } from "@loomic/shared";

import { ChatMessage } from "../src/components/chat-message";

afterEach(cleanup);

describe("ChatMessage streaming status", () => {
  it("keeps a processing status visible after content has arrived", () => {
    const blocks = [{ type: "text", text: "已收到部分回复" }] as ContentBlock[];

    const { rerender } = render(
      <ChatMessage role="assistant" contentBlocks={blocks} isStreaming />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("处理中");

    rerender(
      <ChatMessage role="assistant" contentBlocks={blocks} isStreaming={false} />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the status after a completed tool while the run remains active", () => {
    const blocks = [
      {
        type: "tool",
        toolCallId: "completed-tool",
        toolName: "project_search",
        status: "completed",
      },
    ] as unknown as ContentBlock[];

    render(<ChatMessage role="assistant" contentBlocks={blocks} isStreaming />);

    expect(screen.getByRole("status")).toHaveTextContent("处理中");
  });

  it("does not duplicate an actively streaming thinking indicator", () => {
    const blocks = [
      { type: "thinking", thinking: "仍在推理" },
    ] as ContentBlock[];

    render(<ChatMessage role="assistant" contentBlocks={blocks} isStreaming />);

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("正在分析中")).toBeInTheDocument();
    expect(screen.queryByText("仍在推理")).not.toBeInTheDocument();
  });
});
