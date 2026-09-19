import { beforeEach, describe, expect, it, vi } from "vitest";

const insertImageElement = vi.hoisted(() => vi.fn());
const markImageGenerationPlaceholderFailed = vi.hoisted(() => vi.fn());
const removeCompletedImagePlaceholder = vi.hoisted(() => vi.fn());

vi.mock("../canvas/canvas-element-writer.js", () => ({
  insertImageElement,
  markImageGenerationPlaceholderFailed,
  removeCompletedImagePlaceholder,
}));

import {
  finalizeDesignImageJobChat,
  finalizeImageJobToCanvas,
  finalizeTerminalImageJobPlaceholder,
  finalizeTerminalVideoJobPlaceholder,
  videoTerminalSummary,
  reconcileSucceededDesignImageChats,
  reconcileSucceededImageJobs,
  reconcileTerminalImageJobChats,
  reconcileTerminalImageJobPlaceholders,
} from "./job-canvas-finalizer.js";

function createAdmin() {
  const eqStatus = vi.fn(async () => ({ error: null }));
  const eqId = vi.fn(() => ({ eq: eqStatus }));
  const update = vi.fn(() => ({ eq: eqId }));
  // The chat card is now written with update-only, scoped to the placeholder row
  // the submitter created (id === job id). It must NOT resurrect a row that the
  // user deleted through "edit and resend".
  const chatUpdate = vi.fn(() => ({
    eq: () => ({ eq: () => ({ select: vi.fn(async () => ({ data: [{ id: "chat-card" }], error: null })) }) }),
  }));
  // Other chat-card paths (design delivery, terminal placeholders) still upsert.
  const upsert = vi.fn(async () => ({ error: null }));
  return {
    admin: {
      from: vi.fn((table: string) =>
        table === "chat_messages" ? { update: chatUpdate, upsert } : { update },
      ),
    },
    update,
    chatUpdate,
    upsert,
    eqId,
    eqStatus,
  };
}

const successfulJob = {
  id: "job-1",
  workspace_id: "workspace-1",
  canvas_id: "canvas-1",
  target_kind: "canvas",
  design_id: null,
  session_id: null,
  job_type: "image_generation",
  status: "succeeded",
  payload: { auto_finalize_canvas: true, title: "Logo" },
  result: {
    asset_id: "asset-1",
    object_path: "workspace/generated/logo.png",
    width: 1024,
    height: 1024,
    mime_type: "image/png",
  },
} as const;

