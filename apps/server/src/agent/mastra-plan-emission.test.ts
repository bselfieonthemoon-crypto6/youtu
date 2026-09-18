import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { planUpdatedEventSchema, type StreamEvent } from "@loomic/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { streamMastraDesignAgent } from "./mastra-agent.js";
import { createMastraToolkit } from "./mastra-toolkit.js";
import type { MastraRunInput } from "./mastra-run-types.js";
import { createAgentTool, type MastraAgentTool } from "./tools/tool-run-context.js";
import { SESSION_PLAN_ID_KEY, SESSION_PLAN_REVISION_KEY, SESSION_PLAN_STEPS_KEY } from "./tools/plan-todos.js";

/**
 * End-to-end producer test for the `plan.updated` stream event through the real
 * Mastra agent loop (synthetic OpenAI-compatible transport, not provider E2E):
 * a successful `write_todos` call must reach the wire as exactly one validated
 * full snapshot, and a failed call must reach it as nothing at all.
 */

function textStream(text: string) {
  return new Response(
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function toolStream(name: string, args: string, id: string) {
  return new Response(
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function structuredResponse(object: unknown) {
  return new Response(JSON.stringify({
    id: "classification", object: "chat.completion", created: 1, model: "test",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(object) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { headers: { "content-type": "application/json" } });
}

/** The requirement checker that follows a turn with no registered write tool. */
const noWriteRequired = () => structuredResponse({ decision: "no_write_required", reasonCode: "discussion" });

function run(runId: string): MastraRunInput {
  return {
    runId, sessionId: "session", conversationId: "conversation",
    prompt: "帮我做三张系列海报", executionMode: "fast",
    attachments: [], mentions: [], signal: new AbortController().signal,
  };
}

const steps = [
  { id: "s1", title: "确认品牌信息", status: "completed" },
  { id: "s2", title: "生成三张主视觉", status: "in_progress" },
  { id: "s3", title: "交付到画布", status: "pending" },
];

async function collect(
  input: MastraRunInput,
  responses: Array<() => Response>,
  tools?: MastraAgentTool[],
) {
  let call = 0;
  const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
    fetch: async () => {
      const next = responses[call];
      call += 1;
      if (!next) throw new Error(`unexpected provider call ${call}`);
      return next();
    },
  }).chatModel("test");
  const toolkit = createMastraToolkit({});
  const configurable: Record<string, unknown> = {};
  const events: StreamEvent[] = [];
  for await (const event of streamMastraDesignAgent({
    run: input, model, messages: [{ role: "user", content: input.prompt }],
    configurable, maxOutputTokens: 1_000, tools: tools ?? toolkit.tools, instructions: toolkit.instructions,
  })) events.push(event);
  return { events, configurable, providerCalls: call };
}

describe("write_todos -> plan.updated emission", () => {
  it("publishes exactly one validated full snapshot inside the open run", async () => {
    const { events, configurable } = await collect(run("plan-emission-run"), [
      () => toolStream("discover_tools", '{"names":["write_todos"]}', "call_discover"),
      () => toolStream("write_todos", JSON.stringify({ steps }), "call_todos"),
      () => textStream("计划已记录。"),
      noWriteRequired,
    ]);

    const plans = events.filter(event => event.type === "plan.updated");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual({
      type: "plan.updated",
      runId: "plan-emission-run",
      planId: "plan_plan-emission-run",
      revision: 1,
      timestamp: expect.any(String),
      steps,
    });
    // The emitted event is the shared wire contract itself, not a look-alike.
    for (const plan of plans) expect(planUpdatedEventSchema.safeParse(plan).success).toBe(true);

    const startedIndex = events.findIndex(event => event.type === "tool.started" && event.toolName === "write_todos");
    const planIndex = events.findIndex(event => event.type === "plan.updated");
    const completedIndex = events.findIndex(event => event.type === "run.completed");
    expect(startedIndex).toBeGreaterThan(-1);
    expect(planIndex).toBeGreaterThan(startedIndex);
    expect(planIndex).toBeLessThan(completedIndex);
    expect(events.at(-1)?.type).toBe("run.completed");

    // A recorded plan is a product receipt, never the design-write receipt that
    // lets this turn replace the remembered session series.
    expect(configurable.session_design_write_run_id).toBeUndefined();
    expect(configurable[SESSION_PLAN_ID_KEY]).toBe("plan_plan-emission-run");
    expect(configurable[SESSION_PLAN_REVISION_KEY]).toBe(1);
    // The run's last recorded snapshot is kept on the run context, because the
    // runtime reads its still-open steps after the stream to learn what a
    // cancellation (or an exhausted budget) left undone for the next turn.
    expect(configurable[SESSION_PLAN_STEPS_KEY]).toEqual(steps);
  });

  it("publishes one event per call: same planId, strictly increasing revision", async () => {
    const revised = [...steps.slice(0, 2), { id: "s3", title: "交付到画布", status: "pending" },
      { id: "s4", title: "回看并确认", status: "pending" }];
    const { events, configurable } = await collect(run("plan-revision-run"), [
      () => toolStream("discover_tools", '{"names":["write_todos"]}', "call_discover"),
      () => toolStream("write_todos", JSON.stringify({ steps }), "call_todos_1"),
      () => toolStream("write_todos", JSON.stringify({ steps: revised }), "call_todos_2"),
      () => textStream("计划已更新。"),
      noWriteRequired,
    ]);

    const plans = events.filter(event => event.type === "plan.updated");
    expect(plans.map(plan => plan.revision)).toEqual([1, 2]);
    expect(new Set(plans.map(plan => plan.planId))).toEqual(new Set(["plan_plan-revision-run"]));
    // Each event carries the whole snapshot, so the UI can replace in place.
    expect(plans[0]?.steps).toEqual(steps);
    expect(plans[1]?.steps).toEqual(revised);
    expect(configurable[SESSION_PLAN_REVISION_KEY]).toBe(2);
  });

  it("streams no plan at all when the write_todos call is rejected", async () => {
    const { events, configurable } = await collect(run("plan-rejected-run"), [
      () => toolStream("discover_tools", '{"names":["write_todos"]}', "call_discover"),
      // An empty list is rejected by the tool schema: nothing was recorded.
      () => toolStream("write_todos", '{"steps":[]}', "call_todos"),
      () => textStream("这次没有记录计划。"),
      noWriteRequired,
    ]);

    expect(events.some(event => event.type === "plan.updated")).toBe(false);
    // The rejected call is visible as a failed draft, and the runtime refuses to
    // turn it into a plan.
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.completed", toolName: "write_todos", output: expect.objectContaining({ error: true }),
    }));
    expect(configurable[SESSION_PLAN_REVISION_KEY]).toBeUndefined();
    expect(configurable[SESSION_PLAN_ID_KEY]).toBeUndefined();
    // A rejected call records no snapshot either, so the runtime cannot report
    // a plan (or its open steps) that the product never displayed.
    expect(configurable[SESSION_PLAN_STEPS_KEY]).toBeUndefined();
  });

  it("emits nothing when the write_todos handler reports a rejected call that still carries a draft", async () => {
    // The documented failure shape: a tool result with an `error` field rather
    // than a throw. It must never paint the draft snapshot in the product UI,
    // even though the payload would otherwise validate as a plan.
    const execute = vi.fn(async () => ({ error: "plan_store_unavailable", steps }));
    const rejectingTool = createAgentTool({
      id: "write_todos",
      description: "Record a multi-step plan (test double that rejects the call).",
      inputSchema: z.object({ steps: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })) }),
      execute,
    });
    const { events, configurable } = await collect(run("plan-store-failure-run"), [
      () => toolStream("discover_tools", '{"names":["write_todos"]}', "call_discover"),
      () => toolStream("write_todos", JSON.stringify({ steps }), "call_todos"),
      () => textStream("计划没有存储成功。"),
      noWriteRequired,
    ], [rejectingTool]);

    expect(events.some(event => event.type === "plan.updated")).toBe(false);
    // The handler really ran and really returned the draft with the rejection,
    // so the runtime's failed-receipt check is what kept it off the wire.
    expect(execute).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", toolName: "write_todos",
      output: expect.objectContaining({ error: "plan_store_unavailable", steps }) }));
    expect(configurable[SESSION_PLAN_REVISION_KEY]).toBeUndefined();
  });
});
