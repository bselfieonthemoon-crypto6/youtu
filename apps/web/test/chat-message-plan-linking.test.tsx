// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentBlock } from "@loomic/shared";

import { ChatMessage } from "../src/components/chat-message";

const scrolledIds: string[] = [];

beforeEach(() => {
  scrolledIds.length = 0;
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: function scrollIntoView() {
      scrolledIds.push(this.id);
    },
  });
});

afterEach(cleanup);

describe("ChatMessage plan tool linking", () => {
  it("uses only server IDs and locates the selected full tool block", async () => {
    const blocks = [
      {
        type: "tool",
        toolCallId: "unlinked-before-plan",
        toolName: "generate_video",
        status: "completed",
      },
      {
        type: "plan",
        planId: "plan-1",
        revision: 1,
        steps: [{ id: "step-1", title: "读取并生成", status: "in_progress" }],
      },
      {
        type: "tool",
        toolCallId: "linked-second",
        toolName: "generate_image",
        status: "running",
        planId: "plan-1",
        planStepId: "step-1",
      },
      {
        type: "tool",
        toolCallId: "wrong-plan",
        toolName: "project_search",
        status: "completed",
        planId: "plan-other",
        planStepId: "step-1",
      },
    ] as unknown as ContentBlock[];

    render(<ChatMessage role="assistant" contentBlocks={blocks} />);

    const plan = screen.getByRole("region", { name: "Agent 执行计划" });
    expect(within(plan).getByText("生成图片")).toBeInTheDocument();
    expect(within(plan).queryByText("生成视频")).not.toBeInTheDocument();
    expect(within(plan).queryByText("搜索项目")).not.toBeInTheDocument();

    await userEvent.click(within(plan).getByRole("button", { name: /生成图片/ }));

    expect(scrolledIds).toEqual(["tool-execution-linked-second"]);
    const target = document.getElementById("tool-execution-linked-second");
    expect(target?.firstElementChild).toHaveClass("bg-accent/10");
  });
});
