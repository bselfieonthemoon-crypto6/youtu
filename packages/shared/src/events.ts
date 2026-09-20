import { z } from "zod";

import { toolArtifactSchema } from "./artifacts.js";
import {
  conversationIdSchema,
  messageIdSchema,
  planStepSchema,
  runIdSchema,
  sessionIdSchema,
  timestampSchema,
  toolCallIdSchema,
} from "./contracts.js";
import { loomicErrorSchema } from "./errors.js";

export { imageArtifactSchema, videoArtifactSchema, placementSchema, toolArtifactSchema } from "./artifacts.js";
export type { ImageArtifact, VideoArtifact, Placement, ToolArtifact } from "./artifacts.js";

export const runStartedEventSchema = z.object({
  type: z.literal("run.started"),
  runId: runIdSchema,
  sessionId: sessionIdSchema,
  conversationId: conversationIdSchema,
  timestamp: timestampSchema,
});

export const messageDeltaEventSchema = z.object({
  type: z.literal("message.delta"),
  runId: runIdSchema,
  messageId: messageIdSchema,
  delta: z.string(),
  timestamp: timestampSchema,
});

const toolPlanLinkFields = {
  planId: z.string().min(1).optional(),
  planStepId: z.string().min(1).optional(),
};

function hasPairedPlanLink(value: {
  planId?: string | undefined;
  planStepId?: string | undefined;
}) {
  return (value.planId === undefined) === (value.planStepId === undefined);
}

export const toolStartedEventSchema = z.object({
  type: z.literal("tool.started"),
  runId: runIdSchema,
  toolExecutionId: z.string().uuid().optional(),
  toolCallId: toolCallIdSchema,
  toolName: z.string().min(1),
  input: z.record(z.unknown()).optional(),
  retryable: z.boolean().optional(),
  ...toolPlanLinkFields,
  timestamp: timestampSchema,
}).refine(hasPairedPlanLink, {
  message: "planId and planStepId must appear together",
});

export const toolCompletedEventSchema = z.object({
  type: z.literal("tool.completed"),
  runId: runIdSchema,
  toolExecutionId: z.string().uuid().optional(),
  toolCallId: toolCallIdSchema,
  toolName: z.string().min(1),
  output: z.record(z.unknown()).optional(),
  outputSummary: z.string().optional(),
  artifacts: z.array(toolArtifactSchema).optional(),
  ...toolPlanLinkFields,
  timestamp: timestampSchema,
}).refine(hasPairedPlanLink, {
  message: "planId and planStepId must appear together",
});

export const runCompletedEventSchema = z.object({
  type: z.literal("run.completed"),
  runId: runIdSchema,
  timestamp: timestampSchema,
});

export const runCanceledEventSchema = z.object({
  type: z.literal("run.canceled"),
  runId: runIdSchema,
  timestamp: timestampSchema,
});

export const runFailedEventSchema = z.object({
  type: z.literal("run.failed"),
  runId: runIdSchema,
  error: loomicErrorSchema,
  timestamp: timestampSchema,
});

export const thinkingDeltaEventSchema = z.object({
  type: z.literal("thinking.delta"),
  runId: runIdSchema,
  messageId: messageIdSchema,
  delta: z.string(),
  timestamp: timestampSchema,
});

export const planUpdatedEventSchema = z.object({
  type: z.literal("plan.updated"),
  runId: runIdSchema,
  planId: z.string().min(1),
  revision: z.number().int().positive(),
  timestamp: timestampSchema,
  steps: z.array(planStepSchema),
});

export const toolFailedEventSchema = z.object({
  type: z.literal("tool.failed"),
  runId: runIdSchema,
  toolExecutionId: z.string().uuid().optional(),
  toolCallId: toolCallIdSchema,
  toolName: z.string().min(1),
  error: loomicErrorSchema,
  ...toolPlanLinkFields,
  timestamp: timestampSchema,
}).refine(hasPairedPlanLink, {
  message: "planId and planStepId must appear together",
});

export const canvasSyncEventSchema = z.object({
  type: z.literal("canvas.sync"),
  runId: runIdSchema,
  timestamp: timestampSchema,
});

// ---------------------------------------------------------------------------
// Turn routing notice
// ---------------------------------------------------------------------------

/**
 * The four turn labels the runtime routes on. Declared here (not in the server)
 * because the label now travels over the wire: it is shared protocol vocabulary
 * between the runtime that decides it and the notice that displays it.
 */
export const designTurnIntentSchema = z.enum([
  "new_generation",
  "series_continuation",
  "local_edit",
  "non_design",
]);

export type DesignTurnIntent = z.infer<typeof designTurnIntentSchema>;

/**
 * Machine-readable reason behind a turn label. It is deliberately a small,
 * closed vocabulary so it can be logged, counted and rendered without parsing
 * prose. It describes method selection ONLY: it is never execution, billing,
 * image-ratio or image-source authority.
 */
