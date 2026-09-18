import { modelContextProfileSchema } from "@loomic/shared";
import { type WorkspaceVisionModel, createWorkspaceVisionModel } from "../src/agent/workspace-vision-model.js";
import { resolveContextModelProfile, type ContextModelProfile } from "../src/agent/context-budget.js";
import { loadServerEnv } from "../src/config/env.js";
import { createWorkspaceModelCatalogService } from "../src/features/providers/workspace-model-catalog-service.js";
import { resolveChatSelection } from "../src/features/providers/resolve-chat-selection.js";
import { createAdminSupabaseClient, type AdminSupabaseClient } from "../src/supabase/admin.js";

// This opt-in evaluator is deliberately scoped to the existing local fixture.
// Importing this module performs no I/O. Only the caller may invoke the model.
const WORKSPACE_ID = "25eb32ef-ff55-4de7-8c10-9390a51ece06";
const ACTOR_ID = "541006fa-d2a1-4305-be55-b6263c27a1e3";
const MAX_PROCESS_TEXT_CALLS = 80;
const TEXT_REQUEST_FIELDS = new Set([
  "model", "messages", "temperature", "top_p", "frequency_penalty", "presence_penalty", "logit_bias", "stop", "user", "seed",
  "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls",
  "response_format", "n", "logprobs", "top_logprobs", "service_tier", "reasoning_effort", "prompt_cache_key", "prompt_cache_retention", "verbosity", "thinking",
]);
let processTextCalls = 0;

export type ResolvedIntentEvalModel = {
  model: WorkspaceVisionModel;
  modelRef: string;
  upstreamModel: string;
  source: "workspace_provider_config" | "workspace_settings_apiyi" | "environment_default";
  contextProfile: ContextModelProfile | null;
};

export class IntentLiveModelError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "IntentLiveModelError";
  }
}

/**
 * Read current settings/catalog credentials using the existing server-only
 * Vault read RPC. Never creates runs, snapshots, audit rows, or image jobs.
 */
