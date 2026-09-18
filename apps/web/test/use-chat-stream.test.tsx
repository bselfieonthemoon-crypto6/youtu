// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StreamEvent } from "@loomic/shared";
import type { Message } from "../src/hooks/use-chat-sessions";
import { useChatStream } from "../src/hooks/use-chat-stream";

describe("useChatStream", () => {
  it("materializes a structured clarification block from the tool result", () => {
    let messages: Message[] = [{ id: "assistant", role: "assistant", contentBlocks: [{
      type: "tool", toolCallId: "ask-1", toolName: "ask_clarification", status: "running",
    }] }];
    const { result } = renderHook(() => useChatStream((_sessionId, update) => { messages = update(messages); }));
    const event = {
      type: "tool.completed",
      runId: "run-1",
      toolCallId: "ask-1",
      toolName: "ask_clarification",
      output: { status: "awaiting_user_input", questions: [{
        id: 1, title: "用途", prompt: "主要用在哪里？", options: ["App 图标", "门头"], allowCustom: true,
      }] },
      timestamp: "2026-09-16T00:00:00.000Z",
    } satisfies StreamEvent;

    act(() => result.current.applyStreamEvent(event, "assistant", "session"));
    expect(messages[0]!.contentBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool", status: "completed" }),
      expect.objectContaining({ type: "clarification", clarificationId: "ask-1",
        questions: [expect.objectContaining({ title: "用途", options: ["App 图标", "门头"] })] }),
    ]));
  });
  it.each([
    ["agent_context_budget_exceeded", "安全上下文预算"],
    ["agent_context_summary_failed", "长对话整理未成功"],
    ["agent_context_conflict", "最新要求继续"],
  ])("shows %s even after partial text, preserving content and deduplicating reconnect replay", (reasonCode, expected) => {
    let messages: Message[] = [{ id: "assistant", role: "assistant", contentBlocks: [
      { type: "text", text: "已经读取当前设计。" },
      { type: "tool", toolCallId: "tool-1", toolName: "inspect_design", status: "running" },
    ] }];
    const { result } = renderHook(() => useChatStream((_sessionId, update) => { messages = update(messages); }));
    const event: StreamEvent = { type: "run.failed", runId: "run", timestamp: "2026-09-09T00:00:00Z",
      error: { code: "run_failed", message: "PRIVATE_PROVIDER_BODY", details: { reasonCode, automaticRetry: false } } };
    act(() => result.current.applyStreamEvent(event, "assistant", "session"));
    act(() => result.current.applyStreamEvent(event, "assistant", "session"));
    const blocks = messages[0]!.contentBlocks;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "text", text: "已经读取当前设计。" });
    expect(blocks[1]).toMatchObject({ type: "tool", status: "failed" });
    expect(blocks[2]).toMatchObject({ type: "text", text: expect.stringContaining(expected) });
    expect(JSON.stringify(blocks)).not.toContain("PRIVATE_PROVIDER_BODY");
  });
  it("upserts plan revisions instead of appending stale plan blocks", () => {
    let messages: Message[] = [
      { id: "assistant", role: "assistant", contentBlocks: [] },
    ];
    const { result } = renderHook(() =>
      useChatStream((_sessionId, updater) => {
        messages = updater(messages);
      }),
    );

    const event = (revision: number, status: "pending" | "in_progress") =>
      ({
        type: "plan.updated",
        runId: "run-1",
        planId: "plan-1",
        revision,
        timestamp: "2026-09-01T00:00:00.000Z",
        steps: [{ id: "step-1", title: "生成图片", status }],
      }) satisfies StreamEvent;

    act(() => result.current.applyStreamEvent(event(1, "pending"), "assistant", "session"));
    act(() => result.current.applyStreamEvent(event(2, "in_progress"), "assistant", "session"));

    expect(messages[0]!.contentBlocks).toHaveLength(1);
    expect(messages[0]!.contentBlocks[0]).toMatchObject({
      type: "plan",
      planId: "plan-1",
      revision: 2,
      steps: [{ status: "in_progress" }],
    });
  });

  it.each([
    ["run.failed", "failed", "处理失败"],
    ["run.canceled", "canceled", "已取消"],
  ] as const)("marks running tools on %s", (eventType, status, summary) => {
    let messages: Message[] = [
      {
        id: "assistant",
        role: "assistant",
        contentBlocks: [
          {
            type: "tool",
            toolCallId: "tool-1",
            toolName: "generate_image",
            status: "running",
          },
        ],
      },
    ];
    const { result } = renderHook(() =>
      useChatStream((_sessionId, updater) => {
        messages = updater(messages);
      }),
    );
    const base = {
      type: eventType,
      runId: "run-1",
      timestamp: "2026-09-01T00:00:00.000Z",
      ...(eventType === "run.failed"
        ? { error: { code: "run_failed" as const, message: "boom" } }
        : {}),
    } as StreamEvent;

    act(() => result.current.applyStreamEvent(base, "assistant", "session"));

    expect(messages[0]!.contentBlocks[0]).toMatchObject({ status, outputSummary: summary });
  });

  it("publishes the server-authoritative balance from generation billing", () => {
    let messages: Message[] = [
      {
        id: "assistant",
        role: "assistant",
        contentBlocks: [
          {
            type: "tool",
            toolCallId: "tool-billing",
            toolName: "generate_image",
            status: "running",
          },
        ],
      },
    ];
    const listener = vi.fn();
    window.addEventListener("loomic:credits-updated", listener);
    const { result } = renderHook(() =>
      useChatStream((_sessionId, updater) => {
        messages = updater(messages);
      }),
    );

    act(() =>
      result.current.applyStreamEvent(
        {
          type: "tool.completed",
          runId: "run-1",
          toolCallId: "tool-billing",
          toolName: "generate_image",
          output: {
            billing: {
              estimate: 8,
              charged: 8,
              balanceAfter: 92,
              currency: "credits",
            },
          },
          timestamp: "2026-09-01T00:00:00.000Z",
        } as unknown as StreamEvent,
        "assistant",
        "session",
      ),
    );

    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({ balance: 92 });
    window.removeEventListener("loomic:credits-updated", listener);
  });

  it("records ledger metadata and a precise tool failure", () => {
    let messages: Message[] = [
      { id: "assistant", role: "assistant", contentBlocks: [] },
    ];
    const { result } = renderHook(() =>
      useChatStream((_sessionId, updater) => {
        messages = updater(messages);
      }),
    );

    act(() =>
      result.current.applyStreamEvent(
        {
          type: "tool.started",
          runId: "run-1",
          toolExecutionId: "11111111-1111-4111-8111-111111111111",
          toolCallId: "tool-1",
          toolName: "inspect_canvas",
          planId: "plan-1",
          planStepId: "step-read",
          retryable: true,
          timestamp: "2026-09-01T00:00:00.000Z",
        } as unknown as StreamEvent,
        "assistant",
        "session",
      ),
    );
    act(() =>
      result.current.applyStreamEvent(
        {
          type: "tool.failed",
          runId: "run-1",
          toolExecutionId: "11111111-1111-4111-8111-111111111111",
          toolCallId: "tool-1",
          toolName: "inspect_canvas",
          planId: "plan-1",
          planStepId: "step-read",
          error: { code: "tool_failed", message: "读取画布失败" },
          timestamp: "2026-09-01T00:00:01.000Z",
        } as unknown as StreamEvent,
        "assistant",
        "session",
      ),
    );

    expect(messages[0]!.contentBlocks[0]).toMatchObject({
      type: "tool",
      toolExecutionId: "11111111-1111-4111-8111-111111111111",
      retryable: true,
      planId: "plan-1",
      planStepId: "step-read",
      status: "failed",
      outputSummary: "读取画布失败",
    });
  });

  it("keeps the explicit step association when completion omits it", () => {
    let messages: Message[] = [
      { id: "assistant", role: "assistant", contentBlocks: [] },
    ];
    const { result } = renderHook(() =>
      useChatStream((_sessionId, updater) => {
        messages = updater(messages);
      }),
    );

    act(() => result.current.applyStreamEvent({
      type: "tool.started",
      runId: "run-1",
      toolCallId: "tool-linked",
      toolName: "inspect_canvas",
      planId: "plan-1",
      planStepId: "step-read",
      timestamp: "2026-09-01T00:00:00.000Z",
    } as unknown as StreamEvent, "assistant", "session"));
    act(() => result.current.applyStreamEvent({
      type: "tool.completed",
      runId: "run-1",
      toolCallId: "tool-linked",
      toolName: "inspect_canvas",
      timestamp: "2026-09-01T00:00:01.000Z",
    }, "assistant", "session"));

    expect(messages[0]!.contentBlocks[0]).toMatchObject({
      planId: "plan-1",
      planStepId: "step-read",
      status: "completed",
    });
  });
});
