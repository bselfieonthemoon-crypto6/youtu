import { randomUUID } from "node:crypto";

import type { Json } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import type {
  RecordToolStartedInput,
  ToolExecution,
  ToolExecutionCompletion,
  ToolExecutionRetryContext,
  ToolExecutionStatus,
} from "./tool-execution-types.js";

const RETRYABLE_READ_TOOLS = new Set([
  "inspect_canvas",
  "inspect_design",
  "get_design_objects",
  "search_design_resources",
]);
const SELECT_COLUMNS =
  "id, run_id, tool_call_id, tool_name, status, input, output, output_summary, artifacts, retryable, attempt, retry_of, requested_by, retry_request_id, plan_id, plan_step_id";

export class ToolExecutionServiceError extends Error {
  constructor(
    readonly code:
      | "tool_execution_not_found"
      | "tool_execution_not_retryable"
      | "tool_execution_conflict"
      | "tool_execution_failed",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export type ToolExecutionService = {
  recordStarted(input: RecordToolStartedInput): Promise<ToolExecution>;
  recordCompleted(
    executionId: string,
    completion: ToolExecutionCompletion,
  ): Promise<ToolExecution | null>;
  recordFailed(
    executionId: string,
    error: { code: string; message: string },
  ): Promise<ToolExecution | null>;
  finishRunningForRun(
    runId: string,
    status: "failed" | "canceled",
    message: string,
  ): Promise<void>;
  prepareRetry(
    user: AuthenticatedUser,
    executionId: string,
    requestId: string,
  ): Promise<ToolExecutionRetryContext>;
};

export function createToolExecutionService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  idFactory?: () => string;
}): ToolExecutionService {
  const idFactory = options.idFactory ?? randomUUID;

  async function fetchAdminById(id: string): Promise<ToolExecution | null> {
    const { data, error } = await options
      .getAdminClient()
      .from("tool_executions")
      .select(SELECT_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw persistenceError();
    return data ? mapRow(data) : null;
  }

  async function updateTerminal(
    executionId: string,
    patch: Record<string, Json | string | null>,
  ): Promise<ToolExecution | null> {
    const { data, error } = await options
      .getAdminClient()
      .from("tool_executions")
      .update({ ...patch, finished_at: new Date().toISOString() })
      .eq("id", executionId)
      .eq("status", "running")
      .select(SELECT_COLUMNS)
      .maybeSingle();
    if (error) throw persistenceError();
    return data ? mapRow(data) : null;
  }

  return {
    async recordStarted(input) {
      // LangChain's tool runnable runId is also emitted as on_tool_start.run_id.
      // Reusing that UUID lets the tool mutation reference this durable ledger
      // row without accepting a model-controlled audit identifier.
      const id = isUuid(input.toolCallId) ? input.toolCallId : idFactory();
      const planLink =
        input.planId && input.planStepId
          ? { plan_id: input.planId, plan_step_id: input.planStepId }
          : { plan_id: null, plan_step_id: null };
      const { data, error } = await options
        .getAdminClient()
        .from("tool_executions")
        .insert({
          id,
          run_id: input.runId,
          requested_by: input.requestedBy,
          tool_call_id: input.toolCallId,
          tool_name: input.toolName,
          status: "running",
          input: (input.input ?? null) as Json,
          ...planLink,
          retryable: RETRYABLE_READ_TOOLS.has(input.toolName),
        })
        .select(SELECT_COLUMNS)
        .single();

      if (!error && data) return mapRow(data);
      if (error?.code === "23505") {
        const existing = await options
          .getAdminClient()
          .from("tool_executions")
          .select(SELECT_COLUMNS)
          .eq("run_id", input.runId)
          .eq("tool_call_id", input.toolCallId)
          .maybeSingle();
        if (existing.error || !existing.data) throw persistenceError();
        return mapRow(existing.data);
      }
      throw persistenceError();
    },

    recordCompleted(executionId, completion) {
      return updateTerminal(executionId, {
        status: "completed",
        output: (completion.output ?? null) as Json,
        output_summary: completion.outputSummary ?? null,
        artifacts: (completion.artifacts ?? null) as Json,
        error_code: null,
        error_message: null,
      });
    },

    recordFailed(executionId, error) {
      return updateTerminal(executionId, {
        status: "failed",
        error_code: error.code,
        error_message: error.message,
      });
    },

    async finishRunningForRun(runId, status, message) {
      const { error } = await options
        .getAdminClient()
        .from("tool_executions")
        .update({
          status,
          error_code: status === "failed" ? "tool_failed" : null,
          error_message: message,
          finished_at: new Date().toISOString(),
        })
        .eq("run_id", runId)
        .eq("status", "running");
      if (error) throw persistenceError();
    },

    async prepareRetry(user, executionId, requestId) {
      const client = options.createUserClient(user.accessToken);
      const { data: originalRow, error: originalError } = await client
        .from("tool_executions")
        .select(SELECT_COLUMNS)
        .eq("id", executionId)
        .maybeSingle();
      if (originalError || !originalRow) {
        throw new ToolExecutionServiceError(
          "tool_execution_not_found",
          "Tool execution not found or access denied.",
          404,
        );
      }
      const original = mapRow(originalRow);
      if (
        original.status !== "failed" ||
        !original.retryable ||
        !RETRYABLE_READ_TOOLS.has(original.toolName)
      ) {
        throw new ToolExecutionServiceError(
          "tool_execution_not_retryable",
          "Only failed read-only tool executions can be retried.",
          409,
        );
      }

      const admin = options.getAdminClient();
      const { data: run, error: runError } = await admin
        .from("agent_runs")
        .select("session_id, thread_id")
        .eq("id", original.runId)
        .maybeSingle();
      if (runError || !run) throw persistenceError();
      const { data: session, error: sessionError } = await client
        .from("chat_sessions")
        .select("id, canvas_id")
        .eq("id", run.session_id)
        .maybeSingle();
      if (sessionError || !session) {
        throw new ToolExecutionServiceError(
          "tool_execution_not_found",
          "Tool execution not found or access denied.",
          404,
        );
      }

      const existing = await admin
        .from("tool_executions")
        .select(SELECT_COLUMNS)
        .eq("requested_by", user.id)
        .eq("retry_request_id", requestId)
        .maybeSingle();
      if (existing.error) throw persistenceError();
      if (existing.data) {
        const execution = mapRow(existing.data);
        if (execution.retryOf !== original.id) {
          throw new ToolExecutionServiceError(
            "tool_execution_conflict",
            "Retry request id was already used.",
            409,
          );
        }
        return {
          execution,
          canvasId: session.canvas_id,
          sessionId: session.id,
          threadId: run.thread_id,
          isNew: false,
        };
      }

      const retryId = idFactory();
      const retryCallId = `retry_${idFactory()}`;
      const inserted = await admin
        .from("tool_executions")
        .insert({
          id: retryId,
          run_id: original.runId,
          tool_call_id: retryCallId,
          tool_name: original.toolName,
          status: "running",
          input: original.input as Json,
          retryable: true,
          attempt: original.attempt + 1,
          retry_of: original.id,
          requested_by: user.id,
          retry_request_id: requestId,
          plan_id: original.planId,
          plan_step_id: original.planStepId,
        })
        .select(SELECT_COLUMNS)
        .single();
      if (inserted.error || !inserted.data) {
        if (inserted.error?.code === "23505") {
          const raced = await admin
            .from("tool_executions")
            .select(SELECT_COLUMNS)
            .eq("requested_by", user.id)
            .eq("retry_request_id", requestId)
            .maybeSingle();
          if (!raced.error && raced.data) {
            return {
              execution: mapRow(raced.data),
              canvasId: session.canvas_id,
              sessionId: session.id,
              threadId: run.thread_id,
              isNew: false,
            };
          }
        }
        throw persistenceError();
      }
      return {
        execution: mapRow(inserted.data),
        canvasId: session.canvas_id,
        sessionId: session.id,
        threadId: run.thread_id,
        isNew: true,
      };
    },
  };
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function mapRow(row: Record<string, unknown>): ToolExecution {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    toolCallId: row.tool_call_id as string,
    toolName: row.tool_name as string,
    status: row.status as ToolExecutionStatus,
    input: asRecord(row.input),
    output: asRecord(row.output),
    outputSummary: (row.output_summary as string | null) ?? null,
    planId: (row.plan_id as string | null) ?? null,
    planStepId: (row.plan_step_id as string | null) ?? null,
    artifacts: Array.isArray(row.artifacts)
      ? (row.artifacts as ToolExecution["artifacts"])
      : null,
    retryable: row.retryable === true,
    attempt: Number(row.attempt ?? 1),
    retryOf: (row.retry_of as string | null) ?? null,
    requestedBy: (row.requested_by as string | null) ?? null,
    retryRequestId: (row.retry_request_id as string | null) ?? null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function persistenceError() {
  return new ToolExecutionServiceError(
    "tool_execution_failed",
    "Failed to persist tool execution.",
    500,
  );
}