export async function resolveCurrentIntentEvalModel(options: {
  /** Explicit opt-in permits schema-only routing probes; no handlers are installed. */
  onlyForToolRoutingProbe?: boolean;
  /** Isolated Agent evals may send prior tool calls/results back to the text
   * model. This permits only transcript syntax; tool capability still requires
   * the separate routing-probe opt-in above. */
  allowToolTranscript?: boolean;
  /** Production compaction uses a bounded 6k summary reserve. Default probes
   * remain capped at 2k. */
  allowAgentSummaryOutput?: boolean;
  /** One finite multi-turn acceptance may need more calls than independent
   * probes. The hard ceiling remains 120 physical text requests per process. */
  maximumProcessTextCalls?: number;
} = {}): Promise<ResolvedIntentEvalModel> {
  const env = loadServerEnv();
  assertLocalDatabase(env.supabaseUrl);
  const admin = createAdminSupabaseClient(env);
  await requireLocalManager(admin);
  const configured = await readDefaultModel(admin);
  const fallback = env.agentModel.includes(":") ? env.agentModel : `apiyi:${env.agentModel}`;
  const catalog = createWorkspaceModelCatalogService({ getAdminClient: () => admin });
  const actor = { id: ACTOR_ID, accessToken: "", email: "", userMetadata: {} };
  // Diagnostics must follow production Auto routing, never resurrect an
  // unpublished historical env default just because this is a test harness.
  const modelRef = await resolveChatSelection({ user: actor, workspaceId: WORKSPACE_ID,
    defaultModel: configured ?? fallback, catalog });
  if (!modelRef) throw failure("intent_eval_model_not_available");
  let upstreamModel: string;
  let apiKey: string;
  let baseUrl: string;
  let source: ResolvedIntentEvalModel["source"];
  let contextProfile: ContextModelProfile | null = null;
  let assertProviderCurrent: () => Promise<void> = async () => {};

  if (modelRef.startsWith("workspace:")) {
    const resolved = await catalog.resolvePublishedModel(actor, WORKSPACE_ID, modelRef, "text").catch(() => null);
    if (!resolved || !resolved.capabilities.includes("text")) throw failure("intent_eval_model_not_available");
    const config = await readProviderConfig(admin, resolved.providerConfigId);
    if (config.revision !== resolved.revision) throw failure("intent_eval_config_changed");
    const modelResult = await (admin.from("workspace_provider_models") as any)
      .select("upstream_model_id, context_profile, modality, capabilities, enabled")
      .eq("catalog_key", resolved.catalogKey).eq("provider_config_id", resolved.providerConfigId).maybeSingle();
    if (modelResult.error || !modelResult.data || modelResult.data.enabled !== true || modelResult.data.modality !== "text" ||
      !modelResult.data.capabilities?.includes("text") || modelResult.data.upstream_model_id !== resolved.upstreamModelId)
      throw failure("intent_eval_model_not_available");
    const profile = modelContextProfileSchema.nullable().safeParse(modelResult.data.context_profile ?? null);
    if (!profile.success) throw failure("intent_eval_context_profile_invalid");
    contextProfile = profile.data;
    // Same read-only RPC used by provider-config-service.readVaultSecret.
    // Do not use createRunSnapshot/resolveRunSnapshot: creating one would mutate DB.
    const secret = await (admin.rpc as any)("loomic_provider_secret_read", { p_secret_id: config.secretId });
    if (secret.error || typeof secret.data !== "string" || !secret.data) throw failure("intent_eval_secret_unavailable");
    apiKey = secret.data;
    upstreamModel = resolved.upstreamModelId;
    baseUrl = config.baseUrl;
    source = "workspace_provider_config";
    assertProviderCurrent = async () => {
      const current = await readProviderConfig(admin, resolved.providerConfigId);
      const currentModel = await catalog.resolvePublishedModel(actor, WORKSPACE_ID, modelRef, "text").catch(() => null);
      if (current.revision !== config.revision || current.baseUrl !== config.baseUrl || current.secretId !== config.secretId ||
        !currentModel || currentModel.revision !== resolved.revision || currentModel.upstreamModelId !== upstreamModel ||
        !currentModel.capabilities.includes("text")) throw failure("intent_eval_config_changed");
    };
  } else {
    // Do not use createStreamingChatModel's legacy-provider substitution here.
    // An unsupported explicit selection must fail, never silently switch models.
    if (!modelRef.startsWith("apiyi:") || !/^apiyi:[^\s:]+$/.test(modelRef)) throw failure("intent_eval_model_not_available");
    if (!configured && modelRef !== fallback) throw failure("intent_eval_default_model_mismatch");
    if (!env.apiYiApiKey) throw failure("intent_eval_secret_unavailable");
    upstreamModel = modelRef.slice("apiyi:".length);
    if (/(?:^|[-_/])(image|imagen|dall-e|flux|seedream|banana|video|veo|sora|kling|hailuo|seedance)(?:$|[-_/\d])/i.test(upstreamModel))
      throw failure("intent_eval_text_model_required");
    apiKey = env.apiYiApiKey;
    baseUrl = env.apiYiApiBase ?? "https://api.apiyi.com/v1";
    source = configured ? "workspace_settings_apiyi" : "environment_default";
    contextProfile = resolveContextModelProfile(modelRef, process.env.LOOMIC_MODEL_CONTEXT_PROFILES_JSON, upstreamModel) ?? null;
  }
  const expectedEndpoint = textEndpoint(baseUrl);
  const maximumProcessTextCalls = options.maximumProcessTextCalls ?? MAX_PROCESS_TEXT_CALLS;
  if (!Number.isInteger(maximumProcessTextCalls) || maximumProcessTextCalls < 1 || maximumProcessTextCalls > 120)
    throw failure("intent_eval_call_limit_invalid");
  const recheckSelection = async () => {
    await requireLocalManager(admin);
    if (await readDefaultModel(admin) !== configured) throw failure("intent_eval_config_changed");
    if (await resolveChatSelection({ user: actor, workspaceId: WORKSPACE_ID,
      defaultModel: configured ?? fallback, catalog }) !== modelRef) throw failure("intent_eval_config_changed");
    await assertProviderCurrent();
  };
  await recheckSelection();
  const guardedFetch = createIntentEvalTextFetch({
    endpoint: expectedEndpoint, upstreamModel,
    onlyForToolRoutingProbe: options.onlyForToolRoutingProbe === true,
    allowToolTranscript: options.allowToolTranscript === true,
    maximumOutputTokens: options.allowAgentSummaryOutput === true ? 6_000 : 2_000,
    beforeRequest: recheckSelection,
    takeCallAllowance: () => {
      if (processTextCalls >= maximumProcessTextCalls) throw failure("intent_eval_call_limit_exceeded");
      processTextCalls += 1;
    },
  });
  // The guarded fetch IS the transport here: it pins the exact endpoint, method
  // and payload shape, so the abstraction must not add a second confinement
  // layer that would rewrite the URL this guard compares against.
  const model = createWorkspaceVisionModel({
    apiKey, baseUrl, upstreamModelId: upstreamModel,
    ...(contextProfile ? { contextProfile } : {}),
  }, { temperature: 0, fetch: guardedFetch });
  const result = { modelRef, upstreamModel, source, contextProfile } as ResolvedIntentEvalModel;
  // A generic report JSON must not accidentally serialize the credential-bearing client.
  Object.defineProperty(result, "model", { value: model, enumerable: false });
  return result;
}

