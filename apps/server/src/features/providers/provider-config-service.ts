import { randomUUID } from "node:crypto";
import { modelContextProfileSchema } from "@loomic/shared";

import { isActivePlatformAdmin } from "../admin/platform-admin.js";
import {
  createSafeProviderFetch,
  normalizePublicProviderBaseUrl,
} from "../../security/safe-provider-fetch.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import type {
  CreateProviderConfigInput,
  DiscoverProviderModelsDraftInput,
  ProviderConfigService,
  ProviderConnectionTestResult,
  ProviderModelCapability,
  ProviderModelInput,
  ProviderTestErrorCode,
  UpdateProviderConfigInput,
  WorkspaceProviderConfigView,
  WorkspaceProviderModelView,
} from "./types.js";

// `/models` is an intentionally bounded catalog endpoint, not a general
// provider response.  Some valid upstream catalogs exceed the small health
// probe limit; retain a finite cap and parse the result before declaring the
// provider usable.
const MAX_MODEL_LIST_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_DISCOVERED_MODELS = 10_000;
const TEST_TIMEOUT_MS = 8_000;

const CONFIG_COLUMNS =
  "id, workspace_id, adapter, display_name, base_url, enabled, api_key_secret_id, api_key_last_four, revision, last_tested_at, last_test_status, created_at, updated_at";
const MODEL_COLUMNS =
  "id, provider_config_id, upstream_model_id, display_name, modality, enabled, capabilities, context_profile";

