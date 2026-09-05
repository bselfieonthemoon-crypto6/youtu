import { randomUUID } from "node:crypto";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import type {
  CreateProviderConfigInput,
  ProviderConfigService,
  ProviderConnectionTestResult,
  ProviderModelCapability,
  ProviderModelInput,
  ProviderTestErrorCode,
  UpdateProviderConfigInput,
  WorkspaceProviderConfigView,
  WorkspaceProviderModelView,
} from "./types.js";

const ALLOWED_HOSTS = new Set(["api.apiyi.com"]);
const MAX_RESPONSE_BYTES = 64 * 1024;
const TEST_TIMEOUT_MS = 8_000;

const CONFIG_COLUMNS =
  "id, workspace_id, adapter, display_name, base_url, enabled, api_key_secret_id, api_key_last_four, revision, last_tested_at, last_test_status, created_at, updated_at";
const MODEL_COLUMNS =
  "id, provider_config_id, upstream_model_id, display_name, modality, enabled, capabilities";

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

export function createProviderConfigService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  fetchFn?: typeof fetch;
  idFactory?: () => string;
  now?: () => string;
}): ProviderConfigService {
  const fetchFn = options.fetchFn ?? fetch;
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  async function requireManager(user: AuthenticatedUser, workspaceId: string) {
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

  async function listAuthorized(workspaceId: string) {
    const admin = options.getAdminClient();
    const configsResult = await (admin.from("workspace_provider_configs") as any)
      .select(CONFIG_COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true });
    if (configsResult.error) throw persistenceError();
    const configs = (configsResult.data ?? []) as Record<string, unknown>[];
    if (configs.length === 0) return [];
    const modelsResult = await (admin.from("workspace_provider_models") as any)
      .select(MODEL_COLUMNS)
      .in("provider_config_id", configs.map((row) => row.id));
    if (modelsResult.error) throw persistenceError();
    return mapViews(configs, (modelsResult.data ?? []) as Record<string, unknown>[]);
  }

  async function findConfig(workspaceId: string, configId: string) {
    const { data, error } = await (options
      .getAdminClient()
      .from("workspace_provider_configs") as any)
      .select(CONFIG_COLUMNS)
      .eq("workspace_id", workspaceId)
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
    workspaceId: string,
    configId: string,
    actorId: string,
    action: "created" | "updated" | "key_rotated" | "test_succeeded" | "test_failed",
    safeDetails: Record<string, unknown> = {},
  ) {
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
            workspace_id: workspaceId,
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
      const errorCode = await testConnection(fetchFn, baseUrl, apiKey);
      const ok = errorCode === undefined;
      const admin = options.getAdminClient();
      const { error } = await (admin.from("workspace_provider_configs") as any)
        .update({
          last_tested_at: testedAt,
          last_test_status: ok ? "succeeded" : "failed",
          last_test_error_code: errorCode ?? null,
          updated_by: user.id,
        })
        .eq("id", configId)
        .eq("workspace_id", workspaceId);
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
      return discoverProviderModels(fetchFn, baseUrl, apiKey);
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
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES * 8) {
    throw discoveryError("Provider model response is too large.");
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
  const ids = [...new Set(rows.map((row) =>
    typeof row === "object" && row && "id" in row
      ? String((row as { id: unknown }).id).trim()
      : "",
  ).filter(Boolean))].slice(0, 500);
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

function normalizeDisplayName(value: string) {
  const result = value?.trim();
  if (!result || result.length > 100) throw invalidRequest("Invalid display name.");
  return result;
}

export function normalizeBaseUrl(value: unknown): string {
  try {
    if (typeof value !== "string" || value.length > 500) throw new Error();
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && url.port !== "443") ||
      !ALLOWED_HOSTS.has(url.hostname.toLowerCase()) ||
      !["/", "/v1", ""].includes(url.pathname.replace(/\/$/, "") || "/")
    ) throw new Error();
    url.hostname = url.hostname.toLowerCase();
    url.port = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
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
    return {
      upstreamModelId,
      displayName,
      modality: model.modality,
      enabled: model.enabled === true,
      ...(model.capabilities
        ? { capabilities: validateCapabilities(model.capabilities) }
        : {}),
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
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      return "provider_response_too_large";
    }
    if (response.body) {
      const reader = response.body.getReader();
      let total = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return "provider_response_too_large";
        }
      }
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
