import { describe, expect, it } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createToolExecutionService } from "./tool-execution-service.js";

type Row = Record<string, unknown>;

function createDatabase(options?: { executionVisible?: boolean }) {
  const tables: Record<string, Row[]> = {
    tool_executions: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        run_id: "00000000-0000-4000-8000-000000000010",
        tool_call_id: "call-1",
        tool_name: "inspect_canvas",
        status: "failed",
        input: { detail_level: "summary" },
        output: null,
        output_summary: null,
        artifacts: null,
        plan_id: "plan-1",
        plan_step_id: "step-1",
        retryable: true,
        attempt: 1,
        retry_of: null,
        requested_by: null,
        retry_request_id: null,
      },
    ],
    agent_runs: [
      {
        id: "00000000-0000-4000-8000-000000000010",
        session_id: "00000000-0000-4000-8000-000000000020",
        thread_id: "thread-1",
      },
    ],
    chat_sessions: [
      {
        id: "00000000-0000-4000-8000-000000000020",
        canvas_id: "00000000-0000-4000-8000-000000000030",
      },
    ],
  };

  function client(isUser: boolean) {
    return {
      from(table: string) {
        let action: "select" | "insert" | "update" = "select";
        let value: Row = {};
        const filters: Array<[string, unknown]> = [];
        const builder = {
          select() {
            return builder;
          },
          insert(next: Row) {
            action = "insert";
            value = next;
            return builder;
          },
          update(next: Row) {
            action = "update";
            value = next;
            return builder;
          },
          eq(column: string, expected: unknown) {
            filters.push([column, expected]);
            return builder;
          },
          async maybeSingle() {
            return execute(false);
          },
          async single() {
            return execute(true);
          },
        };
        function matches(row: Row) {
          return filters.every(
            ([column, expected]) => row[column] === expected,
          );
        }
        function execute(requireRow: boolean) {
          const rows = tables[table] ?? (tables[table] = []);
          if (
            isUser &&
            table === "tool_executions" &&
            options?.executionVisible === false
          ) {
            return { data: null, error: null };
          }
          if (action === "insert") {
            const duplicateRequest = rows.find(
              (row) =>
                value.retry_request_id &&
                row.requested_by === value.requested_by &&
                row.retry_request_id === value.retry_request_id,
            );
            if (duplicateRequest) {
              return { data: null, error: { code: "23505" } };
            }
            rows.push({ ...value });
            return { data: { ...value }, error: null };
          }
          const row = rows.find(matches) ?? null;
          if (action === "update" && row) Object.assign(row, value);
          return {
            data: row ? { ...row } : null,
            error: requireRow && !row ? { code: "not_found" } : null,
          };
        }
        return builder;
      },
    };
  }

  return {
    tables,
    admin: client(false) as unknown as AdminSupabaseClient,
    user: client(true) as unknown as UserSupabaseClient,
  };
}

const user = {
  accessToken: "token",
  email: "owner@example.test",
  id: "00000000-0000-4000-8000-000000000099",
  userMetadata: {},
};

describe("tool execution retry authorization", () => {
  it("denies an execution hidden by member-select RLS", async () => {
    const db = createDatabase({ executionVisible: false });
    const service = createToolExecutionService({
      createUserClient: () => db.user,
      getAdminClient: () => db.admin,
    });
    await expect(
      service.prepareRetry(
        user,
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000050",
      ),
    ).rejects.toMatchObject({
      code: "tool_execution_not_found",
      statusCode: 404,
    });
  });

  it("rejects completed and non-allowlisted tools", async () => {
    for (const patch of [
      { status: "completed" },
      { tool_name: "manipulate_canvas", retryable: true },
    ]) {
      const db = createDatabase();
      Object.assign(db.tables.tool_executions![0]!, patch);
      const service = createToolExecutionService({
        createUserClient: () => db.user,
        getAdminClient: () => db.admin,
      });
      await expect(
        service.prepareRetry(
          user,
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000050",
        ),
      ).rejects.toMatchObject({
        code: "tool_execution_not_retryable",
        statusCode: 409,
      });
    }
  });

  it("uses requestId as an idempotency key", async () => {
    const db = createDatabase();
    let next = 40;
    const service = createToolExecutionService({
      createUserClient: () => db.user,
      getAdminClient: () => db.admin,
      idFactory: () =>
        `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    });
    const requestId = "00000000-0000-4000-8000-000000000050";
    const first = await service.prepareRetry(
      user,
      "00000000-0000-4000-8000-000000000001",
      requestId,
    );
    const second = await service.prepareRetry(
      user,
      "00000000-0000-4000-8000-000000000001",
      requestId,
    );

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.execution.id).toBe(first.execution.id);
    expect(first.execution).toMatchObject({
      planId: "plan-1",
      planStepId: "step-1",
    });
    expect(db.tables.tool_executions![1]).toMatchObject({
      plan_id: "plan-1",
      plan_step_id: "step-1",
    });
    expect(db.tables.tool_executions).toHaveLength(2);
  });

  it("persists a complete plan link and drops an incomplete one", async () => {
    const db = createDatabase();
    let next = 60;
    const service = createToolExecutionService({
      createUserClient: () => db.user,
      getAdminClient: () => db.admin,
      idFactory: () =>
        `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    });

    const linked = await service.recordStarted({
      runId: "00000000-0000-4000-8000-000000000010",
      requestedBy: "00000000-0000-4000-8000-000000000020",
      toolCallId: "call-linked",
      toolName: "inspect_canvas",
      planId: "plan-1",
      planStepId: "step-1",
    });
    const unlinked = await service.recordStarted({
      runId: "00000000-0000-4000-8000-000000000010",
      requestedBy: "00000000-0000-4000-8000-000000000020",
      toolCallId: "call-unlinked",
      toolName: "inspect_canvas",
      planId: "plan-1",
    });

    expect(linked).toMatchObject({ planId: "plan-1", planStepId: "step-1" });
    expect(unlinked).toMatchObject({ planId: null, planStepId: null });
  });

  it("uses a UUID tool runnable id as the durable execution id", async () => {
    const db = createDatabase();
    const runnableId = "70000000-0000-4000-8000-000000000001";
    const service = createToolExecutionService({
      createUserClient: () => db.user,
      getAdminClient: () => db.admin,
      idFactory: () => "80000000-0000-4000-8000-000000000001",
    });

    const execution = await service.recordStarted({
      runId: "00000000-0000-4000-8000-000000000010",
      requestedBy: "00000000-0000-4000-8000-000000000020",
      toolCallId: runnableId,
      toolName: "manipulate_design",
    });

    expect(execution.id).toBe(runnableId);
    expect(db.tables.tool_executions?.at(-1)).toMatchObject({
      id: runnableId,
      tool_call_id: runnableId,
      run_id: "00000000-0000-4000-8000-000000000010",
      requested_by: "00000000-0000-4000-8000-000000000020",
    });
  });
});