export class ProviderConfigServiceError extends Error {
  constructor(
    readonly code:
      | "provider_forbidden"
      | "provider_not_found"
      | "provider_invalid_request"
      | "provider_conflict"
      | "provider_persistence_failed",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/**
 * `null` is the platform scope: the one channel set every workspace resolves to
 * while it has no usable configuration of its own. It is managed from the
 * platform console and is authorized by an active platform-admin check instead
 * of workspace membership, exactly like the other admin write paths.
 */
export type ProviderConfigScope = string | null;

/** Restrict a query to one scope: an owning workspace, or the platform default. */
function inScope(query: any, workspaceId: ProviderConfigScope) {
  return workspaceId === null
    ? query.is("workspace_id", null)
    : query.eq("workspace_id", workspaceId);
}

export function createProviderConfigService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  fetchFn?: typeof fetch;
  resolveProviderHost?: (hostname: string) => Promise<string[]>;
  idFactory?: () => string;
  now?: () => string;
}): ProviderConfigService {
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  const providerFetch = (baseUrl: string) => createSafeProviderFetch(baseUrl, {
    ...(options.fetchFn ? { fetch: options.fetchFn } : {}),
    ...(options.resolveProviderHost ? { resolve: options.resolveProviderHost } : {}),
  });

  async function requireManager(user: AuthenticatedUser, workspaceId: ProviderConfigScope) {
    if (workspaceId === null) {
      if (!(await isActivePlatformAdmin(options.getAdminClient(), user.id))) {
        throw new ProviderConfigServiceError(
          "provider_forbidden",
          "Platform administrator access is required.",
          403,
        );
      }
      return;
    }
    const { data, error } = await options
      .createUserClient(user.accessToken)
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error || !data || (data.role !== "owner" && data.role !== "admin")) {
      throw new ProviderConfigServiceError(
        "provider_forbidden",
        "Workspace owner or admin access is required.",
        403,
      );
    }
  }

  async function listAuthorized(workspaceId: ProviderConfigScope) {
    const admin = options.getAdminClient();
    const configsResult = await inScope(
      (admin.from("workspace_provider_configs") as any).select(CONFIG_COLUMNS),
      workspaceId,
    ).order("created_at", { ascending: true });
    if (configsResult.error) throw persistenceError();
    const configs = (configsResult.data ?? []) as Record<string, unknown>[];
    if (configs.length === 0) return [];
    const modelsResult = await (admin.from("workspace_provider_models") as any)
      .select(MODEL_COLUMNS)
      .in("provider_config_id", configs.map((row) => row.id));
    if (modelsResult.error) throw persistenceError();
    return mapViews(configs, (modelsResult.data ?? []) as Record<string, unknown>[]);
  }

  async function findConfig(workspaceId: ProviderConfigScope, configId: string) {
    const { data, error } = await inScope(
      (options.getAdminClient().from("workspace_provider_configs") as any)
        .select(CONFIG_COLUMNS),
      workspaceId,
    )
      .eq("id", configId)
      .maybeSingle();
    if (error) throw persistenceError();
    if (!data) {
      throw new ProviderConfigServiceError(
        "provider_not_found",
        "Provider configuration not found.",
        404,
      );
    }
    return data as Record<string, unknown>;
  }

  async function audit(
    workspaceId: ProviderConfigScope,
    configId: string,
    actorId: string,
    action: "created" | "updated" | "key_rotated" | "test_succeeded" | "test_failed",
    safeDetails: Record<string, unknown> = {},
  ) {
    // A platform channel has no owning workspace, so its trail is the platform
    // audit log rather than the workspace-scoped one (whose workspace_id is NOT
    // NULL). updated/key_rotated/deleted are written by the database RPCs in the
    // same transaction as the change; created and test results are written here.
    if (workspaceId === null) {
      // `admin_audit_events` is newer than the hand-maintained Database type map
      // (same reason http/skills.ts has its own loose view).
      const { error } = await (options.getAdminClient() as any)
        .from("admin_audit_events")
        .insert({
          actor_user_id: actorId,
          action: `provider_config.${action}`,
          target_kind: "provider_config",
          target_id: configId,
          after: safeDetails,
        });
      if (error) throw persistenceError();
      return;
    }
    const { error } = await (options
      .getAdminClient()
      .from("workspace_provider_audit_events") as any)
      .insert({
        workspace_id: workspaceId,
        provider_config_id: configId,
        actor_user_id: actorId,
        action,
        safe_details: safeDetails,
      });
    if (error) throw persistenceError();
  }

  return {
    async list(user, workspaceId) {
      await requireManager(user, workspaceId);
      return listAuthorized(workspaceId);
    },

    async create(user, workspaceId, rawInput) {
      await requireManager(user, workspaceId);
      const input = validateCreateInput(rawInput);
      const configId = idFactory();
      const secretId = await createVaultSecret(
        options.getAdminClient(),
        input.apiKey,
        `workspace-provider-${configId}`,
      );
      const admin = options.getAdminClient();
      try {
        const { error } = await (admin.from("workspace_provider_configs") as any)
          .insert({
            id: configId,
            ...(workspaceId === null ? {} : { workspace_id: workspaceId }),
            adapter: "openai_compatible",
            display_name: input.displayName,
            base_url: input.baseUrl,
            enabled: input.enabled,
            api_key_secret_id: secretId,
            api_key_last_four: lastFour(input.apiKey),
            created_by: user.id,
            updated_by: user.id,
          });
        if (error) throw mapWriteError(error);
        await replaceModels(admin, configId, input.models);
        await audit(workspaceId, configId, user.id, "created", {
          adapter: "openai_compatible",
          modelCount: input.models.length,
        });
      } catch (error) {
        await (admin.from("workspace_provider_configs") as any)
          .delete()
          .eq("id", configId);
        await deleteVaultSecret(admin, secretId).catch(() => undefined);
        throw error;
      }
      return getSingleView(await listAuthorized(workspaceId), configId);
    },

    async update(user, workspaceId, configId, rawInput) {
      await requireManager(user, workspaceId);
      const current = await findConfig(workspaceId, configId);
      const input = validateUpdateInput(rawInput, current);
      const originChanged =
        new URL(input.baseUrl).origin !== new URL(current.base_url as string).origin;
      if (originChanged && !input.apiKey) {
        throw new ProviderConfigServiceError(
          "provider_invalid_request",
          "Changing provider origin requires a new API key.",
          400,
        );
      }

      const admin = options.getAdminClient();
      const { data, error } = await (admin as any).rpc(
        "loomic_provider_config_update",
        {
          p_workspace_id: workspaceId,
          p_provider_config_id: configId,
          p_expected_revision: current.revision,
          p_display_name: input.displayName,
          p_base_url: input.baseUrl,
          p_enabled: input.enabled,
          p_new_secret: input.apiKey ?? null,
          p_new_secret_last_four: input.apiKey ? lastFour(input.apiKey) : null,
          p_models: input.models ?? null,
          p_actor_user_id: user.id,
        },
      );
      if (error) throw mapWriteError(error);
      if (data === "not_found") {
        throw new ProviderConfigServiceError(
          "provider_not_found",
          "Provider configuration not found.",
          404,
        );
      }
      if (data === "conflict") {
        throw new ProviderConfigServiceError(
          "provider_conflict",
          "Provider configuration changed concurrently.",
          409,
        );
      }
      if (data !== "updated") throw persistenceError();
      return getSingleView(await listAuthorized(workspaceId), configId);
    },

    async delete(user, workspaceId, configId) {
      await requireManager(user, workspaceId);
      const { data, error } = await (options.getAdminClient() as any).rpc(
        "loomic_provider_config_delete",
        {
          p_workspace_id: workspaceId,
          p_provider_config_id: configId,
          p_actor_user_id: user.id,
        },
      );
      if (error) throw persistenceError();
      if (data !== true) {
        throw new ProviderConfigServiceError(
          "provider_not_found",
          "Provider configuration not found.",
          404,
        );
      }
    },

    async test(user, workspaceId, configId) {
      await requireManager(user, workspaceId);
      const config = await findConfig(workspaceId, configId);
      const baseUrl = normalizeBaseUrl(config.base_url);
      const apiKey = await readVaultSecret(
        options.getAdminClient(),
        config.api_key_secret_id as string,
      );
      const testedAt = now();
      const errorCode = await testConnection(providerFetch(baseUrl), baseUrl, apiKey);
      const ok = errorCode === undefined;
      const admin = options.getAdminClient();
      const { error } = await inScope(
        (admin.from("workspace_provider_configs") as any).update({
          last_tested_at: testedAt,
          last_test_status: ok ? "succeeded" : "failed",
          last_test_error_code: errorCode ?? null,
          updated_by: user.id,
        }),
        workspaceId,
      ).eq("id", configId);
      if (error) throw persistenceError();
      await audit(
        workspaceId,
        configId,
        user.id,
        ok ? "test_succeeded" : "test_failed",
        errorCode ? { errorCode } : {},
      );
      return {
        ok,
        testedAt,
        ...(errorCode ? { errorCode } : {}),
      } satisfies ProviderConnectionTestResult;
    },

    async discoverModels(user, workspaceId, configId) {
      await requireManager(user, workspaceId);
      const config = await findConfig(workspaceId, configId);
      const baseUrl = normalizeBaseUrl(config.base_url);
      const apiKey = await readVaultSecret(
        options.getAdminClient(),
        config.api_key_secret_id as string,
      );
      return discoverProviderModels(providerFetch(baseUrl), baseUrl, apiKey);
    },

    async discoverDraftModels(user, workspaceId, rawInput) {
      // Authorize before looking up a configuration, reading Vault, or making
      // any provider request.  Draft discovery is intentionally write-free.
      await requireManager(user, workspaceId);
      const input = validateDraftDiscoveryInput(rawInput);
      let apiKey = input.apiKey;
      if (input.configId && !apiKey) {
        const config = await findConfig(workspaceId, input.configId);
        const storedBaseUrl = normalizeBaseUrl(config.base_url);
        if (new URL(input.baseUrl).origin !== new URL(storedBaseUrl).origin) {
          throw new ProviderConfigServiceError(
            "provider_invalid_request",
            "Changing provider origin requires a new API key.",
            400,
          );
        }
        apiKey = await readVaultSecret(
          options.getAdminClient(),
          config.api_key_secret_id as string,
        );
      }
      if (!apiKey) {
        throw invalidRequest("An API key is required to discover provider models.");
      }
      return discoverProviderModels(providerFetch(input.baseUrl), input.baseUrl, apiKey);
    },
  };
}

