import { isUuid } from "@loomic/shared";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { sanitizeErrorForClient } from "../../utils/error-sanitizer.js";
import type {
  AgentRunDetail,
  AgentRunListPage,
  AgentRunSummary,
  AgentRunToolCounts,
  CreateAcceptedAgentRunInput,
  UpdateAgentRunInput,
} from "./types.js";

export class AgentRunPersistenceError extends Error {
  readonly statusCode: number;
  readonly code: "application_error";

  constructor(message: string, statusCode = 500) {
    super(message);
    this.code = "application_error";
    this.statusCode = statusCode;
  }
}

export type AgentRunMetadataService = {
  createAcceptedRun(input: CreateAcceptedAgentRunInput): Promise<void>;
  getRunSessionId(runId: string): Promise<string | null>;
  getRunDetail(
    runId: string,
    expectedSessionId: string,
  ): Promise<AgentRunDetail | null>;
  listSessionRuns(
    sessionId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<AgentRunListPage>;
  updateRun(input: UpdateAgentRunInput): Promise<void>;
};

const RUN_COLUMNS =
  "id, session_id, status, model, execution_mode, created_at, started_at, completed_at, error_code, error_message";
const TOOL_COLUMNS =
  "id, run_id, tool_call_id, tool_name, status, retryable, attempt, retry_of, started_at, finished_at";

export function createAgentRunMetadataService(options: {
  getAdminClient: () => AdminSupabaseClient;
}): AgentRunMetadataService {
  return {
    async createAcceptedRun(input) {
      if (!input.requestMessageId && input.prompt !== undefined) {
        const { error } = await (options.getAdminClient() as any).rpc("loomic_create_run_with_request", {
          p_run: input.runId, p_session: input.sessionId, p_created_by: input.createdBy ?? null,
          p_thread: input.threadId, p_model: input.model ?? null,
          p_execution_mode: input.executionMode ?? "fast", p_prompt: input.prompt,
        });
        if (error) throw new AgentRunPersistenceError("Failed to persist accepted run and request.");
        return;
      }
      const { error } = await (options.getAdminClient().from("agent_runs") as any).insert({
        created_by: input.createdBy ?? null,
        execution_mode: input.executionMode ?? "fast",
        id: input.runId,
        model: input.model ?? null,
        ...(input.requestMessageId
          ? {
              request_message_id: input.requestMessageId,
              request_prompt: input.prompt ?? null,
            }
          : {}),
        session_id: input.sessionId,
        status: "accepted",
        thread_id: input.threadId,
      });

      if (error) {
        throw new AgentRunPersistenceError("Failed to persist accepted run.");
      }
    },

    async getRunDetail(runId, expectedSessionId) {
      const admin = options.getAdminClient();
      const runResult = await (admin.from("agent_runs") as any)
        .select(RUN_COLUMNS)
        .eq("id", runId)
        .eq("session_id", expectedSessionId)
        .maybeSingle();
      if (runResult.error) throw new AgentRunPersistenceError("Failed to query run.");
      if (!runResult.data) return null;

      const toolsResult = await (admin.from("tool_executions") as any)
        .select(TOOL_COLUMNS)
        .eq("run_id", runId)
        .order("started_at", { ascending: true })
        .order("id", { ascending: true });
      if (toolsResult.error) throw new AgentRunPersistenceError("Failed to query run tools.");
      const tools = (toolsResult.data ?? []).map(mapToolDetail);
      return {
        ...mapRunSummary(runResult.data, countTools(toolsResult.data ?? [])),
        tools,
      };
    },

    async getRunSessionId(runId) {
      const { data, error } = await (options.getAdminClient().from("agent_runs") as any)
        .select("session_id")
        .eq("id", runId)
        .maybeSingle();
      if (error) throw new AgentRunPersistenceError("Failed to query run.");
      return data ? (data.session_id as string) : null;
    },

    async listSessionRuns(sessionId, pageOptions) {
      const limit = Math.min(Math.max(pageOptions?.limit ?? 20, 1), 50);
      const cursor = pageOptions?.cursor ? decodeCursor(pageOptions.cursor) : null;
      let query = (options.getAdminClient().from("agent_runs") as any)
        .select(RUN_COLUMNS)
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1);
      if (cursor) {
        query = query.or(
          `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
        );
      }
      const runsResult = await query;
      if (runsResult.error) throw new AgentRunPersistenceError("Failed to list runs.");
      const rows = (runsResult.data ?? []) as Record<string, unknown>[];
      const page = rows.slice(0, limit);
      const runIds = page.map((row) => row.id as string);
      let toolRows: Record<string, unknown>[] = [];
      if (runIds.length > 0) {
        const toolsResult = await (options.getAdminClient().from("tool_executions") as any)
          .select("run_id, status")
          .in("run_id", runIds);
        if (toolsResult.error) throw new AgentRunPersistenceError("Failed to summarize runs.");
        toolRows = toolsResult.data ?? [];
      }
      const counts = new Map<string, AgentRunToolCounts>();
      for (const row of toolRows) {
        const runId = row.run_id as string;
        const current = counts.get(runId) ?? emptyToolCounts();
        current.total += 1;
        const status = row.status as keyof Omit<AgentRunToolCounts, "total">;
        if (status in current) current[status] += 1;
        counts.set(runId, current);
      }
      const last = page.at(-1);
      return {
        runs: page.map((row) => mapRunSummary(row, counts.get(row.id as string) ?? emptyToolCounts())),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor(last.created_at as string, last.id as string)
            : null,
      };
    },

    async updateRun(input) {
      const patch = {
        ...(input.completedAt ? { completed_at: input.completedAt } : {}),
        ...(input.errorCode ? { error_code: input.errorCode } : {}),
        ...(input.errorMessage ? { error_message: input.errorMessage } : {}),
        ...(input.startedAt ? { started_at: input.startedAt } : {}),
        status: input.status,
      };
      let query = (options.getAdminClient()
        .from("agent_runs")
        .update(patch) as any)
        .eq("id", input.runId);
      query = input.status === "running"
        ? query.eq("status", "accepted")
        : query.in("status", ["accepted", "running"]);
      const { error } = await query;

      if (error) {
        throw new AgentRunPersistenceError("Failed to update run metadata.");
      }
    },
  };
}

function emptyToolCounts(): AgentRunToolCounts {
  return { total: 0, running: 0, completed: 0, failed: 0, canceled: 0 };
}

function countTools(rows: Record<string, unknown>[]): AgentRunToolCounts {
  const counts = emptyToolCounts();
  for (const row of rows) {
    counts.total += 1;
    const status = row.status as keyof Omit<AgentRunToolCounts, "total">;
    if (status in counts) counts[status] += 1;
  }
  return counts;
}

function mapRunSummary(row: Record<string, unknown>, toolCounts: AgentRunToolCounts): AgentRunSummary {
  const startedAt = (row.started_at as string | null) ?? null;
  const completedAt = (row.completed_at as string | null) ?? null;
  const errorCode = (row.error_code as string | null) ?? null;
  const errorMessage = (row.error_message as string | null) ?? null;
  return {
    runId: row.id as string,
    sessionId: row.session_id as string,
    status: row.status as AgentRunSummary["status"],
    executionMode: row.execution_mode === "thinking" ? "thinking" : "fast",
    model: (row.model as string | null) ?? null,
    createdAt: row.created_at as string,
    startedAt,
    completedAt,
    durationMs:
      startedAt && completedAt
        ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
        : null,
    error: errorCode || errorMessage
      ? {
          code: errorCode,
          message: errorMessage
            ? sanitizeErrorForClient(Object.assign(new Error(errorMessage), { code: errorCode })).slice(0, 500)
            : null,
        }
      : null,
    toolCounts,
  };
}

function mapToolDetail(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    toolCallId: row.tool_call_id as string,
    toolName: row.tool_name as string,
    status: row.status as "running" | "completed" | "failed" | "canceled",
    retryable: row.retryable === true,
    attempt: Number(row.attempt ?? 1),
    retryOf: (row.retry_of as string | null) ?? null,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

function encodeCursor(createdAt: string, id: string) {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url");
}

function decodeCursor(value: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const parsedDate = new Date(parsed?.createdAt);
    if (
      !parsed ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(parsedDate.getTime()) ||
      typeof parsed.id !== "string" ||
      !isUuid(parsed.id)
    ) throw new Error("invalid");
    return { createdAt: parsedDate.toISOString(), id: parsed.id };
  } catch {
    throw new AgentRunPersistenceError("Invalid run history cursor.", 400);
  }
}
