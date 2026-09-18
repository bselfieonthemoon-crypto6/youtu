import { z } from "zod";
import { createHash } from "node:crypto";
import { designTaskTargetSchema, type DesignTaskTarget } from "@loomic/shared";
import type { AdminSupabaseClient } from "../../supabase/admin.js";

export const agentTaskTargetSchema = designTaskTargetSchema;

export type AgentTaskTarget = DesignTaskTarget;
export type AgentTaskSnapshot = {
  id: string;
  revision: number;
  runId: string;
  sessionId: string;
  canvasId: string;
  goal: string;
  corrections: string[];
  target: AgentTaskTarget;
  brief: Record<string, unknown> | null;
};
export type BeginAgentTaskInput = {
  userId: string;
  sessionId: string;
  canvasId: string;
  runId: string;
  prompt: string;
  target?: AgentTaskTarget;
  correctionOfRunId?: string;
};
/** Read-only proposal for a task transition; no execution authority until activate. */
export type PreparedAgentTask = {
  snapshot: AgentTaskSnapshot;
  baseTaskId: string | null;
  baseRevision: number | null;
  baseRunId: string | null;
};
export type AgentTaskService = {
  registerCanvasResultReview?(input: { userId: string; sessionId: string; runId: string; jobId: string }): Promise<void>;
  begin(input: BeginAgentTaskInput): Promise<AgentTaskSnapshot>;
  prepare(input: BeginAgentTaskInput): Promise<PreparedAgentTask>;
  activate(input: BeginAgentTaskInput, prepared: PreparedAgentTask): Promise<AgentTaskSnapshot>;
  getCurrent(userId: string, sessionId: string): Promise<AgentTaskSnapshot | null>;
  assertCurrentRun(runId: string): Promise<AgentTaskSnapshot | null>;
  updateBrief(runId: string, brief: Record<string, unknown>): Promise<AgentTaskSnapshot>;
  updateWorkflow?(
    runId: string,
    taskRevision: number,
    expectedWorkflowRevision: number | null,
    workflow: Record<string, unknown>,
  ): Promise<AgentTaskSnapshot>;
};

export class AgentTaskError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 409) {
    super(code);
    this.name = "AgentTaskError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isAgentTaskAttachmentRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message
    : typeof error === "object" && error !== null && "message" in error ? String(error.message) : "";
  return message.includes("agent_task_superseded") || message.includes("agent_task_target_mismatch");
}

const snapshotSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  runId: z.string().uuid(),
  sessionId: z.string().uuid(),
  canvasId: z.string().uuid(),
  goal: z.string(),
  corrections: z.array(z.string()),
  target: z.unknown().transform((value): AgentTaskTarget => agentTaskTargetSchema.parse(value)),
  brief: z.record(z.string(), z.unknown()).nullable(),
});
const preparedSchema = z.object({
  snapshot: snapshotSchema,
  baseTaskId: z.string().uuid().nullable(),
  baseRevision: z.number().int().positive().nullable(),
  baseRunId: z.string().uuid().nullable(),
}).strict().refine(value => value.baseTaskId === null
  ? value.baseRevision === null && value.baseRunId === null
  : value.baseRevision !== null && value.baseRunId !== null);

function beginArguments(input: BeginAgentTaskInput): Record<string, unknown> {
  let target = input.target ? agentTaskTargetSchema.parse(input.target) : null;
  if (target?.kind === "design" && target.objectIds?.length === 0) {
    const { objectIds: _emptySelection, ...wholeDesign } = target;
    target = wholeDesign;
  }
  return {
    p_user: input.userId, p_session: input.sessionId, p_canvas: input.canvasId,
    p_run: input.runId, p_prompt: input.prompt, p_target: target,
    p_correction_of: input.correctionOfRunId ?? null,
  };
}

function requestFingerprint(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
    return item;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function freezePreparation<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezePreparation(item);
    Object.freeze(value);
  }
  return value;
}

