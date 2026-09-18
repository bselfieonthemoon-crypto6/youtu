// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebSocketHandle } from "../src/hooks/use-websocket";
import type { StreamEvent, WsCommandAck } from "@loomic/shared";
import { ChatSidebar } from "../src/components/chat-sidebar";
import { INITIAL_ATTACHMENTS_KEY, INITIAL_EXECUTION_MODE_KEY } from "../src/hooks/use-create-project";
import { fetchModels, fetchWorkspaceSkills } from "../src/lib/server-api";

const {
  createSessionMock,
  deleteSessionMock,
  fetchMessagesMock,
  fetchSessionsMock,
  saveMessageMock,
  truncateMessagesFromMock,
  updateSessionTitleMock,
  fetchSessionRunsMock,
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
  fetchMessagesMock: vi.fn(),
  fetchSessionsMock: vi.fn(),
  saveMessageMock: vi.fn(),
  truncateMessagesFromMock: vi.fn(),
  updateSessionTitleMock: vi.fn(),
  fetchSessionRunsMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  createSession: createSessionMock,
  deleteSession: deleteSessionMock,
  fetchMessages: fetchMessagesMock,
  fetchSessions: fetchSessionsMock,
  saveMessage: saveMessageMock,
  truncateMessagesFrom: truncateMessagesFromMock,
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
    Object.defineProperty(Element.prototype, "scrollTo", {
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
    truncateMessagesFromMock.mockReset();
    truncateMessagesFromMock.mockResolvedValue({ deleted: 1 });
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
    vi.mocked(fetchWorkspaceSkills).mockResolvedValue({ skills: [] });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("selects a skill into the existing composer draft without starting a run", async () => {
    vi.mocked(fetchWorkspaceSkills).mockResolvedValue({
      skills: [{
        id: "poster-skill", slug: "campaign-design", name: "活动海报与宣传图", description: "设计海报",
        installed: true, enabled: true, metadata: {}, readiness: { status: "ready", reasons: [], models: [] },
      }],
    } as never);
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs} />);
    const composer = await screen.findByRole("textbox", { name: "输入消息" });
    fireEvent.change(composer, { target: { value: "保留这段目标" } });

    await userEvent.click(await screen.findByRole("button", { name: "活动海报与宣传图" }));

    expect(composer).toHaveValue("请使用「活动海报与宣传图」技能协助我。\n\n保留这段目标");
    expect(mockWs.startRun).not.toHaveBeenCalled();
  });

  it("replaces the edited turn instead of appending a parallel one, keeping the composer draft", async () => {
    // First load shows the original turn; the reload after truncation shows it gone.
    fetchMessagesMock.mockResolvedValueOnce({ messages: [{ id: "original-user", role: "user", content: "原始请求", contentBlocks: [
      { type: "text", text: "原始请求" },
      { type: "image", assetId: "old-image", url: "https://example.com/original.png", mimeType: "image/png", source: "upload", name: "Original" },
      { type: "mention", mentionType: "image-model", id: "workspace:original-model", label: "gpt-image-2" },
    ] }] }).mockResolvedValue({ messages: [] });
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs} />);
    await screen.findByText("原始请求");
    const composer = screen.getByRole("textbox");
    fireEvent.change(composer, { target: { value: "未发送的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "编辑消息" }));
    fireEvent.change(screen.getByRole("textbox", { name: "编辑消息" }), { target: { value: "修改尺寸为800*600" } });
    fireEvent.click(screen.getByRole("button", { name: "发送编辑后的消息" }));
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledOnce());
    // The edited turn must be removed BEFORE the replacement is sent, otherwise
    // the superseded attempt (and its generation card) stays on screen.
    expect(truncateMessagesFromMock).toHaveBeenCalledWith("token_abc", "session-real", "original-user");
    expect(truncateMessagesFromMock.mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(mockWs.startRun).mock.invocationCallOrder[0]!);
    expect(mockWs.startRun).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "修改尺寸为800*600", sessionId: "session-real",
      attachments: [expect.objectContaining({ assetId: "old-image" })],
      imageGenerationPreference: { mode: "manual", models: ["workspace:original-model"] },
      mentions: [expect.objectContaining({ id: "workspace:original-model" })],
    }), expect.any(Function), expect.any(Function));
    await act(async () => streamListener?.({ type: "run.completed", runId: "run_123", timestamp: new Date().toISOString() }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "编辑消息" })).not.toBeInTheDocument());
    expect(screen.queryByText("原始请求")).not.toBeInTheDocument();
    expect(composer).toHaveValue("未发送的草稿");
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(saveMessageMock).toHaveBeenCalledWith("token_abc", "session-real", expect.objectContaining({ content: "修改尺寸为800*600" }));
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
        expect.any(Function),
      ),
    );
    const savedMessageId = saveMessageMock.mock.calls[0]![2].id;
    expect(savedMessageId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(vi.mocked(mockWs.startRun).mock.calls[0]![0].userMessageId).toBe(savedMessageId);
    expect(screen.queryByLabelText("执行模式")).not.toBeInTheDocument();
    expect(mockWs.startRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-canvas-1",
      }),
      expect.anything(),
      expect.any(Function),
    );
  });

  it("does not start a run when the authoritative user message cannot be saved", async () => {
    saveMessageMock.mockRejectedValueOnce(new Error("message persistence unavailable"));
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs} />);
    await userEvent.type(screen.getByRole("textbox"), "确认生成{Enter}");
    await waitFor(() => expect(saveMessageMock).toHaveBeenCalledOnce());
    expect(mockWs.startRun).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeInTheDocument());
  });

  it("waits for the authoritative message save before starting the run", async () => {
    let resolveSave!: (value: undefined) => void;
    saveMessageMock.mockReturnValueOnce(new Promise<undefined>((resolve) => { resolveSave = resolve; }));
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs} />);
    await userEvent.type(screen.getByRole("textbox"), "先保存再运行");
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(saveMessageMock).toHaveBeenCalledOnce());
    expect(mockWs.startRun).not.toHaveBeenCalled();
    await act(async () => resolveSave(undefined));
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledOnce());
  });

  it("blocks a rapid second send while the first message save is pending", async () => {
    let resolveSave!: (value: undefined) => void;
    saveMessageMock.mockReturnValueOnce(new Promise<undefined>((resolve) => { resolveSave = resolve; }));
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs} />);
    await userEvent.type(screen.getByRole("textbox"), "只发送一次");
    const send = screen.getByRole("button", { name: "发送消息" });
    act(() => {
      fireEvent.click(send);
      fireEvent.click(send);
    });
    await waitFor(() => expect(saveMessageMock).toHaveBeenCalledOnce());
    expect(mockWs.startRun).not.toHaveBeenCalled();
    await act(async () => resolveSave(undefined));
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledOnce());
    expect(saveMessageMock).toHaveBeenCalledOnce();
  });

  it("shows the server startup rejection immediately and releases the input", async () => {
    vi.mocked(mockWs.startRun).mockImplementation((_payload, _ack, onError) => {
      onError?.(new Error("The selected text model is not available in this workspace."));
    });
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs} />);
    await userEvent.type(screen.getByRole("textbox"), "黑色背景改为绿色");
    await userEvent.click(screen.getByRole("button", { name: "发送消息" }));
    expect(await screen.findByText(/当前选择的 Agent 模型不可用/)).toBeInTheDocument();
    expect(screen.queryByText("Failed to get response.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeInTheDocument();
  });

  it("captures native canvas selection at send time rather than trusting the cached sidebar selection", async () => {
    const onRequestCanvasSelection = vi.fn(() => ({ elementIds: ["actual-text"] }));
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs}
      selectedCanvasElements={[{ id: "cached-text", type: "text", x: 0, y: 0, width: 100, height: 30 }]}
      onRequestCanvasSelection={onRequestCanvasSelection} />);
    await userEvent.type(screen.getByRole("textbox"), "选中的文字改短一点{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledOnce());
    const payload = vi.mocked(mockWs.startRun).mock.calls[0]![0];
    expect(onRequestCanvasSelection).toHaveBeenCalledExactlyOnceWith("canvas-1");
    expect(payload.canvasSelection).toEqual({ elementIds: ["actual-text"] });
    expect(screen.queryByRole("region", { name: "当前需求" })).not.toBeInTheDocument();
  });

  it("sends an empty native selection when no current editor is available without guessing from cached props", async () => {
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs}
      selectedCanvasElements={[{ id: "stale-text", type: "text", x: 0, y: 0, width: 100, height: 30 }]} />);
    await userEvent.type(screen.getByRole("textbox"), "聊聊文案{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledOnce());
    expect(vi.mocked(mockWs.startRun).mock.calls[0]![0].canvasSelection).toEqual({ elementIds: [] });
    expect(screen.queryByRole("region", { name: "当前需求" })).not.toBeInTheDocument();
  });

  it("keeps the transmitted selection immutable while an ACK is pending", async () => {
    mockWs = createMockWs({ deferAck: true });
    const elementIds = ["first-text"];
    const onRequestCanvasSelection = vi.fn(() => ({ elementIds }));
    const props = { accessToken: "token_abc", canvasId: "canvas-1", open: true, onToggle: () => {}, ws: mockWs, onRequestCanvasSelection };
    const { rerender } = render(<ChatSidebar {...props} />);
    await userEvent.type(screen.getByRole("textbox"), "修改这段文字{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledOnce());
    elementIds.splice(0, 1, "later-selected-text");
    rerender(<ChatSidebar {...props} selectedCanvasElements={[{ id: "later-selected-text", type: "text", x: 0, y: 0, width: 100, height: 30 }]} />);
    expect(vi.mocked(mockWs.startRun).mock.calls[0]![0].canvasSelection).toEqual({ elementIds: ["first-text"] });
    expect(onRequestCanvasSelection).toHaveBeenCalledOnce();
  });

  it("does not bind an open editor without an explicit target selection", async () => {
    const onRequestCanvasSelection = vi.fn(() => ({ elementIds: ["unrelated-text"] }));
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs}
      activeDesignId="11111111-1111-4111-8111-111111111111" onRequestCanvasSelection={onRequestCanvasSelection} />);
    await userEvent.type(screen.getByRole("textbox"), "修改设计标题{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledOnce());
    expect(vi.mocked(mockWs.startRun).mock.calls[0]![0]).toEqual(expect.objectContaining({
      canvasSelection: { elementIds: ["unrelated-text"] },
    }));
    expect(onRequestCanvasSelection).toHaveBeenCalledOnce();
  });

  it("releases a disconnected send when the run finished before reconnect", async () => {
    const props = { accessToken: "token_abc", canvasId: "canvas-1", open: true, onToggle: () => {} };
    const { rerender } = render(<ChatSidebar {...props} ws={mockWs} />);
    await userEvent.type(screen.getByRole("textbox"), "生成图片");
    await userEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledOnce());
    const beforeDisconnect = streamListener;
    rerender(<ChatSidebar {...props} ws={{ ...mockWs, connected: false }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeInTheDocument());
    expect(streamListener).not.toBe(beforeDisconnect);
    vi.mocked(mockWs.resumeCanvas).mockImplementation((_id, ack) => ack?.({ type: "command.ack", action: "canvas.resume", payload: { activeRunId: null } }));
    rerender(<ChatSidebar {...props} ws={mockWs} />);
    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalled());
    expect(mockWs.startRun).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeInTheDocument();
  });

  it("never inserts a completed design image again as a loose canvas image", async () => {
    const onImageGenerated = vi.fn();
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs} onImageGenerated={onImageGenerated} />);
    await userEvent.type(screen.getByRole("textbox"), "生成主体");
    await userEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledOnce());
    streamListener?.({ type: "tool.completed", runId: "run_123", toolCallId: "tool", toolName: "confirm_image_generation", timestamp: "2026-09-08T00:00:00Z", output: { design_id: "design", status: "succeeded" }, artifacts: [{ type: "image", url: "https://example.test/image.png", mimeType: "image/png", width: 512, height: 512 }] });
    expect(onImageGenerated).not.toHaveBeenCalled();
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
        payload: { activeRunId: "run_resumed", activeSessionId: "session-real" },
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
        selectedCanvasElements={[{ id: "title", type: "text", designId: "20000000-0000-4000-8000-000000000001", x: 0, y: 0, width: 100, height: 30 }]}
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
        selectedCanvasElements={[{ id: "title", type: "text", designId: "20000000-0000-4000-8000-000000000001", x: 0, y: 0, width: 100, height: 30 }]}
      />,
    );
    const input = await screen.findByPlaceholderText(/start with an idea/i);
    await userEvent.type(input, "生成背景{Enter}");
    await waitFor(() =>
      expect(screen.getByText(/先处理画板冲突/)).toBeInTheDocument(),
    );
    expect(mockWs.startRun).not.toHaveBeenCalled();
  });

  it("keeps an ordinary image request unbound while an editor is open", async () => {
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs} activeDesignId="new-design" />);
    await screen.findByRole("textbox", { name: "输入消息" });
    expect(screen.queryByRole("button", { name: "退出补充/纠正" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "补充纠正状态" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "输入消息" }), "生成一张夕阳下的猫咪插画{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledOnce());
    expect(vi.mocked(mockWs.startRun).mock.calls[0]![0]).not.toHaveProperty("activeDesignId");
  });

  it("does not fall back to a historic or open board for an explicit uploaded image", async () => {
    sessionStorage.setItem(INITIAL_ATTACHMENTS_KEY, JSON.stringify([{ assetId: "uploaded-image", url: "https://example.test/upload.png", mimeType: "image/png", source: "upload" }]));
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs} activeDesignId="open-design" initialPrompt="只分析刚上传的图片" />);
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalledOnce());
    const payload = vi.mocked(mockWs.startRun).mock.calls[0]![0];
    expect(payload.attachments).toEqual([expect.objectContaining({ assetId: "uploaded-image", source: "upload" })]);
    expect(payload).not.toHaveProperty("canvasSelection");
    expect(payload).not.toHaveProperty("activeDesignId");
  });

  it("never reattaches a just-completed run returned by a racing resume response", async () => {
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs} />);
    await userEvent.type(await screen.findByRole("textbox", { name: "输入消息" }), "普通咨询{Enter}");
    vi.mocked(mockWs.resumeCanvas).mockImplementation((_canvas, ack) => ack?.({ type: "command.ack", action: "canvas.resume", payload: { activeRunId: "run_123", activeSessionId: "session-real" } }));
    const initialResumes = vi.mocked(mockWs.resumeCanvas).mock.calls.length;
    act(() => streamListener?.({ type: "run.completed", runId: "run_123", timestamp: "2026-09-09T00:00:00Z" }));
    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalledTimes(initialResumes + 2));
    expect(screen.queryByRole("button", { name: "停止生成" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeInTheDocument();
  });

  it.each(["other-session", null, undefined])("refuses resumed runs without matching conversation identity (%s)", async activeSessionId => {
    vi.mocked(mockWs.resumeCanvas).mockImplementation((_canvas, ack) => ack?.({ type: "command.ack", action: "canvas.resume", payload: { activeRunId: "foreign-run", activeSessionId } }));
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs} />);
    await waitFor(() => expect(mockWs.resumeCanvas).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "停止生成" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "补充纠正状态" })).not.toBeInTheDocument();
    expect(mockWs.onEvent).not.toHaveBeenCalled();
    expect(mockWs.cancelRun).not.toHaveBeenCalled();
  });

  it("keeps the submitted design scope when selection changes during save", async () => {
    let finishSave: (() => void) | undefined;
    const save = vi.fn(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const props = { accessToken: "token_abc", canvasId: "canvas-1", open: true, onToggle: () => {}, ws: mockWs };
    const originalDesignId = "10000000-0000-4000-8000-000000000001";
    const selectedCanvasElements = [{ id: "title", type: "text", designId: originalDesignId, x: 0, y: 0, width: 100, height: 30 }];
    const { rerender } = render(<ChatSidebar {...props} activeDesignId={originalDesignId} beforeDesignSend={save} selectedCanvasElements={selectedCanvasElements} />);
    await userEvent.type(await screen.findByRole("textbox", { name: "输入消息" }), "更新标题{Enter}");
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    rerender(<ChatSidebar {...props} activeDesignId="20000000-0000-4000-8000-000000000002" selectedCanvasElements={selectedCanvasElements} />);
    await act(async () => { finishSave?.(); });
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalled());
    expect(vi.mocked(mockWs.startRun).mock.calls[0]![0]).toMatchObject({
      activeDesignId: originalDesignId,
    });
  });

  it("binds a selected unopened design artboard", async () => {
    const designId = "10000000-0000-4000-8000-000000000001";
    render(<ChatSidebar accessToken="token_abc" canvasId="canvas-1" open onToggle={() => {}} ws={mockWs}
      selectedCanvasElements={[{ id: "board-element", type: "rectangle", designId, x: 0, y: 0, width: 100, height: 100 }]} />);
    await userEvent.type(await screen.findByRole("textbox", { name: "输入消息" }), "改标题{Enter}");
    await waitFor(() => expect(mockWs.startRun).toHaveBeenCalled());
    expect(vi.mocked(mockWs.startRun).mock.calls[0]![0]).toMatchObject({
      activeDesignId: designId,
    });
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