/** Guard remains active if callers bind tools/config or try another SDK route. */
export function createIntentEvalTextFetch(options: {
  endpoint: string;
  upstreamModel: string;
  onlyForToolRoutingProbe?: boolean;
  allowToolTranscript?: boolean;
  maximumOutputTokens?: number;
  beforeRequest?: () => Promise<void>;
  takeCallAllowance?: () => void;
  fetchFn?: typeof fetch;
}): typeof fetch {
  const expected = textEndpoint(options.endpoint.replace(/\/chat\/completions$/, ""));
  const fetchFn = options.fetchFn ?? fetch;
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? String(input);
    if (url !== expected || (init?.method ?? request?.method ?? "GET").toUpperCase() !== "POST")
      throw failure("intent_eval_endpoint_blocked");
    let body: Record<string, any>;
    try {
      const raw = init?.body ?? (request ? await request.clone().text() : "");
      if (typeof raw !== "string") throw failure("intent_eval_payload_blocked");
      body = JSON.parse(raw);
    } catch { throw failure("intent_eval_payload_blocked"); }
    if (!body || Array.isArray(body) || typeof body !== "object" || body.model !== options.upstreamModel ||
      body.stream !== false || body.temperature !== 0 || (body.n !== undefined && body.n !== 1))
      throw failure("intent_eval_payload_blocked");
    if (Object.keys(body).some(key => !TEXT_REQUEST_FIELDS.has(key))) throw failure("intent_eval_payload_blocked");
    if (body.thinking !== undefined && (!/^deepseek-v4(?:-|$)/i.test(options.upstreamModel)
      || JSON.stringify(body.thinking) !== JSON.stringify({ type: "disabled" }))) throw failure("intent_eval_payload_blocked");
    const outputKeys = ["max_tokens", "max_completion_tokens"].filter(key => body[key] !== undefined);
    const maximumOutputTokens = options.maximumOutputTokens ?? 2_000;
    if (!Number.isInteger(maximumOutputTokens) || maximumOutputTokens < 1 || maximumOutputTokens > 6_000 ||
      outputKeys.length !== 1 || !Number.isInteger(body[outputKeys[0]!]) || body[outputKeys[0]!] < 1 || body[outputKeys[0]!] > maximumOutputTokens ||
      body.max_output_tokens !== undefined) throw failure("intent_eval_output_limit_required");
    const validTextContent = (content: unknown) => typeof content === "string" || (Array.isArray(content) && content.every((part: any) =>
      part?.type === "text" && typeof part.text === "string" && Object.keys(part).every(key => ["type", "text"].includes(key))));
    const validToolCalls = (calls: unknown) => Array.isArray(calls) && calls.length > 0 && calls.every((call: any) =>
      call && call.type === "function" && typeof call.id === "string" && call.function && typeof call.function.name === "string" &&
      typeof call.function.arguments === "string" && Object.keys(call).every(key => ["id", "type", "function"].includes(key)) &&
      Object.keys(call.function).every(key => ["name", "arguments"].includes(key)));
    const validMessage = (message: any) => {
      if (!message || message.function_call) return false;
      if (options.allowToolTranscript && message.role === "tool")
        return typeof message.content === "string" && typeof message.tool_call_id === "string" &&
          Object.keys(message).every(key => ["role", "content", "name", "tool_call_id"].includes(key));
      if (!["system", "developer", "user", "assistant"].includes(message.role)) return false;
      const hasToolCalls = message.tool_calls !== undefined;
      if (hasToolCalls && (!options.allowToolTranscript || message.role !== "assistant" || !validToolCalls(message.tool_calls))) return false;
      if (!(validTextContent(message.content) || (hasToolCalls && message.content === null))) return false;
      return Object.keys(message).every(key => ["role", "content", "name", ...(hasToolCalls ? ["tool_calls"] : [])].includes(key));
    };
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.some((message: any) => !validMessage(message)))
      throw failure("intent_eval_text_only");
    if (body.functions !== undefined || body.function_call !== undefined || body.modalities !== undefined || body.audio !== undefined)
      throw failure("intent_eval_payload_blocked");
    // The production isolated reviewer explicitly disables tools on its config.
    // Empty schemas + choice=none confer no tool capability; real schemas remain opt-in.
    if (!options.onlyForToolRoutingProbe && ((body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0))
      || (body.tool_choice !== undefined && body.tool_choice !== "none")
      || (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== false)))
      throw failure("intent_eval_tools_blocked");
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool: any) => tool?.type !== "function" ||
      typeof tool.function?.name !== "string" || !tool.function.parameters || typeof tool.function.parameters !== "object" || Array.isArray(tool.function.parameters))))
      throw failure("intent_eval_tools_blocked");
    await options.beforeRequest?.();
    options.takeCallAllowance?.();
    let response: Response;
    try { response = await fetchFn(input, { ...init, redirect: "error" }); }
    catch { throw failure("intent_eval_text_request_failed"); }
    // Never include provider error bodies, prompts, endpoint URLs, or headers.
    if (!response.ok) throw new IntentLiveModelError("intent_eval_text_request_failed", response.status);
    return response;
  }) as typeof fetch;
}

