import { createHash } from "node:crypto";
import {
  designTaskAuthorizedTargetsSchema,
  designTaskTargetSchema,
  type DesignTaskTarget,
} from "@loomic/shared";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import {
  AgentTaskError,
  type AgentTaskService,
  type AgentTaskSnapshot,
  type PreparedAgentTask,
} from "./agent-task-service.js";

export type PreparedAgentTargetScope = Readonly<{
  userId: string;
  sessionId: string;
  canvasId: string;
  runId: string;
  primaryTarget: DesignTaskTarget;
  targets: readonly DesignTaskTarget[];
  source: "authenticated_user_request" | "validated_correction_inheritance";
}>;

export type ExecutionScopedAgentTask = {
  /** A projection for one already-authorized workflow destination. It retains
   * the canonical task identity but never replaces its database target. */
  snapshot: AgentTaskSnapshot;
  service: AgentTaskService;
  canonicalTarget: DesignTaskTarget;
  executionTarget: DesignTaskTarget;
};

export class AgentTargetScopeError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 409) {
    super(code);
    this.name = "AgentTargetScopeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function targetFingerprint(target: DesignTaskTarget): string {
  return fingerprint(target.kind === "design" && target.objectIds
    ? { ...target, objectIds: [...target.objectIds].sort() }
    : target);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function cloneTarget(target: DesignTaskTarget): DesignTaskTarget {
  return structuredClone(target);
}

function sameTaskIdentity(left: AgentTaskSnapshot, right: AgentTaskSnapshot): boolean {
  return left.id === right.id && left.revision === right.revision && left.runId === right.runId
    && left.sessionId === right.sessionId && left.canvasId === right.canvasId;
}

export function createAgentTargetScopeService(options: {
  getAdminClient: () => AdminSupabaseClient;
  taskService?: AgentTaskService;
}) {
  const preparations = new WeakMap<PreparedAgentTargetScope, string>();

  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await (options.getAdminClient().rpc as any)(name, args);
    if (error) {
      const code = /agent_target_scope_[a-z_]+/.exec(error.message ?? "")?.[0]
        ?? "agent_target_scope_persistence_failed";
      const status = code.includes("forbidden") ? 403 : code.includes("invalid") || code.includes("primary_missing")
        ? 400 : code === "agent_target_scope_persistence_failed" ? 500 : 409;
      throw new AgentTargetScopeError(code, status);
    }
    return data;
  }

