import { planStepStatusSchema, planUpdatedEventSchema } from "@loomic/shared";
import { describe, expect, it, vi } from "vitest";

import { createMastraToolkit } from "../mastra-toolkit.js";
import { toolExecutionContext, type MastraAgentTool } from "./tool-run-context.js";
import {
  MAX_PLAN_STEPS,
  MAX_PLAN_STEP_ID_LENGTH,
  MAX_PLAN_STEP_TITLE_LENGTH,
  SESSION_PLAN_ID_KEY,
  SESSION_PLAN_REVISION_KEY,
  WRITE_TODOS_TOOL_ID,
  createWriteTodosTool,
  nextPlanRevision,
  planIdForRun,
  planStepsFromWriteTodosResult,
  recordPlanSnapshot,
  writeTodosInputSchema,
} from "./plan-todos.js";

/**
 * `createAgentTool` erases the per-tool generics and declares `execute`
 * optional; every tool under test has a handler, so the direct call goes
 * through this view instead of `!` per call.
 */
function callable(tool: MastraAgentTool) {
  const shaped = tool as unknown as {
    execute: (input: unknown, context: ReturnType<typeof toolExecutionContext>) => Promise<unknown>;
  };
  return (input: unknown, context: ReturnType<typeof toolExecutionContext>) => shaped.execute(input, context);
}

const snapshot = [
  { id: "s1", title: "确认品牌信息", status: "completed" },
  { id: "s2", title: "生成主视觉", status: "in_progress" },
  { id: "s3", title: "交付到画布", status: "pending" },
] as const;