async function discoverProviderModels(
  fetchFn: typeof fetch,
  baseUrl: string,
  apiKey: string,
): Promise<ProviderModelInput[]> {
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch {
    throw discoveryError("Unable to fetch provider models.");
  }
  if (!response.ok) throw discoveryError("Provider model discovery failed.");
  const raw = await readBoundedResponseText(response, MAX_MODEL_LIST_RESPONSE_BYTES);
  if (raw === null) throw discoveryError("Provider model response is too large.");
  if (!isJsonContentType(response.headers.get("content-type"))) {
    throw discoveryError("Provider returned invalid model data.");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw discoveryError("Provider returned invalid model data.");
  }
  const rows = typeof body === "object" && body && "data" in body && Array.isArray((body as { data?: unknown }).data)
    ? (body as { data: unknown[] }).data
    : [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = typeof row === "object" && row && "id" in row
      ? String((row as { id: unknown }).id).trim()
      : "";
    if (!id || seen.has(id)) continue;
    if (id.length > 200) throw discoveryError("Provider returned invalid model data.");
    seen.add(id);
    ids.push(id);
    if (ids.length > MAX_DISCOVERED_MODELS) {
      throw discoveryError("Provider model catalog contains too many models.");
    }
  }
  return ids.map(inferDiscoveredModel);
}

