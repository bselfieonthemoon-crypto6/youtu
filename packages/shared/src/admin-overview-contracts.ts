import { z } from "zod";

import { timestampSchema, workspaceIdSchema, workspaceTypeSchema } from "./contracts.js";

/**
 * Read-only platform operations console.
 *
 * A platform admin needs to see the whole install at once: which workspaces
 * exist, who is in them, what they have spent, which jobs died and why, and
 * whether the channels behind them are healthy. Every field here is a bounded
 * snapshot or an explicit "recent"/"top" list — no endpoint returns an unbounded
 * table dump, and nothing in this contract is writable.
 *
 * Authorization is separate from shape: the server checks `platform_admins`
 * before it builds any of this, and the UI only decides whether to show the tab.
 */

export const adminAccessResponseSchema = z.object({
  platformAdmin: z.boolean(),
});

const adminWorkspaceViewSchema = z.object({
  id: workspaceIdSchema,
  name: z.string().min(1),
  type: workspaceTypeSchema,
  createdAt: timestampSchema,
  memberCount: z.number().int().nonnegative(),
  balance: z.number().int(),
  plan: z.string().min(1),
});

const adminJobFailureViewSchema = z.object({
  id: z.string().min(1),
  workspaceId: workspaceIdSchema,
  workspaceName: z.string().min(1),
  jobType: z.string().min(1),
  status: z.string().min(1),
  errorCode: z.string().nullable(),
  /** Truncated raw provider text. Internal diagnostics only, never customer copy. */
  errorMessage: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
});

const adminProviderViewSchema = z.object({
  id: z.string().min(1),
  workspaceId: workspaceIdSchema,
  workspaceName: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean(),
  modelCount: z.number().int().nonnegative(),
  lastTestStatus: z.string().min(1),
  lastTestErrorCode: z.string().nullable(),
  updatedAt: timestampSchema,
});

const adminTransactionViewSchema = z.object({
  id: z.string().min(1),
  workspaceId: workspaceIdSchema,
  workspaceName: z.string().min(1),
  transactionType: z.string().min(1),
  amount: z.number().int(),
  balanceAfter: z.number().int(),
  jobId: z.string().nullable(),
  createdAt: timestampSchema,
});

export const adminOverviewResponseSchema = z.object({
  generatedAt: timestampSchema,
  workspaces: z.object({
    total: z.number().int().nonnegative(),
    byType: z.record(z.string(), z.number().int().nonnegative()),
    items: z.array(adminWorkspaceViewSchema),
  }),
  jobs: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    byStatus: z.record(z.string(), z.number().int().nonnegative()),
    byType: z.record(z.string(), z.number().int().nonnegative()),
    recentFailures: z.array(adminJobFailureViewSchema),
  }),
  credits: z.object({
    totalBalance: z.number().int(),
    byPlan: z.record(z.string(), z.number().int().nonnegative()),
    deductionsLast30d: z.number().int().nonnegative(),
    refundsLast30d: z.number().int().nonnegative(),
    recentTransactions: z.array(adminTransactionViewSchema),
    /**
     * True when a paginated scan hit its safety cap, so a total that needs every
     * row (the balance sum, the plan histogram) may be incomplete. Reported
     * instead of silently returning a wrong number.
     */
    truncated: z.boolean(),
  }),
  providers: z.object({
    configCount: z.number().int().nonnegative(),
    disabledConfigCount: z.number().int().nonnegative(),
    failingTestCount: z.number().int().nonnegative(),
    modelCount: z.number().int().nonnegative(),
    disabledModelCount: z.number().int().nonnegative(),
    modelsByModality: z.record(z.string(), z.number().int().nonnegative()),
    items: z.array(adminProviderViewSchema),
    truncated: z.boolean(),
  }),
  skills: z.object({
    total: z.number().int().nonnegative(),
    byCategory: z.record(z.string(), z.number().int().nonnegative()),
    installs: z.number().int().nonnegative(),
    enabledInstalls: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
});

export const adminOverviewErrorCodeSchema = z.enum([
  "platform_admin_required",
  "admin_overview_failed",
  "admin_invalid_request",
]);

export const adminOverviewErrorResponseSchema = z.object({
  error: z.object({
    code: adminOverviewErrorCodeSchema,
    message: z.string().min(1),
  }),
});

export type AdminAccessResponse = z.infer<typeof adminAccessResponseSchema>;
export type AdminOverviewResponse = z.infer<typeof adminOverviewResponseSchema>;
export type AdminOverviewWorkspace = z.infer<typeof adminWorkspaceViewSchema>;
export type AdminOverviewJobFailure = z.infer<typeof adminJobFailureViewSchema>;
export type AdminOverviewProvider = z.infer<typeof adminProviderViewSchema>;
export type AdminOverviewTransaction = z.infer<typeof adminTransactionViewSchema>;
export type AdminOverviewErrorCode = z.infer<typeof adminOverviewErrorCodeSchema>;
