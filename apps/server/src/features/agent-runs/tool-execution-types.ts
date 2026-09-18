import type { Json, ToolArtifact } from "@loomic/shared";

export type ToolExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type ToolExecution = {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  status: ToolExecutionStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  outputSummary: string | null;
  planId: string | null;
  planStepId: string | null;
  artifacts: ToolArtifact[] | null;
  retryable: boolean;
  attempt: number;
  retryOf: string | null;
  requestedBy: string | null;
  retryRequestId: string | null;
};

export type RecordToolStartedInput = {
  runId: string;
  requestedBy: string;
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  planId?: string;
  planStepId?: string;
};

export type ToolExecutionCompletion = {
  output?: Record<string, unknown>;
  outputSummary?: string;
  artifacts?: ToolArtifact[];
};

export type ToolExecutionRetryContext = {
  execution: ToolExecution;
  canvasId: string;
  sessionId: string;
  threadId: string;
  /** Workspace of the original run; required to re-run workspace-scoped reads. */
  workspaceId: string;
  isNew: boolean;
};

export function asJson(value: unknown): Json {
  return value as Json;
}
