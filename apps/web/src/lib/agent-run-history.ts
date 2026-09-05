export type AgentRunStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type AgentRunExecutionMode = "fast" | "thinking";

export type AgentRunToolCounts = {
  total: number;
  running: number;
  completed: number;
  failed: number;
  canceled: number;
};

export type AgentRunSummary = {
  runId: string;
  sessionId: string;
  status: AgentRunStatus;
  executionMode: AgentRunExecutionMode;
  model: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  error: { code: string | null; message: string | null } | null;
  toolCounts: AgentRunToolCounts;
};

export type AgentRunToolExecutionDetail = {
  id: string;
  toolCallId: string;
  toolName: string;
  status: "running" | "completed" | "failed" | "canceled";
  retryable: boolean;
  attempt: number;
  retryOf: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type AgentRunDetail = AgentRunSummary & {
  tools: AgentRunToolExecutionDetail[];
};

export type AgentRunListPage = {
  runs: AgentRunSummary[];
  nextCursor: string | null;
};

export class AgentRunResponseParseError extends Error {
  constructor(path: string) {
    super(`Invalid run history response at ${path}`);
    this.name = "AgentRunResponseParseError";
  }
}

export function parseAgentRunListPage(value: unknown): AgentRunListPage {
  const record = expectRecord(value, "response");
  return {
    runs: expectArray(record.runs, "response.runs").map((run, index) =>
      parseRunSummary(run, `response.runs[${index}]`),
    ),
    nextCursor: expectNullableString(
      record.nextCursor,
      "response.nextCursor",
    ),
  };
}

export function parseAgentRunDetailResponse(value: unknown): AgentRunDetail {
  const response = expectRecord(value, "response");
  const runRecord = expectRecord(response.run, "response.run");
  const summary = parseRunSummary(runRecord, "response.run");
  return {
    ...summary,
    tools: expectArray(runRecord.tools, "response.run.tools").map(
      (tool, index) => parseTool(tool, `response.run.tools[${index}]`),
    ),
  };
}

function parseRunSummary(value: unknown, path: string): AgentRunSummary {
  const record = expectRecord(value, path);
  return {
    runId: expectString(record.runId, `${path}.runId`),
    sessionId: expectString(record.sessionId, `${path}.sessionId`),
    status: expectEnum(
      record.status,
      ["accepted", "running", "completed", "failed", "canceled"] as const,
      `${path}.status`,
    ),
    executionMode: expectEnum(
      record.executionMode,
      ["fast", "thinking"] as const,
      `${path}.executionMode`,
    ),
    model: expectNullableString(record.model, `${path}.model`),
    createdAt: expectDateString(record.createdAt, `${path}.createdAt`),
    startedAt: expectNullableDateString(
      record.startedAt,
      `${path}.startedAt`,
    ),
    completedAt: expectNullableDateString(
      record.completedAt,
      `${path}.completedAt`,
    ),
    durationMs: expectNullableNonNegativeNumber(
      record.durationMs,
      `${path}.durationMs`,
    ),
    error: parseError(record.error, `${path}.error`),
    toolCounts: parseToolCounts(record.toolCounts, `${path}.toolCounts`),
  };
}

function parseError(
  value: unknown,
  path: string,
): AgentRunSummary["error"] {
  if (value === null) return null;
  const record = expectRecord(value, path);
  return {
    code: expectNullableString(record.code, `${path}.code`),
    message: expectNullableString(record.message, `${path}.message`),
  };
}

function parseToolCounts(value: unknown, path: string): AgentRunToolCounts {
  const record = expectRecord(value, path);
  return {
    total: expectNonNegativeInteger(record.total, `${path}.total`),
    running: expectNonNegativeInteger(record.running, `${path}.running`),
    completed: expectNonNegativeInteger(record.completed, `${path}.completed`),
    failed: expectNonNegativeInteger(record.failed, `${path}.failed`),
    canceled: expectNonNegativeInteger(record.canceled, `${path}.canceled`),
  };
}

function parseTool(
  value: unknown,
  path: string,
): AgentRunToolExecutionDetail {
  const record = expectRecord(value, path);
  return {
    id: expectString(record.id, `${path}.id`),
    toolCallId: expectString(record.toolCallId, `${path}.toolCallId`),
    toolName: expectString(record.toolName, `${path}.toolName`),
    status: expectEnum(
      record.status,
      ["running", "completed", "failed", "canceled"] as const,
      `${path}.status`,
    ),
    retryable: expectBoolean(record.retryable, `${path}.retryable`),
    attempt: expectNonNegativeInteger(record.attempt, `${path}.attempt`),
    retryOf: expectNullableString(record.retryOf, `${path}.retryOf`),
    startedAt: expectDateString(record.startedAt, `${path}.startedAt`),
    finishedAt: expectNullableDateString(
      record.finishedAt,
      `${path}.finishedAt`,
    ),
  };
}

function expectRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentRunResponseParseError(path);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new AgentRunResponseParseError(path);
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentRunResponseParseError(path);
  }
  return value;
}

function expectNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return expectString(value, path);
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new AgentRunResponseParseError(path);
  return value;
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new AgentRunResponseParseError(path);
  }
  return value as number;
}

function expectNullableNonNegativeNumber(
  value: unknown,
  path: string,
): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AgentRunResponseParseError(path);
  }
  return value;
}

function expectDateString(value: unknown, path: string): string {
  const text = expectString(value, path);
  if (!Number.isFinite(Date.parse(text))) {
    throw new AgentRunResponseParseError(path);
  }
  return text;
}

function expectNullableDateString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return expectDateString(value, path);
}

function expectEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new AgentRunResponseParseError(path);
  }
  return value as Values[number];
}
