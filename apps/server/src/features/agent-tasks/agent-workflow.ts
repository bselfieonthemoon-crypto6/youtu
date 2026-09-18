import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type { DesignTaskTarget } from "@loomic/shared";
import type {
  AgentTaskService,
  AgentTaskSnapshot,
} from "./agent-task-service.js";

export const AGENT_WORKFLOW_BRIEF_KEY = "agentWorkflow";
export const MAX_WORKFLOW_STEPS = 20;
const MAX_WORKFLOW_JSON_BYTES = 15_000;

export const workflowStepIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const workflowStepStatusSchema = z.enum([
  "planned",
  "ready",
  "running",
  "waiting_job",
  "needs_attention",
  "completed",
  "canceled",
]);

// @loomic/shared currently ships Zod 3 while the server uses Zod 4. Reusing a
// schema object across those runtime versions is unsafe, so keep the identical
// target wire contract local and use the shared inferred TypeScript type.
const workflowTargetSchema: z.ZodType<DesignTaskTarget> = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("design"),
      designId: z.string().uuid(),
      objectIds: z.array(z.string().uuid()).max(100).optional(),
      elementId: z.string().min(1).max(200).optional(),
    }).strict(),
    z.object({
      kind: z.literal("canvas_image"),
      elementId: z.string().min(1).max(200),
      assetId: z.string().uuid(),
    }).strict(),
  ],
);

export const workflowPlanStepInputSchema = z
  .object({
    stepId: workflowStepIdSchema,
    title: z.string().trim().min(1).max(120),
    intent: z.string().trim().min(1).max(500),
    dependsOn: z.array(workflowStepIdSchema).max(MAX_WORKFLOW_STEPS).default([]),
    target: workflowTargetSchema.optional(),
  })
  .strict();

export const workflowPlanInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    steps: z.array(workflowPlanStepInputSchema).min(1).max(MAX_WORKFLOW_STEPS),
  })
  .strict();

const workflowResultSchema = z
  .object({
    resultId: z.string().min(1).max(128),
    kind: z.enum(["execution", "verification"]),
    outcome: z.enum(["succeeded", "failed", "canceled"]),
    jobId: z.string().min(1).max(128).optional(),
    verificationRequired: z.boolean().optional(),
    summary: z.string().max(160).optional(),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const workflowStepSchema = workflowPlanStepInputSchema.extend({
  status: workflowStepStatusSchema,
  requiresTargetConfirmation: z.boolean(),
  /** A prior paid result was retained across a correction, but its old
   * verification did not prove the corrected requirements. Re-review the
   * retained result; do not submit the generation/edit operation again. */
  requiresResultReverification: z.boolean().default(false),
  proposalIds: z.array(z.string().min(1).max(128)).max(20),
  proposalJobs: z.record(
    z.string().min(1).max(128),
    z.string().min(1).max(128),
  ),
  jobs: z.array(z.string().min(1).max(128)).max(20),
  results: z.array(workflowResultSchema).max(40),
  attemptHistory: z.array(z.object({
    proposalIds: z.array(z.string()).max(20), jobs: z.array(z.string()).max(20),
    results: z.array(workflowResultSchema).max(40), recordedAt: z.string().datetime({ offset: true }),
  }).strict()).max(2).optional(),
}).strict();

export const agentWorkflowSnapshotSchema = z
  .object({
    version: z.literal(1),
    workflowId: z.string().uuid(),
    workflowRevision: z.number().int().positive(),
    taskId: z.string().uuid(),
    taskRevision: z.number().int().positive(),
    runId: z.string().uuid(),
    title: z.string().trim().min(1).max(160),
    status: workflowStepStatusSchema,
    authority: z.literal("planning_snapshot_not_execution_authority"),
    steps: z.array(workflowStepSchema).min(1).max(MAX_WORKFLOW_STEPS),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type WorkflowPlanInput = z.infer<typeof workflowPlanInputSchema>;
export type AgentWorkflowSnapshot = z.infer<typeof agentWorkflowSnapshotSchema>;
export type AgentWorkflowStep = AgentWorkflowSnapshot["steps"][number];

export class AgentWorkflowError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "AgentWorkflowError";
    this.code = code;
  }
}

export type TrustedWorkflowEvent =
  | { type: "visual_repair_requested"; stepId: string; jobId: string }
  | { type: "execution_started"; stepId: string }
  | {
      type: "execution_finished";
      stepId: string;
      resultId: string;
      outcome: "succeeded" | "failed" | "canceled";
      verificationRequired: boolean;
      summary?: string;
    }
  | { type: "proposal_created"; stepId: string; proposalId: string }
  | { type: "job_submitted"; stepId: string; jobId: string; proposalId?: string }
  | {
      type: "job_finished";
      stepId: string;
      jobId: string;
      resultId: string;
      outcome: "succeeded" | "failed" | "canceled";
      verificationRequired: boolean;
      summary?: string;
    }
  | {
      type: "verification_finished";
      stepId: string;
      resultId: string;
      jobId?: string;
      outcome: "succeeded" | "failed";
      summary?: string;
    }
  | { type: "needs_attention"; stepId: string; resultId: string; summary?: string }
  | { type: "canceled"; stepId: string; resultId: string; summary?: string };

export function workflowTargetFingerprint(target: DesignTaskTarget): string {
  const canonical = target.kind === "design"
    ? {
        kind: target.kind,
        designId: target.designId,
        ...(target.objectIds
          ? { objectIds: [...target.objectIds].sort() }
          : {}),
        ...(target.elementId ? { elementId: target.elementId } : {}),
      }
    : target;
  return JSON.stringify(canonical);
}

export function workflowOperationFingerprint(step: WorkflowPlanInput["steps"][number]): string {
  return createHash("sha256")
    .update(JSON.stringify({ title: step.title, intent: step.intent }))
    .digest("hex");
}

/** Hash only a server-reviewed, step-scoped requirements projection. Raw model
 * summaries are not suitable inputs because matching hashes are evidence of
 * equality, not evidence that the projection was authorized. */
export function workflowRequirementsFingerprint(requirements: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]))
      : value;
  return createHash("sha256").update(JSON.stringify(canonical(requirements))).digest("hex");
}

