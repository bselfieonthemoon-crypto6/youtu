import { describe, expect, it, vi } from "vitest";

import type { ConfirmedActionAppliedEvent } from "../../features/agent-actions/destructive-confirmation-service.js";
import { createConfirmedActionAppliedHandler } from "./design-tools.js";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000001",
  design: "30000000-0000-4000-8000-000000000001",
  otherDesign: "30000000-0000-4000-8000-000000000002",
};

function event(overrides: Partial<ConfirmedActionAppliedEvent> = {}): ConfirmedActionAppliedEvent {
  return {
    confirmationId: "40000000-0000-4000-8000-000000000001",
    taskId: ids.task,
    taskRevision: 2,
    originRunId: ids.run,
    toolExecutionId: "50000000-0000-4000-8000-000000000001",
    userId: "60000000-0000-4000-8000-000000000001",
    workspaceId: "70000000-0000-4000-8000-000000000001",
    sessionId: "80000000-0000-4000-8000-000000000001",
    canvasId: "90000000-0000-4000-8000-000000000001",
    workflowStepId: "delete-old",
    kind: "design_mutation",
    details: {},
    outcome: { design_id: ids.design, revision: 5 },
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.task,
    revision: 2,
    target: { kind: "design" as const, designId: ids.design },
    brief: { keep: "value" },
    ...overrides,
  };
}

describe("createConfirmedActionAppliedHandler", () => {
  it("is a no-op when no durable task exists (Mastra path)", async () => {
    const updateBrief = vi.fn();
    const handler = createConfirmedActionAppliedHandler({
      tasks: { assertCurrentRun: vi.fn(async () => null), updateBrief } as never,
    });
    await handler(event());
    expect(updateBrief).not.toHaveBeenCalled();
  });

  it("records the confirmed mutation against the exact current design task", async () => {
    const updateBrief = vi.fn(async () => task());
    const handler = createConfirmedActionAppliedHandler({
      tasks: { assertCurrentRun: vi.fn(async () => task()), updateBrief } as never,
    });
    await handler(event());
    expect(updateBrief).toHaveBeenCalledExactlyOnceWith(ids.run, {
      keep: "value",
      confirmedDesignMutation: {
        confirmationId: "40000000-0000-4000-8000-000000000001",
        stepId: "delete-old",
        designId: ids.design,
        revision: 5,
      },
    });
  });

  it("does nothing for a superseded task revision", async () => {
    const updateBrief = vi.fn();
    const handler = createConfirmedActionAppliedHandler({
      tasks: { assertCurrentRun: vi.fn(async () => task({ revision: 3 })), updateBrief } as never,
    });
    await handler(event());
    expect(updateBrief).not.toHaveBeenCalled();
  });

  it("does nothing when the outcome targets a different design", async () => {
    const updateBrief = vi.fn();
    const handler = createConfirmedActionAppliedHandler({
      tasks: { assertCurrentRun: vi.fn(async () => task()), updateBrief } as never,
    });
    await handler(event({ outcome: { design_id: ids.otherDesign } }));
    expect(updateBrief).not.toHaveBeenCalled();
  });

  it("does nothing for a non-design task target", async () => {
    const updateBrief = vi.fn();
    const handler = createConfirmedActionAppliedHandler({
      tasks: {
        assertCurrentRun: vi.fn(async () => task({
          target: { kind: "canvas_image", elementId: "e", assetId: ids.design },
        })),
        updateBrief,
      } as never,
    });
    await handler(event());
    expect(updateBrief).not.toHaveBeenCalled();
  });
});
