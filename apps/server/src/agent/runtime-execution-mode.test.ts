import { describe, expect, it, vi } from "vitest";

import type { LoomicAgentFactory } from "./deep-agent.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import { createAgentRunService } from "./runtime.js";

const env = {
  agentBackendMode: "state" as const,
  agentModel: "test-model",
  port: 3001,
  version: "test",
  webOrigin: "http://localhost:3002",
};

async function executeWithMode(executionMode?: "fast" | "thinking") {
  const factory = vi.fn((() => ({
    stream: vi.fn(),
    async *streamEvents() {
      // Empty LangChain event stream; the adapter still emits run lifecycle.
    },
  })) as unknown as LoomicAgentFactory);
  const service = createAgentRunService({ agentFactory: factory, env });
  const response = service.createRun({
    canvasId: "canvas-1",
    conversationId: "conversation-1",
    prompt: "hello",
    sessionId: "session-1",
    ...(executionMode ? { executionMode } : {}),
  });

  for await (const _event of service.streamRun(response.runId)) {
    // Drain the run so the agent factory is invoked.
  }
  return factory;
}

describe("agent runtime execution mode", () => {
  it("defaults omitted execution mode to Thinking", async () => {
    const factory = await executeWithMode();
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "thinking" }),
    );
  });

  it("normalizes legacy Fast requests to Thinking", async () => {
    const factory = await executeWithMode("fast");
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "thinking" }),
    );
  });

  it("persists only a sanitized runtime failure message", async () => {
    const updateRun = vi.fn(async () => undefined);
    const metadata = {
      createAcceptedRun: vi.fn(),
      getRunDetail: vi.fn(),
      getRunSessionId: vi.fn(),
      listSessionRuns: vi.fn(),
      updateRun,
    } as AgentRunMetadataService;
    const service = createAgentRunService({
      agentFactory: vi.fn(() => {
        throw new Error("provider secret sk-test-sensitive upstream failure");
      }),
      agentPersistenceService: {
        getPersistence: vi.fn(async () => ({ checkpointer: {}, store: {} }) as never),
      },
      agentRunMetadataService: metadata,
      env,
    });
    const response = service.createRun(
      {
        canvasId: "canvas-1",
        conversationId: "conversation-1",
        prompt: "hello",
        sessionId: "session-1",
      },
      { threadId: "thread-1" },
    );

    for await (const _event of service.streamRun(response.runId)) {
      // Drain failure lifecycle.
    }

    expect(updateRun).toHaveBeenLastCalledWith(expect.objectContaining({
      errorCode: "run_failed",
      errorMessage: "请求处理失败，请重试。",
      status: "failed",
    }));
    expect(JSON.stringify(updateRun.mock.calls)).not.toContain("sk-test-sensitive");
  });
});