describe("image job canvas finalization", () => {
  it("preserves durable zero-cost Low 2K metadata when replacing a queued card with success", async () => {
    const { admin, chatUpdate } = createAdmin();
    insertImageElement.mockResolvedValue({ elementId: "element", inserted: true });
    await finalizeImageJobToCanvas(admin as never, { ...successfulJob, session_id: "session-1",
      payload: { ...successfulJob.payload, quality: "standard", resolution: "2k", mastra_credits_cost: 0, mastra_pricing_version: "credits-v1" },
      result: { ...successfulJob.result, signed_url: "https://example.com/generated.png" } });
    // Update-only, scoped to the placeholder the submitter wrote (id === job id).
    expect(chatUpdate).toHaveBeenCalledWith(expect.objectContaining({ content_blocks: [expect.objectContaining({ output: expect.objectContaining({
      creditsCost: 0, pricingVersion: "credits-v1", actualQuality: "Low", actualResolution: "2K", status: "succeeded",
    }) })] }));
  });

  it("does not resurrect a chat card whose placeholder the user deleted via edit", async () => {
    const { admin, chatUpdate, update } = createAdmin();
    // The "edit and resend" path deleted the placeholder, so the scoped update
    // matches nothing. The canvas result must still be recorded.
    chatUpdate.mockImplementationOnce(() => ({
      eq: () => ({ eq: () => ({ select: vi.fn(async () => ({ data: [], error: null })) }) }),
    }));
    insertImageElement.mockResolvedValue({ elementId: "element", inserted: true });
    await finalizeImageJobToCanvas(admin as never, { ...successfulJob, session_id: "session-1",
      result: { ...successfulJob.result, signed_url: "https://example.com/generated.png" } });
    // chat_finalized_at is still stamped so a recovery scan stops retrying.
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ chat_finalized_at: expect.any(String) }),
    }));
  });
  beforeEach(() => {
    insertImageElement.mockReset();
    markImageGenerationPlaceholderFailed.mockReset();
    removeCompletedImagePlaceholder.mockReset();
    markImageGenerationPlaceholderFailed.mockResolvedValue(true);
  });

  it.each([
    ["dead_letter", "图片生成失败"],
    ["canceled", "生成已取消"],
  ])("settles a %s placeholder for the exact terminal job and records recovery", async (status, message) => {
    const { admin, update, eqId, eqStatus } = createAdmin();
    const terminal = { ...successfulJob, status, payload: { ...successfulJob.payload,
      placeholder_element_id: "placeholder-1", target: { kind: "canvas", canvas_id: "canvas-1", element_id: "placeholder-1" } },
      result: null };
    await expect(finalizeTerminalImageJobPlaceholder(admin as never, terminal as never)).resolves.toBe(true);
    expect(markImageGenerationPlaceholderFailed).toHaveBeenCalledExactlyOnceWith(
      admin, "canvas-1", "placeholder-1", "job-1", message,
    );
    expect(update).toHaveBeenCalledWith({ result: expect.objectContaining({
      canvas_terminal_finalized_at: expect.any(String), canvas_terminal_status: status,
    }) });
    expect(eqId).toHaveBeenCalledWith("id", "job-1");
    expect(eqStatus).toHaveBeenCalledWith("status", status);
  });

  it("does not settle a retryable failure, success, design target, mismatched canvas, or already checked job", async () => {
    const { admin, update } = createAdmin();
    const payload = { placeholder_element_id: "placeholder-1", target: { kind: "canvas", canvas_id: "canvas-1" } };
    const variants = [
      { ...successfulJob, status: "failed", payload },
      { ...successfulJob, status: "succeeded", payload },
      { ...successfulJob, status: "dead_letter", target_kind: "design", payload },
      { ...successfulJob, status: "dead_letter", payload: { ...payload, target: { kind: "canvas", canvas_id: "other" } } },
      { ...successfulJob, status: "dead_letter", payload, result: { canvas_terminal_finalized_at: "done" } },
    ];
    for (const job of variants)
      await expect(finalizeTerminalImageJobPlaceholder(admin as never, job as never)).resolves.toBe(false);
    expect(markImageGenerationPlaceholderFailed).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ["provider_rejected", true, "当前兼容图片渠道均明确拒绝"],
    ["image_generation_result_unknown", false, "图片生成结果不确定"],
  ])("durably replaces a running chat card for terminal %s without offering an automatic retry", async (errorCode, retryEligible, summaryText) => {
    const { admin, update, upsert } = createAdmin();
    const terminal = {
      ...successfulJob,
      session_id: "session-1",
      target_kind: "design",
      status: "dead_letter",
      error_code: errorCode,
      error_message: "bounded provider detail",
      payload: { ...successfulJob.payload, mastra_submission_key: "run:digest" },
      result: null,
    };

    await expect(finalizeTerminalImageJobPlaceholder(admin as never, terminal as never)).resolves.toBe(true);
    expect(markImageGenerationPlaceholderFailed).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: "job-1",
      session_id: "session-1",
      content: expect.stringContaining(summaryText),
      content_blocks: [expect.objectContaining({
        status: "failed",
        retryable: false,
        output: expect.objectContaining({
          status: "dead_letter",
          error_code: errorCode,
          retryEligible,
        }),
      })],
    }), { onConflict: "id" });
    expect(update).toHaveBeenCalledWith({ result: expect.objectContaining({
      chat_terminal_finalized_at: expect.any(String),
      chat_terminal_status: "dead_letter",
    }) });
  });

  it("recovers terminal design chat cards omitted by canvas-placeholder recovery", async () => {
    const terminal = { ...successfulJob, session_id: "session-1", target_kind: "design",
      canvas_id: null, status: "dead_letter", error_code: "provider_rejected", error_message: "no channel",
      payload: { ...successfulJob.payload, mastra_submission_key: "run:digest" }, result: null };
    const scan = {
      select: vi.fn(), eq: vi.fn(), in: vi.fn(), not: vi.fn(), is: vi.fn(), order: vi.fn(),
      limit: vi.fn(async () => ({ data: [terminal], error: null })),
    };
    scan.select.mockReturnValue(scan); scan.eq.mockReturnValue(scan); scan.in.mockReturnValue(scan);
    scan.not.mockReturnValue(scan); scan.is.mockReturnValue(scan); scan.order.mockReturnValue(scan);
    const upsert = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })) }));
    let backgroundReads = 0;
    const admin = { from: vi.fn((table: string) => {
      if (table === "chat_messages") return { upsert };
      backgroundReads += 1;
      return backgroundReads === 1 ? scan : { update };
    }) };

    await expect(reconcileTerminalImageJobChats(admin as never))
      .resolves.toEqual({ checked: 1, finalized: 1, failed: 0 });
    expect(scan.not).toHaveBeenCalledWith("session_id", "is", null);
    expect(scan.not).toHaveBeenCalledWith("payload->>mastra_submission_key", "is", null);
    expect(upsert).toHaveBeenCalled();
  });

  it("does not create a terminal chat card for a legacy image job without a Mastra placeholder", async () => {
    const { admin, upsert, update } = createAdmin();
    await expect(finalizeTerminalImageJobPlaceholder(admin as never, {
      ...successfulJob,
      session_id: "session-legacy",
      target_kind: "design",
      status: "dead_letter",
      error_code: "provider_rejected",
      result: null,
    } as never)).resolves.toBe(false);
    expect(upsert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  // Video jobs used to have no terminal path at all: the image finalizer returns
  // immediately for another job_type, so a failed video left its chat card at
  // "processing" and the user never learned that nothing was coming.
  it("settles a terminal video job with code-derived copy instead of the raw provider error", async () => {
    const { admin, upsert } = createAdmin();
    const rawProviderError = "Video generation failed for model workspace:debd662d: Invalid token. (request id: 2026091911215231969217496e93ae325D4nIF1)";
    const settled = await finalizeTerminalVideoJobPlaceholder(admin as never, {
      ...successfulJob,
      job_type: "video_generation",
      session_id: "session-video",
      status: "dead_letter",
      error_code: "http_401",
      error_message: rawProviderError,
      payload: { video_submission_key: "run:key", duration: 8, resolution: "1080p" },
      result: null,
    } as never);

    expect(settled).toBe(true);
    const card = (upsert.mock.calls[0] as unknown[])[0] as {
      content: string; content_blocks: Array<{ toolName: string; status: string; output: Record<string, unknown> }>;
    };
    expect(card.content).toBe(videoTerminalSummary("dead_letter", "http_401"));
    expect(card.content).toContain("凭据或配置无效");
    expect(card.content).not.toContain("workspace:");
    expect(card.content).not.toContain("request id");
    expect(card.content_blocks[0]).toMatchObject({
      toolName: "generate_video", status: "failed",
      output: { error_code: "http_401", durationSeconds: 8, resolution: "1080p" },
    });
    // The raw provider string must never be the user-visible copy.
    expect(JSON.stringify(card)).not.toContain("Invalid token");
  });

  it("ignores a video job that is not terminal, not Mastra-submitted, or already settled", async () => {
    const cases = [
      { status: "succeeded" as const, payload: { video_submission_key: "run:key" }, result: null },
      { status: "dead_letter" as const, payload: {}, result: null },
      { status: "dead_letter" as const, payload: { video_submission_key: "run:key" },
        result: { chat_terminal_finalized_at: "2026-09-19T11:00:00.000Z" } },
    ];
    for (const entry of cases) {
      const { admin, upsert } = createAdmin();
      await expect(finalizeTerminalVideoJobPlaceholder(admin as never, {
        ...successfulJob, job_type: "video_generation", session_id: "session-video",
        error_code: "http_401", ...entry,
      } as never)).resolves.toBe(false);
      expect(upsert).not.toHaveBeenCalled();
    }
  });

  it("recovers a previously archived terminal placeholder once and persists its marker", async () => {
    const terminal = { ...successfulJob, status: "dead_letter", payload: {
      placeholder_element_id: "placeholder-recovery", target: { kind: "canvas", canvas_id: "canvas-1" },
    }, result: null };
    const scan = {
      select: vi.fn(), eq: vi.fn(), in: vi.fn(), is: vi.fn(), order: vi.fn(),
      limit: vi.fn(async () => ({ data: [terminal], error: null })),
    };
    scan.select.mockReturnValue(scan); scan.eq.mockReturnValue(scan); scan.in.mockReturnValue(scan);
    scan.is.mockReturnValue(scan); scan.order.mockReturnValue(scan);
    const eqStatus = vi.fn(async () => ({ error: null }));
    const eqId = vi.fn(() => ({ eq: eqStatus }));
    const update = vi.fn(() => ({ eq: eqId }));
    const admin = { from: vi.fn()
      .mockReturnValueOnce(scan)
      .mockReturnValueOnce({ update }) };

    await expect(reconcileTerminalImageJobPlaceholders(admin as never))
      .resolves.toEqual({ checked: 1, finalized: 1, failed: 0 });
    expect(scan.is).toHaveBeenCalledWith("result->>canvas_terminal_finalized_at", null);
    expect(markImageGenerationPlaceholderFailed).toHaveBeenCalledWith(
      admin, "canvas-1", "placeholder-recovery", "job-1", "图片生成失败",
    );
    expect(update).toHaveBeenCalledWith({ result: expect.objectContaining({
      canvas_terminal_status: "dead_letter", canvas_terminal_finalized_at: expect.any(String),
    }) });
  });

  it("retains a late successful asset without attaching it or marking generation failed", async () => {
    insertImageElement.mockRejectedValue(new Error("Failed to write canvas: agent_task_superseded"));
    const { admin, update, eqStatus, upsert } = createAdmin();
    await expect(finalizeImageJobToCanvas(admin as never, successfulJob)).resolves.toBeNull();
    expect(update).toHaveBeenCalledWith({ result: expect.objectContaining({
      asset_id: successfulJob.result.asset_id,
      attachment_status: "superseded",
      canvas_finalized_at: expect.any(String),
    }) });
    expect(eqStatus).toHaveBeenCalledWith("status", "succeeded");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("persists a terminal not-applied chat result when a current-task guard rejects attachment", async () => {
    insertImageElement.mockRejectedValue(new Error("Failed to write canvas: agent_task_superseded"));
    const { admin, update, upsert } = createAdmin();
    await expect(finalizeImageJobToCanvas(admin as never, {
      ...successfulJob,
      session_id: "session-1",
      result: {
        ...successfulJob.result,
        signed_url: "https://example.com/retained.png",
      },
    } as never)).resolves.toBeNull();

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: "job-1",
      session_id: "session-1",
      content: expect.stringContaining("未应用到当前画布"),
      content_blocks: [expect.objectContaining({
        status: "completed",
        output: expect.objectContaining({
          status: "succeeded",
          finalization_status: "needs_attention",
          attachment_status: "superseded",
          error_code: "agent_task_superseded",
        }),
        artifacts: [expect.objectContaining({
          url: "https://example.com/retained.png",
          jobId: "job-1",
        })],
      })],
    }), { onConflict: "id" });
    expect(update).toHaveBeenCalledWith({ result: expect.objectContaining({
      attachment_status: "superseded",
      canvas_finalized_at: expect.any(String),
      chat_finalized_at: expect.any(String),
    }) });
  });

  it("never inserts a standalone matting preview before user confirmation", async () => {
    const { admin, update, upsert } = createAdmin();
    const outcome = await finalizeImageJobToCanvas(admin as never, {
      ...successfulJob, canvas_id: null, target_kind: null,
      payload: { operation: "remove_background", target: null },
    } as never);
    expect(outcome).toBeNull();
    expect(insertImageElement).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("inserts a successful opted-in image and records a durable marker", async () => {
    insertImageElement.mockResolvedValue({
      elementId: "element-1",
      inserted: true,
    });
    const { admin, update, eqId, eqStatus } = createAdmin();

    const outcome = await finalizeImageJobToCanvas(
      admin as never,
      successfulJob as never,
    );

    expect(outcome).toEqual({ elementId: "element-1", inserted: true });
    expect(insertImageElement).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({
        canvasId: "canvas-1",
        sourceJobId: "job-1",
        assetId: "asset-1",
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          canvas_element_id: "element-1",
          canvas_finalized_at: expect.any(String),
        }),
      }),
    );
    expect(eqId).toHaveBeenCalledWith("id", "job-1");
    expect(eqStatus).toHaveBeenCalledWith("status", "succeeded");
  });

  it("does nothing after the durable finalization marker exists", async () => {
    const { admin, update } = createAdmin();
    const outcome = await finalizeImageJobToCanvas(
      admin as never,
      {
        ...successfulJob,
        result: {
          ...successfulJob.result,
          canvas_finalized_at: new Date().toISOString(),
        },
      } as never,
    );

    expect(outcome).toBeNull();
    expect(insertImageElement).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("places a replacement result beside its source image", async () => {
    insertImageElement.mockResolvedValue({
      elementId: "element-2",
      inserted: true,
    });
    const { admin } = createAdmin();

    await finalizeImageJobToCanvas(
      admin as never,
      {
        ...successfulJob,
        payload: {
          ...successfulJob.payload,
          placement_x: 552,
          placement_y: 20,
          placement_width: 512,
          placement_height: 512,
          placeholder_element_id: "placeholder-1",
        },
      } as never,
    );

    expect(insertImageElement).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({
        canvasId: "canvas-1",
        replaceElementId: "placeholder-1",
      }),
      { x: 552, y: 20, width: 512, height: 512 },
    );
  });

  it("persists one durable chat image result for a session job", async () => {
    insertImageElement.mockResolvedValue({
      elementId: "element-3",
      inserted: true,
    });
    const { admin, chatUpdate, update } = createAdmin();

    await finalizeImageJobToCanvas(
      admin as never,
      {
        ...successfulJob,
        session_id: "session-1",
        result: {
          ...successfulJob.result,
          signed_url: "https://example.com/generated.png",
        },
      } as never,
    );

    expect(chatUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        content_blocks: [
          expect.objectContaining({
            toolName: "generate_image",
            artifacts: [expect.objectContaining({ jobId: "job-1" })],
          }),
        ],
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          chat_finalized_at: expect.any(String),
        }),
      }),
    );
  });

  it.each([undefined, "semantic"])("restores split layers and settles only the placeholder (%s)", async (layerBackend) => {
    insertImageElement
      .mockResolvedValueOnce({
        elementId: "background-element",
        inserted: true,
      })
      .mockResolvedValueOnce({
        elementId: "foreground-element",
        inserted: true,
      });
    const { admin, update } = createAdmin();

    const outcome = await finalizeImageJobToCanvas(
      admin as never,
      {
        ...successfulJob,
        payload: {
          auto_finalize_canvas: true,
          operation: "split_layers",
          layer_backend: layerBackend,
          prompt: "拆分图层",
          placement_x: 100,
          placement_y: 200,
          placement_width: 512,
          placement_height: 256,
          placeholder_element_id: "split-placeholder",
        },
        result: {
          ...successfulJob.result,
          source_width: 1024,
          source_height: 512,
          layers: [
            {
              kind: "background",
              asset_id: "asset-bg",
              object_path: "bg.png",
              width: 1024,
              height: 512,
              x: 0,
              y: 0,
            },
            {
              kind: "element",
              asset_id: "asset-fg",
              object_path: "fg.png",
              width: 256,
              height: 128,
              x: 128,
              y: 64,
            },
          ],
        },
      } as never,
    );

    expect(outcome).toEqual({
      elementId: "background-element",
      inserted: true,
    });
    expect(insertImageElement).toHaveBeenNthCalledWith(
      1,
      admin,
      expect.objectContaining({
        sourceJobId: "job-1:background:0",
        ...(layerBackend === "semantic" ? {} : { replaceElementId: "split-placeholder" }),
      }),
      { x: 100, y: 200, width: 512, height: 256 },
    );
    expect(insertImageElement).toHaveBeenNthCalledWith(
      2,
      admin,
      expect.objectContaining({
        sourceJobId: "job-1:element:1",
      }),
      { x: 164, y: 232, width: 128, height: 64 },
    );
    if (layerBackend === "semantic") {
      expect(removeCompletedImagePlaceholder).toHaveBeenCalledExactlyOnceWith(admin, "canvas-1", "split-placeholder", "job-1");
      expect(insertImageElement.mock.calls[0]?.[1]).not.toHaveProperty("replaceElementId");
      expect(removeCompletedImagePlaceholder.mock.invocationCallOrder[0]).toBeGreaterThan(insertImageElement.mock.invocationCallOrder[1]!);
    } else expect(removeCompletedImagePlaceholder).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          canvas_element_id: "background-element",
          canvas_layer_ids: ["background-element", "foreground-element"],
        }),
      }),
    );
  });

  it("does not send a design-target job through the Canvas finalizer", async () => {
    const { admin } = createAdmin();
    const outcome = await finalizeImageJobToCanvas(
      admin as never,
      {
        ...successfulJob,
        canvas_id: null,
        target_kind: "design",
        design_id: "design-1",
        payload: {
          prompt: "logo",
          target: {
            kind: "design",
            design_id: "design-1",
            expected_revision: 1,
            idempotency_key: "command-1",
          },
        },
      } as never,
    );

    expect(outcome).toBeNull();
    expect(insertImageElement).not.toHaveBeenCalled();
  });

  it("persists a recoverable completed chat card for a design-target image", async () => {
    const { admin, upsert, update } = createAdmin();
    const finalized = await finalizeDesignImageJobChat(
      admin as never,
      {
        ...successfulJob,
        canvas_id: null,
        target_kind: "design",
        design_id: "20000000-0000-4000-8000-000000000001",
        session_id: "session-1",
        result: {
          ...successfulJob.result,
          signed_url: "https://example.com/design-image.png",
        },
      } as never,
      {
        status: "completed",
        result: {
          design_id: "20000000-0000-4000-8000-000000000001",
          object_id: "30000000-0000-4000-8000-000000000001",
          revision: 4,
        },
      } as never,
    );

    expect(finalized).toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "job-1",
        content_blocks: [
          expect.objectContaining({
            output: expect.objectContaining({
              status: "succeeded",
              design_id: "20000000-0000-4000-8000-000000000001",
              object_id: "30000000-0000-4000-8000-000000000001",
              revision: 4,
            }),
          }),
        ],
      }),
      { onConflict: "id" },
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          chat_finalized_at: expect.any(String),
        }),
      }),
    );
  });

  it.each(["needs_attention", "failed"] as const)(
    "persists a truthful terminal chat card when design delivery is %s",
    async (status) => {
      const { admin, upsert, update } = createAdmin();
      const finalized = await finalizeDesignImageJobChat(
        admin as never,
        {
          ...successfulJob,
          canvas_id: null,
          target_kind: "design",
          design_id: "20000000-0000-4000-8000-000000000001",
          session_id: "session-1",
          result: {
            ...successfulJob.result,
            signed_url: "https://example.com/retained-image.png",
          },
        } as never,
        {
          status,
          result: null,
          error_code: "design_revision_conflict",
          error_message: "设计已发生变化，图片未应用。",
        } as never,
      );

      expect(finalized).toBe(true);
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "job-1",
          content: expect.stringContaining("图片已生成"),
          content_blocks: [
            expect.objectContaining({
              status: "completed",
              output: expect.objectContaining({
                status: "succeeded",
                finalization_status: status,
                error: "设计已发生变化，图片未应用。",
              }),
              artifacts: [
                expect.objectContaining({
                  url: "https://example.com/retained-image.png",
                  jobId: "job-1",
                }),
              ],
            }),
          ],
        }),
        { onConflict: "id" },
      );
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          result: expect.objectContaining({
            chat_finalized_at: expect.any(String),
          }),
        }),
      );
    },
  );

  it("requests a database-prefiltered recovery batch so 100 dead assets cannot hide a live job", async () => {
    const unfinished = {
      ...successfulJob,
      id: "old-unfinished-job",
    };
    const databaseRows = [
      ...Array.from({ length: 100 }, (_, index) => ({
        ...successfulJob,
        id: `dead-asset-job-${index}`,
        result: { ...successfulJob.result, asset_id: `dead-asset-${index}` },
      })),
      unfinished,
    ];
    const databaseLiveAssets = new Set<string>([successfulJob.result.asset_id]);
    insertImageElement.mockResolvedValue({
      elementId: "recovered-element",
      inserted: true,
    });
    const backgroundQuery: any = {
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(async () => ({ error: null })),
        })),
      })),
    };
    const assetQuery: any = {
      select: vi.fn(() => assetQuery),
      in: vi.fn(() => assetQuery),
      is: vi.fn(async () => ({
        data: [{
          id: successfulJob.result.asset_id,
          workspace_id: successfulJob.workspace_id,
        }],
        error: null,
      })),
    };
    const admin = {
      rpc: vi.fn(async (_name: string, input: { p_limit: number }) => ({
        data: databaseRows
          .filter(job => databaseLiveAssets.has(job.result.asset_id))
          .slice(0, input.p_limit),
        error: null,
      })),
      from: vi.fn((table: string) =>
        table === "asset_objects" ? assetQuery : backgroundQuery,
      ),
    };

    await expect(reconcileSucceededImageJobs(admin as never)).resolves.toEqual({
      checked: 1,
      finalized: 1,
      failed: 0,
    });
    expect(admin.rpc).toHaveBeenCalledWith(
      "loomic_recoverable_canvas_image_jobs",
      { p_limit: 100 },
    );
    expect(assetQuery.select).toHaveBeenCalledWith("id,workspace_id");
    expect(assetQuery.in).toHaveBeenCalledWith("id", [
      successfulJob.result.asset_id,
    ]);
    expect(assetQuery.is).toHaveBeenCalledWith("deletion_pending_at", null);
    expect(insertImageElement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceJobId: "old-unfinished-job" }),
    );
  });

  it("filters 100 pending design finalizations before limiting the terminal chat batch", async () => {
    const pending = {
      ...successfulJob,
      id: "pending-job",
      canvas_id: null,
      target_kind: "design",
      design_id: "20000000-0000-4000-8000-000000000001",
      session_id: "session-1",
      result: {
        ...successfulJob.result,
        signed_url: "https://example.com/pending.png",
      },
    };
    const pendingRows = Array.from({ length: 100 }, (_, index) => ({
      ...pending,
      id: `pending-${index}`,
    }));
    const databaseRows = [...pendingRows, pending];
    const terminalJobIds = new Set([pending.id]);
    const backgroundQuery = {
      update: vi.fn(() => ({
        eq: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
      })),
    };
    const finalizationQuery = {
      select: vi.fn(() => finalizationQuery),
      eq: vi.fn(() => finalizationQuery),
      maybeSingle: vi.fn(async () => ({
        data: {
          job_id: pending.id,
          command_id: "30000000-0000-4000-8000-000000000001",
          status: "completed",
          result: {
            design_id: pending.design_id,
            object_id: "40000000-0000-4000-8000-000000000001",
            revision: 4,
          },
          error_code: null,
          error_message: null,
          created_at: "2026-09-04T00:00:00Z",
          updated_at: "2026-09-04T00:00:00Z",
        },
        error: null,
      })),
    };
    const upsert = vi.fn(async () => ({ error: null }));
    const admin = {
      rpc: vi.fn(async (_name: string, input: { p_limit: number }) => ({
        data: databaseRows
          .filter(job => terminalJobIds.has(job.id))
          .slice(0, input.p_limit),
        error: null,
      })),
      from: vi.fn((table: string) => {
        if (table === "background_jobs") return backgroundQuery;
        if (table === "job_target_finalizations") return finalizationQuery;
        return { upsert };
      }),
    };

    await expect(
      reconcileSucceededDesignImageChats(admin as never),
    ).resolves.toEqual({ finalized: 1, failed: 0 });
    expect(admin.rpc).toHaveBeenCalledWith(
      "loomic_recoverable_design_image_chats",
      { p_limit: 100 },
    );
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
