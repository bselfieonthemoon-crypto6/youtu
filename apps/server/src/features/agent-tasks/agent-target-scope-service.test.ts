import { describe, expect, it, vi } from "vitest";
import type { AgentTaskService, AgentTaskSnapshot } from "./agent-task-service.js";
import { AgentTargetScopeError, createAgentTargetScopeService } from "./agent-target-scope-service.js";

const id = (tail: number) => `10000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;
const primary = { kind: "design" as const, designId: id(10), objectIds: [id(20)] };
const secondary = { kind: "design" as const, designId: id(11), objectIds: [id(21)] };
const task: AgentTaskSnapshot = {
  id: id(1), revision: 3, runId: id(2), sessionId: id(3), canvasId: id(4),
  goal: "Update two explicitly selected boards", corrections: [], target: primary, brief: null,
};

function fixture(handler?: (name: string, args: Record<string, unknown>) => unknown) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({
    data: handler?.(name, args) ?? (name.endsWith("_assert") ? true : [primary, secondary]), error: null,
  }));
  const service = createAgentTargetScopeService({ getAdminClient: () => ({ rpc }) as any });
  return { service, rpc };
}

function baseTaskService(current: AgentTaskSnapshot = task): AgentTaskService {
  return {
    begin: vi.fn(), prepare: vi.fn(), activate: vi.fn(),
    getCurrent: vi.fn(async () => current),
    assertCurrentRun: vi.fn(async () => current),
    updateBrief: vi.fn(async (_runId, brief) => ({ ...current, brief })),
    updateWorkflow: vi.fn(async () => current),
  } as AgentTaskService;
}

describe("authenticated agent target scopes", () => {
  it("activates only an opaque exact request preparation", async () => {
    const f = fixture();
    const prepared = f.service.prepareUserScope({
      userId: id(5), sessionId: task.sessionId, canvasId: task.canvasId, runId: task.runId,
      primaryTarget: primary, authorizedTargets: [primary, secondary],
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    await expect(f.service.activate({ ...prepared }, task)).rejects.toMatchObject({ code: "agent_target_scope_activation_conflict" });
    expect(f.rpc).not.toHaveBeenCalled();
    await expect(f.service.activate(prepared, task)).resolves.toEqual([primary, secondary]);
    expect(f.rpc).toHaveBeenCalledWith("loomic_agent_target_scope_activate", expect.objectContaining({
      p_user: id(5), p_run: task.runId, p_task_revision: 3, p_targets: [primary, secondary],
    }));
  });

  it("rejects a list that omits the exact primary or duplicates a destination", () => {
    const f = fixture();
    expect(() => f.service.prepareUserScope({ userId: id(5), sessionId: task.sessionId,
      canvasId: task.canvasId, runId: task.runId, primaryTarget: primary, authorizedTargets: [secondary] }))
      .toThrow("agent_target_scope_primary_missing");
    expect(() => f.service.prepareUserScope({ userId: id(5), sessionId: task.sessionId,
      canvasId: task.canvasId, runId: task.runId, primaryTarget: primary, authorizedTargets: [
        primary, { kind: "design", designId: primary.designId },
      ] })).toThrow();
  });

  it("prepares correction inheritance only from freshly validated server targets", async () => {
    const f = fixture();
    const prepared = await f.service.prepareCorrectionScope({
      userId: id(5), sessionId: task.sessionId, canvasId: task.canvasId,
      runId: id(6), correctionOfRunId: task.runId, taskRevision: 4,
      primaryTarget: primary,
    });
    expect(prepared).toMatchObject({
      runId: id(6), primaryTarget: primary, targets: [primary, secondary],
      source: "validated_correction_inheritance",
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(f.rpc).toHaveBeenCalledWith("loomic_agent_target_scope_prepare_correction", {
      p_user: id(5), p_session: task.sessionId, p_canvas: task.canvasId,
      p_run: id(6), p_correction_of: task.runId, p_task_revision: 4,
      p_primary_target: primary,
    });
  });

  it("fails closed when correction validation omits the unchanged primary", async () => {
    const f = fixture(name => name.endsWith("_prepare_correction") ? [secondary] : [primary]);
    await expect(f.service.prepareCorrectionScope({
      userId: id(5), sessionId: task.sessionId, canvasId: task.canvasId,
      runId: id(6), correctionOfRunId: task.runId, taskRevision: 4,
      primaryTarget: primary,
    })).rejects.toMatchObject({ code: "agent_target_scope_primary_missing" });
  });

  it("does not turn a correction preparation into authority for a different run", async () => {
    const f = fixture();
    const prepared = await f.service.prepareCorrectionScope({
      userId: id(5), sessionId: task.sessionId, canvasId: task.canvasId,
      runId: id(6), correctionOfRunId: task.runId, taskRevision: 4,
      primaryTarget: primary,
    });
    await expect(f.service.activate(prepared, { ...task, revision: 4, runId: id(7) }))
      .rejects.toMatchObject({ code: "agent_target_scope_activation_conflict" });
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the server RPC does not authorize a workflow target", async () => {
    const f = fixture(name => name.endsWith("_assert") ? false : [primary]);
    await expect(f.service.assertAuthorized({ userId: id(5), task, target: secondary }))
      .rejects.toMatchObject({ code: "agent_target_scope_forbidden", statusCode: 403 });
  });

  it("projects one authorized execution target without replacing canonical identity or target", async () => {
    const f = fixture();
    const base = baseTaskService();
    const execution = await f.service.resolveExecutionTask({ userId: id(5), task, target: secondary, taskService: base });
    expect(execution.snapshot).toMatchObject({ id: task.id, revision: 3, runId: task.runId, target: secondary });
    expect(execution.canonicalTarget).toEqual(primary);
    expect(task.target).toEqual(primary);

    const updated = await execution.service.updateBrief(task.runId, { goal: "same authority" });
    expect(updated.target).toEqual(secondary);
    expect(base.updateBrief).toHaveBeenCalledWith(task.runId, { goal: "same authority" });
    expect(f.rpc.mock.calls.filter(([name]) => name === "loomic_agent_target_scope_assert").length).toBeGreaterThanOrEqual(3);
    await expect(execution.service.begin({} as never)).rejects.toMatchObject({ code: "agent_target_scope_facade_forbidden" });
    await expect(execution.service.assertCurrentRun(id(99))).rejects.toMatchObject({ code: "agent_target_scope_forbidden" });
  });

  it("invalidates an execution facade when a correction advances the canonical revision", async () => {
    const f = fixture();
    const corrected = { ...task, revision: 4, runId: id(6), corrections: ["Do not edit the second board"] };
    await expect(f.service.resolveExecutionTask({ userId: id(5), task, target: secondary,
      taskService: baseTaskService(corrected) })).rejects.toBeInstanceOf(AgentTargetScopeError);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("adapts only the exact autonomy grant to the execution facade", async () => {
    const rpc = vi.fn(async (name: string) => ({ data: name.endsWith("_assert") ? true : [primary, secondary], error: null }));
    const base = baseTaskService();
    const service = createAgentTargetScopeService({ getAdminClient: () => ({ rpc }) as any, taskService: base });
    const grant = { created_by: id(5), session_id: task.sessionId, task_id: task.id,
      task_revision: task.revision, origin_run_id: task.runId, canvas_id: task.canvasId };
    await expect(service.resolveAutonomousExecutionTask(grant, task, secondary))
      .resolves.toMatchObject({ task: { id: task.id, revision: 3, runId: task.runId, target: secondary } });
    await expect(service.resolveAutonomousExecutionTask({ ...grant, task_revision: 4 }, task, secondary))
      .rejects.toMatchObject({ code: "agent_target_scope_revision_conflict" });
  });
});
