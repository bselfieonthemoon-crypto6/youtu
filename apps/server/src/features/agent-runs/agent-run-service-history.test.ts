import { describe, expect, it, vi } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { createAgentRunMetadataService } from "./agent-run-service.js";
import { CONTEXT_ERROR_MESSAGES } from "../../utils/context-error.js";

describe("agent run metadata writes", () => {
  it("atomically persists a new exact request for older clients without a message ID", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn();
    const service = createAgentRunMetadataService({ getAdminClient: () => ({ rpc, from }) as unknown as AdminSupabaseClient });
    await service.createAcceptedRun({ createdBy: "user-1", runId: "run-1", sessionId: "session-1", threadId: "thread-1", prompt: "继续生成落地页" });
    expect(rpc).toHaveBeenCalledWith("loomic_create_run_with_request", {
      p_created_by: "user-1", p_run: "run-1", p_session: "session-1", p_thread: "thread-1",
      p_model: null, p_execution_mode: "fast", p_prompt: "继续生成落地页",
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("preserves an explicit request ID without creating another message", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const rpc = vi.fn();
    const service = createAgentRunMetadataService({ getAdminClient: () => ({ rpc, from: () => ({ insert }) }) as unknown as AdminSupabaseClient });
    await service.createAcceptedRun({ runId: "run-1", sessionId: "session-1", threadId: "thread-1", requestMessageId: "message-1", prompt: "确认生成" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ request_message_id: "message-1", request_prompt: "确认生成" }));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not fall back to an unbound run when atomic persistence fails", async () => {
    const from = vi.fn();
    const service = createAgentRunMetadataService({ getAdminClient: () => ({ from, rpc: vi.fn().mockResolvedValue({ error: { message: "invalid request" } }) }) as unknown as AdminSupabaseClient });
    await expect(service.createAcceptedRun({ runId: "run-1", sessionId: "session-1", threadId: "thread-1", prompt: "生成" })).rejects.toThrow("Failed to persist accepted run and request.");
    expect(from).not.toHaveBeenCalled();
  });
  it("persists execution mode and creator and uses terminal CAS", async () => {
    const inserts: Record<string, unknown>[] = [];
    const updates: Array<{ patch: Record<string, unknown>; filters: unknown[] }> = [];
    const table = {
      insert(row: Record<string, unknown>) {
        inserts.push(row);
        return Promise.resolve({ error: null });
      },
      update(patch: Record<string, unknown>) {
        const entry = { patch, filters: [] as unknown[] };
        updates.push(entry);
        const query = {
          eq(...args: unknown[]) {
            entry.filters.push(["eq", ...args]);
            return query;
          },
          in(...args: unknown[]) {
            entry.filters.push(["in", ...args]);
            return query;
          },
          then(resolve: (value: { error: null }) => unknown) {
            return Promise.resolve(resolve({ error: null }));
          },
        };
        return query;
      },
    };
    const service = createAgentRunMetadataService({
      getAdminClient: () => ({ from: vi.fn(() => table) }) as unknown as AdminSupabaseClient,
    });

    await service.createAcceptedRun({
      createdBy: "user-1",
      executionMode: "thinking",
      model: "model-1",
      runId: "run-1",
      sessionId: "session-1",
      threadId: "thread-1",
    });
    await service.updateRun({
      completedAt: "2026-09-01T01:01:00.000Z",
      runId: "run-1",
      status: "canceled",
    });

    expect(inserts[0]).toMatchObject({
      created_by: "user-1",
      execution_mode: "thinking",
      status: "accepted",
    });
    expect(updates[0]?.filters).toContainEqual([
      "in",
      "status",
      ["accepted", "running"],
    ]);
  });

  it("returns only a sanitized public error message in run detail", async () => {
    const runRow = {
      id: "run-1",
      session_id: "session-1",
      status: "failed",
      model: "model-1",
      execution_mode: "fast",
      created_at: "2026-09-01T01:00:00.000Z",
      started_at: "2026-09-01T01:00:01.000Z",
      completed_at: "2026-09-01T01:00:02.000Z",
      error_code: "run_failed",
      error_message: "provider leaked sk-test-sensitive credential",
    };
    const client = {
      from: vi.fn((tableName: string) => {
        const state = { selected: "" };
        const query = {
          select(columns: string) {
            state.selected = columns;
            return query;
          },
          eq() {
            return query;
          },
          order() {
            return query;
          },
          maybeSingle() {
            if (tableName === "agent_runs" && state.selected === "session_id") {
              return Promise.resolve({ data: { session_id: "session-1" }, error: null });
            }
            return Promise.resolve({ data: runRow, error: null });
          },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve(resolve({ data: [], error: null }));
          },
        };
        return query;
      }),
    };
    const service = createAgentRunMetadataService({
      getAdminClient: () => client as unknown as AdminSupabaseClient,
    });

    await expect(service.getRunSessionId("run-1")).resolves.toBe("session-1");
    const detail = await service.getRunDetail("run-1", "session-1");
    expect(detail?.error).toEqual({
      code: "run_failed",
      message: "认证失败，请刷新页面重新登录。",
    });
    expect(JSON.stringify(detail)).not.toContain("sk-test-sensitive");
    // Durable context reasons must survive a reload and its second sanitization.
    runRow.error_code = "agent_context_budget_exceeded";
    runRow.error_message = "PRIVATE_CONTEXT_BODY";
    const contextDetail = await service.getRunDetail("run-1", "session-1");
    expect(contextDetail?.error).toEqual({ code: "agent_context_budget_exceeded", message: CONTEXT_ERROR_MESSAGES.agent_context_budget_exceeded });
    expect(JSON.stringify(contextDetail)).not.toContain("PRIVATE_CONTEXT_BODY");
  });
});
