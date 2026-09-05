// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunHistoryPanel } from "../src/components/chat/run-history-panel";
import { ApiAuthError } from "../src/lib/server-api";

const { fetchSessionRunsMock, fetchAgentRunDetailMock } = vi.hoisted(() => ({
  fetchSessionRunsMock: vi.fn(),
  fetchAgentRunDetailMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/server-api")>();
  return {
    ...original,
    fetchSessionRuns: fetchSessionRunsMock,
    fetchAgentRunDetail: fetchAgentRunDetailMock,
  };
});

const summary = {
  runId: "run-1",
  sessionId: "session-1",
  status: "completed" as const,
  executionMode: "thinking" as const,
  model: "gemini-3.1-flash-lite",
  createdAt: "2026-09-01T01:00:00.000Z",
  startedAt: "2026-09-01T01:00:01.000Z",
  completedAt: "2026-09-01T01:00:03.500Z",
  durationMs: 2500,
  error: null,
  toolCounts: { total: 1, running: 0, completed: 1, failed: 0, canceled: 0 },
};

describe("RunHistoryPanel", () => {
  beforeEach(() => {
    fetchSessionRunsMock.mockReset();
    fetchAgentRunDetailMock.mockReset();
    fetchSessionRunsMock.mockResolvedValue({ runs: [summary], nextCursor: null });
    fetchAgentRunDetailMock.mockResolvedValue({
      ...summary,
      tools: [{
        id: "tool-1",
        toolCallId: "call-1",
        toolName: "generate_image",
        status: "completed",
        retryable: false,
        attempt: 2,
        retryOf: "tool-0",
        startedAt: "2026-09-01T01:00:01.000Z",
        finishedAt: "2026-09-01T01:00:02.000Z",
      }],
    });
  });

  afterEach(() => cleanup());

  it("shows mode, model and opens a read-only tool detail", async () => {
    render(<RunHistoryPanel accessToken="token" sessionId="session-1" onClose={() => {}} />);

    expect(await screen.findByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText(/gemini-3.1-flash-lite/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Thinking/ }));

    expect(await screen.findByText("生成图片")).toBeInTheDocument();
    expect(screen.getByText("第 2 次尝试")).toBeInTheDocument();
    expect(fetchAgentRunDetailMock).toHaveBeenCalledWith("token", "session-1", "run-1");
    expect(screen.queryByRole("button", { name: /重放|恢复|重试工具/ })).not.toBeInTheDocument();
  });

  it("filters runs and loads the next page", async () => {
    fetchSessionRunsMock
      .mockResolvedValueOnce({ runs: [summary], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({
        runs: [{ ...summary, runId: "run-2", status: "failed", model: "deepseek-v4" }],
        nextCursor: null,
      });
    render(<RunHistoryPanel accessToken="token" sessionId="session-1" onClose={() => {}} />);
    await screen.findByText(/gemini-3.1-flash-lite/);
    await userEvent.click(screen.getByRole("button", { name: "失败" }));
    expect(screen.getByText(/可继续加载更早记录/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText(/deepseek-v4/)).toBeInTheDocument();
    expect(screen.queryByText(/gemini-3.1-flash-lite/)).not.toBeInTheDocument();
    expect(fetchSessionRunsMock).toHaveBeenLastCalledWith("token", "session-1", { cursor: "cursor-2", limit: 20 });
  });

  it("shows clear empty, auth and permission states", async () => {
    fetchSessionRunsMock.mockResolvedValueOnce({ runs: [], nextCursor: null });
    const { rerender } = render(<RunHistoryPanel accessToken="token" sessionId="session-empty" onClose={() => {}} />);
    expect(await screen.findByText("当前会话还没有运行记录。")).toBeInTheDocument();

    fetchSessionRunsMock.mockRejectedValueOnce(new ApiAuthError());
    rerender(<RunHistoryPanel accessToken="expired" sessionId="session-auth" onClose={() => {}} />);
    expect(await screen.findByText(/登录状态已失效/)).toBeInTheDocument();

    fetchSessionRunsMock.mockRejectedValueOnce(Object.assign(new Error(), { code: "forbidden" }));
    rerender(<RunHistoryPanel accessToken="token" sessionId="session-denied" onClose={() => {}} />);
    expect(await screen.findByText(/没有权限查看/)).toBeInTheDocument();
  });

  it("closes from its compact header", async () => {
    const onClose = vi.fn();
    render(<RunHistoryPanel accessToken="token" sessionId="session-1" onClose={onClose} />);
    await waitFor(() => expect(fetchSessionRunsMock).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "关闭运行历史" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
