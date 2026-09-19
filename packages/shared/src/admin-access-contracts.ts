import { z } from "zod";

import { timestampSchema, userIdSchema, workspaceIdSchema } from "./contracts.js";

/**
 * Platform-admin access management and the operation audit trail.
 *
 * These are the only write contracts the operations console has. Every one of
 * them is executed by a database function that (a) re-checks the actor is an
 * active platform admin, (b) performs the change, and (c) writes the audit row in
 * the same transaction. A reason is mandatory: an access change with no stated
 * reason is not reviewable later.
 */

export const adminPlatformAdminViewSchema = z.object({
  userId: userIdSchema,
  /** Profiles may legitimately have no email captured; the UI shows the id then. */
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  grantedAt: timestampSchema.nullable(),
  grantedBy: userIdSchema.nullable(),
  isCurrentUser: z.boolean(),
});

export const adminPlatformAdminListResponseSchema = z.object({
  admins: z.array(adminPlatformAdminViewSchema),
});

export const adminPlatformAdminGrantRequestSchema = z.object({
  email: z.string().trim().email(),
  reason: z.string().trim().min(2).max(500),
}).strict();

export const adminPlatformAdminRevokeRequestSchema = z.object({
  reason: z.string().trim().min(2).max(500),
}).strict();

export const adminAuditEventViewSchema = z.object({
  id: z.string().min(1),
  actorUserId: userIdSchema.nullable(),
  actorEmail: z.string().nullable(),
  action: z.string().min(1),
  targetKind: z.string().min(1),
  targetId: z.string().min(1),
  workspaceId: workspaceIdSchema.nullable(),
  workspaceName: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: timestampSchema,
});

export const adminAuditListResponseSchema = z.object({
  events: z.array(adminAuditEventViewSchema),
});

export const adminWriteErrorCodeSchema = z.enum([
  "platform_admin_required",
  "admin_write_failed",
  "admin_invalid_request",
  "admin_user_not_found",
  "admin_not_platform_admin",
  "admin_last_platform_admin",
  "admin_reason_required",
]);

export const adminWriteErrorResponseSchema = z.object({
  error: z.object({
    code: adminWriteErrorCodeSchema,
    message: z.string().min(1),
  }),
});

export type AdminPlatformAdminView = z.infer<typeof adminPlatformAdminViewSchema>;
export type AdminPlatformAdminListResponse = z.infer<typeof adminPlatformAdminListResponseSchema>;
export type AdminPlatformAdminGrantRequest = z.infer<typeof adminPlatformAdminGrantRequestSchema>;
export type AdminPlatformAdminRevokeRequest = z.infer<typeof adminPlatformAdminRevokeRequestSchema>;
export type AdminAuditEventView = z.infer<typeof adminAuditEventViewSchema>;
export type AdminAuditListResponse = z.infer<typeof adminAuditListResponseSchema>;
export type AdminWriteErrorCode = z.infer<typeof adminWriteErrorCodeSchema>;
