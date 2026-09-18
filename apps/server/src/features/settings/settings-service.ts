import { agentCollaborationSettingsSchema, agentCollaborationSettingsUpdateSchema, defaultAgentCollaborationSettings, type WorkspaceSettings } from "@loomic/shared";
import type { WorkspaceModelCatalogService } from "../providers/workspace-model-catalog-service.js";

import type { AuthenticatedUser, UserSupabaseClient } from "../../supabase/user.js";

const FALLBACK_MODEL = "apiyi:gemini-3.1-flash-lite";

export class SettingsServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "settings_not_found"
    | "settings_read_failed"
    | "settings_forbidden"
    | "settings_model_not_accessible"
    | "settings_update_failed";

  constructor(
    code:
      | "settings_not_found"
      | "settings_read_failed"
      | "settings_forbidden"
      | "settings_model_not_accessible"
      | "settings_update_failed",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type SettingsService = {
  getWorkspaceSettings(
    user: AuthenticatedUser,
    workspaceId: string,
  ): Promise<WorkspaceSettings>;
  updateWorkspaceSettings(
    user: AuthenticatedUser,
    workspaceId: string,
    settings: { defaultModel?: string | undefined; agentCollaboration?: WorkspaceSettings["agentCollaboration"] },
  ): Promise<WorkspaceSettings>;
};

export function createSettingsService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  /** Override the fallback model when no workspace setting exists. */
  defaultModel?: string;
  workspaceModelCatalogService?: WorkspaceModelCatalogService;
}): SettingsService {
  const defaultModel = options.defaultModel ?? FALLBACK_MODEL;

  return {
    async getWorkspaceSettings(user, workspaceId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("workspace_settings")
        .select("default_model, agent_collaboration")
        .eq("workspace_id", workspaceId)
        .maybeSingle();

      if (error) {
        throw new SettingsServiceError(
          "settings_read_failed",
          "Unable to load workspace settings.",
          500,
        );
      }

      const row = data as { default_model?: string; agent_collaboration?: unknown } | null;
      return {
        defaultModel: normalizeDefaultModel(row?.default_model, defaultModel),
        agentCollaboration: row?.agent_collaboration == null
          ? defaultAgentCollaborationSettings()
          : agentCollaborationSettingsSchema.parse(row.agent_collaboration),
      };
    },

    async updateWorkspaceSettings(user, workspaceId, settings) {
      const client = options.createUserClient(user.accessToken);
      const member = await client.from("workspace_members").select("role")
        .eq("workspace_id", workspaceId).eq("user_id", user.id).maybeSingle();
      if (member.error || !member.data || !["owner", "admin"].includes(member.data.role)) {
        throw new SettingsServiceError("settings_forbidden", "只有工作区所有者或管理员可以修改 Agent 配置。", 403);
      }
      const collaboration = settings.agentCollaboration === undefined
        ? undefined : agentCollaborationSettingsUpdateSchema.parse(settings.agentCollaboration);
      if (settings.defaultModel !== undefined && settings.defaultModel !== defaultModel) {
        const model = await options.workspaceModelCatalogService?.resolvePublishedModel(user, workspaceId, settings.defaultModel, "text");
        if (!model?.capabilities.includes("text")) {
          throw new SettingsServiceError("settings_model_not_accessible", "默认 Agent 模型不可用，请选择当前工作区已启用的文本模型。", 422);
        }
      }
      if (collaboration?.enabled) {
        const refs = [...new Set(Object.values(collaboration.roleModels).filter((ref): ref is string => ref !== null))];
        for (const ref of refs) {
          const model = await options.workspaceModelCatalogService?.resolvePublishedModel(user, workspaceId, ref, "text");
          if (!model?.capabilities.includes("text")) {
            throw new SettingsServiceError("settings_model_not_accessible", "子 Agent 只能使用当前工作区已启用的文本模型。请重新选择模型。", 422);
          }
        }
      }
      const { error } = await client
        .from("workspace_settings")
        .upsert(
          {
            workspace_id: workspaceId,
            ...(settings.defaultModel !== undefined ? { default_model: normalizeDefaultModel(settings.defaultModel, defaultModel) } : {}),
            ...(collaboration ? { agent_collaboration: collaboration } : {}),
          },
          { onConflict: "workspace_id" },
        );

      if (error) {
        throw new SettingsServiceError(
          "settings_update_failed",
          "Unable to update workspace settings.",
          500,
        );
      }

      // Omitted configuration is a partial update, never a reset of role models.
      return this.getWorkspaceSettings(user, workspaceId);
    },
  };
}

function normalizeDefaultModel(model: string | null | undefined, fallback: string): string {
  if (model?.startsWith("apiyi:") || model?.startsWith("workspace:")) return model;
  return fallback;
}
