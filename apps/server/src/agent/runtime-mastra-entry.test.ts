import { describe, expect, it, vi } from "vitest";

import type { MastraRunFactory } from "./mastra-run-types.js";
import { createAgentRunService, resolveAgentRuntimeMode } from "./runtime.js";

const ids = {
  run: "00000000-0000-4000-8000-000000000001",
  conversation: "00000000-0000-4000-8000-000000000002",
  session: "00000000-0000-4000-8000-000000000003",
  message: "00000000-0000-4000-8000-000000000004",
  user: "00000000-0000-4000-8000-000000000005",
  workspace: "00000000-0000-4000-8000-000000000006",
  canvas: "00000000-0000-4000-8000-000000000007",
  design: "00000000-0000-4000-8000-000000000008",
};

const env = {
  agentModel: "offline",
  port: 0,
  version: "test",
  webOrigin: "http://localhost.invalid",
};

async function drain(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Mastra runtime entry", () => {
  it("defaults to Mastra and fails fast for the retired or misspelled legacy runtime", () => {
    expect(resolveAgentRuntimeMode({})).toBe("mastra");
    expect(resolveAgentRuntimeMode({ LOOMIC_AGENT_RUNTIME: "  MaStRa " })).toBe("mastra");
    expect(() => resolveAgentRuntimeMode({ LOOMIC_AGENT_RUNTIME: " legacy " }))
      .toThrow(/retired/);
    expect(() => resolveAgentRuntimeMode({ LOOMIC_AGENT_RUNTIME: "other" }))
      .toThrow('Expected "mastra"');
  });

  it("branches before legacy task and conversational interceptors", async () => {
    const seen = vi.fn();
    const createUserClient = vi.fn(() => {
      throw new Error("legacy interceptor must not load chat history");
    });
    const mastraRunFactory: MastraRunFactory = async function* (input) {
      seen(input);
      yield { type: "run.started", runId: input.runId, conversationId: input.conversationId,
        sessionId: input.sessionId, timestamp: "2026-09-13T00:00:00.000Z" };
      yield { type: "run.completed", runId: input.runId, timestamp: "2026-09-13T00:00:01.000Z" };
    };
    const updateRun = vi.fn(async () => undefined);
    const runtime = createAgentRunService({
      env,
      mastraRunFactory,
      createUserClient,
      agentRunMetadataService: { updateRun } as any,
      runIdFactory: () => ids.run,
    });
    runtime.createRun({
      conversationId: ids.conversation,
      sessionId: ids.session,
      userMessageId: ids.message,
      canvasId: ids.canvas,
      prompt: "生成logo",
      attachments: [{ assetId: ids.message, url: "https://example.invalid/image.png", mimeType: "image/png" }],
      mentions: [],
      canvasSelection: { elementIds: ["element-1"] },
      activeDesignId: ids.design,
    }, {
      accessToken: "secret-token",
      threadId: "thread-1",
      userId: ids.user,
      workspaceId: ids.workspace,
      model: "workspace:model-1",
    });
    // Real HTTP/WS entrypoints retain this compatibility call. The Mastra
    // rollout must not prepare the legacy task before streaming.
    await expect(runtime.prepareDesignTask(ids.run)).resolves.toBeUndefined();

    const emitted = await drain(runtime.streamRun(ids.run));

    expect(emitted.map((event: any) => event.type)).toEqual(["run.started", "run.completed"]);
    expect(createUserClient).not.toHaveBeenCalled();
    expect(seen).toHaveBeenCalledOnce();
    expect(seen.mock.calls[0]![0]).toMatchObject({
      runId: ids.run,
      conversationId: ids.conversation,
      sessionId: ids.session,
      userMessageId: ids.message,
      userId: ids.user,
      workspaceId: ids.workspace,
      accessToken: "secret-token",
      threadId: "thread-1",
      canvasId: ids.canvas,
      prompt: "生成logo",
      model: "workspace:model-1",
      activeDesignId: ids.design,
      canvasSelection: { elementIds: ["element-1"] },
    });
    expect(seen.mock.calls[0]![0]).not.toHaveProperty("designTask");
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({ runId: ids.run, status: "running" }));
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({ runId: ids.run, status: "completed" }));
  });

  it("returns the request unchanged during Mastra routing without task lookup", async () => {
    const runtime = createAgentRunService({ env, mastraRunFactory: async function* () {},
      runIdFactory: () => ids.run });
    const request = {
      conversationId: ids.conversation,
      sessionId: ids.session,
      prompt: "继续修改",
    };

    await expect(runtime.routeTaskSubmission(request, ids.user)).resolves.toEqual(request);
  });

  it("turns an aborted Mastra stream into one durable canceled terminal", async () => {
    let markControllerReady!: () => void;
    const controllerReady = new Promise<void>(resolve => { markControllerReady = resolve; });
    const mastraRunFactory: MastraRunFactory = async function* (input) {
      yield { type: "run.started", runId: input.runId, conversationId: input.conversationId,
        sessionId: input.sessionId, timestamp: "2026-09-13T00:00:00.000Z" };
      markControllerReady();
      await new Promise<void>((_resolve, reject) => input.signal.addEventListener("abort", () =>
        reject(new DOMException("canceled", "AbortError")), { once: true }));
    };
    const updateRun = vi.fn(async () => undefined);
    const runtime = createAgentRunService({ env, mastraRunFactory,
      agentRunMetadataService: { updateRun } as any, runIdFactory: () => ids.run });
    runtime.createRun({ conversationId: ids.conversation, sessionId: ids.session, prompt: "hello" },
      { userId: ids.user, threadId: "thread-1" });
    const consuming = drain(runtime.streamRun(ids.run));
    await controllerReady;

    expect(runtime.cancelRun(ids.run, ids.user)?.status).toBe("canceled");
    const emitted = await consuming;

    expect(emitted.map((event: any) => event.type)).toEqual(["run.started", "run.canceled"]);
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({ runId: ids.run, status: "canceled" }));
  });
});
