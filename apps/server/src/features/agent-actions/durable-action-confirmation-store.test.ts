import { describe, expect, it, vi } from "vitest";

import { createDurableActionConfirmationStore } from "./durable-action-confirmation-store.js";

describe("durable action confirmation store", () => {
  it("uses server RPCs for create, claim, applied completion and cancel", async () => {
    const action = {
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
      status: "pending",
      claimToken: null,
      result: null,
      completionDone: false,
      confirmedAt: null,
      expiresAt: "2026-09-10T12:00:00.000Z",
    } as const;
    const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => ({
      data: name === "loomic_claim_agent_action_confirmation"
        ? { state: "claimed", action: { ...action, status: "executing", claimToken: "10000000-0000-4000-8000-000000000009" } }
        : name === "loomic_list_agent_action_confirmation_recovery" ? []
        : name === "loomic_create_agent_action_confirmation" ? action : true,
      error: null,
    }));
    const store = createDurableActionConfirmationStore(() => ({ rpc }) as never);
    await expect(store.create({
      confirmationId: action.confirmationId, kind: action.kind, userId: action.userId,
      workspaceId: action.workspaceId, sessionId: action.sessionId, canvasId: action.canvasId,
      taskId: action.taskId, taskRevision: action.taskRevision, originRunId: action.originRunId,
      toolExecutionId: action.toolExecutionId,
      workflowStepId: action.workflowStepId, details: action.details, payload: action.payload,
      expiresAt: action.expiresAt,
    })).resolves.toMatchObject({ confirmationId: action.confirmationId });
    await expect(store.claim(action.confirmationId, action.userId, action.canvasId))
      .resolves.toMatchObject({ state: "claimed" });
    await expect(store.listRecoveryPending(action.userId, action.sessionId)).resolves.toEqual([]);
    await expect(store.finishApplied(action.confirmationId, "10000000-0000-4000-8000-000000000009", { revision: 3 }))
      .resolves.toBe(true);
    await expect(store.complete(action.confirmationId)).resolves.toBe(true);
    await expect(store.cancel(action.confirmationId, action.userId, action.canvasId)).resolves.toBe(true);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_origin_run: action.originRunId,
      p_tool_execution: action.toolExecutionId,
      p_workflow_step: action.workflowStepId,
    });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "loomic_create_agent_action_confirmation",
      "loomic_claim_agent_action_confirmation",
      "loomic_list_agent_action_confirmation_recovery",
      "loomic_finish_agent_action_confirmation",
      "loomic_complete_agent_action_confirmation",
      "loomic_cancel_agent_action_confirmation",
    ]);
  });
});