function stepFingerprint(step: WorkflowPlanInput["steps"][number]): string {
  return createHash("sha256")
    .update(JSON.stringify({
      title: step.title,
      intent: step.intent,
      dependsOn: [...step.dependsOn].sort(),
      target: step.target ? workflowTargetFingerprint(step.target) : null,
    }))
    .digest("hex");
}

function isTargetWithinBound(
  candidate: DesignTaskTarget | undefined,
  bound: DesignTaskTarget,
): boolean {
  if (!candidate) return true;
  if (candidate.kind !== bound.kind) return false;
  if (candidate.kind === "canvas_image" && bound.kind === "canvas_image")
    return candidate.elementId === bound.elementId && candidate.assetId === bound.assetId;
  if (candidate.kind !== "design" || bound.kind !== "design") return false;
  if (candidate.designId !== bound.designId) return false;
  if (!bound.objectIds) return true;
  if (!candidate.objectIds) return false;
  const allowed = new Set(bound.objectIds);
  return candidate.objectIds.every((id) => allowed.has(id));
}

export function isWorkflowTargetAuthorized(
  candidate: DesignTaskTarget | undefined,
  canonicalTarget: DesignTaskTarget,
  authorizedTargets: readonly DesignTaskTarget[] = [],
): boolean {
  return [canonicalTarget, ...authorizedTargets].some(bound => isTargetWithinBound(candidate, bound));
}

function validateGraph(steps: WorkflowPlanInput["steps"]): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.stepId)) throw new AgentWorkflowError("agent_workflow_duplicate_step");
    ids.add(step.stepId);
    if (new Set(step.dependsOn).size !== step.dependsOn.length)
      throw new AgentWorkflowError("agent_workflow_duplicate_dependency");
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency))
        throw new AgentWorkflowError("agent_workflow_dependency_missing");
      if (dependency === step.stepId)
        throw new AgentWorkflowError("agent_workflow_cycle");
    }
  }
  const incoming = new Map(steps.map((step) => [step.stepId, step.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const step of steps)
    for (const dependency of step.dependsOn)
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), step.stepId]);
  const queue = steps.filter((step) => step.dependsOn.length === 0).map((step) => step.stepId);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (incoming.get(dependent) ?? 0) - 1;
      incoming.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  if (visited !== steps.length) throw new AgentWorkflowError("agent_workflow_cycle");
}

function deriveStepReadiness(steps: AgentWorkflowStep[]): AgentWorkflowStep[] {
  const completed = new Set(
    steps.filter((step) => step.status === "completed").map((step) => step.stepId),
  );
  return steps.map((step) => {
    if (!["planned", "ready"].includes(step.status)) return step;
    if (step.requiresTargetConfirmation)
      return { ...step, status: "needs_attention" };
    return {
      ...step,
      status: step.dependsOn.every((id) => completed.has(id)) ? "ready" : "planned",
    };
  });
}

function deriveWorkflowStatus(steps: AgentWorkflowStep[]): AgentWorkflowSnapshot["status"] {
  if (steps.every((step) => step.status === "completed")) return "completed";
  if (steps.every((step) => step.status === "canceled")) return "canceled";
  if (steps.some((step) => step.status === "needs_attention")) return "needs_attention";
  // A canceled prerequisite makes the original DAG impossible to complete.
  // A correction/replan can explicitly replace that branch later.
  if (steps.some((step) => step.status === "canceled")) return "canceled";
  if (steps.some((step) => step.status === "waiting_job")) return "waiting_job";
  if (steps.some((step) => step.status === "running")) return "running";
  if (steps.some((step) => step.status === "ready")) return "ready";
  return "planned";
}

