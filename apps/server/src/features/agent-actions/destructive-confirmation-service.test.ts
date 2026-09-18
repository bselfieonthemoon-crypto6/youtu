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

  it("retries only the durable completion callback after the mutation was applied", async () => {
    const action: any = {
      confirmationId: "10000000-0000-4000-8000-000000000001",
      kind: "design_mutation",
      userId: "10000000-0000-4000-8000-000000000002",
      workspaceId: "10000000-0000-4000-8000-000000000003",
      sessionId: "10000000-0000-4000-8000-000000000004",
      canvasId: "10000000-0000-4000-8000-000000000005",
      taskId: "10000000-0000-4000-8000-000000000006",
      taskRevision: 2,
      originRunId: "10000000-0000-4000-8000-000000000007",
      toolExecutionId: "10000000-0000-4000-8000-000000000010",
      workflowStepId: "delete-old",
      details: { design_id: "10000000-0000-4000-8000-000000000008" },
      payload: { design_id: "10000000-0000-4000-8000-000000000008" },
      status: "executing",
      claimToken: "10000000-0000-4000-8000-000000000009",
      result: null,
      completionDone: false,
      confirmedAt: "2026-09-10T11:00:00.000Z",
      expiresAt: "2026-09-10T12:00:00.000Z",
    };
    let stored = action;
    const store = {
      create: vi.fn(),
      claim: vi.fn(async () => stored.status === "applied"
        ? { state: "applied", action: stored }
        : { state: "claimed", action: stored }),
      finishApplied: vi.fn(async (_id, _token, result) => {
        stored = { ...stored, status: "applied", result };
        return true;
      }),
      release: vi.fn(async () => false),
      complete: vi.fn(async () => { stored = { ...stored, completionDone: true }; return true; }),
      cancel: vi.fn(),
    };
    const execute = vi.fn(async () => ({
      design_id: action.details.design_id,
      revision: 7,
      changed_object_ids: [],
      replayed: false,
    }));
    const applied = vi.fn()
      .mockRejectedValueOnce(new Error("outbox unavailable"))
      .mockResolvedValueOnce(undefined);
    const service = createDestructiveConfirmationService({
      durableActionStore: store as never,
      executeDurableAction: execute,
      onConfirmedActionApplied: applied,
    });
    const input = {
      confirmationId: action.confirmationId,
      userId: action.userId,
      canvasId: action.canvasId,
      context: {},
    };
    await expect(service.confirm(input)).rejects.toThrow("outbox unavailable");
    await expect(service.confirm(input)).resolves.toMatchObject({ revision: 7 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledTimes(2);
    expect(store.finishApplied).toHaveBeenCalledOnce();
    expect(store.complete).toHaveBeenCalledOnce();
  });

  it("recovers applied callbacks and previously confirmed executions without another click", async () => {
    const base: any = {
      confirmationId: "10000000-0000-4000-8000-000000000001",
      kind: "design_mutation",
      userId: "10000000-0000-4000-8000-000000000002",
      workspaceId: "10000000-0000-4000-8000-000000000003",
      sessionId: "10000000-0000-4000-8000-000000000004",
      canvasId: "10000000-0000-4000-8000-000000000005",
      taskId: "10000000-0000-4000-8000-000000000006",
      taskRevision: 2,
      originRunId: "10000000-0000-4000-8000-000000000007",
      toolExecutionId: "10000000-0000-4000-8000-000000000010",
      workflowStepId: "delete-old",
      details: { design_id: "10000000-0000-4000-8000-000000000008", expected_revision: 4 },
      payload: { design_id: "10000000-0000-4000-8000-000000000008" },
      claimToken: null,
      completionDone: false,
      confirmedAt: "2026-09-10T11:00:00.000Z",
      expiresAt: "2026-09-10T12:00:00.000Z",
    };
    const applied = {
      ...base,
      status: "applied",
      result: { design_id: base.details.design_id, revision: 5, changed_object_ids: [] },
    };
    const retry = {
      ...base,
      confirmationId: "10000000-0000-4000-8000-000000000011",
      status: "pending",
      result: null,
    };
    const claimed = {
      ...retry,
      status: "executing",
      claimToken: "10000000-0000-4000-8000-000000000012",
    };
    const store = {
      listRecoveryPending: vi.fn(async () => [applied, retry]),
      claim: vi.fn(async (id: string) => id === applied.confirmationId
        ? { state: "applied", action: applied }
        : { state: "claimed", action: claimed }),
      finishApplied: vi.fn(async () => true),
      release: vi.fn(async () => true),
      complete: vi.fn(async () => true),
    };
    const execute = vi.fn(async () => ({
      design_id: base.details.design_id,
      revision: 5,
      changed_object_ids: [],
    }));
    const onApplied = vi.fn(async () => {});
    const service = createDestructiveConfirmationService({
      durableActionStore: store as never,
      executeDurableAction: execute,
      onConfirmedActionApplied: onApplied,
    });
    await expect(service.resumeAppliedForSession({
      user: { id: base.userId },
      sessionId: base.sessionId,
    })).resolves.toEqual({ completed: 1, replayed: 1, errors: [] });
    expect(execute).toHaveBeenCalledOnce();
    expect(onApplied).toHaveBeenCalledTimes(2);
    expect(store.finishApplied).toHaveBeenCalledOnce();
    expect(store.complete).toHaveBeenCalledTimes(2);
  });

  it.each(["expired", "stale", "canceled"] as const)(
    "does not execute a durable %s confirmation",
    async (state) => {
      const execute = vi.fn();
      const service = createDestructiveConfirmationService({
        durableActionStore: {
          claim: vi.fn(async () => ({ state })),
        } as never,
        executeDurableAction: execute,
      });
      await expect(service.confirm({
        confirmationId: "10000000-0000-4000-8000-000000000001",
        userId: "10000000-0000-4000-8000-000000000002",
        canvasId: "10000000-0000-4000-8000-000000000003",
      })).rejects.toBeInstanceOf(DestructiveConfirmationError);
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
