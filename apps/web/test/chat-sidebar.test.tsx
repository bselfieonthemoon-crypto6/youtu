// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebSocketHandle } from "../src/hooks/use-websocket";
import type { StreamEvent, WsCommandAck } from "@loomic/shared";
import { ChatSidebar } from "../src/components/chat-sidebar";
import { INITIAL_EXECUTION_MODE_KEY } from "../src/hooks/use-create-project";

const {
  createSessionMock,
  deleteSessionMock,
  fetchMessagesMock,
  fetchSessionsMock,
  saveMessageMock,
  updateSessionTitleMock,
  fetchSessionRunsMock,
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
  fetchMessagesMock: vi.fn(),
  fetchSessionsMock: vi.fn(),
  saveMessageMock: vi.fn(),
  updateSessionTitleMock: vi.fn(),
  fetchSessionRunsMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  createSession: createSessionMock,
  deleteSession: deleteSessionMock,
  fetchMessages: fetchMessagesMock,
  fetchSessions: fetchSessionsMock,
  saveMessage: saveMessageMock,
  updateSessionTitle: updateSessionTitleMock,
  fetchImageModels: vi.fn().mockResolvedValue({ models: [] }),
  fetchModels: vi.fn().mockResolvedValue({ models: [] }),
  fetchWorkspaceSkills: vi.fn().mockResolvedValue({ skills: [] }),
  fetchSessionRuns: fetchSessionRunsMock,
  fetchAgentRunDetail: vi.fn(),
  ApiAuthError: class ApiAuthError extends Error {},
}));

vi.mock("../src/components/credits/tier-limit-toast", () => ({
  useTierLimitToast: vi.fn(() => ({ showTierLimit: vi.fn() })),
}));

vi.mock("../src/components/toast", () => ({
  useToast: vi.fn(() => ({ toast: vi.fn() })),
}));

let streamListener: ((event: StreamEvent) => void) | undefined;

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

function createMockWs(options?: {
  deferAck?: boolean;
  onAckReady?: (ack: () => void) => void;
}): WebSocketHandle {
  return {
    connected: true,
    startRun: vi.fn((payload, onAck) => {
      // Simulate server ack
      const ack = () =>
        onAck?.({
          type: "command.ack",
          action: "agent.run",
          payload: { runId: "run_123" },
        });
      if (options?.deferAck) options.onAckReady?.(ack);
      else ack();
    }),
    cancelRun: vi.fn(),
    confirmAction: vi.fn(),
    retryTool: vi.fn(),
    onEvent: vi.fn((listener) => {
      streamListener = listener;
      return () => {
        if (streamListener === listener) streamListener = undefined;
      };
    }),
    registerRPC: vi.fn(() => () => {}),
    resumeCanvas: vi.fn(),
  };
}

