export type PersistedAgentRunStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type CreateAcceptedAgentRunInput = {
  createdBy?: string;
  executionMode?: "fast" | "thinking";
  model?: string;
  runId: string;
  sessionId: string;
  threadId: string;
};

export type UpdateAgentRunInput = {
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  runId: string;
  startedAt?: string;
  status: PersistedAgentRunStatus;
};

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
  status: PersistedAgentRunStatus;
  executionMode: "fast" | "thinking";
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
