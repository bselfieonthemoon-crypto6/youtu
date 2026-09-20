import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { AgentRunService } from "../agent/runtime.js";
import { refusalCorrectionId } from "../agent/mastra-refusal-notice.js";
import type { StreamEvent } from "@loomic/shared";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

const REFUSAL_SUMMARY =
  "本轮没有近似授权，不能把用户要求的比例改成其它比例。若目标比例超出 3:1/1:3，需要用户明确接受近似，或原话直接给出该像素尺寸（如 658×176）；未提交或扣费。";
const CORRECTION_TEXT = `本轮没有提交任何生成任务，也没有扣费；${REFUSAL_SUMMARY}`;

describe("WebSocket assistant persistence identity", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  /** One agent run whose stream yields the events the fence reads. */
  function startRun(input: {
    runId: string;
    events: (runId: string) => StreamEvent[];
    createMessage: ReturnType<typeof vi.fn>;
  }) {
    const agentRuns = {
      createRun: vi.fn(() => ({ conversationId: "canvas", runId: input.runId, sessionId: "session", status: "accepted" })),
      async *streamRun() {
        for (const event of input.events(input.runId)) yield event;
      },
    } as unknown as AgentRunService;
    const app = Fastify();
    apps.push(app);
    return { agentRuns, app, createMessage: input.createMessage };
  }

  function sendRun(app: ReturnType<typeof Fastify>, prompt: string) {
    return app
      .injectWS("/api/ws?token=test&connectionId=persistence-identity-2")
      .then((socket: (typeof sockets)[number]) => {
        sockets.push(socket);
        socket.send(JSON.stringify({ type: "command", action: "agent.run", payload: {
          canvasId: "canvas", conversationId: "canvas", sessionId: "session", prompt, model: "apiyi:offline",
        } }));
        return socket;
      });
  }

  it("uses the run id when persisting a streamed assistant response", async () => {
    const runId = "33333333-3333-4333-8333-333333333333";
    const createMessage = vi.fn(async () => ({ id: runId }));
    const agentRuns = {
      createRun: vi.fn(() => ({ conversationId: "canvas", runId, sessionId: "session", status: "accepted" })),
      async *streamRun() {
        yield { type: "run.started", runId, conversationId: "canvas", sessionId: "session", timestamp: new Date().toISOString() } as StreamEvent;
        yield { type: "message.delta", runId, messageId: runId, delta: "需要补充品牌名称。", timestamp: new Date().toISOString() } as StreamEvent;
        yield { type: "run.completed", runId, timestamp: new Date().toISOString() } as StreamEvent;
      },
    } as unknown as AgentRunService;
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);
    await registerWsRoute(app, {
      agentRuns,
      chatService: { createMessage } as never,
      connectionManager: new ConnectionManager(),
      canvasService: {
        getCanvas: vi.fn(async () => ({ id: "canvas" })),
        getCanvasWorkspaceId: vi.fn(async () => "workspace"),
      } as never,
      auth: { async authenticate() {
        return { id: "owner", accessToken: "test", email: "owner@example.test", userMetadata: {} };
      } },
    });
    await app.ready();
    const socket = await app.injectWS("/api/ws?token=test&connectionId=persistence-identity");
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "command", action: "agent.run", payload: {
      canvasId: "canvas", conversationId: "canvas", sessionId: "session", prompt: "帮我设计一个Logo。", model: "apiyi:offline",
    } }));

    await vi.waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "owner" }),
      "session",
      expect.objectContaining({ id: runId, role: "assistant", content: "需要补充品牌名称。" }),
    );
  });

  /**
   * The reproduced defect: the image tool refused 320×70 before any submission
   * (`refused: true`, no jobId) and the closing text still said the work was
   * under way. The refusal receipt arrives in this run's own tool block, so the
   * fence is appended at the persistence seam — after the run's message, as the
   * newest line.
   */
  it("appends the refusal correction after a run that claimed a refused submission", async () => {
    const runId = "44444444-4444-4444-8444-444444444444";
    const createMessage = vi.fn(async () => ({ id: runId }));
    const fixture = startRun({ runId, createMessage, events: (id) => [
      { type: "run.started", runId: id, conversationId: "canvas", sessionId: "session", timestamp: "t" } as StreamEvent,
      { type: "tool.started", runId: id, toolCallId: "call-refused", toolName: "generate_image", timestamp: "t" } as StreamEvent,
      { type: "tool.completed", runId: id, toolCallId: "call-refused", toolName: "generate_image", timestamp: "t",
        output: { status: "failed", error: "image_approximation_not_authorized", summary: REFUSAL_SUMMARY, refused: true },
        outputSummary: "未提交" } as StreamEvent,
      { type: "message.delta", runId: id, messageId: id, delta: "已提交，正在生成，稍后告诉你。", timestamp: "t" } as StreamEvent,
      { type: "run.completed", runId: id, timestamp: "t" } as StreamEvent,
    ] });
    await fixture.app.register(websocket);
    await registerWsRoute(fixture.app, {
      agentRuns: fixture.agentRuns,
      chatService: { createMessage } as never,
      connectionManager: new ConnectionManager(),
      canvasService: {
        getCanvas: vi.fn(async () => ({ id: "canvas" })),
        getCanvasWorkspaceId: vi.fn(async () => "workspace"),
      } as never,
      auth: { async authenticate() {
        return { id: "owner", accessToken: "test", email: "owner@example.test", userMetadata: {} };
      } },
    });
    await fixture.app.ready();
    await sendRun(fixture.app, "生成一张 320×70 的横幅。");

    await vi.waitFor(() => expect(createMessage).toHaveBeenCalledTimes(2));
    // 1. the model's own (false) closing line, persisted under the run id
    expect(createMessage).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ id: "owner" }),
      "session",
      expect.objectContaining({ id: runId, role: "assistant", content: "已提交，正在生成，稍后告诉你。" }));
    // 2. the server correction, appended AFTER it → the newest message
    expect(createMessage).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ id: "owner" }),
      "session",
      expect.objectContaining({
        id: refusalCorrectionId(runId),
        role: "assistant",
        content: CORRECTION_TEXT,
        contentBlocks: [{ type: "text", text: CORRECTION_TEXT }],
      }));
    expect(refusalCorrectionId(runId)).not.toBe(runId);
  });

  it("appends nothing when the reply is honest, or when a job was created", async () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    const createMessage = vi.fn(async () => ({ id: runId }));
    const fixture = startRun({ runId, createMessage, events: (id) => [
      { type: "run.started", runId: id, conversationId: "canvas", sessionId: "session", timestamp: "t" } as StreamEvent,
      { type: "tool.started", runId: id, toolCallId: "call-refused", toolName: "generate_image", timestamp: "t" } as StreamEvent,
      { type: "tool.completed", runId: id, toolCallId: "call-refused", toolName: "generate_image", timestamp: "t",
        output: { status: "failed", error: "image_approximation_not_authorized", summary: REFUSAL_SUMMARY, refused: true } } as StreamEvent,
      { type: "tool.started", runId: id, toolCallId: "call-job", toolName: "edit_image", timestamp: "t" } as StreamEvent,
      { type: "tool.completed", runId: id, toolCallId: "call-job", toolName: "edit_image", timestamp: "t",
        output: { jobId: "job-1", status: "processing", jobType: "image_generation" } } as StreamEvent,
      { type: "message.delta", runId: id, messageId: id, delta: "已提交，正在生成。", timestamp: "t" } as StreamEvent,
      { type: "run.completed", runId: id, timestamp: "t" } as StreamEvent,
    ] });
    await fixture.app.register(websocket);
    await registerWsRoute(fixture.app, {
      agentRuns: fixture.agentRuns,
      chatService: { createMessage } as never,
      connectionManager: new ConnectionManager(),
      canvasService: {
        getCanvas: vi.fn(async () => ({ id: "canvas" })),
        getCanvasWorkspaceId: vi.fn(async () => "workspace"),
      } as never,
      auth: { async authenticate() {
        return { id: "owner", accessToken: "test", email: "owner@example.test", userMetadata: {} };
      } },
    });
    await fixture.app.ready();
    await sendRun(fixture.app, "做一张海报。");

    // A created job makes "nothing was submitted" false, so the fence stays silent.
    await vi.waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "owner" }),
      "session",
      expect.objectContaining({ id: runId, content: "已提交，正在生成。" }));
  });

  it("appends nothing when a refused run answered honestly", async () => {
    const runId = "66666666-6666-4666-8666-666666666666";
    const createMessage = vi.fn(async () => ({ id: runId }));
    const honest = "没有提交，工具拒绝了该比例，也未扣费；需要你明确接受近似尺寸。";
    const fixture = startRun({ runId, createMessage, events: (id) => [
      { type: "run.started", runId: id, conversationId: "canvas", sessionId: "session", timestamp: "t" } as StreamEvent,
      { type: "tool.started", runId: id, toolCallId: "call-refused", toolName: "generate_image", timestamp: "t" } as StreamEvent,
      { type: "tool.completed", runId: id, toolCallId: "call-refused", toolName: "generate_image", timestamp: "t",
        output: { status: "failed", error: "image_approximation_not_authorized", summary: REFUSAL_SUMMARY, refused: true } } as StreamEvent,
      { type: "message.delta", runId: id, messageId: id, delta: honest, timestamp: "t" } as StreamEvent,
      { type: "run.completed", runId: id, timestamp: "t" } as StreamEvent,
    ] });
    await fixture.app.register(websocket);
    await registerWsRoute(fixture.app, {
      agentRuns: fixture.agentRuns,
      chatService: { createMessage } as never,
      connectionManager: new ConnectionManager(),
      canvasService: {
        getCanvas: vi.fn(async () => ({ id: "canvas" })),
        getCanvasWorkspaceId: vi.fn(async () => "workspace"),
      } as never,
      auth: { async authenticate() {
        return { id: "owner", accessToken: "test", email: "owner@example.test", userMetadata: {} };
      } },
    });
    await fixture.app.ready();
    await sendRun(fixture.app, "生成一张 320×70 的横幅。");

    await vi.waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "owner" }),
      "session",
      expect.objectContaining({ id: runId, content: honest }));
  });
});
