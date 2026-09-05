// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolBlockView } from "../src/components/chat/tool-block-view";

afterEach(() => cleanup());

describe("ToolBlockView", () => {
  it.each([
    ["running", "执行中"],
    ["completed", "已完成"],
    ["failed", "失败"],
    ["canceled", "已取消"],
  ] as const)("renders %s status", (status, label) => {
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: `tool-${status}`,
          toolName: "inspect_canvas",
          status,
        }}
      />,
    );
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it("renders destructive confirmation and forwards the decision", async () => {
    const onConfirmAction = vi.fn().mockResolvedValue({ status: "applied" });
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-confirm",
          toolName: "manipulate_canvas",
          status: "completed",
          output: {
            error: "confirmation_required",
            confirmation: {
              confirmationId: "confirm-1",
              targets: ["旧图片 1", "旧图片 2"],
            },
          },
        }}
        onConfirmAction={onConfirmAction}
      />,
    );

    expect(screen.getByText("需要确认危险操作")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(onConfirmAction).toHaveBeenCalledWith("confirm-1", "confirm");
    expect(await screen.findByText("已确认并删除")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认删除" }),
    ).not.toBeInTheDocument();
  });

  it("treats an accepted background confirmation as submitted", async () => {
    const onConfirmAction = vi.fn().mockResolvedValue({ status: "accepted" });
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-confirm-accepted",
          toolName: "manipulate_canvas",
          status: "completed",
          output: {
            error: "confirmation_required",
            confirmation: {
              confirmationId: "confirm-accepted",
              kind: "image_generation",
              targets: [],
            },
          },
        }}
        onConfirmAction={onConfirmAction}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "确认生成" }));
    expect(
      await screen.findByText("已确认，图片生成任务已提交"),
    ).toBeInTheDocument();
  });

  it("renders a Chinese design result and opens the authoritative design", async () => {
    const onOpenDesign = vi.fn();
    const designId = "10000000-0000-4000-8000-000000000001";
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-inspect-design",
          toolName: "inspect_design",
          status: "completed",
          output: {
            design_id: designId,
            name: "活动海报",
            revision: 7,
            width: 1080,
            height: 1440,
            object_count: 5,
            objects: [],
            selection_object_ids: [],
            truncated: true,
          },
        }}
        onOpenDesign={onOpenDesign}
      />,
    );

    expect(screen.getByText("已读取设计「活动海报」")).toBeInTheDocument();
    expect(
      screen.getByText("版本 7 · 1080 × 1440 · 5 个对象"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "打开设计" }));
    expect(onOpenDesign).toHaveBeenCalledWith(designId);
  });

  it("shows a completed generated image insertion and opens its design", async () => {
    const onOpenDesign = vi.fn();
    const designId = "10000000-0000-4000-8000-000000000001";
    const objectId = "20000000-0000-4000-8000-000000000001";
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-generate-into-design",
          toolName: "generate_image",
          status: "completed",
          output: {
            status: "succeeded",
            jobId: "30000000-0000-4000-8000-000000000001",
            finalization: {
              design_id: designId,
              object_id: objectId,
              revision: 8,
            },
          },
        }}
        onOpenDesign={onOpenDesign}
      />,
    );

    expect(screen.getByText("图片已插入设计")).toBeInTheDocument();
    expect(screen.getByText(`版本 8 · 对象 ${objectId}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "打开设计" }));
    expect(onOpenDesign).toHaveBeenCalledWith(designId);
  });

  it("shows a retryable design conflict without a fake retry button", () => {
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-design-conflict",
          toolName: "manipulate_design",
          status: "completed",
          output: {
            status: "error",
            code: "design_revision_conflict",
            design_id: "10000000-0000-4000-8000-000000000001",
            current_revision: 9,
            message: "revision conflict",
            retryable: true,
          },
        }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("设计版本冲突");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "服务器已是版本 9。请让 Agent 重新读取设计后再修改。",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the authoritative completed export state", () => {
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-export-design",
          toolName: "export_design",
          status: "completed",
          output: {
            design_id: "10000000-0000-4000-8000-000000000001",
            revision: 12,
            job_id: "20000000-0000-4000-8000-000000000001",
            status: "succeeded",
            replayed: true,
          },
        }}
      />,
    );

    expect(screen.getByText("设计导出完成")).toBeInTheDocument();
    expect(screen.getByText(/版本 12 · 未重复创建任务/u)).toBeInTheDocument();
  });

  it("renders and confirms a destructive design template proposal", async () => {
    const onConfirmAction = vi.fn().mockResolvedValue({ status: "accepted" });
    const confirmationId = "20000000-0000-4000-8000-000000000001";
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-apply-template",
          toolName: "apply_design_template",
          status: "completed",
          output: {
            status: "confirmation_required",
            confirmation_id: confirmationId,
            design_id: "10000000-0000-4000-8000-000000000001",
            template_id: "30000000-0000-4000-8000-000000000001",
            expected_revision: 4,
          },
        }}
        onConfirmAction={onConfirmAction}
      />,
    );

    expect(screen.getByText("确认套用设计模板")).toBeInTheDocument();
    expect(screen.queryByText("设计模板已套用")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "确认套用" }));
    expect(onConfirmAction).toHaveBeenCalledWith(
      confirmationId,
      "confirm",
      "design_template_apply",
    );
    expect(
      await screen.findByText("已确认，正在应用设计更改"),
    ).toBeInTheDocument();
  });

  it("hides the internal image proposal so confirmation stays conversational", () => {
    const { container } = render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-image-confirm",
          toolName: "generate_image",
          status: "completed",
          output: {
            status: "awaiting_confirmation",
            confirmation: {
              confirmationId: "confirm-image-1",
              kind: "image_generation",
              details: {
                title: "品牌 Logo",
                description: "深蓝背景上的金色四叶草标志，配合简洁无衬线文字。",
                model: "gpt-image-2-all",
                aspectRatio: "1:1",
                quality: "hd",
                outputFormat: "png",
                referenceImageCount: 0,
              },
              targets: [],
            },
          },
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("hides the agent's duplicate internal confirmation result", () => {
    const { container } = render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-confirm-image-internal",
          toolName: "confirm_image_generation",
          status: "failed",
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders an image placeholder while a generation job is running", () => {
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "job-pending-image",
          toolName: "generate_image",
          status: "running",
          input: {
            model: "gpt-image-2-all",
            aspectRatio: "1:1",
          },
          output: {
            status: "queued",
            jobId: "job-pending-image",
          },
        }}
      />,
    );

    expect(screen.getByText("图片生成中...")).toBeInTheDocument();
    expect(screen.getAllByText("Gpt Image 2 All").length).toBeGreaterThan(0);
  });

  it("refreshes an expired persisted image URL from its completed job", async () => {
    const onWaitGeneration = vi.fn().mockResolvedValue({
      status: "succeeded",
      result: { signed_url: "https://example.com/fresh.png" },
    });
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-image-result",
          toolName: "generate_image",
          status: "completed",
          artifacts: [
            {
              type: "image",
              url: "https://example.com/expired.png",
              mimeType: "image/png",
              width: 1024,
              height: 1024,
              title: "生成结果",
              jobId: "job-1",
            },
          ],
        }}
        onWaitGeneration={onWaitGeneration}
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "生成结果" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "生成结果" })).toHaveAttribute(
        "src",
        "https://example.com/fresh.png",
      ),
    );
    expect(onWaitGeneration).toHaveBeenCalledWith("job-1");
  });

  it("renders only server-provided generation billing details", () => {
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-image-billing",
          toolName: "generate_image",
          status: "completed",
          output: {
            billing: {
              estimate: 8,
              charged: 8,
              balanceAfter: 92,
              currency: "credits",
            },
          },
        }}
      />,
    );

    const summary = screen.getByLabelText("生成积分明细");
    expect(summary).toHaveTextContent("预计 8 积分");
    expect(summary).toHaveTextContent("已扣 8 积分");
    expect(summary).toHaveTextContent("余额 92");
  });

  it("retries only a failed retryable inspect_canvas execution", async () => {
    const onRetryRead = vi.fn().mockResolvedValue({ status: "completed" });
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolExecutionId: "11111111-1111-4111-8111-111111111111",
          toolCallId: "tool-inspect-failed",
          toolName: "inspect_canvas",
          status: "failed",
          retryable: true,
        }}
        onRetryRead={onRetryRead}
      />,
    );

    const button = screen.getByRole("button", { name: "重新读取" });
    await userEvent.click(button);
    expect(onRetryRead).toHaveBeenCalledOnce();
    expect(onRetryRead).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(await screen.findByText("已重新读取画布")).toBeInTheDocument();
  });

  it("never offers read retry for a side-effect tool", () => {
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolExecutionId: "22222222-2222-4222-8222-222222222222",
          toolCallId: "tool-write-failed",
          toolName: "manipulate_canvas",
          status: "failed",
          retryable: true,
        }}
        onRetryRead={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "重新读取" }),
    ).not.toBeInTheDocument();
  });

  it("continues waiting for the same timed-out job and restores it once", async () => {
    const onWaitGeneration = vi.fn().mockResolvedValue({
      status: "succeeded",
      result: { object_path: "generated/image.png" },
    });
    let resolveRestore!: (value: {
      jobId: string;
      canvasId: string;
      elementId: string;
      inserted: boolean;
    }) => void;
    const onRestoreGeneration = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveRestore = resolve;
      }),
    );

    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-timeout",
          toolName: "generate_image",
          status: "completed",
          output: {
            jobId: "job-1",
            jobType: "image_generation",
            error: "Job timed out after 240s",
          },
        }}
        onWaitGeneration={onWaitGeneration}
        onRestoreGeneration={onRestoreGeneration}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "继续等待" }));
    expect(onWaitGeneration).toHaveBeenCalledTimes(1);
    expect(onWaitGeneration).toHaveBeenCalledWith("job-1");

    const restore = await screen.findByRole("button", { name: "恢复到画布" });
    await userEvent.click(restore);
    await userEvent.click(restore);
    expect(onRestoreGeneration).toHaveBeenCalledTimes(1);
    expect(restore).toBeDisabled();

    resolveRestore({
      jobId: "job-1",
      canvasId: "canvas-1",
      elementId: "element-1",
      inserted: true,
    });
    expect(await screen.findByText("已恢复到画布")).toBeInTheDocument();
  });

  it.each([
    ["inspect_canvas", { jobId: "job-1", error: "timed out" }],
    [
      "generate_video",
      { jobId: "job-2", jobStatus: "canceled", error: "canceled" },
    ],
    [
      "generate_image",
      {
        jobId: "job-3",
        imageUrl: "https://example.test/a.png",
        elementId: "el-3",
      },
    ],
  ])(
    "does not offer generation recovery for %s with ineligible output",
    async (toolName, output) => {
      render(
        <ToolBlockView
          block={{
            type: "tool",
            toolCallId: `tool-${toolName}`,
            toolName,
            status: "completed",
            output,
          }}
          onWaitGeneration={vi.fn()}
          onRestoreGeneration={vi.fn()}
        />,
      );
      await waitFor(() => {
        expect(
          screen.queryByRole("button", { name: "继续等待" }),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: "恢复到画布" }),
        ).not.toBeInTheDocument();
      });
    },
  );
});