function inferDiscoveredModel(id: string): ProviderModelInput {
  const normalized = id.toLowerCase();
  if (/(?:^|[-_/])(image|imagen|dall-e|flux|seedream|banana)(?:$|[-_/\d])/.test(normalized)) {
    return { upstreamModelId: id, displayName: id, modality: "image", enabled: false, capabilities: ["image_generation"] };
  }
  if (/(?:^|[-_/])(video|veo|sora|kling|hailuo|seedance)(?:$|[-_/\d])/.test(normalized)) {
    return { upstreamModelId: id, displayName: id, modality: "video", enabled: false, capabilities: ["video_generation"] };
  }
  const capabilities: ProviderModelCapability[] = ["text"];
  if (/(?:vision|gemini|gpt-4o|gpt-4\.1|claude)/.test(normalized)) {
    capabilities.push("vision_input");
  }
  return { upstreamModelId: id, displayName: id, modality: "text", enabled: false, capabilities };
}

function discoveryError(message: string) {
  return new ProviderConfigServiceError("provider_persistence_failed", message, 502);
}

function validateCreateInput(input: CreateProviderConfigInput) {
  if (input.adapter !== undefined && input.adapter !== "openai_compatible") {
    throw invalidRequest("Unsupported provider adapter.");
  }
  const apiKey = normalizeApiKey(input.apiKey);
  return {
    displayName: normalizeDisplayName(input.displayName),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    apiKey,
    enabled: input.enabled ?? true,
    models: validateModels(input.models ?? []),
  };
}

function validateUpdateInput(
  input: UpdateProviderConfigInput,
  current: Record<string, unknown>,
) {
  const apiKey = input.apiKey === undefined
    ? undefined
    : normalizeApiKey(input.apiKey);
  return {
    displayName:
      input.displayName === undefined
        ? (current.display_name as string)
        : normalizeDisplayName(input.displayName),
    baseUrl:
      input.baseUrl === undefined
        ? (current.base_url as string)
        : normalizeBaseUrl(input.baseUrl),
    enabled: input.enabled ?? (current.enabled === true),
    ...(apiKey ? { apiKey } : {}),
    ...(input.models ? { models: validateModels(input.models) } : {}),
  };
}

