import { z } from "zod";

import { timestampSchema, userIdSchema, workspaceIdSchema } from "./contracts.js";

/**
 * Platform-admin channel health: cross-workspace provider configuration, the
 * self-test history that goes with it, and failure rates by error code.
 *
 * Everything here is read-only on purpose. A platform admin can look at any
 * workspace's channel, but cannot edit it: silently repointing another tenant's
 * traffic is a bigger decision than a console tab.
 *
 * Two rates are reported because they answer different questions. The provider
 * rate counts only jobs that reached a channel ("how often does a channel let us
 * down"); the overall rate counts every job in the window ("how much of what we
 * ran failed at all"). Reporting only the first would hide failure classes that
 * never touch a channel; reporting only the second would blame channels for them.
 */

export const adminChannelTestStatusSchema = z.enum(["never", "succeeded", "failed"]);
export const ADMIN_CHANNEL_TEST_STATUS_FILTERS = ["never", "succeeded", "failed"] as const;

/** A rate the database can legitimately be unable to compute (no jobs in window). */
const nullableRateSchema = z.number().min(0).nullable();

export const adminChannelErrorCountSchema = z.object({
  errorCode: z.string().min(1),
  count: z.number().int().positive(),
  lastSeenAt: timestampSchema.nullable(),
});

export const adminChannelViewSchema = z.object({
  id: z.string().min(1),
  workspaceId: workspaceIdSchema,
  workspaceName: z.string().nullable(),
  displayName: z.string().min(1),
  adapter: z.string().min(1),
  baseUrl: z.string(),
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  /** Only the last four characters ever leave the database. */
  apiKeyLastFour: z.string().nullable(),
  modelCount: z.number().int().nonnegative(),
  enabledModelCount: z.number().int().nonnegative(),
  modalities: z.array(z.string()),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastTestedAt: timestampSchema.nullable(),
  lastTestStatus: adminChannelTestStatusSchema,
  lastTestErrorCode: z.string().nullable(),
  windowDays: z.number().int().positive(),
  jobs: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  failureRate: nullableRateSchema,
  lastFailureAt: timestampSchema.nullable(),
  /** The five codes that cost this channel the most jobs in the window. */
  topErrorCodes: z.array(adminChannelErrorCountSchema),
});

export const adminChannelListResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  windowDays: z.number().int().positive(),
  totalJobs: z.number().int().nonnegative(),
  totalFailures: z.number().int().nonnegative(),
  channels: z.array(adminChannelViewSchema),
});

export const adminChannelHistoryEntrySchema = z.object({
  action: z.string().min(1),
  actorUserId: userIdSchema.nullable(),
  actorEmail: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: timestampSchema,
});

export const adminChannelDetailResponseSchema = z.object({
  channel: adminChannelViewSchema.omit({ topErrorCodes: true }).extend({
    createdByEmail: z.string().nullable(),
    updatedByEmail: z.string().nullable(),
  }),
  history: z.array(adminChannelHistoryEntrySchema),
  errorCodes: z.array(z.object({
    errorCode: z.string().min(1),
    failures: z.number().int().positive(),
    failed: z.number().int().nonnegative(),
    deadLetter: z.number().int().nonnegative(),
    lastSeenAt: timestampSchema.nullable(),
  })),
  /** Newest failures, deliberately not limited to the reporting window. */
  failures: z.array(z.object({
    jobId: z.string().min(1),
    jobType: z.string().min(1),
    status: z.string().min(1),
    errorCode: z.string().nullable(),
    createdAt: timestampSchema,
    finishedAt: timestampSchema.nullable(),
  })),
});

export const adminChannelFailureRateRowSchema = z.object({
  errorCode: z.string().min(1),
  failures: z.number().int().positive(),
  failed: z.number().int().nonnegative(),
  deadLetter: z.number().int().nonnegative(),
  /** This code's share of every failure in the window, attributed or not. */
  share: nullableRateSchema,
  /** How many channels this code touched; 0 means it never reached one. */
  channelCount: z.number().int().nonnegative(),
  lastSeenAt: timestampSchema.nullable(),
});

export const adminChannelFailureRatesResponseSchema = z.object({
  windowDays: z.number().int().positive(),
  totalJobs: z.number().int().nonnegative(),
  totalFailures: z.number().int().nonnegative(),
  overallFailureRate: nullableRateSchema,
  providerJobs: z.number().int().nonnegative(),
  providerFailures: z.number().int().nonnegative(),
  providerFailureRate: nullableRateSchema,
  channelCount: z.number().int().nonnegative(),
  errorCodes: z.array(adminChannelFailureRateRowSchema),
});

export type AdminChannelTestStatus = z.infer<typeof adminChannelTestStatusSchema>;
export type AdminChannelView = z.infer<typeof adminChannelViewSchema>;
export type AdminChannelListResponse = z.infer<typeof adminChannelListResponseSchema>;
export type AdminChannelDetailResponse = z.infer<typeof adminChannelDetailResponseSchema>;
export type AdminChannelFailureRatesResponse = z.infer<typeof adminChannelFailureRatesResponseSchema>;
