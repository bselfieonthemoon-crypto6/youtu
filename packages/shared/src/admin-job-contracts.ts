import { z } from "zod";

import { timestampSchema, userIdSchema, workspaceIdSchema } from "./contracts.js";

/**
 * Platform-admin job inspection and disposition.
 *
 * `acknowledged*` is derived from the audit trail (the newest
 * `job.failure.acknowledge` row for the job), so the list and the history cannot
 * disagree. `stuck` is computed from the job's own age against thresholds, which
 * is what makes "queued since last night" visible without a separate health feed.
 */

export const adminJobRowSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  jobType: z.string().min(1),
  queueName: z.string().min(1),
  workspaceId: workspaceIdSchema.nullable(),
  workspaceName: z.string().nullable(),
  createdBy: userIdSchema.nullable(),
  createdByEmail: z.string().nullable(),
  title: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  creditsCost: z.number().int().nullable(),
  stuck: z.boolean(),
  ageSeconds: z.number().int().nonnegative(),
  acknowledgedAt: timestampSchema.nullable(),
  acknowledgedByEmail: z.string().nullable(),
  acknowledgeReason: z.string().nullable(),
});

export const adminJobListResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  jobs: z.array(adminJobRowSchema),
});

const adminJobDetailRowSchema = adminJobRowSchema.omit({ stuck: true, ageSeconds: true, title: true, model: true })
  .extend({
    sessionId: z.string().nullable(),
    sessionTitle: z.string().nullable(),
    canvasId: z.string().nullable(),
    failedAt: timestampSchema.nullable(),
    canceledAt: timestampSchema.nullable(),
    creditsTransactionId: z.string().nullable(),
    /** Bounded JSON text: enough to read the request, never the whole payload. */
    payloadPreview: z.string().nullable(),
    resultPreview: z.string().nullable(),
  });

export const adminJobDetailResponseSchema = z.object({
  job: adminJobDetailRowSchema,
  transactions: z.array(z.object({
    id: z.string().min(1),
    transactionType: z.string().min(1),
    amount: z.number().int(),
    balanceAfter: z.number().int(),
    description: z.string().nullable(),
    createdAt: timestampSchema,
  })),
  audit: z.array(z.object({
    action: z.string().min(1),
    reason: z.string().nullable(),
    actorEmail: z.string().nullable(),
    actorUserId: userIdSchema.nullable(),
    createdAt: timestampSchema,
  })),
});

export const adminJobActionRequestSchema = z.object({
  reason: z.string().trim().min(2).max(500),
}).strict();

export const adminJobCancelResponseSchema = z.object({
  jobId: z.string().min(1),
  status: z.literal("canceled"),
  statusBefore: z.string().min(1),
});

export const adminJobAcknowledgeResponseSchema = z.object({
  jobId: z.string().min(1),
  acknowledged: z.literal(true),
});

export type AdminJobRow = z.infer<typeof adminJobRowSchema>;
export type AdminJobListResponse = z.infer<typeof adminJobListResponseSchema>;
export type AdminJobDetailResponse = z.infer<typeof adminJobDetailResponseSchema>;
export type AdminJobActionRequest = z.infer<typeof adminJobActionRequestSchema>;

/** Statuses the console offers as filters, in workflow order. */
export const ADMIN_JOB_STATUS_FILTERS = ["queued", "running", "succeeded", "failed", "canceled", "dead_letter"] as const;
export const ADMIN_JOB_TYPE_FILTERS = [
  "image_generation", "video_generation", "code_execution", "design_preview", "design_export", "design_resource_import",
] as const;
