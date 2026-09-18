import { planUpdatedEventSchema, type PlanStep, type PlanStepStatus, type StreamEvent } from "@loomic/shared";
import { z } from "zod";

import { createAgentTool } from "./tool-run-context.js";

/**
 * `write_todos` records the model's plan for the current turn.
 *
 * The retired Deep Agents runtime produced the `plan.updated` stream event from
 * this tool. The Mastra migration kept the whole consumer pipeline — the server
 * accumulates a `plan` content block, the web replaces the matching plan in
 * place by `revision`, and the plan card renders it — but lost the producer, so
 * the feature was unreachable. This module is the producer: the tool validates
 * and returns the canonical full snapshot, and `mastra-agent.ts` turns exactly
 * one *successful* call into exactly one validated `plan.updated` event.
 *
 * Nothing here mints a new event variant: the wire contract stays
 * `planUpdatedEventSchema` from `@loomic/shared`.
 */
export const WRITE_TODOS_TOOL_ID = "write_todos";

/** The inline plan card stays readable at this size; the model must not flood it. */
export const MAX_PLAN_STEPS = 20;
export const MAX_PLAN_STEP_ID_LENGTH = 64;
export const MAX_PLAN_STEP_TITLE_LENGTH = 200;

/**
 * Per-run bookkeeping on the runtime's mutable `configurable` record (the same
 * object `mastra-runtime.ts` builds once per run and passes to every tool).
 * Plan identity therefore never lives in toolkit or module scope, where a
 * rebuilt catalog or a second run could reset or leak it.
 */
export const SESSION_PLAN_ID_KEY = "session_plan_id";
export const SESSION_PLAN_REVISION_KEY = "session_plan_revision";
/**
 * The last full snapshot this run recorded. `mastra-runtime.ts` reads it after
 * the stream: steps still `pending`/`in_progress` are the unfinished work a
 * cancellation left behind, which is invisible to the next turn because the
 * model never sees previous tool results. Display/progress state only.
 */
export const SESSION_PLAN_STEPS_KEY = "session_plan_steps";

/** One `plan.updated` as it travels on the wire. */
export type PlanUpdatedEvent = Extract<StreamEvent, { type: "plan.updated" }>;

/**
 * The legacy Deep Agents convention, kept so existing transcripts and fixtures
 * (`plan_run_123`) keep their meaning: one plan identity per run.
 */
export function planIdForRun(runId: string): string {
  return `plan_${runId}`;
}

/**
 * The next revision for this run. `planUpdatedEventSchema` requires a positive
 * integer, so a run that has not recorded a plan yet starts at 1.
 */
export function nextPlanRevision(configurable: Record<string, unknown>): number {
  const current = configurable[SESSION_PLAN_REVISION_KEY];
  return typeof current === "number" && Number.isInteger(current) && current >= 1 ? current + 1 : 1;
}

/**
 * Statuses declared locally (not imported from the shared schema) because the
 * server's tool schemas use its own Zod major version; `satisfies` proves every
 * value is one the shared `planStepStatusSchema` accepts, and
 * `plan-todos.test.ts` checks each one round-trips through
 * `planUpdatedEventSchema`.
 */
const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed", "failed"] as const satisfies readonly PlanStepStatus[];

const planStepStatusInputSchema = z.enum(PLAN_STEP_STATUSES);

const writeTodosStepInputSchema = z.object({
  id: z.string().trim().min(1).max(MAX_PLAN_STEP_ID_LENGTH),
  title: z.string().trim().min(1).max(MAX_PLAN_STEP_TITLE_LENGTH),
  status: planStepStatusInputSchema,
}).strict();

/**
 * The complete ordered snapshot the model wants recorded. Bounds: 1..20 steps,
 * unique ids, bounded id/title length, and no undeclared fields. An empty list
 * is a schema violation rather than a "cleared plan", so it can never replace a
 * recorded plan with nothing.
 */
export const writeTodosInputSchema = z.object({
  steps: z.array(writeTodosStepInputSchema).min(1).max(MAX_PLAN_STEPS)
    .refine(steps => new Set(steps.map(step => step.id)).size === steps.length,
      "Plan step ids must be unique within one snapshot."),
}).strict();

