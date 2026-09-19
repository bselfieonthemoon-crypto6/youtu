import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@loomic/shared";

import { createToolResultEnvelope } from "./agent-message-shapes.js";
import { adaptAgentStream } from "./stream-adapter.js";

async function collect(stream: AsyncIterable<unknown>): Promise<StreamEvent[]> {
  const result: StreamEvent[] = [];
  for await (const event of adaptAgentStream({
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

describe("adaptAgentStream tool failures", () => {
  it("does not expose the independent intent review stream as assistant output", async () => {
    const result = await collect(events([
      { event: "on_chat_model_stream", name: "review", run_id: "internal", tags: ["loomic-intent-review"],
        data: { chunk: { content: "private review JSON" } } },
      { event: "on_chat_model_end", name: "review", run_id: "internal", tags: ["loomic-intent-review"],
        data: { output: { content: "private review JSON" } } },
    ]));
    expect(JSON.stringify(result)).not.toContain("private review JSON");
  });
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

describe("adaptAgentStream tool results", () => {
  const payload = { summary: "已保存", url: "https://example.invalid/a.png",
    placement: { x: 0, y: 0, width: 512, height: 512 } };

  function completedEvents(result: StreamEvent[]) {
    return result.filter((event): event is Extract<StreamEvent, { type: "tool.completed" }> =>
      event.type === "tool.completed");
  }

  it("reads a branded envelope as its serialized content, keeping artifacts and summary intact", async () => {
    const result = await collect(events([
      { event: "on_tool_end", name: "generate_image", run_id: "call-1", data: {
        output: createToolResultEnvelope({ content: JSON.stringify(payload), name: "generate_image", toolCallId: "call-1" }),
      } },
    ]));

    const completed = completedEvents(result);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.toolName).toBe("generate_image");
    expect(completed[0]!.toolCallId).toBe("call-1");
    expect(completed[0]!.outputSummary).toBe("已保存");
    expect(completed[0]!.artifacts).toHaveLength(1);
    expect(completed[0]!.artifacts![0]).toMatchObject({ type: "image", url: "https://example.invalid/a.png" });
    // Extracted artifact keys are stripped from the structured output branch.
    expect(completed[0]!.output).toEqual({ summary: "已保存" });
  });

  it("does not reclassify a plain result object that only carries a content field", async () => {
    const lookalike = { content: JSON.stringify({ summary: "不该被当成回执" }), name: "generate_image",
      tool_call_id: "call-1", status: "success" };
    const result = await collect(events([
      { event: "on_tool_end", name: "generate_image", run_id: "call-1", data: { output: lookalike } },
    ]));

    const completed = completedEvents(result);
    expect(completed).toHaveLength(1);
    // The whole object is serialized instead of its `content`, so the inner
    // `summary` never becomes the tool summary — the brand, not the fields,
    // decides which branch runs.
    expect(completed[0]!.outputSummary).not.toBe("不该被当成回执");
    expect(completed[0]!.output).toEqual({
      content: JSON.stringify({ summary: "不该被当成回执" }), name: "generate_image",
      tool_call_id: "call-1", status: "success",
    });
    expect(completed[0]!.artifacts).toBeUndefined();
  });

  // A real workspace has 15 enabled Skills, and their list_skills payload is
  // 24.8KB. The 10KB guard used to drop the whole payload, so the client and the
  // transcript received `{}` and no card could render the entries.
  it("bounds an oversized tool payload instead of dropping it whole", async () => {
    const skills = Array.from({ length: 15 }, (_, index) => ({
      name: `skill-${index}`, displayName: `技能 ${index}`,
      description: "为确实需要位图生成的任务整理主体、保留项、构图和素材提示；不强制 JSON 格式。".repeat(3),
      version: "2.2.0", contentHash: "a".repeat(64),
      runtime: { outputKinds: ["raster-image", "image-prompt"], instructions: "x".repeat(400) },
    }));
    const result = await collect(events([
      { event: "on_tool_end", name: "list_skills", run_id: "call-skills",
        data: { output: { skills, scope: "Enabled packages for this run only" } } },
    ]));

    const completed = completedEvents(result);
    const output = completed[0]!.output as { skills?: unknown[]; truncated?: boolean; scope?: string };
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(10240);
    expect(output.truncated).toBe(true);
    // Structure survives: the entries and their identifiers stay readable.
    expect(Array.isArray(output.skills)).toBe(true);
    expect(output.skills!.length).toBeGreaterThan(0);
    expect(JSON.stringify(output.skills)).toContain("skill-0");
    expect(JSON.stringify(output.skills)).toContain("[truncated");
    expect(output.scope).toBe("Enabled packages for this run only");
  });

  it("leaves a payload inside the limit untouched", async () => {
    const result = await collect(events([
      { event: "on_tool_end", name: "ask_clarification", run_id: "call-small",
        data: { output: { status: "awaiting_user_input", questions: ["品牌名是什么？"] } } },
    ]));

    const output = completedEvents(result)[0]!.output;
    expect(output).toEqual({ status: "awaiting_user_input", questions: ["品牌名是什么？"] });
    expect(output).not.toHaveProperty("truncated");
  });
});
