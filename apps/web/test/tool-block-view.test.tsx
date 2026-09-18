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
import { GenerationCanvasPresenceProvider } from "../src/components/chat/generation-canvas-presence";

afterEach(() => cleanup());

describe("ToolBlockView", () => {
  it.each(["queued", "processing", "succeeded", "finished"])("shows the server image cost receipt for %s", (status) => {
    render(<ToolBlockView block={{ type: "tool", toolCallId: `cost-${status}`, toolName: "generate_image", status: "completed", output: { status, creditsCost: 7, pricingVersion: "credits-v1", actualQuality: "Low", actualResolution: "1K" } }} />);
    expect(screen.getByLabelText("图片任务成本回执")).toHaveTextContent("本次任务 7 积分");
    expect(screen.getByLabelText("图片任务成本回执")).toHaveTextContent("计价 credits-v1");
  });
  it.each(["failed", "canceled", "refunded"])("does not call a non-submitted %s result a cost receipt", (status) => {
    render(<ToolBlockView block={{ type: "tool", toolCallId: `no-cost-${status}`, toolName: "generate_image", status: "failed", output: { status, creditsCost: 7, pricingVersion: "credits-v1", actualQuality: "Low", actualResolution: "1K" } }} />);
    expect(screen.queryByLabelText("图片任务成本回执")).not.toBeInTheDocument();
  });
  it.each([
    { status: "queued", visible: true }, { status: "processing", visible: true },
    { status: "succeeded", visible: true }, { status: "finished", visible: true },
    { status: "failed", visible: false }, { status: "canceled", visible: false },
    { status: "dead_letter", visible: false }, { status: "refunded", visible: false },
  ].flatMap(state => ["generate_image", "edit_image"].flatMap(toolName =>
    [0, 7].map(cost => ({ ...state, toolName, cost })))))
    ("keeps $toolName $status receipt visibility at $cost credits", ({ status, visible, toolName, cost }) => {
      render(<ToolBlockView block={{ type: "tool", toolCallId: `cost-${status}`, toolName,
        status: visible ? "completed" : "failed", output: { status, creditsCost: cost,
          pricingVersion: "historic-v2", actualQuality: "Medium", actualResolution: "2K" } }} />);
      const receipt = screen.queryByLabelText("图片任务成本回执");
      if (!visible) expect(receipt).not.toBeInTheDocument();
      else {
        expect(receipt).toHaveTextContent(`本次任务 ${cost} 积分`);
        expect(receipt).toHaveTextContent("计价 historic-v2");
        expect(receipt).toHaveTextContent("质量 Medium");
        expect(receipt).toHaveTextContent("分辨率 2K");
        expect(receipt).not.toHaveTextContent("已扣");
      }
    });
  it("shows input correction rather than a failed paid generation", () => {
    render(<ToolBlockView block={{ type: "tool", toolCallId: "invalid", toolName: "edit_image", status: "completed",
      output: { error: true, message: "Tool input validation failed for edit_image", validationErrors: { errors: ["Unrecognized key"] } } }} />);
    expect(screen.getByText("参数需要调整")).toBeInTheDocument();
    expect(screen.queryByText("图片生成失败")).not.toBeInTheDocument();
  });
  it("renders a pre-submission refusal neutrally with the server summary, never the raw code", () => {
    const { container } = render(<ToolBlockView block={{ type: "tool", toolCallId: "refused-image", toolName: "edit_image", status: "completed",
      output: { status: "failed", error: "image_generation_run_limit", limit: 4, refused: true,
        summary: "本轮图片生成与编辑共用 4 张额度，已达到上限；未创建新任务、未扣费。请在新的用户请求中明确下一批输出。" } }} />);
    const card = screen.getByText("未提交生成").closest(".rounded-xl");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("本轮图片生成与编辑共用 4 张额度");
    expect(card?.textContent).toContain("未创建新任务、未扣费");
    expect(card?.className).toContain("amber");
    expect(card?.className).not.toContain("destructive");
    // The machine receipt — the raw code, the raw limit and `status: failed` — is
    // not repeated anywhere else in the block either.
    expect(container.textContent).not.toContain("image_generation_run_limit");
    expect(container.textContent).not.toContain("status: failed");
    expect(screen.queryByText("图片生成失败")).not.toBeInTheDocument();
  });
  it("still renders a post-submission failure as a destructive 图片生成失败 card", () => {
    render(<ToolBlockView block={{ type: "tool", toolCallId: "failed-image", toolName: "edit_image", status: "completed",
      output: { status: "failed", error: "provider_unavailable" } }} />);
    expect(screen.getByText("图片生成失败")).toBeInTheDocument();
    expect(screen.queryByText("未提交生成")).not.toBeInTheDocument();
    const card = screen.getByText("图片生成失败").closest(".rounded-xl");
    expect(card?.textContent).toContain("provider_unavailable");
    expect(card?.className).toContain("destructive");
    // A genuine failure keeps its raw output preview exactly as before.
    expect(screen.getByText("error: provider_unavailable")).toBeInTheDocument();
  });
  it("falls back to the raw code when a receipt carries no summary", () => {
    render(<ToolBlockView block={{ type: "tool", toolCallId: "refused-no-summary", toolName: "edit_image", status: "completed",
      output: { status: "failed", error: "image_generation_run_limit", refused: true } }} />);
    const card = screen.getByText("未提交生成").closest(".rounded-xl");
    expect(card?.textContent).toContain("image_generation_run_limit");
    expect(screen.getAllByText("image_generation_run_limit")).toHaveLength(1);
  });
  it.each([undefined, false, "true"])("does not treat refused=%s as a pre-submission refusal", (refused) => {
    render(<ToolBlockView block={{ type: "tool", toolCallId: `not-refused-${String(refused)}`, toolName: "edit_image", status: "completed",
      output: { status: "failed", error: "image_generation_run_limit",
        summary: "本轮图片生成与编辑共用 4 张额度，已达到上限；未创建新任务、未扣费。",
        ...(refused === undefined ? {} : { refused }) } }} />);
    expect(screen.getByText("图片生成失败")).toBeInTheDocument();
    expect(screen.queryByText("未提交生成")).not.toBeInTheDocument();
    const card = screen.getByText("图片生成失败").closest(".rounded-xl");
    expect(card?.textContent).toContain("未创建新任务、未扣费");
    expect(card?.textContent).not.toContain("image_generation_run_limit");
  });
  it("keeps a video failure destructive with its own title", () => {
    render(<ToolBlockView block={{ type: "tool", toolCallId: "video-failed", toolName: "generate_video", status: "completed",
      output: { status: "failed", error: "视频渠道不可用，任务已停止" } }} />);
    expect(screen.getByText("视频生成失败")).toBeInTheDocument();
    expect(screen.queryByText("未提交生成")).not.toBeInTheDocument();
    const card = screen.getByText("视频生成失败").closest(".rounded-xl");
    expect(card?.textContent).toContain("视频渠道不可用，任务已停止");
    expect(card?.className).toContain("destructive");
  });
  it("keeps the cancellation copy even when a canceled receipt carries a summary", () => {
    render(<ToolBlockView block={{ type: "tool", toolCallId: "canceled-with-summary", toolName: "edit_image", status: "failed",
      output: { status: "canceled", error: "生成任务未完成", summary: "本轮已取消，未创建新任务、未扣费。" } }} />);
    expect(screen.getByText("图片生成已取消")).toBeInTheDocument();
    expect(screen.getByText("任务已取消，不会将后续结果放入画布")).toBeInTheDocument();
    expect(screen.queryByText("本轮已取消，未创建新任务、未扣费。")).not.toBeInTheDocument();
  });
  it("does not show retired visual acceptance copy on an unverified generated image", () => {
    render(<ToolBlockView block={{ type: "tool", toolCallId: "image-result", toolName: "generate_image", status: "completed",
      output: { status: "succeeded", visualStatus: "unverified" },
      artifacts: [{ type: "image", url: "https://example.com/image.png", mimeType: "image/png", width: 512, height: 512 }] }} />);
    expect(screen.queryByText(/尚未做视觉验收/)).not.toBeInTheDocument();
    expect(screen.queryByText(/可让 Agent 检查这张结果图/)).not.toBeInTheDocument();
  });
  it.each(["status", "jobStatus"])("presents canceled generation from %s without a failure or retry", (key) => {
    render(<ToolBlockView block={{ type: "tool", toolCallId: "canceled-job", toolName: "confirm_image_generation", status: "failed", output: { jobId: "job", [key]: "canceled", error: "生成任务未完成" } }} />);
    expect(screen.getByText("图片生成已取消")).toBeInTheDocument();
    expect(screen.getByText("任务已取消，不会将后续结果放入画布")).toBeInTheDocument();
    expect(screen.queryByText("图片生成失败")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续等待" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "放入画布" })).not.toBeInTheDocument();
  });
  it.each(["failed", "completed"] as const)("shows terminal provider errors for %s blocks without a generation placeholder", (status) => {
    render(<ToolBlockView block={{ type: "tool", toolCallId: "terminal", toolName: "confirm_image_generation", status, output: { jobId: "job", status: "dead_letter", error: "503 渠道不可用，任务已停止" } }} />);
    expect(screen.getByText("503 渠道不可用，任务已停止")).toBeInTheDocument();
    expect(screen.queryByText("正在生成图片")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续等待" })).not.toBeInTheDocument();
  });
  it("distinguishes proposal preparation from actual generation", () => {
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "proposal",
          toolName: "generate_image",
          status: "running",
        }}
      />,
    );
    expect(
      screen.getByText("正在准备图片方案（尚未生成）"),
    ).toBeInTheDocument();
    expect(screen.queryByText("正在生成图片")).not.toBeInTheDocument();
  });
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

  it("discloses a validated two-provider foreground pipeline before confirmation", () => {
    const { container } = render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-foreground-confirm",
          toolName: "generate_image",
          status: "completed",
          output: {
            status: "awaiting_confirmation",
            confirmation: {
              confirmationId: "confirm-foreground",
              kind: "image_generation",
              targets: [],
              details: {
                title: "Logo 前景",
                description: "生成后作为 Logo 图层插入。",
                model: "workspace:gpt-image-2-all",
                foregroundPolicy: {
                  version: 1,
                  mode: "api_matting",
                  generationModel: "workspace:gpt-image-2-all",
                  mattingModel: "workspace:gpt-image-2",
                  generationCredits: 12,
                  mattingCredits: 2,
                  totalCredits: 14,
                  pricingVersion: "credits-v1",
                  providerCalls: 2,
                  summary: "先生成，再调用 gpt-image-2 API 去背景；去背景可能改变主体细节。",
                  billingNote: "积分按平台配置计算；<script>不会作为 HTML 执行</script>",
                },
              },
            },
          },
        }}
      />,
    );

    expect(screen.getByLabelText("前景处理与费用")).toHaveTextContent(
      "先生成，再调用 gpt-image-2 API 去背景",
    );
    expect(screen.getByText(/服务调用（2 次）/)).toHaveTextContent(
      "workspace:gpt-image-2-all → workspace:gpt-image-2",
    );
    expect(screen.getByText("合计 14 积分")).toBeInTheDocument();
    expect(screen.getByText(/不会作为 HTML 执行/)).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });

  it("does not render an incomplete or arithmetically inconsistent foreground disclosure", () => {
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-invalid-foreground-confirm",
          toolName: "generate_image",
          status: "completed",
          output: {
            error: "confirmation_required",
            confirmation: {
              confirmationId: "confirm-invalid-foreground",
              kind: "image_generation",
              targets: [],
              details: {
                title: "普通图片",
                foregroundPolicy: {
                  version: 1,
                  mode: "api_matting",
                  generationModel: "workspace:gpt-image-2-all",
                  mattingModel: "workspace:gpt-image-2",
                  generationCredits: 12,
                  mattingCredits: 2,
                  totalCredits: 1,
                  pricingVersion: "credits-v1",
                  providerCalls: 2,
                  summary: "伪造费用",
                  billingNote: "伪造说明",
                },
              },
            },
          },
        }}
      />,
    );

    expect(screen.queryByLabelText("前景处理与费用")).not.toBeInTheDocument();
    expect(screen.queryByText("伪造费用")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("步骤或费用信息不完整");
    expect(screen.queryByRole("button", { name: "确认生成" })).not.toBeInTheDocument();
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

  it("shows a retained design image without claiming insertion or offering canvas restore", async () => {
    const onOpenDesign = vi.fn();
    const onRestoreGeneration = vi.fn();
    const designId = "10000000-0000-4000-8000-000000000001";
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-design-image-needs-attention",
          toolName: "generate_image",
          status: "completed",
          output: {
            status: "succeeded",
            jobId: "30000000-0000-4000-8000-000000000001",
            design_id: designId,
            finalization_status: "needs_attention",
            error: "设计版本已改变，图片素材已保留。",
          },
          artifacts: [
            {
              type: "image",
              url: "https://example.test/retained.png",
              mimeType: "image/png",
              width: 1024,
              height: 1024,
              jobId: "30000000-0000-4000-8000-000000000001",
            },
          ],
        }}
        onOpenDesign={onOpenDesign}
        onRestoreGeneration={onRestoreGeneration}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "图片已生成，但尚未应用到设计",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "设计版本已改变，图片素材已保留。",
    );
    expect(screen.queryByText("图片已插入设计")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "放入画布" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "打开原设计" }));
    expect(onOpenDesign).toHaveBeenCalledWith(designId);
    expect(onRestoreGeneration).not.toHaveBeenCalled();
  });

  it("does not offer a futile restore for an image rejected by the current-task guard", () => {
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-superseded-image",
          toolName: "generate_image",
          status: "completed",
          output: {
            status: "succeeded",
            jobId: "job-superseded",
            attachment_status: "superseded",
            finalization_status: "needs_attention",
            error: "图片已生成并保留；任务已更新，未应用到当前画布。",
          },
          outputSummary: "图片已生成并保留；任务已更新，未应用到当前画布。",
          artifacts: [{
            type: "image",
            url: "https://example.com/retained.png",
            mimeType: "image/png",
            width: 1024,
            height: 1024,
            jobId: "job-superseded",
          }],
        }}
        onRestoreGeneration={vi.fn()}
      />,
    );

    expect(screen.getByText(/未应用到当前画布/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "放入画布" })).not.toBeInTheDocument();
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
      { wrapper: ({ children }) => <GenerationCanvasPresenceProvider api={{ getSceneElementsIncludingDeleted: () => [], onChange: () => () => {} }}>{children}</GenerationCanvasPresenceProvider> },
    );

    await userEvent.click(screen.getByRole("button", { name: "继续等待" }));
    expect(onWaitGeneration).toHaveBeenCalledTimes(1);
    expect(onWaitGeneration).toHaveBeenCalledWith("job-1");

    const restore = await screen.findByRole("button", { name: "放入画布" });
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

  it("does not offer top-level canvas restore after observing a succeeded design job", async () => {
    const onWaitGeneration = vi.fn().mockResolvedValue({
      status: "succeeded",
      target_kind: "design",
      design_id: "10000000-0000-4000-8000-000000000001",
      result: { object_path: "generated/design-image.png" },
    });
    const onRestoreGeneration = vi.fn();

    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "tool-design-timeout",
          toolName: "generate_image",
          status: "completed",
          output: {
            jobId: "job-design",
            jobType: "image_generation",
            error: "Job timed out after 240s",
          },
        }}
        onWaitGeneration={onWaitGeneration}
        onRestoreGeneration={onRestoreGeneration}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "继续等待" }));
    await waitFor(() => {
      expect(onWaitGeneration).toHaveBeenCalledWith("job-design");
      expect(
      screen.queryByRole("button", { name: "放入画布" }),
      ).not.toBeInTheDocument();
    });
    expect(onRestoreGeneration).not.toHaveBeenCalled();
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
      screen.queryByRole("button", { name: "放入画布" }),
        ).not.toBeInTheDocument();
      });
    },
  );
});
