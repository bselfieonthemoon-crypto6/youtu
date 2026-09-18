import { describe, expect, it, vi } from "vitest";

import type { StreamEvent } from "@loomic/shared";

import { integrateMastraRunStream } from "./mastra-run-integration.js";
import type { MastraRunInput } from "./mastra-run-types.js";

const input = (signal = new AbortController().signal): MastraRunInput => ({
  runId: "00000000-0000-4000-8000-000000000001",
  conversationId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  prompt: "hello",
  executionMode: "thinking",
  attachments: [],
  mentions: [],
  signal,
});

async function* events(...items: StreamEvent[]) {
  yield* items;
}

async function drain(stream: AsyncIterable<StreamEvent>) {
  const result: StreamEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

describe("Mastra run stream integration", () => {
  it("accepts one scoped lifecycle and persists every emitted event first", async () => {
    const run = input();
    const emitted: StreamEvent[] = [
      {
        type: "run.started",
        runId: run.runId,
        conversationId: run.conversationId,
        sessionId: run.sessionId,
        timestamp: "2026-09-13T00:00:00.000Z",
      },
      {
        type: "message.delta",
        runId: run.runId,
        messageId: "00000000-0000-4000-8000-000000000004",
        delta: "done",
        timestamp: "2026-09-13T00:00:01.000Z",
      },
      {
        type: "run.completed",
        runId: run.runId,
        timestamp: "2026-09-13T00:00:02.000Z",
      },
    ];
    const persisted: StreamEvent[] = [];

    const received = await drain(integrateMastraRunStream({
      input: run,
      stream: events(...emitted),
      onEvent: event => { persisted.push(event); },
    }));

    expect(received).toEqual(emitted);
    expect(persisted).toEqual(emitted);
  });

  it.each([
    ["missing start", [
      { type: "run.completed", runId: input().runId, timestamp: "2026-09-13T00:00:00.000Z" },
    ], "mastra_stream_started_missing"],
    ["wrong run", [
      { type: "run.started", runId: "00000000-0000-4000-8000-000000000099", conversationId: input().conversationId,
        sessionId: input().sessionId, timestamp: "2026-09-13T00:00:00.000Z" },
    ], "mastra_stream_run_mismatch"],
    ["wrong scope", [
      { type: "run.started", runId: input().runId, conversationId: "00000000-0000-4000-8000-000000000099",
        sessionId: input().sessionId, timestamp: "2026-09-13T00:00:00.000Z" },
    ], "mastra_stream_scope_mismatch"],
    ["duplicate start", [
      { type: "run.started", runId: input().runId, conversationId: input().conversationId,
        sessionId: input().sessionId, timestamp: "2026-09-13T00:00:00.000Z" },
      { type: "run.started", runId: input().runId, conversationId: input().conversationId,
        sessionId: input().sessionId, timestamp: "2026-09-13T00:00:01.000Z" },
    ], "mastra_stream_started_duplicate"],
  ] as const)("rejects %s", async (_label, emitted, code) => {
    await expect(drain(integrateMastraRunStream({
      input: input(),
      stream: events(...emitted as unknown as StreamEvent[]),
      onEvent: vi.fn(),
    }))).rejects.toThrow(code);
  });

  it("rejects a stream that ends without a terminal event", async () => {
    const run = input();
    await expect(drain(integrateMastraRunStream({
      input: run,
      stream: events({ type: "run.started", runId: run.runId, conversationId: run.conversationId,
        sessionId: run.sessionId, timestamp: "2026-09-13T00:00:00.000Z" }),
      onEvent: vi.fn(),
    }))).rejects.toThrow("mastra_stream_terminal_missing");
  });

  it.each([
    ["completion without start", [
      { type: "run.started", runId: input().runId, conversationId: input().conversationId,
        sessionId: input().sessionId, timestamp: "2026-09-13T00:00:00.000Z" },
      { type: "tool.completed", runId: input().runId, toolCallId: "call-1", toolName: "generate_image",
        timestamp: "2026-09-13T00:00:01.000Z" },
    ], "mastra_tool_start_missing"],
    ["mismatched tool name", [
      { type: "run.started", runId: input().runId, conversationId: input().conversationId,
        sessionId: input().sessionId, timestamp: "2026-09-13T00:00:00.000Z" },
      { type: "tool.started", runId: input().runId, toolCallId: "call-1", toolName: "generate_image",
        timestamp: "2026-09-13T00:00:01.000Z" },
      { type: "tool.completed", runId: input().runId, toolCallId: "call-1", toolName: "edit_image",
        timestamp: "2026-09-13T00:00:02.000Z" },
    ], "mastra_tool_name_mismatch"],
    ["duplicate tool start", [
      { type: "run.started", runId: input().runId, conversationId: input().conversationId,
        sessionId: input().sessionId, timestamp: "2026-09-13T00:00:00.000Z" },
      { type: "tool.started", runId: input().runId, toolCallId: "call-1", toolName: "generate_image",
        timestamp: "2026-09-13T00:00:01.000Z" },
      { type: "tool.started", runId: input().runId, toolCallId: "call-1", toolName: "generate_image",
        timestamp: "2026-09-13T00:00:02.000Z" },
    ], "mastra_tool_started_duplicate"],
    ["completed run with active tool", [
      { type: "run.started", runId: input().runId, conversationId: input().conversationId,
        sessionId: input().sessionId, timestamp: "2026-09-13T00:00:00.000Z" },
      { type: "tool.started", runId: input().runId, toolCallId: "call-1", toolName: "generate_image",
        timestamp: "2026-09-13T00:00:01.000Z" },
      { type: "run.completed", runId: input().runId, timestamp: "2026-09-13T00:00:02.000Z" },
    ], "mastra_tool_terminal_missing"],
  ] as const)("rejects invalid tool lifecycle: %s", async (_label, emitted, code) => {
    await expect(drain(integrateMastraRunStream({
      input: input(),
      stream: events(...emitted as unknown as StreamEvent[]),
      onEvent: vi.fn(),
    }))).rejects.toThrow(code);
  });
});
