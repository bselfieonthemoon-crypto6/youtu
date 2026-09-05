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
  billingErrorEventSchema,
]);

export type StreamEvent = z.infer<typeof streamEventSchema>;
