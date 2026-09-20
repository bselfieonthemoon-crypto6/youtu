import { z } from "zod";

import { timestampSchema, workspaceIdSchema, workspaceTypeSchema } from "./contracts.js";
import { billingPeriodSchema, subscriptionPlanSchema } from "./credits.js";

/**
 * Platform-admin plan and credit management, with the per-workspace
 * reconciliation the console shows beside it.
 *
 * These are the only billing writes in the product outside the generation
 * pipeline: they move a workspace's plan and balance through the same ledger the
 * billing code reads, require a reason, and write the audit row in the same
 * transaction. Nothing here changes how a generation is priced or charged.
 */

export const adminBillingTransactionSchema = z.object({
  id: z.string().min(1),
  transactionType: z.string().min(1),
  amount: z.number().int(),
  balanceAfter: z.number().int(),
  jobId: z.string().nullable(),
  description: z.string().nullable(),
  /** Who caused the entry: a member for generation rows, an admin for adjustments. */
  actorEmail: z.string().nullable(),
  createdAt: timestampSchema,
});

export const adminBillingMismatchSchema = z.object({
  jobId: z.string().min(1),
  status: z.string().min(1),
  jobType: z.string().min(1),
  recordedCreditsCost: z.number().int(),
  ledgerCharged: z.number().int(),
  ledgerRefunded: z.number().int(),
  createdAt: timestampSchema,
});

export const adminWorkspaceBillingResponseSchema = z.object({
  workspace: z.object({
    id: workspaceIdSchema,
    name: z.string().min(1),
    type: workspaceTypeSchema,
    createdAt: timestampSchema,
  }),
  plan: subscriptionPlanSchema,
  balance: z.number().int(),
  subscription: z.object({
    billingPeriod: billingPeriodSchema.nullable(),
    currentPeriodStart: timestampSchema.nullable(),
    currentPeriodEnd: timestampSchema.nullable(),
    canceledAt: timestampSchema.nullable(),
    /** True when an external provider manages this subscription. */
    hasExternalSubscription: z.boolean(),
  }),
  last30d: z.object({
    deductedCredits: z.number().int().nonnegative(),
    refundedCredits: z.number().int().nonnegative(),
  }),
  recentTransactions: z.array(adminBillingTransactionSchema),
  /** Jobs whose recorded cost disagrees with what the ledger charged. */
  mismatchedJobs: z.array(adminBillingMismatchSchema),
});

const reasonSchema = z.string().trim().min(2).max(500);

export const adminSetWorkspacePlanRequestSchema = z.object({
  plan: subscriptionPlanSchema,
  grantCredits: z.number().int().min(0).max(1_000_000).default(0),
  reason: reasonSchema,
}).strict();

export const adminAdjustCreditsRequestSchema = z.object({
  delta: z.number().int().min(-1_000_000).max(1_000_000).refine(value => value !== 0, "delta must not be zero"),
  reason: reasonSchema,
}).strict();

export const adminPlanChangeResponseSchema = z.object({
  plan: subscriptionPlanSchema,
  planBefore: subscriptionPlanSchema.nullable(),
  grantedCredits: z.number().int().nonnegative(),
  balance: z.number().int(),
});

export const adminCreditAdjustmentResponseSchema = z.object({
  delta: z.number().int(),
  balance: z.number().int(),
});

export type AdminBillingTransaction = z.infer<typeof adminBillingTransactionSchema>;
export type AdminBillingMismatch = z.infer<typeof adminBillingMismatchSchema>;
export type AdminWorkspaceBillingResponse = z.infer<typeof adminWorkspaceBillingResponseSchema>;
export type AdminSetWorkspacePlanRequest = z.infer<typeof adminSetWorkspacePlanRequestSchema>;
export type AdminAdjustCreditsRequest = z.infer<typeof adminAdjustCreditsRequestSchema>;
