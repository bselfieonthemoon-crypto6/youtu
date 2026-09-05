import { beforeEach, describe, expect, it, vi } from "vitest";

const insertImageElement = vi.hoisted(() => vi.fn());

vi.mock("../canvas/canvas-element-writer.js", () => ({
  insertImageElement,
}));

import {
  finalizeDesignImageJobChat,
  finalizeImageJobToCanvas,
  reconcileSucceededDesignImageChats,
} from "./job-canvas-finalizer.js";

function createAdmin() {
  const eqStatus = vi.fn(async () => ({ error: null }));
  const eqId = vi.fn(() => ({ eq: eqStatus }));
  const update = vi.fn(() => ({ eq: eqId }));
  const upsert = vi.fn(async () => ({ error: null }));
  return {
    admin: {
      from: vi.fn((table: string) =>
        table === "chat_messages" ? { upsert } : { update },
      ),
    },
    update,
    upsert,
    eqId,
    eqStatus,
  };
}

const successfulJob = {
  id: "job-1",
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
  beforeEach(() => {
    insertImageElement.mockReset();
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
    const { admin, upsert, update } = createAdmin();

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

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "job-1",
        session_id: "session-1",
        content_blocks: [
          expect.objectContaining({
            toolName: "generate_image",
            artifacts: [expect.objectContaining({ jobId: "job-1" })],
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

  it("restores a split background and foreground elements at matching canvas coordinates", async () => {
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
        replaceElementId: "split-placeholder",
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

  it("filters finalized chats before limiting the reconciliation batch", async () => {
    let pendingFilter = false;
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
    const completed = Array.from({ length: 100 }, (_, index) => ({
      ...pending,
      id: `completed-${index}`,
      result: { ...pending.result, chat_finalized_at: "2026-09-04T00:00:00Z" },
    }));
    const backgroundQuery = {
      select: vi.fn(() => backgroundQuery),
      eq: vi.fn(() => backgroundQuery),
      not: vi.fn(() => backgroundQuery),
      is: vi.fn((column: string) => {
        if (column === "result->>chat_finalized_at") pendingFilter = true;
        return backgroundQuery;
      }),
      order: vi.fn(() => backgroundQuery),
      limit: vi.fn(async () => ({
        data: pendingFilter ? [pending] : completed,
        error: null,
      })),
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
      from: vi.fn((table: string) => {
        if (table === "background_jobs") return backgroundQuery;
        if (table === "job_target_finalizations") return finalizationQuery;
        return { upsert };
      }),
    };

    await expect(
      reconcileSucceededDesignImageChats(admin as never),
    ).resolves.toEqual({ finalized: 1, failed: 0 });
    expect(pendingFilter).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
