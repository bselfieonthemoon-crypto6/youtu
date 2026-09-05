import type { ManageableWorkspaceRole, WorkspaceMemberAdminView } from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { AuthenticatedUser, UserSupabaseClient } from "../../supabase/user.js";

type ManagerRole = "owner" | "admin";

export class WorkspaceMemberServiceError extends Error {
  constructor(
    readonly code:
      | "member_forbidden"
      | "member_not_found"
      | "member_already_exists"
      | "member_owner_immutable"
      | "member_persistence_failed",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export type WorkspaceMemberService = {
  list(user: AuthenticatedUser, workspaceId: string): Promise<WorkspaceMemberAdminView[]>;
  add(user: AuthenticatedUser, workspaceId: string, email: string, role: ManageableWorkspaceRole): Promise<WorkspaceMemberAdminView>;
  updateRole(user: AuthenticatedUser, workspaceId: string, targetUserId: string, role: ManageableWorkspaceRole): Promise<WorkspaceMemberAdminView>;
  remove(user: AuthenticatedUser, workspaceId: string, targetUserId: string): Promise<void>;
};

export function createWorkspaceMemberService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
}): WorkspaceMemberService {
  async function requireManager(user: AuthenticatedUser, workspaceId: string): Promise<ManagerRole> {
    const { data, error } = await options
      .createUserClient(user.accessToken)
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error || !data || (data.role !== "owner" && data.role !== "admin")) {
      throw new WorkspaceMemberServiceError("member_forbidden", "Workspace owner or admin access is required.", 403);
    }
    return data.role;
  }

  async function listRows(workspaceId: string, currentUserId: string): Promise<WorkspaceMemberAdminView[]> {
    const admin = options.getAdminClient();
    const membershipResult = await (admin.from("workspace_members") as any)
      .select("user_id, role, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true });
    if (membershipResult.error) throw persistenceError();
    const memberships = (membershipResult.data ?? []) as Array<{ user_id: string; role: "owner" | "admin" | "member"; created_at: string }>;
    if (memberships.length === 0) return [];
    const profileResult = await (admin.from("profiles") as any)
      .select("id, email, display_name, avatar_url")
      .in("id", memberships.map((item) => item.user_id));
    if (profileResult.error) throw persistenceError();
    const profiles = new Map(((profileResult.data ?? []) as Array<{ id: string; email: string | null; display_name: string | null; avatar_url: string | null }>).map((profile) => [profile.id, profile]));
    return memberships.map((membership) => {
      const profile = profiles.get(membership.user_id);
      const email = profile?.email?.trim() || "unknown@example.invalid";
      return {
        userId: membership.user_id,
        email,
        displayName: profile?.display_name?.trim() || email.split("@")[0] || "未命名用户",
        avatarUrl: profile?.avatar_url ?? null,
        role: membership.role,
        joinedAt: membership.created_at,
        isCurrentUser: membership.user_id === currentUserId,
      };
    });
  }

  async function findMembership(workspaceId: string, targetUserId: string) {
    const { data, error } = await (options.getAdminClient().from("workspace_members") as any)
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", targetUserId)
      .maybeSingle();
    if (error) throw persistenceError();
    if (!data) throw new WorkspaceMemberServiceError("member_not_found", "Workspace member not found.", 404);
    return data as { role: "owner" | "admin" | "member" };
  }

  async function singleView(workspaceId: string, currentUserId: string, targetUserId: string) {
    const member = (await listRows(workspaceId, currentUserId)).find((item) => item.userId === targetUserId);
    if (!member) throw new WorkspaceMemberServiceError("member_not_found", "Workspace member not found.", 404);
    return member;
  }

  return {
    async list(user, workspaceId) {
      await requireManager(user, workspaceId);
      return listRows(workspaceId, user.id);
    },

    async add(user, workspaceId, email, role) {
      const actorRole = await requireManager(user, workspaceId);
      if (actorRole !== "owner" && role === "admin") throw forbiddenRoleChange();
      const normalizedEmail = email.trim().toLowerCase();
      const { data: profile, error: profileError } = await (options.getAdminClient().from("profiles") as any)
        .select("id")
        .ilike("email", normalizedEmail)
        .maybeSingle();
      if (profileError) throw persistenceError();
      if (!profile) throw new WorkspaceMemberServiceError("member_not_found", "No registered user was found for this email.", 404);
      const { error } = await (options.getAdminClient().from("workspace_members") as any).insert({
        workspace_id: workspaceId,
        user_id: profile.id,
        role,
      });
      if (error) {
        if (String(error.code) === "23505") throw new WorkspaceMemberServiceError("member_already_exists", "The user is already a workspace member.", 409);
        throw persistenceError();
      }
      return singleView(workspaceId, user.id, String(profile.id));
    },

    async updateRole(user, workspaceId, targetUserId, role) {
      const actorRole = await requireManager(user, workspaceId);
      const target = await findMembership(workspaceId, targetUserId);
      if (target.role === "owner") throw ownerImmutable();
      if (actorRole !== "owner") throw forbiddenRoleChange();
      const { error } = await (options.getAdminClient().from("workspace_members") as any)
        .update({ role })
        .eq("workspace_id", workspaceId)
        .eq("user_id", targetUserId);
      if (error) throw persistenceError();
      return singleView(workspaceId, user.id, targetUserId);
    },

    async remove(user, workspaceId, targetUserId) {
      const actorRole = await requireManager(user, workspaceId);
      const target = await findMembership(workspaceId, targetUserId);
      if (target.role === "owner") throw ownerImmutable();
      if (targetUserId === user.id) throw new WorkspaceMemberServiceError("member_forbidden", "You cannot remove your own administrator membership.", 403);
      if (actorRole !== "owner" && target.role !== "member") throw forbiddenRoleChange();
      const { error } = await (options.getAdminClient().from("workspace_members") as any)
        .delete()
        .eq("workspace_id", workspaceId)
        .eq("user_id", targetUserId);
      if (error) throw persistenceError();
    },
  };
}

function persistenceError() {
  return new WorkspaceMemberServiceError("member_persistence_failed", "Unable to persist workspace member changes.", 500);
}

function ownerImmutable() {
  return new WorkspaceMemberServiceError("member_owner_immutable", "The workspace owner cannot be changed or removed.", 409);
}

function forbiddenRoleChange() {
  return new WorkspaceMemberServiceError("member_forbidden", "Only the workspace owner can manage administrator roles.", 403);
}