async function requireLocalManager(admin: AdminSupabaseClient) {
  const result = await admin.from("workspace_members").select("role").eq("workspace_id", WORKSPACE_ID).eq("user_id", ACTOR_ID).maybeSingle();
  if (result.error || !result.data || !["owner", "admin"].includes(result.data.role)) throw failure("intent_eval_workspace_forbidden");
}

async function readDefaultModel(admin: AdminSupabaseClient): Promise<string | null> {
  const result = await admin.from("workspace_settings").select("default_model").eq("workspace_id", WORKSPACE_ID).maybeSingle();
  if (result.error) throw failure("intent_eval_settings_unavailable");
  const model = result.data?.default_model;
  if (model === null || model === undefined || model === "") return null;
  if (typeof model !== "string" || !model.trim()) throw failure("intent_eval_settings_invalid");
  return model;
}

async function readProviderConfig(admin: AdminSupabaseClient, configId: string) {
  const result = await (admin.from("workspace_provider_configs") as any)
    .select("id, revision, adapter, base_url, api_key_secret_id, enabled, last_test_status")
    .eq("id", configId).eq("workspace_id", WORKSPACE_ID).maybeSingle();
  const value = result.data;
  if (result.error || !value || value.enabled !== true || value.last_test_status !== "succeeded" || value.adapter !== "openai_compatible" ||
    !Number.isInteger(value.revision) || typeof value.base_url !== "string" || typeof value.api_key_secret_id !== "string")
    throw failure("intent_eval_model_not_available");
  textEndpoint(value.base_url);
  return { revision: value.revision as number, baseUrl: value.base_url as string, secretId: value.api_key_secret_id as string };
}

function textEndpoint(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw failure("intent_eval_endpoint_blocked"); }
  // Match the existing workspace provider allowlist without substituting an origin.
  if (url.protocol !== "https:" || url.hostname !== "api.apiyi.com" || url.port || url.username || url.password || url.search || url.hash)
    throw failure("intent_eval_endpoint_blocked");
  return `${url.href.replace(/\/+$/, "")}/chat/completions`;
}

function assertLocalDatabase(value?: string) {
  try {
    const url = new URL(value ?? "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol)) throw failure("intent_eval_local_database_required");
  } catch { throw failure("intent_eval_local_database_required"); }
}

function failure(code: string) { return new IntentLiveModelError(code); }
