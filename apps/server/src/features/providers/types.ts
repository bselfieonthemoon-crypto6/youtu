import type { AuthenticatedUser } from "../../supabase/user.js";
import type { ModelContextProfile } from "@loomic/shared";

export type ProviderAdapter = "openai_compatible";
export type ProviderModelModality = "text" | "image" | "video";
export type ProviderLastTestStatus = "never" | "succeeded" | "failed";
export type ProviderTestErrorCode =
  | "provider_connection_failed"
  | "provider_connection_timeout"
  | "provider_auth_failed"
  | "provider_redirect_not_allowed"
  | "provider_response_too_large";

export type ProviderModelCapability =
  | "text"
  | "vision_input"
  | "image_generation"
  | "video_generation";

export type ProviderModelInput = {
  upstreamModelId: string;
  displayName: string;
  modality: ProviderModelModality;
  enabled: boolean;
  capabilities?: ProviderModelCapability[];
  contextProfile?: ModelContextProfile | null;
};

export type WorkspaceProviderModelView = ProviderModelInput & {
  id: string;
};

export type CreateProviderConfigInput = {
  adapter?: ProviderAdapter;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
  models?: ProviderModelInput[];
};

export type UpdateProviderConfigInput = {
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  models?: ProviderModelInput[];
};

export type DiscoverProviderModelsDraftInput = {
  baseUrl: string;
  apiKey?: string;
  configId?: string;
};

export type WorkspaceProviderConfigView = {
  id: string;
  adapter: ProviderAdapter;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
  hasApiKey: boolean;
  lastFour: string;
  models: WorkspaceProviderModelView[];
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
  lastTestStatus: ProviderLastTestStatus;
};

export type ProviderConnectionTestResult = {
  ok: boolean;
  testedAt: string;
  errorCode?: ProviderTestErrorCode;
};

export type ProviderConfigService = {
  /** `workspaceId === null` addresses the platform-wide default channel. */
  list(
    user: AuthenticatedUser,
    workspaceId: string | null,
  ): Promise<WorkspaceProviderConfigView[]>;
  create(
    user: AuthenticatedUser,
    workspaceId: string | null,
    input: CreateProviderConfigInput,
  ): Promise<WorkspaceProviderConfigView>;
  update(
    user: AuthenticatedUser,
    workspaceId: string | null,
    configId: string,
    input: UpdateProviderConfigInput,
  ): Promise<WorkspaceProviderConfigView>;
  delete(
    user: AuthenticatedUser,
    workspaceId: string | null,
    configId: string,
  ): Promise<void>;
  test(
    user: AuthenticatedUser,
    workspaceId: string | null,
    configId: string,
  ): Promise<ProviderConnectionTestResult>;
  discoverModels(
    user: AuthenticatedUser,
    workspaceId: string | null,
    configId: string,
  ): Promise<ProviderModelInput[]>;
  discoverDraftModels(
    user: AuthenticatedUser,
    workspaceId: string | null,
    input: DiscoverProviderModelsDraftInput,
  ): Promise<ProviderModelInput[]>;
};