export function createAgentTaskService(options: {
  getAdminClient: () => AdminSupabaseClient;
  onActivated?: (userId: string, task: AgentTaskSnapshot) => Promise<void>;
  atomicAutonomy?: { defaultEnabled: boolean };
}): AgentTaskService {
  // An opaque per-service handle prevents a model-derived reconstructed object
  // or a changed user prompt from being treated as the prepared request. After
  // server restart, prepare the authenticated original input again.
  const preparations = new WeakMap<PreparedAgentTask, string>();
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await (options.getAdminClient().rpc as any)(name, args);
    if (error) {
      const code = /agent_(?:task|workflow)_[a-z_]+/.exec(error.message ?? "")?.[0] ?? "agent_task_persistence_failed";
      const status = code.includes("forbidden") ? 403 : code.includes("invalid") ? 400
        : code === "agent_task_persistence_failed" ? 500 : 409;
      throw new AgentTaskError(code, status);
    }
    return data;
  }
  return {
    ...(options.atomicAutonomy ? {
      async registerCanvasResultReview(input: { userId: string; sessionId: string; runId: string; jobId: string }) {
        await rpc("loomic_register_canvas_result_review", {
          p_user: input.userId, p_session: input.sessionId, p_run: input.runId, p_job: input.jobId,
        });
      },
    } : {}),
    async begin(input) {
      return snapshotSchema.parse(await rpc("loomic_agent_task_begin", beginArguments(input)));
    },
    async prepare(input) {
      const args = beginArguments(input);
      const fingerprint = requestFingerprint(args);
      const prepared = preparedSchema.parse(await rpc("loomic_agent_task_prepare", args));
      if (prepared.snapshot.runId !== input.runId || prepared.snapshot.sessionId !== input.sessionId || prepared.snapshot.canvasId !== input.canvasId)
        throw new AgentTaskError("agent_task_preparation_invalid", 400);
      freezePreparation(prepared);
      preparations.set(prepared, fingerprint);
      return prepared;
    },
    async activate(input, prepared) {
      const args = beginArguments(input);
      if (!preparations.has(prepared) || preparations.get(prepared) !== requestFingerprint(args))
        throw new AgentTaskError("agent_task_activation_conflict");
      const actual = snapshotSchema.parse(await rpc(options.atomicAutonomy
        ? "loomic_agent_task_activate_autonomous" : "loomic_agent_task_activate", {
        ...args, p_prepared: prepared,
        ...(options.atomicAutonomy ? { p_default_enabled: options.atomicAutonomy.defaultEnabled } : {}),
      }));
      // A new task gets its real database ID at activation; every other source
      // and intent field must still represent this exact prepared transition.
      const { id: _candidateId, brief: _candidateBrief, ...candidate } = prepared.snapshot;
      const { id: _actualId, brief: _actualBrief, ...activated } = actual;
      if (requestFingerprint(candidate) !== requestFingerprint(activated) ||
        (prepared.baseTaskId !== null && actual.id !== prepared.baseTaskId))
        throw new AgentTaskError("agent_task_activation_conflict");
      await options.onActivated?.(input.userId, actual);
      return actual;
    },
    async getCurrent(userId, sessionId) {
      const result = await rpc("loomic_agent_task_current", { p_user: userId, p_session: sessionId });
      return result === null ? null : snapshotSchema.parse(result);
    },
    async assertCurrentRun(runId) {
      const result = await rpc("loomic_agent_task_assert_current", { p_run: runId });
      return result === null ? null : snapshotSchema.parse(result);
    },
    async updateBrief(runId, brief) {
      if (JSON.stringify(brief).length > 20_000) throw new AgentTaskError("agent_task_brief_invalid", 400);
      return snapshotSchema.parse(await rpc("loomic_agent_task_update_brief", { p_run: runId, p_brief: brief }));
    },
    async updateWorkflow(runId, taskRevision, expectedWorkflowRevision, workflow) {
      return snapshotSchema.parse(await rpc("loomic_agent_task_update_workflow", {
        p_run: runId,
        p_task_revision: taskRevision,
        p_expected_workflow_revision: expectedWorkflowRevision,
        p_workflow: workflow,
      }));
    },
  };
}
