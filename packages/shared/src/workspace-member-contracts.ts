import { z } from "zod";

import { timestampSchema, userIdSchema, workspaceRoleSchema } from "./contracts.js";

export const manageableWorkspaceRoleSchema = workspaceRoleSchema.exclude(["owner"]);

export const workspaceMemberAdminViewSchema = z.object({
  userId: userIdSchema,
  email: z.string().email(),
  displayName: z.string().min(1),
  avatarUrl: z.string().url().nullable(),
  role: workspaceRoleSchema,
  joinedAt: timestampSchema,
  isCurrentUser: z.boolean(),
});

export const workspaceMemberListResponseSchema = z.object({
  members: z.array(workspaceMemberAdminViewSchema),
});

export const workspaceMemberResponseSchema = z.object({
  member: workspaceMemberAdminViewSchema,
});

export const workspaceMemberCreateRequestSchema = z.object({
  email: z.string().trim().email(),
  role: manageableWorkspaceRoleSchema.default("member"),
});

export const workspaceMemberUpdateRequestSchema = z.object({
  role: manageableWorkspaceRoleSchema,
});

export const workspaceMemberErrorCodeSchema = z.enum([
  "member_forbidden",
  "member_not_found",
  "member_already_exists",
  "member_owner_immutable",
  "member_invalid_request",
  "member_persistence_failed",
]);

export const workspaceMemberErrorResponseSchema = z.object({
  error: z.object({
    code: workspaceMemberErrorCodeSchema,
    message: z.string().min(1),
  }),
});

export type ManageableWorkspaceRole = z.infer<typeof manageableWorkspaceRoleSchema>;
export type WorkspaceMemberAdminView = z.infer<typeof workspaceMemberAdminViewSchema>;
export type WorkspaceMemberListResponse = z.infer<typeof workspaceMemberListResponseSchema>;
export type WorkspaceMemberResponse = z.infer<typeof workspaceMemberResponseSchema>;
export type WorkspaceMemberCreateRequest = z.infer<typeof workspaceMemberCreateRequestSchema>;
export type WorkspaceMemberUpdateRequest = z.infer<typeof workspaceMemberUpdateRequestSchema>;
export type WorkspaceMemberErrorCode = z.infer<typeof workspaceMemberErrorCodeSchema>;
