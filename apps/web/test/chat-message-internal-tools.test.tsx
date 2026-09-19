// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentBlock } from "@loomic/shared";

import { ChatMessage } from "../src/components/chat-message";

afterEach(cleanup);

describe("ChatMessage internal preparation tools", () => {
  it("keeps skill and prompt preparation out of the customer transcript", () => {
    const blocks = [
      { type: "tool", toolCallId: "list", toolName: "list_skills", status: "completed", output: { skills: [] } },
      { type: "tool", toolCallId: "use", toolName: "use_skill", status: "completed", output: { status: "loaded" } },
      { type: "tool", toolCallId: "compose", toolName: "compose_skills", status: "failed", output: { status: "conflict" } },
      { type: "tool", toolCallId: "discover", toolName: "discover_tools", status: "completed", output: { available: true } },
      { type: "tool", toolCallId: "search", toolName: "search_prompt_library", status: "completed", output: { results: [] } },
      { type: "tool", toolCallId: "read", toolName: "get_prompt_library_entry", status: "completed", output: { prompt: "internal" } },
      { type: "text", text: "Logo 已生成。" },
    ] as unknown as ContentBlock[];

    render(<ChatMessage role="assistant" contentBlocks={blocks} />);

    expect(screen.getByText("Logo 已生成。")).toBeInTheDocument();
    expect(screen.queryByText("查看可用技能")).not.toBeInTheDocument();
    expect(screen.queryByText("加载设计技能")).not.toBeInTheDocument();
    expect(screen.queryByText("组合设计技能")).not.toBeInTheDocument();
    expect(document.querySelector('[id^="tool-execution-"]')).toBeNull();
  });

  it("replaces multilingual preparation narration with one completed marker", () => {
    const blocks = [
      { type: "text", text: "I'll load the relevant product-visualization guide first." },
      { type: "tool", toolCallId: "list", toolName: "list_skills", status: "completed", output: { skills: [] } },
      { type: "text", text: "本轮的技能目录被截断了，我先把可用的技能名看全，再读取最相关的产品视觉指南。" },
      { type: "tool", toolCallId: "use", toolName: "use_skill", status: "completed", output: { status: "loaded" } },
      { type: "text", text: "产品视觉方案已经生成。" },
    ] as unknown as ContentBlock[];

    render(<ChatMessage role="assistant" contentBlocks={blocks} />);

    expect(screen.getByText("分析完成")).toBeInTheDocument();
    expect(screen.getByText("产品视觉方案已经生成。")).toBeInTheDocument();
    expect(screen.queryByText(/I'll load/)).not.toBeInTheDocument();
    expect(screen.queryByText(/技能目录被截断/)).not.toBeInTheDocument();
  });

  it("keeps a running image task reachable behind the collapsed process row", async () => {
    const blocks = [
      {
        type: "tool",
        toolCallId: "generate",
        toolName: "generate_image",
        status: "running",
      },
    ] as unknown as ContentBlock[];

    render(<ChatMessage role="assistant" contentBlocks={blocks} />);

    // The chat shows one quiet process row instead of a tool card; expanding it
    // still reaches the full operation with its own anchor.
    expect(screen.queryByText("正在准备图片方案（尚未生成）")).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: "过程 · 1 项" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row).toHaveTextContent("正在处理…");

    await userEvent.click(row);

    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("正在准备图片方案（尚未生成）")).toBeInTheDocument();
    expect(document.getElementById("tool-execution-generate")).toBeInTheDocument();
  });
});