export type WriteTodosInput = z.infer<typeof writeTodosInputSchema>;

/** The receipt shape a successful `write_todos` call returns to the runtime. */
const writeTodosReceiptSchema = z.object({
  steps: z.array(writeTodosStepInputSchema).min(1).max(MAX_PLAN_STEPS),
});

/**
 * Canonical full snapshot from a completed `write_todos` receipt, or `undefined`
 * when the value carries no usable snapshot (for example a rejected call's
 * `{ error }` payload). The runtime still applies its own `toolResultIsError`
 * check; this only refuses to invent a plan from a payload that has none.
 */
export function planStepsFromWriteTodosResult(result: unknown): PlanStep[] | undefined {
  let candidate = result;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  const parsed = writeTodosReceiptSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  return parsed.data.steps.map(step => ({ id: step.id, title: step.title, status: step.status }));
}

/**
 * Turn ONE successful `write_todos` receipt into ONE `plan.updated` carrying the
 * full snapshot, and commit the run's plan identity/revision.
 *
 * Returns `undefined` — and streams nothing — when the snapshot cannot be
 * validated against the shared contract. The revision is committed only for an
 * event that is actually published, so a dropped snapshot never consumes a
 * revision.
 */
export function recordPlanSnapshot(input: {
  configurable: Record<string, unknown>;
  runId: string;
  result: unknown;
  now?: () => string;
}): PlanUpdatedEvent | undefined {
  const steps = planStepsFromWriteTodosResult(input.result);
  if (!steps) {
    console.warn("[mastra-plan] ignored a write_todos receipt with no usable snapshot", {
      runId: input.runId,
      reasonCode: "plan_snapshot_missing",
    });
    return undefined;
  }
  const planId = planIdForRun(input.runId);
  const revision = nextPlanRevision(input.configurable);
  const parsed = planUpdatedEventSchema.safeParse({
    type: "plan.updated",
    runId: input.runId,
    planId,
    revision,
    timestamp: (input.now ?? (() => new Date().toISOString()))(),
    steps,
  });
  if (!parsed.success) {
    // A malformed snapshot must never reach the client: keep it server-side.
    // Only issue paths and codes are logged, never the recorded step titles.
    console.warn("[mastra-plan] dropped an invalid plan.updated snapshot", {
      runId: input.runId,
      planId,
      revision,
      stepCount: steps.length,
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join("."), code: issue.code })),
    });
    return undefined;
  }
  input.configurable[SESSION_PLAN_ID_KEY] = planId;
  input.configurable[SESSION_PLAN_REVISION_KEY] = revision;
  // A snapshot replaces the previous one wholesale, so the last recorded
  // snapshot IS the run's current plan — the runtime reads its open steps at
  // run end. Recording them grants nothing: this tool only displays a plan.
  input.configurable[SESSION_PLAN_STEPS_KEY] = steps;
  return parsed.data;
}

/**
 * Record the user-visible plan. This tool only registers what the model intends
 * to do so the transcript can show it; the server turns the successful receipt
 * into a single `plan.updated` event.
 */
export function createWriteTodosTool() {
  return createAgentTool({
    id: WRITE_TODOS_TOOL_ID,
    description: "Record or revise the complete multi-step plan for the user's current request so the product UI can show it as a plan card. Send the whole ordered snapshot every time — 1 to 20 steps, each with a stable id, a short concrete title, and one status from pending, in_progress, completed or failed — never a partial delta or a diff of steps; each successful call replaces the previous plan in place, so re-send unchanged steps too. Use it when the request genuinely has several ordered steps, not for a single action and not to narrate reasoning. Recording a plan only displays it: it executes nothing and grants no execution, approval, billing, model, source, target or design-write authority, and a recorded step is never evidence that any work ran or that anything was charged.",
    inputSchema: writeTodosInputSchema,
    execute: async ({ steps }) => ({
      status: "recorded" as const,
      stepCount: steps.length,
      steps: steps.map(step => ({ id: step.id, title: step.title, status: step.status })),
      summary: `已记录 ${steps.length} 步计划快照（仅登记展示，未执行任何步骤）。`,
    }),
  });
}
