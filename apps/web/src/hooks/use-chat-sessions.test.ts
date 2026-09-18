// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatSessions } from "./use-chat-sessions";
import { useChatStream } from "./use-chat-stream";

const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchMessages: vi.fn(),
  fetchSessions: vi.fn(),
  updateSessionTitle: vi.fn(),
}));

vi.mock("../lib/server-api", () => api);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const sessionA = { id: "session-a", title: "A" };
const sessionB = { id: "session-b", title: "B" };
const oldMessage = { id: "old", role: "assistant", content: "old", contentBlocks: [] };

function renderChatSessions() {
  return renderHook(() => {
    const sessions = useChatSessions({ canvasId: "canvas-1", accessToken: "token" });
    return { ...sessions, ...useChatStream(sessions.updateSessionMessages) };
  });
}

describe("useChatSessions reload concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchSessions.mockResolvedValue({ sessions: [sessionA, sessionB] });
    api.fetchMessages.mockResolvedValue({ messages: [oldMessage] });
  });

  it("does not let a delayed reload erase a live placeholder and later deltas", async () => {
    const hook = renderChatSessions();
    await waitFor(() => expect(hook.result.current.activeSessionId).toBe(sessionA.id));

    const pending = deferred<{ messages: Array<Record<string, unknown>> }>();
    api.fetchMessages.mockImplementationOnce(() => pending.promise);
    let reload!: Promise<void>;
    act(() => {
      reload = hook.result.current.reloadMessages(sessionA.id);
    });
    act(() => {
      hook.result.current.updateSessionMessages(sessionA.id, previous => [
        ...previous,
        { id: "assistant-live", role: "assistant", contentBlocks: [] },
      ]);
    });

    await act(async () => {
      pending.resolve({ messages: [oldMessage] });
      await reload;
    });
    expect(hook.result.current.messages.map(message => message.id)).toEqual(["old", "assistant-live"]);

    act(() => {
      hook.result.current.applyStreamEvent({
        type: "message.delta",
        runId: "run-live",
        messageId: "assistant-live",
        delta: "stream survived",
        timestamp: new Date().toISOString(),
      }, "assistant-live", sessionA.id);
    });
    expect(hook.result.current.messages.at(-1)?.contentBlocks).toEqual([
      { type: "text", text: "stream survived" },
    ]);

    const finalTool = {
      type: "tool",
      toolCallId: "call-1",
      toolName: "generate_image",
      status: "completed",
      output: { jobId: "job-1", status: "succeeded" },
    };
    api.fetchMessages.mockResolvedValueOnce({ messages: [{
      id: "run-live",
      role: "assistant",
      content: "done",
      contentBlocks: [finalTool],
    }] });
    await act(async () => {
      await hook.result.current.reloadMessages(sessionA.id);
    });
    expect(hook.result.current.messages).toEqual([{
      id: "run-live",
      role: "assistant",
      contentBlocks: [finalTool],
    }]);
  });

  it("versions reloads per session and never leaks a background cache update into the active chat", async () => {
    const hook = renderChatSessions();
    await waitFor(() => expect(hook.result.current.activeSessionId).toBe(sessionA.id));

    const pending = deferred<{ messages: Array<Record<string, unknown>> }>();
    api.fetchMessages.mockImplementationOnce(() => pending.promise);
    let reload!: Promise<void>;
    act(() => { reload = hook.result.current.reloadMessages(sessionA.id); });
    act(() => {
      hook.result.current.updateSessionMessages(sessionB.id, () => [{
        id: "only-b",
        role: "assistant",
        contentBlocks: [{ type: "text", text: "session B" }],
      }]);
    });

    await act(async () => {
      pending.resolve({ messages: [{ id: "new-a", role: "assistant", content: "session A", contentBlocks: [] }] });
      await reload;
    });
    expect(hook.result.current.messages.map(message => message.id)).toEqual(["new-a"]);

    await act(async () => { await hook.result.current.handleSelectSession(sessionB.id); });
    expect(hook.result.current.activeSessionId).toBe(sessionB.id);
    expect(hook.result.current.messages.map(message => message.id)).toEqual(["only-b"]);
  });

  it("ignores an older reload that resolves after a newer snapshot", async () => {
    const hook = renderChatSessions();
    await waitFor(() => expect(hook.result.current.activeSessionId).toBe(sessionA.id));

    const older = deferred<{ messages: Array<Record<string, unknown>> }>();
    const newer = deferred<{ messages: Array<Record<string, unknown>> }>();
    api.fetchMessages
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    let olderReload!: Promise<void>;
    let newerReload!: Promise<void>;
    act(() => {
      olderReload = hook.result.current.reloadMessages(sessionA.id);
      newerReload = hook.result.current.reloadMessages(sessionA.id);
    });

    await act(async () => {
      newer.resolve({ messages: [{ id: "newest", role: "assistant", content: "newest", contentBlocks: [] }] });
      await newerReload;
    });
    await act(async () => {
      older.resolve({ messages: [{ id: "stale", role: "assistant", content: "stale", contentBlocks: [] }] });
      await olderReload;
    });
    expect(hook.result.current.messages.map(message => message.id)).toEqual(["newest"]);
  });
});