describe("ChatSidebar", () => {
  let mockWs: WebSocketHandle;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createStorage(),
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: createStorage(),
    });
    streamListener = undefined;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
      writable: true,
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });
    mockWs = createMockWs();
    createSessionMock.mockReset();
    createSessionMock.mockResolvedValue({
      session: {
        id: "session-created",
        title: "New Chat",
        updatedAt: "2026-03-24T00:00:00.000Z",
      },
    });
    deleteSessionMock.mockReset();
    fetchMessagesMock.mockReset();
    fetchMessagesMock.mockResolvedValue({ messages: [] });
    fetchSessionsMock.mockReset();
    fetchSessionsMock.mockResolvedValue({
      sessions: [
        {
          id: "session-real",
          title: "Existing Chat",
          updatedAt: "2026-03-24T00:00:00.000Z",
        },
      ],
    });
    saveMessageMock.mockReset();
    saveMessageMock.mockResolvedValue(undefined);
    updateSessionTitleMock.mockReset();
    updateSessionTitleMock.mockResolvedValue(undefined);
    fetchSessionRunsMock.mockReset();
    fetchSessionRunsMock.mockResolvedValue({ runs: [], nextCursor: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("starts runs via WebSocket with the active real session id", async () => {
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
      />,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "hello loom{Enter}");

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-real",
          conversationId: "canvas-1",
          prompt: "hello loom",
          canvasId: "canvas-1",
          executionMode: "thinking",
        }),
        expect.any(Function),
      ),
    );
    expect(screen.queryByLabelText("执行模式")).not.toBeInTheDocument();
    expect(mockWs.startRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-canvas-1",
      }),
      expect.anything(),
    );
  });

  it("runs an explicit selected-image toolbar command with its attachment", async () => {
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
        imageChatCommand={{
          id: "command-1",
          mode: "run-agent",
          prompt: "对图片重新打光",
          image: {
            assetId: "asset-1",
            url: "data:image/png;base64,aGVsbG8=",
            mimeType: "image/png",
            name: "Logo",
          },
        }}
      />,
    );

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "对图片重新打光",
          attachments: [
            expect.objectContaining({
              assetId: "asset-1",
              source: "canvas-ref",
            }),
          ],
        }),
        expect.any(Function),
      ),
    );
  });

  it("opens run history for the active session", async () => {
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "打开运行历史" }),
    );
    expect(
      await screen.findByRole("region", { name: "运行历史" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchSessionRunsMock).toHaveBeenCalledWith(
        "token_abc",
        "session-real",
        {
          limit: 20,
        },
      ),
    );
  });

  it("opens the conversation menu and switches back to an older conversation", async () => {
    fetchSessionsMock.mockResolvedValueOnce({
      sessions: [
        {
          id: "session-real",
          title: "New Chat",
          updatedAt: "2026-03-24T00:00:00.000Z",
        },
        {
          id: "session-old",
          title: "旧的 Logo 对话",
          updatedAt: "2026-03-23T00:00:00.000Z",
        },
      ],
    });
    fetchMessagesMock.mockImplementation(
      async (_token: string, sessionId: string) => ({
        messages:
          sessionId === "session-old"
            ? [
                {
                  id: "old-message",
                  role: "assistant",
                  content: "旧对话已恢复",
                  contentBlocks: [{ type: "text", text: "旧对话已恢复" }],
                  createdAt: "2026-03-23T00:00:00.000Z",
                },
              ]
            : [],
      }),
    );
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
      />,
    );

    const conversationMenuButton = (
      await screen.findByText("New Chat")
    ).closest("button");
    expect(conversationMenuButton).not.toBeNull();
    await userEvent.click(conversationMenuButton!);
    await userEvent.click(await screen.findByText("旧的 Logo 对话"));

    expect(await screen.findByText("旧对话已恢复")).toBeInTheDocument();
    expect(fetchMessagesMock).toHaveBeenLastCalledWith(
      "token_abc",
      "session-old",
    );

    const input = screen.getByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "继续旧对话{Enter}");
    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-old",
          prompt: "继续旧对话",
        }),
        expect.any(Function),
      ),
    );
  });

  it("disables message input while an uncached conversation is loading", async () => {
    let resolveOldMessages:
      | ((value: {
          messages: Array<{
            id: string;
            role: string;
            content: string;
            contentBlocks: Array<{ type: string; text: string }>;
            createdAt: string;
          }>;
        }) => void)
      | undefined;
    fetchSessionsMock.mockResolvedValueOnce({
      sessions: [
        {
          id: "session-real",
          title: "New Chat",
          updatedAt: "2026-03-24T00:00:00.000Z",
        },
        {
          id: "session-old",
          title: "旧的 Logo 对话",
          updatedAt: "2026-03-23T00:00:00.000Z",
        },
      ],
    });
    fetchMessagesMock.mockImplementation(
      async (_token: string, sessionId: string) => {
        if (sessionId !== "session-old") return { messages: [] };
        return new Promise((resolve) => {
          resolveOldMessages = resolve;
        });
      },
    );
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
      />,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "切换期间不能发送");
    const conversationMenuButton = (
      await screen.findByText("New Chat")
    ).closest("button");
    if (!conversationMenuButton) throw new Error("Conversation menu not found");
    await userEvent.click(conversationMenuButton);
    await userEvent.click(await screen.findByText("旧的 Logo 对话"));

    const sendButton = screen.getByRole("button", { name: "发送消息" });
    await waitFor(() => expect(sendButton).toBeDisabled());

    resolveOldMessages?.({
      messages: [
        {
          id: "old-message",
          role: "assistant",
          content: "旧对话已恢复",
          contentBlocks: [{ type: "text", text: "旧对话已恢复" }],
          createdAt: "2026-03-23T00:00:00.000Z",
        },
      ],
    });

    expect(await screen.findByText("旧对话已恢复")).toBeInTheDocument();
    await waitFor(() => expect(sendButton).toBeEnabled());
  });

  it("keeps the proposal scrollable above a floating confirmation dialog", async () => {
    fetchMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "proposal-message",
          role: "assistant",
          content: "设计方案已经准备好了。请确认方案后继续执行并生成预览。",
          contentBlocks: [
            {
              type: "text",
              text: "设计方案已经准备好了。请确认方案后继续执行并生成预览。",
            },
          ],
          createdAt: "2026-03-24T00:00:00.000Z",
        },
      ],
    });
    const { container } = render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "确认设计方案" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      const clearance = container.querySelector<HTMLElement>(
        "[data-chat-dialog-clearance]",
      );
      expect(clearance).not.toBeNull();
      expect(Number.parseFloat(clearance?.style.height ?? "0")).toBeGreaterThan(
        0,
      );
    });
  });

  it("requires review of the frozen image proposal and sends its exact ID through a session-bound run", async () => {
    fetchMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "approval-message",
          role: "user",
          content: "可以",
          contentBlocks: [{ type: "text", text: "可以" }],
          createdAt: "2026-03-24T00:00:00.000Z",
        },
        {
          id: "structured-proposal",
          role: "assistant",
          content: "方案已经冻结，请确认生成。",
          contentBlocks: [
            { type: "text", text: "方案已经冻结，请确认生成。" },
            {
              type: "tool",
              toolCallId: "tool-generate",
              toolName: "generate_image",
              status: "completed",
              output: {
                status: "awaiting_confirmation",
                confirmation: {
                  confirmationId: "confirmation-1",
                  kind: "image_generation",
                  targets: [],
                },
              },
            },
          ],
          createdAt: "2026-03-24T00:00:01.000Z",
        },
      ],
    });
    const onCanvasSync = vi.fn();

    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        onCanvasSync={onCanvasSync}
        ws={mockWs}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "确认设计方案" }),
    ).toBeInTheDocument();
    expect(mockWs.startRun).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /确认方案，继续生成/ }),
    );
    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "确认生成",
          imageConfirmation: {
            confirmationId: "confirmation-1",
            decision: "confirm",
          },
        }),
        expect.any(Function),
      ),
    );
    expect(mockWs.confirmAction).not.toHaveBeenCalled();
    streamListener?.({
      type: "run.completed",
      runId: "run_123",
      timestamp: new Date().toISOString(),
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "确认设计方案" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("confirms a design template inline without showing an image generation placeholder", async () => {
    fetchMessagesMock.mockResolvedValue({
      messages: [
        {
          id: "design-confirmation",
          role: "assistant",
          content: "模板已就绪，请确认套用。",
          contentBlocks: [
            {
              type: "tool",
              toolCallId: "tool-template",
              toolName: "apply_design_template",
              status: "completed",
              output: {
                status: "confirmation_required",
                confirmation_id: "confirmation-template",
                design_id: "10000000-0000-4000-8000-000000000001",
                template_id: "20000000-0000-4000-8000-000000000001",
                expected_revision: 3,
                summary: "替换当前设计场景",
                affected_object_ids: [],
                expires_at: "2026-09-04T00:10:00.000Z",
              },
            },
            { type: "text", text: "模板已就绪，请确认套用。" },
          ],
          createdAt: "2026-09-04T00:00:00.000Z",
        },
      ],
    });
    vi.mocked(mockWs.confirmAction).mockImplementation(
      (confirmationId, decision, onAck) => {
        onAck?.({
          type: "command.ack",
          action: "agent.confirm_action",
          payload: { confirmationId, decision, status: "accepted" },
        });
      },
    );

    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "确认套用" }),
    );
    expect(mockWs.confirmAction).toHaveBeenCalledWith(
      "confirmation-template",
      "confirm",
      expect.any(Function),
    );
    expect(
      await screen.findByText("已确认，正在应用设计更改"),
    ).toBeInTheDocument();
    expect(screen.queryByText("图片生成中...")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "确认套用设计模板" }),
    ).not.toBeInTheDocument();
  });

  it("sends the selected Thinking mode in the run payload", async () => {
    localStorage.setItem("loomic:execution-mode", "thinking");
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
      />,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "think deeply{Enter}");

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({ executionMode: "thinking" }),
        expect.any(Function),
      ),
    );
  });

  it("preserves the home-page execution mode for the auto-sent first prompt", async () => {
    sessionStorage.setItem(INITIAL_EXECUTION_MODE_KEY, "thinking");
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        initialPrompt="design a poster"
        ws={mockWs}
      />,
    );

    await waitFor(() =>
      expect(mockWs.startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "design a poster",
          executionMode: "thinking",
        }),
        expect.any(Function),
      ),
    );
    expect(sessionStorage.getItem(INITIAL_EXECUTION_MODE_KEY)).toBeNull();
  });

  it("stops an acknowledged run and restores the send button on cancellation", async () => {
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
      />,
    );
    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "generate{Enter}");

    await userEvent.click(
      await screen.findByRole("button", { name: "停止生成" }),
    );
    expect(mockWs.cancelRun).toHaveBeenCalledWith("run_123");

    streamListener?.({
      type: "run.canceled",
      runId: "run_123",
      timestamp: "2026-09-01T00:00:00.000Z",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "发送消息" }),
      ).toBeInTheDocument(),
    );
  });

  it("honors a stop request made before the run acknowledgement arrives", async () => {
    let acknowledge: (() => void) | undefined;
    mockWs = createMockWs({
      deferAck: true,
      onAckReady: (ack) => {
        acknowledge = ack;
      },
    });
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
      />,
    );
    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "generate{Enter}");
    await userEvent.click(
      await screen.findByRole("button", { name: "停止生成" }),
    );
    expect(mockWs.cancelRun).not.toHaveBeenCalled();

    acknowledge?.();
    await waitFor(() =>
      expect(mockWs.cancelRun).toHaveBeenCalledWith("run_123"),
    );
  });

  it("can stop a run restored by canvas resume", async () => {
    vi.mocked(mockWs.resumeCanvas).mockImplementation((_canvasId, onAck) => {
      onAck?.({
        type: "command.ack",
        action: "canvas.resume",
        payload: { activeRunId: "run_resumed" },
      });
    });
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "停止生成" }),
    );
    expect(mockWs.cancelRun).toHaveBeenCalledWith("run_resumed");
  });

  it("saves the active design before forwarding its explicit generation target", async () => {
    const save = vi.fn(async () => {
      expect(mockWs.startRun).not.toHaveBeenCalled();
    });
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
        activeDesignId="20000000-0000-4000-8000-000000000001"
        beforeDesignSend={save}
      />,
    );
    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "生成背景{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalled());
    expect(save).toHaveBeenCalledOnce();
    expect(vi.mocked(mockWs.startRun).mock.calls[0]?.[0]).toMatchObject({
      activeDesignId: "20000000-0000-4000-8000-000000000001",
    });
  });

  it("does not submit an Agent run when the active design cannot save", async () => {
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
        activeDesignId="20000000-0000-4000-8000-000000000001"
        beforeDesignSend={async () => {
          throw new Error("先处理画板冲突");
        }}
      />,
    );
    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "生成背景{Enter}");
    await waitFor(() =>
      expect(screen.getByText(/先处理画板冲突/)).toBeInTheDocument(),
    );
    expect(mockWs.startRun).not.toHaveBeenCalled();
  });

  it("keeps a new conversation empty when the previous run emits late events", async () => {
    fetchMessagesMock.mockResolvedValueOnce({
      messages: [
        {
          id: "old-message",
          role: "assistant",
          content: "旧对话内容",
          contentBlocks: [{ type: "text", text: "旧对话内容" }],
          createdAt: "2026-03-24T00:00:00.000Z",
        },
      ],
    });
    render(
      <ChatSidebar
        accessToken="token_abc"
        canvasId="canvas-1"
        open
        onToggle={() => {}}
        ws={mockWs}
      />,
    );

    const input = await screen.findByPlaceholderText(/start with an idea/i);
    expect(screen.getByText("旧对话内容")).toBeInTheDocument();
    await userEvent.type(input, "继续生成{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalled());

    await userEvent.click(screen.getByTitle("New Chat"));
    await waitFor(() =>
      expect(screen.queryByText("旧对话内容")).not.toBeInTheDocument(),
    );
    expect(mockWs.cancelRun).toHaveBeenCalledWith("run_123");

    streamListener?.({
      type: "message.delta",
      runId: "run_123",
      messageId: "assistant-late",
      delta: "旧任务迟到的内容",
      timestamp: "2026-03-24T00:00:01.000Z",
    });
    expect(screen.queryByText("旧任务迟到的内容")).not.toBeInTheDocument();
    expect(screen.queryByText("旧对话内容")).not.toBeInTheDocument();
  });
});
