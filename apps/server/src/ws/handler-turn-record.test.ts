import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { AgentRunService } from "../agent/runtime.js";
import type { StreamEvent } from "@loomic/shared";
import { ConnectionManager } from "./connection-manager.js";
import { registerWsRoute } from "./handler.js";

/**
 * The seam this file fences is the one the per-turn two-layer record is built
 * at: the WebSocket handler's "server-side assistant message persistence" block,
 * which is the only place where a run's routing verdict AND its own tool
 * receipts are simultaneously on hand.
 *
 * The reproduced defect: the router detected `new_generation`, the model only
 * asked a clarifying question, and a client had no way to see the two side by
 * side. The record is emitted AFTER the assistant message was persisted, so a
 * turn whose message never landed produces no record either.
 */
describe("per-turn design turn record emission", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  const routingEvent = (runId: string): StreamEvent => ({
    type: "design.routing",
    runId,
    timestamp: "t",
    intent: "new_generation",
    reasonCode: "explicit_creation",
    source: "model",
    clamped: false,
    confidence: 0.92,
    summary: "候选技能：促销海报（命中 海报）",
    detail: "判定依据：明确要求出图（模型判定 · 置信度 92%）",
  }) as StreamEvent;

  async function runTurn(input: {
    runId: string;
    events: (runId: string) => StreamEvent[];
    createMessage?: ReturnType<typeof vi.fn>;
  }): Promise<{ socket: WebSocket; turnEvents: Array<Record<string, unknown>>; createMessage: ReturnType<typeof vi.fn> }> {
    const createMessage = input.createMessage ?? vi.fn(async () => ({ id: input.runId }));
    const agentRuns = {
      createRun: vi.fn(() => ({ conversationId: "canvas", runId: input.runId, sessionId: "session", status: "accepted" })),
      async *streamRun() {
        for (const event of input.events(input.runId)) yield event;
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

    const socket = await app.injectWS(`/api/ws?token=test&connectionId=turn-record-${input.runId}`);
    sockets.push(socket);
    // `design.routing` is emitted before the first token and `design.turn` after
    // the run finished; both are pushed to the canvas during this one run, wrapped
    // in the `{ type: "event", event }` envelope `pushToCanvas` uses.
    const turnEvents: Array<Record<string, unknown>> = [];
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { type?: string; event?: { type?: string } };
      if (frame.type === "event" && frame.event?.type === "design.turn")
        turnEvents.push(frame.event as Record<string, unknown>);
    });
    socket.send(JSON.stringify({ type: "command", action: "agent.run", payload: {
      canvasId: "canvas", conversationId: "canvas", sessionId: "session", prompt: "做一张海报。", model: "apiyi:offline",
    } }));

    await vi.waitFor(() => expect(turnEvents.length).toBeGreaterThan(0));
    return { socket, turnEvents, createMessage };
  }

  it("emits one record after a turn whose router said new_generation but which only asked a question", async () => {
    const runId = "77777777-7777-4777-8777-777777777777";
    const { turnEvents } = await runTurn({
      runId,
      events: (id) => [
        { type: "run.started", runId: id, conversationId: "canvas", sessionId: "session", timestamp: "t" } as StreamEvent,
        routingEvent(id),
        { type: "tool.started", runId: id, toolCallId: "call-ask", toolName: "ask_clarification", timestamp: "t" } as StreamEvent,
        { type: "tool.completed", runId: id, toolCallId: "call-ask", toolName: "ask_clarification", timestamp: "t",
          output: { status: "awaiting_user_input", questions: [{ id: 1, title: "用途", prompt: "用在哪里？", options: [], allowCustom: true }] } } as StreamEvent,
        { type: "message.delta", runId: id, messageId: id, delta: "请告诉我用途和风格。", timestamp: "t" } as StreamEvent,
        { type: "run.completed", runId: id, timestamp: "t" } as StreamEvent,
      ],
    });

    expect(turnEvents).toHaveLength(1);
    const event = turnEvents[0]!;
    expect(event.type).toBe("design.turn");
    expect(event.runId).toBe(runId);
    // The whole point, on the wire: BOTH layers, and they disagree.
    const summary = String(event.summary);
    expect(summary).toContain("检测到「新一轮生成」");
    expect(summary).toContain("实际执行「向用户提问澄清，没有提交生成」");
    expect(summary).toContain("创建任务：0 个");
    // A non-submitted turn is never described as submitted.
    expect(summary).not.toContain("已提交");
    expect(summary).not.toContain("正在生成");
    expect(String(event.detail)).toContain("检测层：模型判定");
  });

  it("carries the created job id and the delivered asset id when the turn really submitted", async () => {
    const runId = "88888888-8888-4888-8888-888888888888";
    const { turnEvents } = await runTurn({
      runId,
      events: (id) => [
        { type: "run.started", runId: id, conversationId: "canvas", sessionId: "session", timestamp: "t" } as StreamEvent,
        routingEvent(id),
        { type: "tool.started", runId: id, toolCallId: "call-gen", toolName: "generate_image", timestamp: "t" } as StreamEvent,
        { type: "tool.completed", runId: id, toolCallId: "call-gen", toolName: "generate_image", timestamp: "t",
          output: { status: "processing", jobId: "job-777", assetId: "asset-777", jobType: "image_generation" } } as StreamEvent,
        { type: "message.delta", runId: id, messageId: id, delta: "已提交一版，稍后出图。", timestamp: "t" } as StreamEvent,
        { type: "run.completed", runId: id, timestamp: "t" } as StreamEvent,
      ],
    });

    const summary = String(turnEvents[0]!.summary);
    expect(summary).toContain("实际执行「提交生成任务（1 个任务）」");
    expect(summary).toContain("创建任务 1 个（job-777）");
    expect(summary).toContain("最终交付资产：asset-777");
  });

  it("never claims submission for a refused turn, and never emits when persistence failed", async () => {
    const runId = "99999999-9999-4999-8999-999999999999";
    const { turnEvents } = await runTurn({
      runId,
      events: (id) => [
        { type: "run.started", runId: id, conversationId: "canvas", sessionId: "session", timestamp: "t" } as StreamEvent,
        routingEvent(id),
        { type: "tool.started", runId: id, toolCallId: "call-refused", toolName: "generate_image", timestamp: "t" } as StreamEvent,
        { type: "tool.completed", runId: id, toolCallId: "call-refused", toolName: "generate_image", timestamp: "t",
          output: { status: "failed", error: "image_approximation_not_authorized", summary: "未提交或扣费。", refused: true } } as StreamEvent,
        { type: "message.delta", runId: id, messageId: id, delta: "已提交，正在生成。", timestamp: "t" } as StreamEvent,
        { type: "run.completed", runId: id, timestamp: "t" } as StreamEvent,
      ],
    });

    const summary = String(turnEvents[0]!.summary);
    expect(summary).toContain("实际执行「提交前被拒绝（image_approximation_not_authorized），未创建任务、未扣费」");
    expect(summary).toContain("创建任务：0 个");
    expect(summary).not.toContain("已提交");
  });

  it("does not emit a record when the run left nothing to persist", async () => {
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const createMessage = vi.fn(async () => ({ id: runId }));
    const agentRuns = {
      createRun: vi.fn(() => ({ conversationId: "canvas", runId, sessionId: "session", status: "accepted" })),
      async *streamRun() {
        yield { type: "run.started", runId, conversationId: "canvas", sessionId: "session", timestamp: "t" } as StreamEvent;
        yield { type: "run.failed", runId, error: { code: "run_failed", message: "boom" }, timestamp: "t" } as StreamEvent;
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
    const socket = await app.injectWS("/api/ws?token=test&connectionId=turn-record-empty");
    sockets.push(socket);
    const turnEvents: Array<Record<string, unknown>> = [];
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { type?: string; event?: { type?: string } };
      if (frame.type === "event" && frame.event?.type === "design.turn")
        turnEvents.push(frame.event as Record<string, unknown>);
    });
    socket.send(JSON.stringify({ type: "command", action: "agent.run", payload: {
      canvasId: "canvas", conversationId: "canvas", sessionId: "session", prompt: "做一张海报。", model: "apiyi:offline",
    } }));

    await vi.waitFor(() => expect(socket.readyState).toBe(socket.OPEN));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(createMessage).not.toHaveBeenCalled();
    expect(turnEvents).toEqual([]);
  });
});
