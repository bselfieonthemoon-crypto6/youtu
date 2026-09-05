import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@loomic/shared";

import { adaptDeepAgentStream } from "./stream-adapter.js";

async function collect(stream: AsyncIterable<unknown>): Promise<StreamEvent[]> {
  const result: StreamEvent[] = [];
  for await (const event of adaptDeepAgentStream({
    conversationId: "conversation-1",
    now: () => "2026-09-01T00:00:00.000Z",
    runId: "run-1",
    sessionId: "session-1",
    stream,
  })) {
    result.push(event);
  }
  return result;
}

async function* events(values: unknown[]) {
  yield* values;
}

describe("adaptDeepAgentStream plans", () => {
  it("promotes write_todos snapshots to revisioned plan.updated events", async () => {
    const result = await collect(
      events([
        {
          event: "on_tool_start",
          name: "write_todos",
          run_id: "todo-call-1",
          data: {
            input: {
              todos: [
                { content: "Inspect canvas", status: "in_progress" },
                { content: "Generate image", status: "pending" },
              ],
            },
          },
        },
        {
          event: "on_tool_end",
          name: "write_todos",
          run_id: "todo-call-1",
          data: { output: "Updated todo list" },
        },
        {
          event: "on_tool_start",
          name: "write_todos",
          run_id: "todo-call-2",
          data: {
            input: {
              todos: [
                { content: "Inspect canvas", status: "completed" },
                { content: "Generate image", status: "in_progress" },
              ],
            },
          },
        },
        {
          event: "on_tool_end",
          name: "write_todos",
          run_id: "todo-call-2",
          data: { output: "Updated todo list" },
        },
      ]),
    );

    expect(result.filter((event) => event.type === "plan.updated")).toEqual([
      {
        type: "plan.updated",
        runId: "run-1",
        planId: "plan_run-1",
        revision: 1,
        timestamp: "2026-09-01T00:00:00.000Z",
        steps: [
          { id: "step_1", title: "Inspect canvas", status: "in_progress" },
          { id: "step_2", title: "Generate image", status: "pending" },
        ],
      },
      {
        type: "plan.updated",
        runId: "run-1",
        planId: "plan_run-1",
        revision: 2,
        timestamp: "2026-09-01T00:00:00.000Z",
        steps: [
          { id: "step_1", title: "Inspect canvas", status: "completed" },
          { id: "step_2", title: "Generate image", status: "in_progress" },
        ],
      },
    ]);
    expect(
      result.some(
        (event) =>
          (event.type === "tool.started" || event.type === "tool.completed") &&
          event.toolName === "write_todos",
      ),
    ).toBe(false);
  });

  it("filters invalid todo items while retaining a valid full snapshot", async () => {
    const result = await collect(
      events([
        {
          event: "on_tool_start",
          name: "write_todos",
          run_id: "todo-valid",
          data: {
            input: {
              todos: [
                { content: "Valid step", status: "pending" },
                { content: "Bad status", status: "blocked" },
                { content: "", status: "completed" },
                null,
              ],
            },
          },
        },
        {
          event: "on_tool_end",
          name: "write_todos",
          run_id: "todo-valid",
          data: { output: "Updated todo list" },
        },
      ]),
    );

    const plan = result.find((event) => event.type === "plan.updated");
    expect(plan).toMatchObject({
      revision: 1,
      steps: [{ id: "step_1", title: "Valid step", status: "pending" }],
    });
  });

  it("commits only successful write_todos calls", async () => {
    const result = await collect(events([
      {
        event: "on_tool_start",
        name: "write_todos",
        run_id: "todo-failed",
        data: { input: { todos: [{ content: "Uncommitted", status: "in_progress" }] } },
      },
      {
        event: "on_tool_error",
        name: "write_todos",
        run_id: "todo-failed",
        data: { error: new Error("failed") },
      },
    ]));
    expect(result.some((event) => event.type === "plan.updated")).toBe(false);
  });

  it("preserves unique unchanged step ids across reorder and insertion", async () => {
    const result = await collect(events([
      {
        event: "on_tool_start",
        name: "write_todos",
        run_id: "todo-1",
        data: { input: { todos: [
          { content: "Inspect canvas", status: "in_progress" },
          { content: "Render image", status: "pending" },
        ] } },
      },
      { event: "on_tool_end", name: "write_todos", run_id: "todo-1" },
      {
        event: "on_tool_start",
        name: "write_todos",
        run_id: "todo-2",
        data: { input: { todos: [
          { content: "New prerequisite", status: "completed" },
          { content: "Render image", status: "in_progress" },
          { content: "Inspect canvas", status: "completed" },
        ] } },
      },
      { event: "on_tool_end", name: "write_todos", run_id: "todo-2" },
    ]));
    const plans = result.filter((event) => event.type === "plan.updated");
    expect(plans[1]).toMatchObject({ steps: [
      { id: "step_3", title: "New prerequisite" },
      { id: "step_2", title: "Render image" },
      { id: "step_1", title: "Inspect canvas" },
    ] });
  });

  it("does not reuse ids for renamed or duplicate-title steps", async () => {
    const result = await collect(events([
      {
        event: "on_tool_start",
        name: "write_todos",
        run_id: "todo-1",
        data: { input: { todos: [{ content: "Inspect", status: "in_progress" }] } },
      },
      { event: "on_tool_end", name: "write_todos", run_id: "todo-1" },
      {
        event: "on_tool_start",
        name: "write_todos",
        run_id: "todo-2",
        data: { input: { todos: [
          { content: "Inspect carefully", status: "in_progress" },
          { content: "Inspect carefully", status: "pending" },
        ] } },
      },
      { event: "on_tool_end", name: "write_todos", run_id: "todo-2" },
    ]));
    const plans = result.filter((event) => event.type === "plan.updated");
    expect(plans[1]).toMatchObject({ steps: [
      { id: "step_2" },
      { id: "step_3" },
    ] });
  });

  it("freezes the single explicit in-progress step onto tool lifecycle events", async () => {
    const result = await collect(events([
      {
        event: "on_tool_start",
        name: "write_todos",
        run_id: "todo-1",
        data: { input: { todos: [
          { content: "Inspect", status: "in_progress" },
          { content: "Render", status: "pending" },
        ] } },
      },
      { event: "on_tool_end", name: "write_todos", run_id: "todo-1" },
      {
        event: "on_tool_start",
        name: "inspect_canvas",
        run_id: "inspect-1",
        data: { input: { detail_level: "summary" } },
      },
      {
        event: "on_tool_start",
        name: "write_todos",
        run_id: "todo-2",
        data: { input: { todos: [
          { content: "Inspect", status: "completed" },
          { content: "Render", status: "in_progress" },
        ] } },
      },
      { event: "on_tool_end", name: "write_todos", run_id: "todo-2" },
      {
        event: "on_tool_end",
        name: "inspect_canvas",
        run_id: "inspect-1",
        data: { output: JSON.stringify({ matchedCount: 1 }) },
      },
    ]));
    const lifecycle = result.filter(
      (event) =>
        (event.type === "tool.started" || event.type === "tool.completed") &&
        event.toolCallId === "inspect-1",
    );
    expect(lifecycle).toEqual([
      expect.objectContaining({ planId: "plan_run-1", planStepId: "step_1" }),
      expect.objectContaining({ planId: "plan_run-1", planStepId: "step_1" }),
    ]);
  });

  it("keeps the frozen plan link on failed tool events", async () => {
    const result = await collect(events([
      {
        event: "on_tool_start",
        name: "write_todos",
        run_id: "todo-1",
        data: { input: { todos: [{ content: "Inspect", status: "in_progress" }] } },
      },
      { event: "on_tool_end", name: "write_todos", run_id: "todo-1" },
      {
        event: "on_tool_start",
        name: "inspect_canvas",
        run_id: "inspect-failed",
        data: { input: {} },
      },
      {
        event: "on_tool_error",
        name: "inspect_canvas",
        run_id: "inspect-failed",
        data: { error: new Error("failed") },
      },
    ]));
    const lifecycle = result.filter(
      (event) =>
        (event.type === "tool.started" || event.type === "tool.failed") &&
        event.toolCallId === "inspect-failed",
    );
    expect(lifecycle).toEqual([
      expect.objectContaining({ planId: "plan_run-1", planStepId: "step_1" }),
      expect.objectContaining({ planId: "plan_run-1", planStepId: "step_1" }),
    ]);
  });

  it("does not associate tools when zero or multiple steps are in progress", async () => {
    const result = await collect(events([
      {
        event: "on_tool_start",
        name: "inspect_canvas",
        run_id: "before-plan",
        data: { input: {} },
      },
      {
        event: "on_tool_start",
        name: "write_todos",
        run_id: "todo-1",
        data: { input: { todos: [
          { content: "One", status: "in_progress" },
          { content: "Two", status: "in_progress" },
        ] } },
      },
      { event: "on_tool_end", name: "write_todos", run_id: "todo-1" },
      {
        event: "on_tool_start",
        name: "project_search",
        run_id: "ambiguous",
        data: { input: { query: "x" } },
      },
    ]));
    const starts = result.filter((event) => event.type === "tool.started");
    expect(starts).toHaveLength(2);
    for (const event of starts) {
      expect(event).not.toHaveProperty("planId");
      expect(event).not.toHaveProperty("planStepId");
    }
  });
});

describe("adaptDeepAgentStream tool failures", () => {
  it("pairs and deduplicates tool errors by tool call id", async () => {
    const result = await collect(events([
      {
        event: "on_tool_start",
        name: "inspect_canvas",
        run_id: "tool-call-1",
        data: { input: { detail_level: "summary" } },
      },
      {
        event: "on_tool_error",
        name: "inspect_canvas",
        run_id: "tool-call-1",
        data: { error: new Error("canvas read failed") },
      },
      {
        event: "on_tool_error",
        name: "inspect_canvas",
        run_id: "tool-call-1",
        data: { error: new Error("duplicate") },
      },
    ]));

    expect(result.filter((event) => event.type === "tool.failed")).toEqual([
      {
        type: "tool.failed",
        runId: "run-1",
        toolCallId: "tool-call-1",
        toolName: "inspect_canvas",
        error: { code: "tool_failed", message: "请求处理失败，请重试。" },
        timestamp: "2026-09-01T00:00:00.000Z",
      },
    ]);
  });
});