function assertWorkflowSize(workflow: AgentWorkflowSnapshot): void {
  if (Buffer.byteLength(JSON.stringify(workflow), "utf8") > MAX_WORKFLOW_JSON_BYTES)
    throw new AgentWorkflowError("agent_workflow_too_large");
}

export function reconcileWorkflowPlan(input: {
  task: AgentTaskSnapshot;
  plan: WorkflowPlanInput;
  previous?: AgentWorkflowSnapshot | null;
  /** Canonical rows loaded from AgentTargetScopeService. Model plan targets are
   * never passed in this authority list. */
  authorizedTargets?: readonly DesignTaskTarget[];
  now?: string;
  workflowId?: string;
}): AgentWorkflowSnapshot {
  const plan = workflowPlanInputSchema.parse(input.plan);
  validateGraph(plan.steps);
  const previous = input.previous
    ? agentWorkflowSnapshotSchema.parse(input.previous)
    : null;
  if (previous && previous.taskId !== input.task.id)
    throw new AgentWorkflowError("agent_workflow_task_mismatch");
  if (previous && previous.taskRevision > input.task.revision)
    throw new AgentWorkflowError("agent_workflow_revision_stale");
  const previousById = new Map(previous?.steps.map((step) => [step.stepId, step]));
  let steps: AgentWorkflowStep[] = plan.steps.map((step) => {
    const old = previousById.get(step.stepId);
    const preservesCompleted = old?.status === "completed" &&
      stepFingerprint(old) === stepFingerprint(step);
    return {
      ...step,
      status: preservesCompleted ? "completed" : "planned",
      requiresTargetConfirmation: !isWorkflowTargetAuthorized(
        step.target,
        input.task.target,
        input.authorizedTargets,
      ),
      requiresResultReverification: false,
      proposalIds: preservesCompleted ? old.proposalIds : [],
      proposalJobs: preservesCompleted ? old.proposalJobs : {},
      jobs: preservesCompleted ? old.jobs : [],
      results: preservesCompleted ? old.results : [],
    };
  });
  steps = deriveStepReadiness(steps);
  const now = input.now ?? new Date().toISOString();
  const workflow: AgentWorkflowSnapshot = {
    version: 1,
    workflowId: previous?.workflowId ?? input.workflowId ?? randomUUID(),
    workflowRevision: (previous?.workflowRevision ?? 0) + 1,
    taskId: input.task.id,
    taskRevision: input.task.revision,
    runId: input.task.runId,
    title: plan.title,
    status: deriveWorkflowStatus(steps),
    authority: "planning_snapshot_not_execution_authority",
    steps,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  assertWorkflowSize(workflow);
  return agentWorkflowSnapshotSchema.parse(workflow);
}

export type CorrectionWorkflowPreservationEvidence = Readonly<{
  /** This object must be emitted by the server-side intent gate from the real
   * authenticated correction. It is intentionally not part of a model tool
   * schema and must never be synthesized from a workflow plan. */
  source: "server_verified_authenticated_user_correction";
  taskId: string;
  baseRevision: number;
  correctionIndex: number;
  correctionText: string;
  stepId: string;
  targetFingerprint: string;
  operationFingerprint: string;
  previousRequirementsFingerprint: string;
  nextRequirementsFingerprint: string;
}>;

function hasSucceededServerVerification(step: AgentWorkflowStep): boolean {
  const executions = step.results.filter(result => result.kind === "execution" && result.outcome === "succeeded");
  return executions.length > 0 && executions.every(execution => step.results.some(result =>
    result.kind === "verification" && result.outcome === "succeeded" && result.jobId === execution.jobId));
}

function retainedExecutionEvidence(step: AgentWorkflowStep): Pick<AgentWorkflowStep,
  "proposalIds" | "proposalJobs" | "jobs" | "results"> | null {
  const executions = step.results.filter(result => result.kind === "execution" && result.outcome === "succeeded");
  if (executions.length === 0) return null;
  const jobs = [...new Set(executions.flatMap(result => result.jobId ? [result.jobId] : []))];
  const proposalJobs = Object.fromEntries(Object.entries(step.proposalJobs)
    .filter(([, jobId]) => jobs.includes(jobId)));
  return {
    proposalIds: step.proposalIds.filter(proposalId => proposalId in proposalJobs),
    proposalJobs,
    jobs,
    results: executions.map(result => ({ ...result, verificationRequired: true })),
  };
}

/** Replan a correction without treating the old workflow or a model plan as
 * renewed authority. A completed step survives only with exact fingerprints,
 * successful server verification, and explicit server-issued preservation
 * evidence tied to the newly appended authenticated correction. Otherwise an
 * unchanged operation retains its successful artifact/job references solely
 * for re-verification, avoiding a duplicate paid operation. */
export function reconcileCorrectionWorkflowPlan(input: {
  task: AgentTaskSnapshot;
  previousTask: AgentTaskSnapshot;
  plan: WorkflowPlanInput;
  previous: AgentWorkflowSnapshot;
  authorizedTargets?: readonly DesignTaskTarget[];
  preservationEvidence?: readonly CorrectionWorkflowPreservationEvidence[];
  now?: string;
}): AgentWorkflowSnapshot {
  const previous = agentWorkflowSnapshotSchema.parse(input.previous);
  if (input.task.id !== input.previousTask.id || input.task.id !== previous.taskId
    || input.task.revision !== input.previousTask.revision + 1
    || previous.taskRevision !== input.previousTask.revision
    || input.task.runId === input.previousTask.runId
    || previous.runId !== input.previousTask.runId
    || input.task.goal !== input.previousTask.goal
    || input.task.corrections.length !== input.previousTask.corrections.length + 1
    || input.previousTask.corrections.some((value, index) => input.task.corrections[index] !== value))
    throw new AgentWorkflowError("agent_workflow_correction_chain_invalid");

  const correctionIndex = input.task.corrections.length - 1;
  const correctionText = input.task.corrections[correctionIndex]!;
  const evidenceByStep = new Map((input.preservationEvidence ?? []).map(evidence => [evidence.stepId, evidence]));
  if (evidenceByStep.size !== (input.preservationEvidence ?? []).length)
    throw new AgentWorkflowError("agent_workflow_preservation_evidence_invalid");

  const clean = reconcileWorkflowPlan({
    task: input.task,
    plan: input.plan,
    ...(input.authorizedTargets ? { authorizedTargets: input.authorizedTargets } : {}),
    workflowId: previous.workflowId,
    ...(input.now ? { now: input.now } : {}),
  });
  const previousById = new Map(previous.steps.map(step => [step.stepId, step]));
  let steps = clean.steps.map(step => {
    const old = previousById.get(step.stepId);
    if (!old || old.status !== "completed" || step.requiresTargetConfirmation) return step;
    const oldTarget = old.target ?? input.previousTask.target;
    const nextTarget = step.target ?? input.task.target;
    const exactTarget = workflowTargetFingerprint(oldTarget) === workflowTargetFingerprint(nextTarget);
    const exactOperation = workflowOperationFingerprint(old) === workflowOperationFingerprint(step);
    const exactStep = stepFingerprint(old) === stepFingerprint(step);
    if (!exactTarget || !exactOperation || !exactStep) return step;

    const evidence = evidenceByStep.get(step.stepId);
    const verified = hasSucceededServerVerification(old);
    const requirementsUnchanged = evidence?.source === "server_verified_authenticated_user_correction"
      && evidence.taskId === input.task.id
      && evidence.baseRevision === input.previousTask.revision
      && evidence.correctionIndex === correctionIndex
      && evidence.correctionText === correctionText
      && evidence.targetFingerprint === workflowTargetFingerprint(nextTarget)
      && evidence.operationFingerprint === workflowOperationFingerprint(step)
      && /^[a-f0-9]{64}$/.test(evidence.previousRequirementsFingerprint)
      && evidence.previousRequirementsFingerprint === evidence.nextRequirementsFingerprint;
    if (verified && requirementsUnchanged) return {
      ...step,
      status: "completed" as const,
      requiresResultReverification: false,
      proposalIds: old.proposalIds,
      proposalJobs: old.proposalJobs,
      jobs: old.jobs,
      results: old.results,
      ...(old.attemptHistory ? { attemptHistory: old.attemptHistory } : {}),
    };

    const retained = retainedExecutionEvidence(old);
    return retained ? {
      ...step,
      status: "running" as const,
      requiresResultReverification: true,
      ...retained,
      ...(old.attemptHistory ? { attemptHistory: old.attemptHistory } : {}),
    } : step;
  });
  // A completed dependent cannot outlive a prerequisite that now requires
  // re-verification. Demote it while retaining its own successful artifact.
  let changed = true;
  while (changed) {
    changed = false;
    const completed = new Set(steps.filter(step => step.status === "completed").map(step => step.stepId));
    steps = steps.map(step => {
      if (step.status !== "completed" || step.dependsOn.every(id => completed.has(id))) return step;
      changed = true;
      const old = previousById.get(step.stepId);
      const retained = old ? retainedExecutionEvidence(old) : null;
      return retained ? { ...step, status: "running" as const, requiresResultReverification: true, ...retained }
        : { ...step, status: "planned" as const, requiresResultReverification: false,
          proposalIds: [], proposalJobs: {}, jobs: [], results: [] };
    });
  }
  steps = deriveStepReadiness(steps);
  const workflow = {
    ...clean,
    workflowRevision: previous.workflowRevision + 1,
    steps,
    status: deriveWorkflowStatus(steps),
    createdAt: previous.createdAt,
  };
  assertWorkflowSize(workflow);
  return agentWorkflowSnapshotSchema.parse(workflow);
}

/** A prepared task uses a provisional task id. Activation is the only point at
 * which that in-memory plan is rebound to durable identity; this never changes
 * targets, steps, results, or their execution authority. */
export function rebindWorkflowToActivatedTask(
  workflow: AgentWorkflowSnapshot,
  task: AgentTaskSnapshot,
  now = new Date().toISOString(),
): AgentWorkflowSnapshot {
  const parsed = agentWorkflowSnapshotSchema.parse(workflow);
  const rebound = {
    ...parsed,
    workflowRevision: 1,
    taskId: task.id,
    taskRevision: task.revision,
    runId: task.runId,
    updatedAt: now,
  };
  assertWorkflowSize(rebound);
  return agentWorkflowSnapshotSchema.parse(rebound);
}

export function selectNextWorkflowStep(
  workflow: AgentWorkflowSnapshot,
  preferredStepId?: string,
  authorizedTargets?: readonly DesignTaskTarget[],
  canonicalTarget?: DesignTaskTarget,
): AgentWorkflowStep | null {
  const parsed = agentWorkflowSnapshotSchema.parse(workflow);
  const currentlyAuthorized = (step: AgentWorkflowStep) => canonicalTarget === undefined
    ? true
    : isWorkflowTargetAuthorized(step.target, canonicalTarget, authorizedTargets);
  if (preferredStepId) {
    const preferred = parsed.steps.find((step) => step.stepId === preferredStepId);
    if (!preferred) throw new AgentWorkflowError("agent_workflow_step_missing");
    if (preferred.requiresTargetConfirmation || !currentlyAuthorized(preferred))
      throw new AgentWorkflowError("agent_workflow_target_not_authorized");
    if (preferred.status !== "ready")
      throw new AgentWorkflowError("agent_workflow_step_not_ready");
    return preferred;
  }
  return parsed.steps.find(
    (step) => step.status === "ready" && !step.requiresTargetConfirmation && currentlyAuthorized(step),
  ) ?? null;
}

export function applyTrustedWorkflowEvent(
  workflow: AgentWorkflowSnapshot,
  event: TrustedWorkflowEvent,
  now = new Date().toISOString(),
): AgentWorkflowSnapshot {
  const parsed = agentWorkflowSnapshotSchema.parse(workflow);
  const index = parsed.steps.findIndex((step) => step.stepId === event.stepId);
  if (index < 0) throw new AgentWorkflowError("agent_workflow_step_missing");
  const current = parsed.steps[index]!;
  if (current.requiresTargetConfirmation)
    throw new AgentWorkflowError("agent_workflow_target_not_authorized");
  let next: AgentWorkflowStep;
  if (event.type === "visual_repair_requested") {
    if (current.status !== "needs_attention" || current.jobs.length !== 1 || current.jobs[0] !== event.jobId ||
      (current.attemptHistory?.length ?? 0) >= 2 ||
      !current.results.some(result => result.kind === "execution" && result.jobId === event.jobId && result.outcome === "succeeded") ||
      !current.results.some(result => result.kind === "verification" && result.jobId === event.jobId && result.outcome === "failed"))
      throw new AgentWorkflowError("agent_workflow_repair_not_authorized");
    next = { ...current, status: "ready", proposalIds: [], proposalJobs: {}, jobs: [], results: [],
      attemptHistory: [...(current.attemptHistory ?? []), { proposalIds: current.proposalIds, jobs: current.jobs, results: current.results, recordedAt: now }] };
  } else if (event.type === "execution_started") {
    if (current.status !== "ready")
      throw new AgentWorkflowError("agent_workflow_step_not_ready");
    next = { ...current, status: "running" };
  } else if (event.type === "execution_finished") {
    const resultOwner = parsed.steps.find((step) => step.results.some(
      (result) => result.kind === "execution" && result.resultId === event.resultId,
    ));
    if (resultOwner && resultOwner.stepId !== current.stepId)
      throw new AgentWorkflowError("agent_workflow_result_conflict");
    const existingResult = current.results.find(
      (result) => result.kind === "execution" && result.jobId === undefined,
    );
    if (existingResult) {
      if (
        existingResult.resultId === event.resultId &&
        existingResult.outcome === event.outcome &&
        existingResult.verificationRequired === event.verificationRequired
      ) return parsed;
      throw new AgentWorkflowError("agent_workflow_event_conflict");
    }
    if (current.status !== "running" || current.jobs.length > 0)
      throw new AgentWorkflowError("agent_workflow_execution_untrusted");
    const results = [...current.results, {
      resultId: event.resultId,
      kind: "execution" as const,
      outcome: event.outcome,
      verificationRequired: event.verificationRequired,
      ...(event.summary ? { summary: event.summary.slice(0, 160) } : {}),
      recordedAt: now,
    }];
    next = {
      ...current,
      results,
      status: event.outcome === "failed"
        ? "needs_attention"
        : event.outcome === "canceled"
          ? "canceled"
          : event.verificationRequired ? "running" : "completed",
    };
  } else if (event.type === "proposal_created") {
    if (!["ready", "running"].includes(current.status))
      throw new AgentWorkflowError("agent_workflow_step_not_ready");
    const owner = parsed.steps.find((step) => step.proposalIds.includes(event.proposalId));
    if (owner && owner.stepId !== current.stepId)
      throw new AgentWorkflowError("agent_workflow_proposal_conflict");
    if (owner) return parsed;
    if (current.proposalIds.length >= 20)
      throw new AgentWorkflowError("agent_workflow_proposal_limit");
    next = {
      ...current,
      proposalIds: [...current.proposalIds, event.proposalId],
    };
  } else if (event.type === "job_submitted") {
    if (!["ready", "running", "waiting_job"].includes(current.status))
      throw new AgentWorkflowError("agent_workflow_step_not_running");
    if (event.proposalId && !current.proposalIds.includes(event.proposalId))
      throw new AgentWorkflowError("agent_workflow_proposal_untrusted");
    if (current.proposalIds.length > 0 && !event.proposalId)
      throw new AgentWorkflowError("agent_workflow_proposal_required");
    const owner = parsed.steps.find((step) => step.jobs.includes(event.jobId));
    if (owner && owner.stepId !== current.stepId)
      throw new AgentWorkflowError("agent_workflow_job_conflict");
    const mappedJob = event.proposalId
      ? current.proposalJobs[event.proposalId]
      : undefined;
    if (mappedJob && mappedJob !== event.jobId)
      throw new AgentWorkflowError("agent_workflow_proposal_conflict");
    const mappedProposal = Object.entries(current.proposalJobs).find(
      ([, jobId]) => jobId === event.jobId,
    )?.[0];
    if (mappedProposal && mappedProposal !== event.proposalId)
      throw new AgentWorkflowError("agent_workflow_job_conflict");
    if (current.jobs.includes(event.jobId)) {
      if (!event.proposalId || mappedJob === event.jobId) return parsed;
      throw new AgentWorkflowError("agent_workflow_event_conflict");
    }
    if (current.jobs.length >= 20)
      throw new AgentWorkflowError("agent_workflow_job_limit");
    next = {
      ...current,
      status: "waiting_job",
      proposalJobs: event.proposalId
        ? { ...current.proposalJobs, [event.proposalId]: event.jobId }
        : current.proposalJobs,
      jobs: [...new Set([...current.jobs, event.jobId])],
    };
  } else if (event.type === "job_finished") {
    const existingResult = current.results.find(
      (result) => result.kind === "execution" && result.jobId === event.jobId,
    );
    if (existingResult) {
      if (
        existingResult.resultId === event.resultId &&
        existingResult.outcome === event.outcome &&
        existingResult.verificationRequired === event.verificationRequired
      ) return parsed;
      throw new AgentWorkflowError("agent_workflow_event_conflict");
    }
    if (
      !["waiting_job", "needs_attention", "canceled"].includes(current.status) ||
      !current.jobs.includes(event.jobId)
    )
      throw new AgentWorkflowError("agent_workflow_job_untrusted");
    const results = [...current.results, {
      resultId: event.resultId,
      kind: "execution" as const,
      outcome: event.outcome,
      jobId: event.jobId,
      verificationRequired: event.verificationRequired,
      ...(event.summary ? { summary: event.summary.slice(0, 160) } : {}),
      recordedAt: now,
    }];
    const pendingJobs = current.jobs.some((jobId) => !results.some(
      (result) => result.kind === "execution" && result.jobId === jobId,
    ));
    const pendingProposals = current.proposalIds.some(
      (proposalId) => !current.proposalJobs[proposalId],
    );
    const executionResults = results.filter((result) => result.kind === "execution");
    const terminalStatus = results.some(
      (result) => result.kind === "verification" && result.outcome === "failed",
    ) || executionResults.some((result) => result.outcome === "failed")
      ? "needs_attention"
      : executionResults.some((result) => result.outcome === "canceled")
        ? "canceled"
        : executionResults.some((result) => result.verificationRequired)
          ? "running"
          : "completed";
    next = {
      ...current,
      results,
      status: terminalStatus === "needs_attention" || terminalStatus === "canceled"
        ? terminalStatus
        : pendingJobs || pendingProposals ? "waiting_job" : terminalStatus,
    };
  } else if (event.type === "verification_finished") {
    const nativeStep = current.jobs.length === 0;
    const existingVerification = current.results.find(
      (result) => result.kind === "verification" &&
        (nativeStep
          ? result.jobId === undefined
          : result.jobId === event.jobId),
    );
    if (existingVerification) {
      if (
        existingVerification.resultId === event.resultId &&
        existingVerification.outcome === event.outcome
      ) return parsed;
      throw new AgentWorkflowError("agent_workflow_event_conflict");
    }
    const execution = current.results.find(
      (result) => result.kind === "execution" &&
        result.jobId === event.jobId &&
        result.outcome === "succeeded" &&
        result.verificationRequired === true,
    );
    if (
      !["running", "waiting_job", "needs_attention", "canceled"].includes(current.status) ||
      (nativeStep ? !!event.jobId || !execution : !execution)
    )
      throw new AgentWorkflowError("agent_workflow_verification_untrusted");
    const results = [...current.results, {
        resultId: event.resultId,
        kind: "verification",
        outcome: event.outcome,
        ...(event.jobId ? { jobId: event.jobId } : {}),
        ...(event.summary ? { summary: event.summary.slice(0, 160) } : {}),
        recordedAt: now,
      } satisfies z.infer<typeof workflowResultSchema>];
    const executionResults = results.filter((result) => result.kind === "execution");
    const pendingJobs = current.jobs.some((jobId) => !executionResults.some(
      (result) => result.jobId === jobId,
    ));
    const pendingProposals = current.proposalIds.some(
      (proposalId) => !current.proposalJobs[proposalId],
    );
    const hasFailed = executionResults.some((result) => result.outcome === "failed") ||
      results.some((result) => result.kind === "verification" && result.outcome === "failed");
    const hasCanceled = executionResults.some((result) => result.outcome === "canceled");
    const allVerified = executionResults
      .filter((result) => result.outcome === "succeeded" && result.verificationRequired)
      .every((result) => results.some(
        (candidate) => candidate.kind === "verification" &&
          candidate.jobId === result.jobId &&
          candidate.outcome === "succeeded",
      ));
    next = {
      ...current,
      status: hasFailed
        ? "needs_attention"
        : hasCanceled
          ? "canceled"
          : pendingJobs || pendingProposals
            ? "waiting_job"
            : allVerified ? "completed" : "running",
      requiresResultReverification: false,
      results,
    };
  } else {
    if (current.status === "completed")
      throw new AgentWorkflowError("agent_workflow_completed_immutable");
    const outcome = event.type === "canceled" ? "canceled" : "failed";
    next = {
      ...current,
      status: event.type === "canceled" ? "canceled" : "needs_attention",
      results: [...current.results, {
        resultId: event.resultId,
        kind: "execution",
        outcome,
        ...(event.summary ? { summary: event.summary.slice(0, 160) } : {}),
        recordedAt: now,
      }],
    };
  }
  if (next.results.length > 40)
    throw new AgentWorkflowError("agent_workflow_result_limit");
  const steps = deriveStepReadiness(parsed.steps.map((step, stepIndex) =>
    stepIndex === index ? next : step));
  const updated = {
    ...parsed,
    workflowRevision: parsed.workflowRevision + 1,
    steps,
    status: deriveWorkflowStatus(steps),
    updatedAt: now,
  };
  assertWorkflowSize(updated);
  return agentWorkflowSnapshotSchema.parse(updated);
}

function readStoredWorkflow(snapshot: AgentTaskSnapshot): AgentWorkflowSnapshot | null {
  const raw = snapshot.brief?.[AGENT_WORKFLOW_BRIEF_KEY];
  if (raw === undefined) return null;
  const parsed = agentWorkflowSnapshotSchema.parse(raw);
  if (
    parsed.taskId !== snapshot.id ||
    parsed.taskRevision > snapshot.revision
  )
    throw new AgentWorkflowError("agent_workflow_revision_stale");
  return parsed;
}

export type AgentWorkflowPlanningPort = {
  recordPlan(plan: WorkflowPlanInput): Promise<AgentWorkflowSnapshot>;
  readPlan(): Promise<AgentWorkflowSnapshot | null>;
  selectNext(preferredStepId?: string): Promise<AgentWorkflowStep | null>;
};

export type AgentWorkflowController = AgentWorkflowPlanningPort & {
  recordTrustedEvent(event: TrustedWorkflowEvent): Promise<AgentWorkflowSnapshot>;
  refreshTargetAuthorization(): Promise<AgentWorkflowSnapshot | null>;
};

export function createAgentWorkflowController(input: {
  task: {
    snapshot: AgentTaskSnapshot;
    service: AgentTaskService;
    phase?: "prepared" | "active";
  };
  /** Must load server-validated canonical scope rows, never plan/model targets. */
  loadAuthorizedTargets?: (task: AgentTaskSnapshot) => Promise<readonly DesignTaskTarget[]>;
  now?: () => string;
}): AgentWorkflowController {
  let tail = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const current = async () => {
    const snapshot = await input.task.service.assertCurrentRun(
      input.task.snapshot.runId,
    );
    if (!snapshot) throw new AgentWorkflowError("agent_workflow_task_missing");
    if (
      snapshot.id !== input.task.snapshot.id ||
      snapshot.revision !== input.task.snapshot.revision ||
      snapshot.runId !== input.task.snapshot.runId
    )
      throw new AgentWorkflowError("agent_workflow_revision_stale");
    input.task.snapshot = snapshot;
    return snapshot;
  };
  const persist = async (
    snapshot: AgentTaskSnapshot,
    workflow: AgentWorkflowSnapshot,
    expectedWorkflowRevision: number | null,
  ) => {
    if (!input.task.service.updateWorkflow)
      throw new AgentWorkflowError("agent_workflow_persistence_unavailable");
    const updated = await input.task.service.updateWorkflow(
      snapshot.runId,
      snapshot.revision,
      expectedWorkflowRevision,
      workflow,
    );
    if (updated.id !== workflow.taskId || updated.revision !== workflow.taskRevision)
      throw new AgentWorkflowError("agent_workflow_revision_stale");
    input.task.snapshot = updated;
    return workflow;
  };
  const authority = async (snapshot: AgentTaskSnapshot) => input.loadAuthorizedTargets
    ? input.loadAuthorizedTargets(snapshot)
    : [snapshot.target];
  return {
    recordPlan(plan) {
      return serialize(async () => {
        const snapshot = await current();
        const previous = readStoredWorkflow(snapshot);
        const timestamp = input.now?.();
        const workflow = reconcileWorkflowPlan({
          task: snapshot,
          plan,
          previous,
          authorizedTargets: await authority(snapshot),
          ...(timestamp ? { now: timestamp } : {}),
        });
        return persist(snapshot, workflow, previous?.workflowRevision ?? null);
      });
    },
    async readPlan() {
      return readStoredWorkflow(await current());
    },
    refreshTargetAuthorization() {
      return serialize(async () => {
        const snapshot = await current();
        const workflow = readStoredWorkflow(snapshot);
        if (!workflow) return null;
        const authorizedTargets = await authority(snapshot);
        let changed = false;
        let steps = workflow.steps.map(step => {
          const requiresTargetConfirmation = !isWorkflowTargetAuthorized(
            step.target,
            snapshot.target,
            authorizedTargets,
          );
          if (requiresTargetConfirmation === step.requiresTargetConfirmation) return step;
          changed = true;
          return {
            ...step,
            requiresTargetConfirmation,
            status: requiresTargetConfirmation
              ? (["planned", "ready"].includes(step.status) ? "needs_attention" as const : step.status)
              : (step.status === "needs_attention" && step.requiresTargetConfirmation ? "planned" as const : step.status),
          };
        });
        if (!changed) return workflow;
        steps = deriveStepReadiness(steps);
        const updated = agentWorkflowSnapshotSchema.parse({
          ...workflow,
          workflowRevision: workflow.workflowRevision + 1,
          status: deriveWorkflowStatus(steps),
          steps,
          updatedAt: input.now?.() ?? new Date().toISOString(),
        });
        assertWorkflowSize(updated);
        return persist(snapshot, updated, workflow.workflowRevision);
      });
    },
    async selectNext(preferredStepId) {
      const snapshot = await current();
      const workflow = readStoredWorkflow(snapshot);
      if (!workflow) return null;
      return selectNextWorkflowStep(workflow, preferredStepId, await authority(snapshot), snapshot.target);
    },
    recordTrustedEvent(event) {
      return serialize(async () => {
        if (input.task.phase === "prepared")
          throw new AgentWorkflowError("agent_workflow_task_not_active");
        const snapshot = await current();
        const workflow = readStoredWorkflow(snapshot);
        if (!workflow || workflow.taskRevision !== snapshot.revision)
          throw new AgentWorkflowError("agent_workflow_revision_stale");
        const step = workflow.steps.find(item => item.stepId === event.stepId);
        if (!step || !isWorkflowTargetAuthorized(step.target, snapshot.target, await authority(snapshot)))
          throw new AgentWorkflowError("agent_workflow_target_not_authorized");
        const timestamp = input.now?.();
        const updated = applyTrustedWorkflowEvent(
          workflow,
          event,
          timestamp ?? new Date().toISOString(),
        );
        if (updated.workflowRevision === workflow.workflowRevision)
          return workflow;
        return persist(snapshot, updated, workflow.workflowRevision);
      });
    },
  };
}