function validateDraftDiscoveryInput(input: DiscoverProviderModelsDraftInput) {
  if (!input || typeof input !== "object") {
    throw invalidRequest("Invalid provider discovery request.");
  }
  const apiKey = input.apiKey === undefined ? undefined : normalizeApiKey(input.apiKey);
  if (input.configId !== undefined && (typeof input.configId !== "string" || input.configId.length === 0)) {
    throw invalidRequest("Invalid provider discovery request.");
  }
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl),
    ...(apiKey ? { apiKey } : {}),
    ...(input.configId ? { configId: input.configId } : {}),
  };
}

function normalizeDisplayName(value: string) {
  const result = value?.trim();
  if (!result || result.length > 100) throw invalidRequest("Invalid display name.");
  return result;
}

export function normalizeBaseUrl(value: unknown): string {
  try {
    return normalizePublicProviderBaseUrl(value);
  } catch {
    throw invalidRequest("Base URL is not allowed.");
  }
}

function normalizeApiKey(value: string) {
  const result = value?.trim();
  if (!result || result.length < 8 || result.length > 4096) {
    throw invalidRequest("Invalid API key.");
  }
  return result;
}

function validateModels(models: ProviderModelInput[]): ProviderModelInput[] {
  if (!Array.isArray(models) || models.length > 500) {
    throw invalidRequest("Invalid provider models.");
  }
  const seen = new Set<string>();
  return models.map((model) => {
    const upstreamModelId = model.upstreamModelId?.trim();
    const displayName = model.displayName?.trim();
    if (
      !upstreamModelId || upstreamModelId.length > 200 || !displayName ||
      displayName.length > 200 ||
      !["text", "image", "video"].includes(model.modality)
    ) throw invalidRequest("Invalid provider model.");
    const key = `${model.modality}:${upstreamModelId}`;
    if (seen.has(key)) throw invalidRequest("Duplicate provider model.");
    seen.add(key);
    const profile = model.contextProfile == null ? null : modelContextProfileSchema.safeParse(model.contextProfile);
    if (profile && (!profile.success || model.modality !== "text")) throw invalidRequest("Invalid model context profile.");
    return {
      upstreamModelId,
      displayName,
      modality: model.modality,
      enabled: model.enabled === true,
      ...(model.capabilities
        ? { capabilities: validateCapabilities(model.capabilities) }
        : {}),
      ...(model.contextProfile !== undefined ? { contextProfile: profile?.success ? profile.data : null } : {}),
    };
  });
}

function validateCapabilities(value: ProviderModelCapability[]) {
  const allowed = new Set<ProviderModelCapability>([
    "text", "vision_input", "image_generation", "video_generation",
  ]);
  if (!Array.isArray(value) || value.some((item) => !allowed.has(item))) {
    throw invalidRequest("Unsupported model capability.");
  }
  return [...new Set(value)];
}

async function replaceModels(
  admin: AdminSupabaseClient,
  configId: string,
  models: ProviderModelInput[],
) {
  const { error: deleteError } = await (admin.from("workspace_provider_models") as any)
    .delete()
    .eq("provider_config_id", configId);
  if (deleteError) throw persistenceError();
  if (models.length === 0) return;
  const { error } = await (admin.from("workspace_provider_models") as any).insert(
    models.map((model) => ({
      provider_config_id: configId,
      upstream_model_id: model.upstreamModelId,
      display_name: model.displayName,
      modality: model.modality,
      enabled: model.enabled,
      capabilities: model.capabilities ?? [],
      context_profile: model.contextProfile ?? null,
    })),
  );
  if (error) throw mapWriteError(error);
}

async function createVaultSecret(
  admin: AdminSupabaseClient,
  secret: string,
  name: string,
) {
  const { data, error } = await (admin as any).rpc("loomic_provider_secret_create", {
    p_secret: secret,
    p_name: name,
    p_description: "Loomic workspace provider API key",
  });
  if (error || typeof data !== "string") throw persistenceError();
  return data;
}

async function readVaultSecret(admin: AdminSupabaseClient, id: string) {
  const { data, error } = await (admin as any).rpc("loomic_provider_secret_read", {
    p_secret_id: id,
  });
  if (error || typeof data !== "string" || data.length === 0) {
    throw persistenceError();
  }
  return data;
}

