import { z } from "zod";

import { timestampSchema, userIdSchema, workspaceIdSchema, workspaceRoleSchema, workspaceTypeSchema } from "./contracts.js";
import { uuidPattern } from "./uuid.js";

/**
 * Platform-level user directory and cross-workspace membership management.
 *
 * Reads come from one database function that aggregates 30-day activity per user;
 * writes go through the audited membership functions, so every add/role/remove
 * carries a reason and a before/after snapshot. Ownership is intentionally not
 * available here: a workspace's owner membership is immutable in this console.
 */

/** A real id, not free text: the request targets a specific account. */
const accountIdSchema = z.string().regex(uuidPattern, "must be a UUID");

export const adminUserMembershipSchema = z.object({
  id: workspaceIdSchema,
  name: z.string().min(1),
  type: workspaceTypeSchema,
  role: workspaceRoleSchema,
});

export const adminUserDirectoryEntrySchema = z.object({
  userId: userIdSchema,
  /** `profiles.email` falls back to `auth.users.email`; both can be absent. */
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  createdAt: timestampSchema,
  isPlatformAdmin: z.boolean(),
  lastActiveAt: timestampSchema.nullable(),
  runs30d: z.number().int().nonnegative(),
  jobs30d: z.number().int().nonnegative(),
  creditsSpent30d: z.number().int().nonnegative(),
  workspaces: z.array(adminUserMembershipSchema),
});

export const adminUserDirectoryResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  users: z.array(adminUserDirectoryEntrySchema),
});

export const adminWorkspaceDirectoryEntrySchema = z.object({
  id: workspaceIdSchema,
  name: z.string().min(1),
  type: workspaceTypeSchema,
  createdAt: timestampSchema,
  memberCount: z.number().int().nonnegative(),
});

export const adminWorkspaceDirectoryResponseSchema = z.object({
  workspaces: z.array(adminWorkspaceDirectoryEntrySchema),
});

/** Roles this console may assign. `owner` is absent by design. */
export const adminAssignableRoleSchema = workspaceRoleSchema.exclude(["owner"]);

export const adminAddWorkspaceMemberRequestSchema = z.object({
  userId: accountIdSchema,
  role: adminAssignableRoleSchema,
  reason: z.string().trim().min(2).max(500),
}).strict();

export const adminSetWorkspaceMemberRoleRequestSchema = z.object({
  role: adminAssignableRoleSchema,
  reason: z.string().trim().min(2).max(500),
}).strict();

export const adminRemoveWorkspaceMemberRequestSchema = z.object({
  reason: z.string().trim().min(2).max(500),
}).strict();

export const adminMembershipChangeResponseSchema = z.object({
  member: z.object({
    userId: userIdSchema,
    workspaceId: workspaceIdSchema,
    role: adminAssignableRoleSchema,
  }),
});

export const adminMembershipRemovalResponseSchema = z.object({
  member: z.object({
    userId: userIdSchema,
    workspaceId: workspaceIdSchema,
    removed: z.literal(true),
  }),
});

export type AdminUserMembership = z.infer<typeof adminUserMembershipSchema>;
export type AdminUserDirectoryEntry = z.infer<typeof adminUserDirectoryEntrySchema>;
export type AdminUserDirectoryResponse = z.infer<typeof adminUserDirectoryResponseSchema>;
export type AdminWorkspaceDirectoryEntry = z.infer<typeof adminWorkspaceDirectoryEntrySchema>;
export type AdminWorkspaceDirectoryResponse = z.infer<typeof adminWorkspaceDirectoryResponseSchema>;
export type AdminAssignableRole = z.infer<typeof adminAssignableRoleSchema>;
export type AdminAddWorkspaceMemberRequest = z.infer<typeof adminAddWorkspaceMemberRequestSchema>;
export type AdminSetWorkspaceMemberRoleRequest = z.infer<typeof adminSetWorkspaceMemberRoleRequestSchema>;
export type AdminRemoveWorkspaceMemberRequest = z.infer<typeof adminRemoveWorkspaceMemberRequestSchema>;