  const service = {
    /** Called only while parsing the authenticated run request, before model
     * execution. The opaque object identity is required by activate(). */
    prepareUserScope(input: {
      userId: string;
      sessionId: string;
      canvasId: string;
      runId: string;
      primaryTarget: DesignTaskTarget;
      authorizedTargets: readonly DesignTaskTarget[];
    }): PreparedAgentTargetScope {
      const primaryTarget = designTaskTargetSchema.parse(input.primaryTarget);
      const targets = designTaskAuthorizedTargetsSchema.parse(input.authorizedTargets);
      if (!targets.some(target => targetFingerprint(target) === targetFingerprint(primaryTarget)))
        throw new AgentTargetScopeError("agent_target_scope_primary_missing", 400);
      const prepared = freeze({
        userId: input.userId,
        sessionId: input.sessionId,
        canvasId: input.canvasId,
        runId: input.runId,
        primaryTarget: cloneTarget(primaryTarget),
        targets: targets.map(cloneTarget),
        source: "authenticated_user_request" as const,
      });
      preparations.set(prepared, fingerprint(prepared));
      return prepared;
    },

    /** Inherit a correction's exact prior scope only through fresh server
     * evidence. The caller must not use this path when the user supplied a new
     * target scope; target changes go through prepareUserScope instead. */
    async prepareCorrectionScope(input: {
      userId: string;
      sessionId: string;
      canvasId: string;
      runId: string;
      correctionOfRunId: string;
      taskRevision: number;
      primaryTarget: DesignTaskTarget;
    }): Promise<PreparedAgentTargetScope> {
      const primaryTarget = designTaskTargetSchema.parse(input.primaryTarget);
      const result = await rpc("loomic_agent_target_scope_prepare_correction", {
        p_user: input.userId,
        p_session: input.sessionId,
        p_canvas: input.canvasId,
        p_run: input.runId,
        p_correction_of: input.correctionOfRunId,
        p_task_revision: input.taskRevision,
        p_primary_target: primaryTarget,
      });
      const targets = designTaskAuthorizedTargetsSchema.parse(result);
      if (!targets.some(target => targetFingerprint(target) === targetFingerprint(primaryTarget)))
        throw new AgentTargetScopeError("agent_target_scope_primary_missing", 400);
      const prepared = freeze({
        userId: input.userId,
        sessionId: input.sessionId,
        canvasId: input.canvasId,
        runId: input.runId,
        primaryTarget: cloneTarget(primaryTarget),
        targets: targets.map(cloneTarget),
        source: "validated_correction_inheritance" as const,
      });
      preparations.set(prepared, fingerprint(prepared));
      return prepared;
    },

    async activate(prepared: PreparedAgentTargetScope, task: AgentTaskSnapshot): Promise<DesignTaskTarget[]> {
      if (!preparations.has(prepared) || preparations.get(prepared) !== fingerprint(prepared)
        || task.runId !== prepared.runId || task.sessionId !== prepared.sessionId || task.canvasId !== prepared.canvasId
        || targetFingerprint(task.target) !== targetFingerprint(prepared.primaryTarget))
        throw new AgentTargetScopeError("agent_target_scope_activation_conflict");
      const result = await rpc("loomic_agent_target_scope_activate", {
        p_user: prepared.userId,
        p_session: prepared.sessionId,
        p_run: prepared.runId,
        p_task_revision: task.revision,
        p_targets: prepared.targets,
      });
      return designTaskAuthorizedTargetsSchema.parse(result);
    },

    async listAuthorizedTargets(input: {
      userId: string;
      task: AgentTaskSnapshot;
    }): Promise<DesignTaskTarget[]> {
      const result = await rpc("loomic_agent_target_scope_list", {
        p_user: input.userId,
        p_session: input.task.sessionId,
        p_run: input.task.runId,
        p_task_revision: input.task.revision,
      });
      return designTaskAuthorizedTargetsSchema.parse(result);
    },

    async assertAuthorized(input: {
      userId: string;
      task: AgentTaskSnapshot;
      target: DesignTaskTarget;
    }): Promise<DesignTaskTarget> {
      const target = designTaskTargetSchema.parse(input.target);
      const result = await rpc("loomic_agent_target_scope_assert", {
        p_user: input.userId,
        p_session: input.task.sessionId,
        p_run: input.task.runId,
        p_task_revision: input.task.revision,
        p_target: target,
      });
      if (result !== true) throw new AgentTargetScopeError("agent_target_scope_forbidden", 403);
      return cloneTarget(target);
    },

    async resolveExecutionTask(input: {
      userId: string;
      task: AgentTaskSnapshot;
      target: DesignTaskTarget;
      taskService: AgentTaskService;
    }): Promise<ExecutionScopedAgentTask> {
      // Reload canonical state. A prior projected snapshot is never accepted as
      // evidence that another target should be authorized.
      const canonicalTask = await input.taskService.assertCurrentRun(input.task.runId);
      if (!canonicalTask || !sameTaskIdentity(canonicalTask, input.task))
        throw new AgentTargetScopeError("agent_target_scope_revision_conflict");
      const executionTarget = await service.assertAuthorized({
        userId: input.userId,
        task: canonicalTask,
        target: input.target,
      });
      const fixed = { id: canonicalTask.id, revision: canonicalTask.revision, runId: canonicalTask.runId,
        sessionId: canonicalTask.sessionId, canvasId: canonicalTask.canvasId };

      const project = async (candidate: AgentTaskSnapshot | null): Promise<AgentTaskSnapshot> => {
        if (!candidate || candidate.id !== fixed.id || candidate.revision !== fixed.revision
          || candidate.runId !== fixed.runId || candidate.sessionId !== fixed.sessionId || candidate.canvasId !== fixed.canvasId)
          throw new AgentTargetScopeError("agent_target_scope_revision_conflict");
        await service.assertAuthorized({ userId: input.userId, task: candidate, target: executionTarget });
        return { ...candidate, target: cloneTarget(executionTarget) };
      };
      const assertArguments = (runId: string) => {
        if (runId !== fixed.runId) throw new AgentTargetScopeError("agent_target_scope_forbidden", 403);
      };
      const forbiddenTransition = async (): Promise<never> => {
        throw new AgentTargetScopeError("agent_target_scope_facade_forbidden", 403);
      };
      const facade: AgentTaskService = {
        begin: forbiddenTransition,
        prepare: forbiddenTransition,
        activate: forbiddenTransition as (request: never, prepared: PreparedAgentTask) => Promise<never>,
        async getCurrent(userId, sessionId) {
          if (userId !== input.userId || sessionId !== fixed.sessionId)
            throw new AgentTargetScopeError("agent_target_scope_forbidden", 403);
          return project(await input.taskService.getCurrent(userId, sessionId));
        },
        async assertCurrentRun(runId) {
          assertArguments(runId);
          return project(await input.taskService.assertCurrentRun(runId));
        },
        async updateBrief(runId, brief) {
          assertArguments(runId);
          await service.assertAuthorized({ userId: input.userId, task: canonicalTask, target: executionTarget });
          return project(await input.taskService.updateBrief(runId, brief));
        },
        async updateWorkflow(runId, taskRevision, expectedWorkflowRevision, workflow) {
          assertArguments(runId);
          if (taskRevision !== fixed.revision || !input.taskService.updateWorkflow)
            throw new AgentTaskError("agent_workflow_revision_conflict");
          await service.assertAuthorized({ userId: input.userId, task: canonicalTask, target: executionTarget });
          return project(await input.taskService.updateWorkflow(runId, taskRevision, expectedWorkflowRevision, workflow));
        },
      };
      return {
        snapshot: await project(canonicalTask),
        service: facade,
        canonicalTarget: cloneTarget(canonicalTask.target),
        executionTarget: cloneTarget(executionTarget),
      };
    },

    /** Direct adapter for AgentAutonomyRunner.resolveExecutionTask. The grant
     * identity is checked before resolving the canonical task facade. */
    async resolveAutonomousExecutionTask(
      grant: { created_by: string; session_id: string; task_id: string; task_revision: number;
        origin_run_id: string; canvas_id: string },
      task: AgentTaskSnapshot,
      target: unknown,
    ): Promise<{ task: AgentTaskSnapshot; service: AgentTaskService }> {
      if (!options.taskService || grant.created_by.length === 0 || grant.session_id !== task.sessionId
        || grant.task_id !== task.id || grant.task_revision !== task.revision
        || grant.origin_run_id !== task.runId || grant.canvas_id !== task.canvasId)
        throw new AgentTargetScopeError("agent_target_scope_revision_conflict");
      const scoped = await service.resolveExecutionTask({
        userId: grant.created_by,
        task,
        target: designTaskTargetSchema.parse(target),
        taskService: options.taskService,
      });
      return { task: scoped.snapshot, service: scoped.service };
    },
  };
  return service;
}

export type AgentTargetScopeService = ReturnType<typeof createAgentTargetScopeService>;
