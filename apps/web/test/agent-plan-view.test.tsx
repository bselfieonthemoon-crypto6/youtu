// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentPlanView } from "../src/components/chat/agent-plan-view";

afterEach(cleanup);

describe("AgentPlanView", () => {
  it("shows progress and all step states", () => {
    render(
      <AgentPlanView
        block={{
          type: "plan",
          planId: "plan",
          revision: 1,
          steps: [
            { id: "1", title: "分析画布", status: "completed" },
            { id: "2", title: "生成图片", status: "in_progress" },
            { id: "3", title: "写入画布", status: "pending" },
            { id: "4", title: "失败步骤", status: "failed" },
          ],
        }}
      />,
    );

    expect(screen.getByText("1/4")).toBeInTheDocument();
    expect(screen.getByLabelText("已完成")).toBeInTheDocument();
    expect(screen.getByLabelText("执行中")).toBeInTheDocument();
    expect(screen.getByLabelText("待执行")).toBeInTheDocument();
    expect(screen.getByLabelText("失败")).toBeInTheDocument();
  });

  it("collapses a plan after all steps finish and can be reopened", async () => {
    const { rerender } = render(
      <AgentPlanView
        block={{
          type: "plan",
          planId: "plan",
          revision: 1,
          steps: [{ id: "1", title: "生成图片", status: "in_progress" }],
        }}
      />,
    );
    rerender(
      <AgentPlanView
        block={{
          type: "plan",
          planId: "plan",
          revision: 2,
          steps: [{ id: "1", title: "生成图片", status: "completed" }],
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /执行计划/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /执行计划/ }));
    expect(screen.getByText("生成图片")).toBeInTheDocument();
  });

  it("shows only explicitly linked tools and locates the exact execution", async () => {
    const onLocateTool = vi.fn();
    render(
      <AgentPlanView
        block={{
          type: "plan",
          planId: "plan",
          revision: 1,
          steps: [{ id: "step-read", title: "分析画布", status: "in_progress" }],
        }}
        toolsByStepId={new Map([
          ["step-read", [
            {
              type: "tool",
              toolCallId: "tool-first",
              toolName: "inspect_canvas",
              status: "completed",
            },
            {
              type: "tool",
              toolCallId: "tool-second",
              toolName: "project_search",
              status: "running",
            },
          ]],
        ])}
        onLocateTool={onLocateTool}
      />,
    );

    expect(screen.getByText("读取画布")).toBeInTheDocument();
    expect(screen.getByText("搜索项目")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("执行中")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /搜索项目/ }));
    expect(onLocateTool).toHaveBeenCalledWith("tool-second");
  });
});
