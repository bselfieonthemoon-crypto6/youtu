import { z } from "zod";

import { timestampSchema, workspaceIdSchema } from "./contracts.js";

/**
 * Platform-admin storage health: occupancy, orphan inventory and the deletion queue.
 *
 * The important shape here is `confirmedOrphan`. Whether an asset is still referenced
 * is decided by `private.loomic_asset_has_live_references`, and that check is ten
 * EXISTS subqueries - one of them scans job result jsonb - so it costs about 20ms per
 * asset. Running it for a whole bucket is minutes, not milliseconds. The list
 * therefore starts from a cheap set-based candidate query (every column that points
 * at an asset) and only asks the authoritative function about the rows a page
 * actually returns. Measured on the local replica (5735 assets): 5419 have no
 * `asset_references` row at all, the column query narrows that to 1307, and the
 * authoritative check says 1298 - so nine candidates survive only because a job
 * result jsonb mentions them. The candidate query over-reports, which is the safe
 * direction, and never decides on its own.
 *
 * `pageConfirmed` says that the verdict applies to this page only, never to `total`.
 */

export const ADMIN_ASSET_QUEUE_KINDS = ["pending_delete", "gc_eligible", "gc_claimed"] as const;
export const adminAssetQueueKindSchema = z.enum(ADMIN_ASSET_QUEUE_KINDS);

export const adminAssetRowSchema = z.object({
  id: z.string().min(1),
  bucket: z.string().min(1),
  objectPath: z.string(),
  workspaceId: workspaceIdSchema.nullable(),
  workspaceName: z.string().nullable(),
  scope: z.string().min(1),
  mimeType: z.string().nullable(),
  byteSize: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  /** Rows in `asset_references` only - the cheap count, not the whole graph. */
  referenceCount: z.number().int().nonnegative(),
  /** The authoritative verdict for this row. */
  confirmedOrphan: z.boolean(),
  deletionPendingAt: timestampSchema.nullable(),
  gcEligibleAt: timestampSchema.nullable(),
  gcClaimedAt: timestampSchema.nullable(),
});

export const adminAssetOrphanRowSchema = adminAssetRowSchema.extend({
  ageDays: z.number().int().nonnegative(),
});

export const adminAssetOverviewResponseSchema = z.object({
  totalObjects: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  gcEligibleCount: z.number().int().nonnegative(),
  gcClaimedCount: z.number().int().nonnegative(),
  buckets: z.array(z.object({
    bucket: z.string().min(1),
    scope: z.string().min(1),
    objects: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
    gcEligibleCount: z.number().int().nonnegative(),
    claimedCount: z.number().int().nonnegative(),
  })),
  scopes: z.array(z.object({
    scope: z.string().min(1),
    objects: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  })),
  workspaces: z.array(z.object({
    workspaceId: workspaceIdSchema.nullable(),
    workspaceName: z.string().nullable(),
    objects: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  })),
});

export const adminAssetOrphanListResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  /** The `confirmedOrphan` verdicts describe this page, not `total`. */
  pageConfirmed: z.boolean(),
  objects: z.array(adminAssetOrphanRowSchema),
});

export const adminAssetQueueResponseSchema = z.object({
  kind: adminAssetQueueKindSchema,
  total: z.number().int().nonnegative(),
  objects: z.array(adminAssetRowSchema),
});

export const adminAssetLargeObjectsResponseSchema = z.object({
  objects: z.array(adminAssetRowSchema),
});

export const adminAssetPurgeRequestSchema = z.object({
  assetId: z.string().uuid(),
  reason: z.string().trim().min(2).max(500),
}).strict();

export const adminAssetPurgeResponseSchema = z.object({
  assetId: z.string().min(1),
  bucket: z.string().min(1),
  objectPath: z.string(),
  deleted: z.literal(true),
});

export type AdminAssetRow = z.infer<typeof adminAssetRowSchema>;
export type AdminAssetOrphanRow = z.infer<typeof adminAssetOrphanRowSchema>;
export type AdminAssetOverviewResponse = z.infer<typeof adminAssetOverviewResponseSchema>;
export type AdminAssetOrphanListResponse = z.infer<typeof adminAssetOrphanListResponseSchema>;
export type AdminAssetQueueResponse = z.infer<typeof adminAssetQueueResponseSchema>;
export type AdminAssetLargeObjectsResponse = z.infer<typeof adminAssetLargeObjectsResponseSchema>;
export type AdminAssetPurgeRequest = z.infer<typeof adminAssetPurgeRequestSchema>;