async function deleteVaultSecret(admin: AdminSupabaseClient, id: string) {
  const { error } = await (admin as any).rpc("loomic_provider_secret_delete", {
    p_secret_id: id,
  });
  if (error) throw persistenceError();
}

async function testConnection(
  fetchFn: typeof fetch,
  baseUrl: string,
  apiKey: string,
): Promise<ProviderTestErrorCode | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const response = await fetchFn(`${baseUrl}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      return "provider_redirect_not_allowed";
    }
    if (response.status === 401 || response.status === 403) {
      return "provider_auth_failed";
    }
    if (!response.ok) return "provider_connection_failed";
    const raw = await readBoundedResponseText(response, MAX_MODEL_LIST_RESPONSE_BYTES);
    if (raw === null) return "provider_response_too_large";
    // A successful HTTP status alone must not publish an HTML login/error page
    // as a healthy provider.  The bounded body must be a JSON model-list shape.
    if (!isJsonContentType(response.headers.get("content-type")) || !isModelListJson(raw)) {
      return "provider_connection_failed";
    }
    return undefined;
  } catch {
    return controller.signal.aborted
      ? "provider_connection_timeout"
      : "provider_connection_failed";
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponseText(response: Response, limit: number): Promise<string | null> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

function isJsonContentType(value: string | null) {
  return !!value && /^(application\/(?:json|[a-z0-9.+-]+\+json))(?:\s*;|\s*$)/i.test(value);
}

function isModelListJson(raw: string) {
  try {
    const body: unknown = JSON.parse(raw);
    return typeof body === "object" && body !== null && "data" in body &&
      Array.isArray((body as { data?: unknown }).data);
  } catch { return false; }
}

function mapViews(
  configs: Record<string, unknown>[],
  models: Record<string, unknown>[],
) {
  const modelsByConfig = new Map<string, WorkspaceProviderModelView[]>();
  for (const row of models) {
    const configId = row.provider_config_id as string;
    const model = {
      id: row.id as string,
      upstreamModelId: row.upstream_model_id as string,
      displayName: row.display_name as string,
      modality: row.modality as WorkspaceProviderModelView["modality"],
      enabled: row.enabled === true,
      capabilities: (row.capabilities ?? []) as ProviderModelCapability[],
      ...(row.context_profile ? { contextProfile: modelContextProfileSchema.parse(row.context_profile) } : {}),
    };
    modelsByConfig.set(configId, [...(modelsByConfig.get(configId) ?? []), model]);
  }
  return configs.map((row): WorkspaceProviderConfigView => ({
    id: row.id as string,
    adapter: "openai_compatible",
    displayName: row.display_name as string,
    baseUrl: row.base_url as string,
    enabled: row.enabled === true,
    hasApiKey: typeof row.api_key_secret_id === "string",
    lastFour: row.api_key_last_four as string,
    models: modelsByConfig.get(row.id as string) ?? [],
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
    lastTestedAt: row.last_tested_at == null
      ? null
      : normalizeTimestamp(row.last_tested_at),
    lastTestStatus: row.last_test_status as WorkspaceProviderConfigView["lastTestStatus"],
  }));
}

function getSingleView(views: WorkspaceProviderConfigView[], id: string) {
  const view = views.find((item) => item.id === id);
  if (!view) throw persistenceError();
  return view;
}

function lastFour(secret: string) {
  return secret.slice(-4);
}

function normalizeTimestamp(value: unknown) {
  if (typeof value !== "string") return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function invalidRequest(message: string) {
  return new ProviderConfigServiceError(
    "provider_invalid_request",
    message,
    400,
  );
}

function mapWriteError(error: { code?: string } | null) {
  return error?.code === "23505"
    ? new ProviderConfigServiceError(
        "provider_conflict",
        "Provider configuration already exists.",
        409,
      )
    : persistenceError();
}

function persistenceError() {
  return new ProviderConfigServiceError(
    "provider_persistence_failed",
    "Unable to persist provider configuration.",
    500,
  );
}