describe("write_todos plan snapshot", () => {
  it("is registered in the runtime toolkit and returns the complete snapshot it recorded", async () => {
    const toolkit = createMastraToolkit({});
    const tool = toolkit.tools.find(candidate => candidate.id === WRITE_TODOS_TOOL_ID);
    if (!tool) throw new Error("write_todos is not registered in the Mastra toolkit.");

    await expect(callable(tool)({ steps: snapshot }, toolExecutionContext({}))).resolves.toEqual({
      status: "recorded",
      stepCount: 3,
      steps: snapshot,
      summary: "已记录 3 步计划快照（仅登记展示，未执行任何步骤）。",
    });
    // The description must state the purpose and that the tool carries no
    // execution, approval, billing or model authority.
    expect(tool.description).toContain("multi-step plan");
    expect(tool.description).toContain("no execution, approval, billing, model");
  });

  it("bounds the snapshot: 1..20 steps, unique ids, bounded fields, no unknown keys", async () => {
    const tool = callable(createWriteTodosTool());
    const context = toolExecutionContext({});
    const step = (id: string, title = `步骤 ${id}`) => ({ id, title, status: "pending" });
    const full = Array.from({ length: MAX_PLAN_STEPS }, (_value, index) => step(`s${index}`));

    await expect(tool({ steps: full }, context)).resolves.toMatchObject({ stepCount: MAX_PLAN_STEPS });
    await expect(tool({ steps: [] }, context)).rejects.toThrow();
    await expect(tool({ steps: [...full, step("s-overflow")] }, context)).rejects.toThrow();
    await expect(tool({ steps: [step("x".repeat(MAX_PLAN_STEP_ID_LENGTH + 1))] }, context)).rejects.toThrow();
    await expect(tool({ steps: [{ id: "s1", title: "t".repeat(MAX_PLAN_STEP_TITLE_LENGTH + 1), status: "pending" }] }, context)).rejects.toThrow();
    await expect(tool({ steps: [step("dup"), step("dup")] }, context)).rejects.toThrow();
    await expect(tool({ steps: [step("s1")], note: "extra" }, context)).rejects.toThrow();
    await expect(tool({ steps: [{ id: "s1", title: "步骤", status: "cancelled" }] }, context)).rejects.toThrow();
    await expect(tool({ steps: [{ id: "s1", title: "   ", status: "pending" }] }, context)).rejects.toThrow();
    await expect(tool({ steps: [{ id: "s1", title: "步骤", status: "pending", owner: "me" }] }, context)).rejects.toThrow();
    // Accepted input is canonicalized: surrounding whitespace never reaches the plan.
    await expect(tool({ steps: [{ id: " s1 ", title: " 步骤一 ", status: "pending" }] }, context))
      .resolves.toMatchObject({ steps: [{ id: "s1", title: "步骤一" }] });
  });

  it("accepts exactly the statuses the shared plan contract declares", async () => {
    const tool = callable(createWriteTodosTool());
    const context = toolExecutionContext({});
    for (const status of planStepStatusSchema.options) {
      expect(planStepStatusSchema.safeParse(status).success).toBe(true);
      const receipt = await tool({ steps: [{ id: "s1", title: "步骤", status }] }, context);
      expect(planStepsFromWriteTodosResult(receipt)).toEqual([{ id: "s1", title: "步骤", status }]);
      const event = recordPlanSnapshot({ configurable: {}, runId: "run_status", result: receipt });
      expect(event?.steps).toEqual([{ id: "s1", title: "步骤", status }]);
      expect(planUpdatedEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("builds exactly one validated plan.updated per snapshot with a run-stable planId and increasing revision", () => {
    const configurable: Record<string, unknown> = {};
    const first = recordPlanSnapshot({ configurable, runId: "run_123", result: { steps: snapshot }, now: () => "2026-09-20T00:00:00.000Z" });
    expect(first).toEqual({
      type: "plan.updated",
      runId: "run_123",
      planId: "plan_run_123",
      revision: 1,
      timestamp: "2026-09-20T00:00:00.000Z",
      steps: snapshot,
    });
    // The full snapshot travels again on the next revision — never a delta.
    const second = recordPlanSnapshot({
      configurable, runId: "run_123",
      result: { steps: [{ id: "s1", title: "确认品牌信息", status: "completed" }] },
    });
    expect(second?.planId).toBe("plan_run_123");
    expect(second?.revision).toBe(2);
    expect(second?.steps).toEqual([{ id: "s1", title: "确认品牌信息", status: "completed" }]);
    expect(configurable[SESSION_PLAN_ID_KEY]).toBe("plan_run_123");
    expect(configurable[SESSION_PLAN_REVISION_KEY]).toBe(2);
    expect(planIdForRun("run_123")).toBe("plan_run_123");
    // A new run starts again at 1 rather than inheriting the previous revision.
    expect(nextPlanRevision({})).toBe(1);
    expect(nextPlanRevision({ [SESSION_PLAN_REVISION_KEY]: 0 })).toBe(1);
    expect(nextPlanRevision({ [SESSION_PLAN_REVISION_KEY]: "2" })).toBe(1);
  });

  it("emits nothing for a rejected or snapshot-less receipt and consumes no revision", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const configurable: Record<string, unknown> = {};
    try {
      for (const result of [
        { error: "plan_rejected" },
        { status: "recorded", stepCount: 0, summary: "nothing" },
        "not json",
        undefined,
        { steps: [] },
        { steps: [{ id: "s1", title: "", status: "pending" }] },
      ]) {
        expect(planStepsFromWriteTodosResult(result)).toBeUndefined();
        expect(recordPlanSnapshot({ configurable, runId: "run_failed", result })).toBeUndefined();
      }
      expect(configurable[SESSION_PLAN_REVISION_KEY]).toBeUndefined();
      expect(configurable[SESSION_PLAN_ID_KEY]).toBeUndefined();
      expect(recordPlanSnapshot({ configurable, runId: "run_failed", result: { steps: snapshot } })?.revision).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("skips a snapshot the shared event contract rejects, logs it server-side and streams nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const configurable: Record<string, unknown> = {};
    try {
      // The tool schema cannot produce this, so it proves the last gate: an
      // unusable run identity makes the shared event invalid.
      const event = recordPlanSnapshot({ configurable, runId: "", result: { steps: snapshot } });
      expect(event).toBeUndefined();
      expect(warn).toHaveBeenCalledWith("[mastra-plan] dropped an invalid plan.updated snapshot",
        expect.objectContaining({ runId: "", stepCount: 3, issues: expect.any(Array) }));
      expect(configurable[SESSION_PLAN_REVISION_KEY]).toBeUndefined();
      // The log must not leak the recorded step titles.
      expect(JSON.stringify(warn.mock.calls)).not.toContain("生成主视觉");
    } finally {
      warn.mockRestore();
    }
  });

  it("covers every status the shared plan contract declares, and nothing outside it", () => {
    // `satisfies readonly PlanStepStatus[]` proves each local value is a shared
    // status; this pins the reverse direction so no shared status can be dropped.
    for (const status of planStepStatusSchema.options)
      expect(writeTodosInputSchema.safeParse({ steps: [{ id: "s1", title: "步骤", status }] }).success, status).toBe(true);
    expect(writeTodosInputSchema.safeParse({ steps: [{ id: "s1", title: "步骤", status: "cancelled" }] }).success).toBe(false);
  });
});
