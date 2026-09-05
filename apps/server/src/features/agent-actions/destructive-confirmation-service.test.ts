import { describe, expect, it, vi } from "vitest";

import type { CanvasContent } from "@loomic/shared";
import {
  createDestructiveConfirmationService,
  DestructiveConfirmationError,
} from "./destructive-confirmation-service.js";

function canvas(version = 1): CanvasContent {
  return {
    elements: [
      {
        id: "shape-1",
        type: "rectangle",
        version,
        versionNonce: 101,
        isDeleted: false,
        boundElements: [{ id: "text-1", type: "text" }],
      },
      {
        id: "text-1",
        type: "text",
        text: "Label",
        version: 2,
        versionNonce: 202,
        isDeleted: false,
      },
    ],
    appState: {},
    files: {},
  } as CanvasContent;
}

describe("destructive confirmation service", () => {
  it("freezes a generic image action until the owner confirms", async () => {
    const execute = vi.fn(async () => ({ jobId: "job-1" }));
    const service = createDestructiveConfirmationService();
    const proposal = service.proposeAction({
      userId: "user-1",
      canvasId: "canvas-1",
      kind: "image_generation",
      details: { description: "Detailed logo prompt", model: "gpt-image-2-all" },
      execute,
    });

    expect(proposal).toEqual(
      expect.objectContaining({
        kind: "image_generation",
        details: expect.objectContaining({ model: "gpt-image-2-all" }),
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    await expect(
      service.confirm({
        confirmationId: proposal.confirmationId,
        userId: "user-1",
        canvasId: "canvas-1",
      }),
    ).resolves.toEqual({ jobId: "job-1" });
    expect(execute).toHaveBeenCalledTimes(1);

    await expect(
      service.confirm({
        confirmationId: proposal.confirmationId,
        userId: "user-1",
        canvasId: "canvas-1",
      }),
    ).resolves.toEqual({ jobId: "job-1" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight image action across confirmation retries", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await gate;
      return { jobId: "job-1" };
    });
    const service = createDestructiveConfirmationService();
    const proposal = service.proposeAction({
      userId: "user-1",
      canvasId: "canvas-1",
      kind: "image_generation",
      details: { description: "Logo", model: "nano-banana-2" },
      execute,
    });

    const first = service.confirm({
      confirmationId: proposal.confirmationId,
      userId: "user-1",
      canvasId: "canvas-1",
    });
    const retry = service.confirm({
      confirmationId: proposal.confirmationId,
      userId: "user-1",
      canvasId: "canvas-1",
    });
    release();

    await expect(first).resolves.toEqual({ jobId: "job-1" });
    await expect(retry).resolves.toEqual({ jobId: "job-1" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("freezes exact targets and permits one matching confirmation", async () => {
    const execute = vi.fn(async (operations) => ({ operations }));
    const service = createDestructiveConfirmationService();
    const proposal = service.propose({
      userId: "user-1",
      canvasId: "canvas-1",
      content: canvas(),
      operations: [{ action: "delete", element_id: "shape-1" }],
      loadCanvas: async () => canvas(),
      execute,
    });

    expect(proposal.targets).toEqual([
      expect.objectContaining({
        elementId: "shape-1",
        version: 1,
        cascade: [expect.objectContaining({ elementId: "text-1", version: 2 })],
      }),
    ]);
    await expect(service.confirm({
      confirmationId: proposal.confirmationId,
      userId: "user-1",
    })).resolves.toEqual({
      operations: [{ action: "delete", element_id: "shape-1" }],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(service.confirm({
      confirmationId: proposal.confirmationId,
      userId: "user-1",
    })).rejects.toMatchObject({ code: "confirmation_consumed" });
  });

  it("rejects a different user and target version drift", async () => {
    const service = createDestructiveConfirmationService();
    const proposal = service.propose({
      userId: "owner",
      canvasId: "canvas-1",
      content: canvas(),
      operations: [{ action: "delete", element_id: "shape-1" }],
      loadCanvas: async () => canvas(2),
      execute: vi.fn(),
    });

    await expect(service.confirm({
      confirmationId: proposal.confirmationId,
      userId: "attacker",
    })).rejects.toMatchObject({ code: "confirmation_forbidden" });
    await expect(service.confirm({
      confirmationId: proposal.confirmationId,
      userId: "owner",
    })).rejects.toMatchObject({ code: "confirmation_stale" });
  });

  it("expires and cancels proposals without executing them", async () => {
    let now = 1_000;
    const execute = vi.fn();
    const service = createDestructiveConfirmationService({ ttlMs: 50, now: () => now });
    const proposal = service.propose({
      userId: "user-1",
      canvasId: "canvas-1",
      content: canvas(),
      operations: [{ action: "delete", element_id: "shape-1" }],
      loadCanvas: async () => canvas(),
      execute,
    });
    now += 51;
    await expect(service.confirm({
      confirmationId: proposal.confirmationId,
      userId: "user-1",
    })).rejects.toBeInstanceOf(DestructiveConfirmationError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows only one of two concurrent confirmations to execute", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => { await gate; return "done"; });
    const service = createDestructiveConfirmationService();
    const proposal = service.propose({
      userId: "user-1",
      canvasId: "canvas-1",
      content: canvas(),
      operations: [{ action: "delete", element_id: "shape-1" }],
      loadCanvas: async () => canvas(),
      execute,
    });
    const first = service.confirm({ confirmationId: proposal.confirmationId, userId: "user-1" });
    await Promise.resolve();
    const second = service.confirm({ confirmationId: proposal.confirmationId, userId: "user-1" });
    release();
    await expect(first).resolves.toBe("done");
    await expect(second).rejects.toMatchObject({ code: "confirmation_consumed" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