export const designTurnReasonCodeSchema = z.enum([
  "explicit_creation",
  "deliverable_brief",
  "series_continuation",
  "property_edit",
  "declined_or_hedged",
  "informational_question",
  "unclear",
]);

export type DesignTurnReasonCode = z.infer<typeof designTurnReasonCodeSchema>;

/**
 * One non-blocking notice per turn describing the routing decision the runtime
 * already made (selected Skill, preloaded helper guides, non-standard-size
 * enable). It carries no authority and does not require acknowledgement.
 *
 * Why a dedicated variant instead of the previously unused `plan.updated`:
 * `plan.updated` is a durable multi-step task plan (`planId` + `revision` +
 * `planStepSchema[]`) which the web maps to an inline `plan` content block in
 * the transcript. Reusing it would either paint a bogus plan card above the
 * answer or force the plan schema to carry Skill slugs, destroying both
 * meanings. A separate variant keeps the plan contract intact and lets the
 * client treat this as transient UI that is never persisted as message content.
 */
export const designRoutingEventSchema = z.object({
  type: z.literal("design.routing"),
  runId: runIdSchema,
  timestamp: timestampSchema,
  intent: designTurnIntentSchema,
  reasonCode: designTurnReasonCodeSchema,
  /** How the verdict was reached: deterministic rule, model refinement, or fallback. */
  source: z.enum(["deterministic", "model", "fallback"]),
  /** True when a server safety rule overrode a model verdict. */
  clamped: z.boolean(),
  confidence: z.number().min(0).max(1),
  // Display-ready Chinese copy authored by the server so the client never
  // re-derives product wording from a machine code.
  summary: z.string().min(1).max(240),
  detail: z.string().min(1).max(240).optional(),
  // Structured form of the same decision, for logs and future UI surfaces.
  primarySkill: z.string().min(1).optional(),
  helperSkills: z.array(z.string().min(1)).min(1).max(4).optional(),
  nonstandardSizeSkill: z.string().min(1).optional(),
});

export type DesignRoutingEvent = z.infer<typeof designRoutingEventSchema>;

// ---------------------------------------------------------------------------
// Turn record (what was DETECTED vs what was EXECUTED)
// ---------------------------------------------------------------------------

/**
 * The turn record, emitted once per run AFTER the run's assistant message was
 * persisted — the only server seam where both layers are on hand at the same
 * time:
 *
 *   - DETECTED: the `design.routing` verdict the router published for this turn
 *     before the first token (intent / reasonCode / source / confidence);
 *   - EXECUTED: the run's ACTUAL behaviour, derived from its own tool receipts
 *     (`generate_image`/`edit_image` with a real `jobId`, `ask_clarification`,
 *     canvas writes, declared Skills read) and never from the intent.
 *
 * It exists because those two layers disagree, and the disagreement used to be
 * invisible: the router said `new_generation`, the model only asked a clarifying
 * question, and the transcript showed a routing notice plus a question with
 * nothing tying them together. This event is the tie.
 *
 * The copy is authored by the server next to the receipts it describes, so the
 * client never re-derives product wording from a machine code — the same
 * discipline `design.routing` follows. Its `summary`/`detail` are rendered only
 * in the existing advanced mode (`localStorage "loomic:routing-detail"`), which
 * is why nothing here is safe to show a normal user as-is.
 */
export const designTurnEventSchema = z.object({
  type: z.literal("design.turn"),
  runId: runIdSchema,
  timestamp: timestampSchema,
  /** One-line conclusion: 用户意图 (detected) + what the run actually did. */
  summary: z.string().min(1).max(400),
  /** Advanced-mode only: judgement basis, execution code, per-field unknowns. */
  detail: z.string().min(1).max(400).optional(),
});

export type DesignTurnEvent = z.infer<typeof designTurnEventSchema>;

export const billingErrorCodeSchema = z.enum([
  "insufficient_credits",
  "model_not_accessible",
  "resolution_not_allowed",
  "concurrency_limit",
]);

export type BillingErrorCode = z.infer<typeof billingErrorCodeSchema>;

export const billingErrorEventSchema = z.object({
  type: z.literal("billing.error"),
  runId: runIdSchema,
  timestamp: timestampSchema,
  code: billingErrorCodeSchema,
  message: z.string(),
  // Credits-specific (only for insufficient_credits)
  currentBalance: z.number().optional(),
  requiredAmount: z.number().optional(),
  plan: z.string().optional(),
  dailyClaimed: z.boolean().optional(),
});

export const streamEventSchema = z.union([
  runStartedEventSchema,
  messageDeltaEventSchema,
  thinkingDeltaEventSchema,
  planUpdatedEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
  toolFailedEventSchema,
  runCanceledEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  canvasSyncEventSchema,
  designRoutingEventSchema,
  designTurnEventSchema,
  billingErrorEventSchema,
]);

export type StreamEvent = z.infer<typeof streamEventSchema>;
