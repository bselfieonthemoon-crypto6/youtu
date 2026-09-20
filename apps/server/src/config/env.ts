import { readFileSync } from "node:fs";

export const DEFAULT_APIYI_AGENT_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_AGENT_MODEL = `apiyi:${DEFAULT_APIYI_AGENT_MODEL}`;
export const DEFAULT_SERVER_PORT = 3001;
export const DEFAULT_WEB_ORIGIN = "http://localhost:3000";
/**
 * Bucket the health endpoint's storage probe checks. `workspace-assets` is where
 * ordinary uploads land; a deployment can point `LOOMIC_STORAGE_HEALTH_BUCKET`
 * at whichever bucket its own traffic uses.
 */
export const DEFAULT_STORAGE_HEALTH_BUCKET = "workspace-assets";

/** Resolve the single environment-backed text model through APIYI. */
export function resolveDefaultAgentModel(_env: {
  apiYiApiKey?: string | undefined;
}): string {
  return DEFAULT_AGENT_MODEL;
}

export type ServerEnv = {
  /** Keep the bounded Mastra omitted-write recovery enabled unless explicitly disabled. */
  mastraWriteRepairEnabled?: boolean;
  /** Require a tool on the first recovery step unless explicitly disabled. */
  mastraWriteRepairToolChoice?: boolean;
  designImportRoot?: string;
  agentModel: string;
  apiYiApiBase?: string;
  apiYiApiKey?: string;
  googleApiKey?: string;
  googleApplicationCredentials?: string;
  googleFontsApiKey?: string;
  googleVertexLocation?: string;
  googleVertexProject?: string;
  googleVertexVideoLocation?: string;
  metasoApiBase?: string;
  metasoApiKey?: string;
  openAIApiBase?: string;
  openAIApiKey?: string;
  port: number;
  replicateApiToken?: string;
  supabaseAnonKey?: string;
  supabaseDbUrl?: string;
  supabaseJwtSecret?: string;
  supabaseProjectId?: string;
  supabaseServiceRoleKey?: string;
  supabaseUrl?: string;
  version: string;
  volcesApiKey?: string;
  volcesBaseUrl?: string;
  lemonSqueezyApiKey?: string;
  lemonSqueezyStoreId?: string;
  lemonSqueezyWebhookSecret?: string;
  lemonSqueezyVariantStarterMonthly?: string;
  lemonSqueezyVariantStarterYearly?: string;
  lemonSqueezyVariantProMonthly?: string;
  lemonSqueezyVariantProYearly?: string;
  lemonSqueezyVariantUltraMonthly?: string;
  lemonSqueezyVariantUltraYearly?: string;
  lemonSqueezyVariantBusinessMonthly?: string;
  lemonSqueezyVariantBusinessYearly?: string;
  skillsRoot?: string;
  /**
   * Bucket the health endpoint probes through the authenticated storage client.
   * `loadServerEnv` always fills it (default `workspace-assets`); it is optional
   * here so test fixtures that only care about one field do not have to carry it.
   */
  storageHealthBucket?: string;
  webOrigin: string;
  workerConcurrency?: number;
  workerImageConcurrency?: number;
  workerVideoConcurrency?: number;
  workerId?: string;
  workerPollIntervalMs?: number;
  workerMaxBatchSize?: number;
};

export function loadServerEnv(
  overrides: Partial<ServerEnv> = {},
  source: NodeJS.ProcessEnv = process.env,
): ServerEnv {
  const designImportRoot =
    overrides.designImportRoot ??
    normalizeOptionalString(source.LOOMIC_DESIGN_IMPORT_ROOT);
  const openAIApiBase =
    overrides.openAIApiBase ?? normalizeOptionalString(source.OPENAI_API_BASE);
  const openAIApiKey =
    overrides.openAIApiKey ?? normalizeOptionalString(source.OPENAI_API_KEY);
  const apiYiApiBase =
    overrides.apiYiApiBase ??
    normalizeOptionalString(source.APIYI_API_BASE) ??
    "https://api.apiyi.com/v1";
  const apiYiApiKey =
    overrides.apiYiApiKey ?? normalizeOptionalString(source.APIYI_API_KEY);
  const supabaseUrl =
    overrides.supabaseUrl ?? normalizeOptionalString(source.SUPABASE_URL);
  const supabaseAnonKey =
    overrides.supabaseAnonKey ??
    normalizeOptionalString(source.SUPABASE_ANON_KEY);
  const supabaseDbUrl =
    overrides.supabaseDbUrl ?? normalizeOptionalString(source.SUPABASE_DB_URL);
  const supabaseJwtSecret =
    overrides.supabaseJwtSecret ??
    normalizeOptionalString(source.SUPABASE_JWT_SECRET);
  const supabaseServiceRoleKey =
    overrides.supabaseServiceRoleKey ??
    normalizeOptionalString(source.SUPABASE_SERVICE_ROLE_KEY);
  const supabaseProjectId =
    overrides.supabaseProjectId ??
    normalizeOptionalString(source.SUPABASE_PROJECT_ID);
  const googleApiKey =
    overrides.googleApiKey ?? normalizeOptionalString(source.GOOGLE_API_KEY);
  const googleApplicationCredentials =
    overrides.googleApplicationCredentials ??
    normalizeOptionalString(source.GOOGLE_APPLICATION_CREDENTIALS);
  const googleFontsApiKey =
    overrides.googleFontsApiKey ??
    normalizeOptionalString(source.GOOGLE_FONTS_API_KEY);
  const googleVertexProject =
    overrides.googleVertexProject ??
    normalizeOptionalString(source.GOOGLE_VERTEX_PROJECT);
  const googleVertexLocation =
    overrides.googleVertexLocation ??
    normalizeOptionalString(source.GOOGLE_VERTEX_LOCATION);
  const googleVertexVideoLocation =
    overrides.googleVertexVideoLocation ??
    normalizeOptionalString(source.GOOGLE_VERTEX_VIDEO_LOCATION);
  const replicateApiToken =
    overrides.replicateApiToken ??
    normalizeOptionalString(source.REPLICATE_API_TOKEN);
  const metasoApiKey =
    overrides.metasoApiKey ?? normalizeOptionalString(source.METASO_API_KEY);
  const metasoApiBase =
    overrides.metasoApiBase ?? normalizeOptionalString(source.METASO_API_BASE);
  const volcesApiKey =
    overrides.volcesApiKey ?? normalizeOptionalString(source.VOLCES_API_KEY);
  const volcesBaseUrl =
    overrides.volcesBaseUrl ?? normalizeOptionalString(source.VOLCES_BASE_URL);
  const lemonSqueezyApiKey =
    overrides.lemonSqueezyApiKey ??
    normalizeOptionalString(source.LEMONSQUEEZY_API_KEY);
  const lemonSqueezyStoreId =
    overrides.lemonSqueezyStoreId ??
    normalizeOptionalString(source.LEMONSQUEEZY_STORE_ID);
  const lemonSqueezyWebhookSecret =
    overrides.lemonSqueezyWebhookSecret ??
    normalizeOptionalString(source.LEMONSQUEEZY_WEBHOOK_SECRET);
  const lemonSqueezyVariantStarterMonthly =
    overrides.lemonSqueezyVariantStarterMonthly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_STARTER_MONTHLY);
  const lemonSqueezyVariantStarterYearly =
    overrides.lemonSqueezyVariantStarterYearly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_STARTER_YEARLY);
  const lemonSqueezyVariantProMonthly =
    overrides.lemonSqueezyVariantProMonthly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_PRO_MONTHLY);
  const lemonSqueezyVariantProYearly =
    overrides.lemonSqueezyVariantProYearly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_PRO_YEARLY);
  const lemonSqueezyVariantUltraMonthly =
    overrides.lemonSqueezyVariantUltraMonthly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_ULTRA_MONTHLY);
  const lemonSqueezyVariantUltraYearly =
    overrides.lemonSqueezyVariantUltraYearly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_ULTRA_YEARLY);
  const lemonSqueezyVariantBusinessMonthly =
    overrides.lemonSqueezyVariantBusinessMonthly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_BUSINESS_MONTHLY);
  const lemonSqueezyVariantBusinessYearly =
    overrides.lemonSqueezyVariantBusinessYearly ??
    normalizeOptionalString(source.LEMONSQUEEZY_VARIANT_BUSINESS_YEARLY);
  const skillsRoot =
    overrides.skillsRoot ?? normalizeOptionalString(source.LOOMIC_SKILLS_ROOT);
  const storageHealthBucket =
    overrides.storageHealthBucket ??
    normalizeOptionalString(source.LOOMIC_STORAGE_HEALTH_BUCKET) ??
    DEFAULT_STORAGE_HEALTH_BUCKET;
  const workerConcurrency =
    overrides.workerConcurrency ??
    (source.WORKER_CONCURRENCY
      ? Number.parseInt(source.WORKER_CONCURRENCY, 10)
      : undefined);
  const workerImageConcurrency =
    overrides.workerImageConcurrency ??
    (source.WORKER_IMAGE_CONCURRENCY
      ? Number.parseInt(source.WORKER_IMAGE_CONCURRENCY, 10)
      : undefined);
  const workerVideoConcurrency =
    overrides.workerVideoConcurrency ??
    (source.WORKER_VIDEO_CONCURRENCY
      ? Number.parseInt(source.WORKER_VIDEO_CONCURRENCY, 10)
      : undefined);
  const workerId =
    overrides.workerId ?? normalizeOptionalString(source.WORKER_ID);
  const workerPollIntervalMs =
    overrides.workerPollIntervalMs ??
    (source.WORKER_POLL_INTERVAL_MS
      ? Number.parseInt(source.WORKER_POLL_INTERVAL_MS, 10)
      : undefined);
  const workerMaxBatchSize =
    overrides.workerMaxBatchSize ??
    (source.WORKER_MAX_BATCH_SIZE
      ? Number.parseInt(source.WORKER_MAX_BATCH_SIZE, 10)
      : undefined);
  const mastraWriteRepairEnabled =
    overrides.mastraWriteRepairEnabled ??
    parseBooleanEnv(source.LOOMIC_MASTRA_WRITE_REPAIR_ENABLED, true);
  const mastraWriteRepairToolChoice =
    overrides.mastraWriteRepairToolChoice ??
    parseBooleanEnv(source.LOOMIC_MASTRA_WRITE_REPAIR_TOOL_CHOICE, true);

  // Explicit LOOMIC_AGENT_MODEL takes precedence; the only environment-backed
  // fallback is the APIYI text model.
  const explicitModel =
    overrides.agentModel ?? parseAgentModel(source.LOOMIC_AGENT_MODEL);
  const resolvedAgentModel =
    explicitModel ?? resolveDefaultAgentModel({ apiYiApiKey });

  return {
    agentModel: resolvedAgentModel,
    mastraWriteRepairEnabled,
    mastraWriteRepairToolChoice,
    port: overrides.port ?? parsePort(source.LOOMIC_SERVER_PORT ?? source.PORT),
    version: overrides.version ?? readServerVersion(),
    webOrigin:
      overrides.webOrigin ?? source.LOOMIC_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN,
    ...(designImportRoot ? { designImportRoot } : {}),
    ...(googleApiKey ? { googleApiKey } : {}),
    ...(googleApplicationCredentials ? { googleApplicationCredentials } : {}),
    ...(openAIApiBase ? { openAIApiBase } : {}),
    ...(openAIApiKey ? { openAIApiKey } : {}),
    ...(apiYiApiBase ? { apiYiApiBase } : {}),
    ...(apiYiApiKey ? { apiYiApiKey } : {}),
    ...(supabaseUrl ? { supabaseUrl } : {}),
    ...(supabaseAnonKey ? { supabaseAnonKey } : {}),
    ...(supabaseDbUrl ? { supabaseDbUrl } : {}),
    ...(supabaseJwtSecret ? { supabaseJwtSecret } : {}),
    ...(supabaseServiceRoleKey ? { supabaseServiceRoleKey } : {}),
    ...(supabaseProjectId ? { supabaseProjectId } : {}),
    ...(googleFontsApiKey ? { googleFontsApiKey } : {}),
    ...(googleVertexProject ? { googleVertexProject } : {}),
    ...(googleVertexLocation ? { googleVertexLocation } : {}),
    ...(googleVertexVideoLocation ? { googleVertexVideoLocation } : {}),
    ...(replicateApiToken ? { replicateApiToken } : {}),
    ...(metasoApiKey ? { metasoApiKey } : {}),
    ...(metasoApiBase ? { metasoApiBase } : {}),
    ...(volcesApiKey ? { volcesApiKey } : {}),
    ...(volcesBaseUrl ? { volcesBaseUrl } : {}),
    ...(lemonSqueezyApiKey ? { lemonSqueezyApiKey } : {}),
    ...(lemonSqueezyStoreId ? { lemonSqueezyStoreId } : {}),
    ...(lemonSqueezyWebhookSecret ? { lemonSqueezyWebhookSecret } : {}),
    ...(lemonSqueezyVariantStarterMonthly
      ? { lemonSqueezyVariantStarterMonthly }
      : {}),
    ...(lemonSqueezyVariantStarterYearly
      ? { lemonSqueezyVariantStarterYearly }
      : {}),
    ...(lemonSqueezyVariantProMonthly ? { lemonSqueezyVariantProMonthly } : {}),
    ...(lemonSqueezyVariantProYearly ? { lemonSqueezyVariantProYearly } : {}),
    ...(lemonSqueezyVariantUltraMonthly
      ? { lemonSqueezyVariantUltraMonthly }
      : {}),
    ...(lemonSqueezyVariantUltraYearly
      ? { lemonSqueezyVariantUltraYearly }
      : {}),
    ...(lemonSqueezyVariantBusinessMonthly
      ? { lemonSqueezyVariantBusinessMonthly }
      : {}),
    ...(lemonSqueezyVariantBusinessYearly
      ? { lemonSqueezyVariantBusinessYearly }
      : {}),
    ...(skillsRoot ? { skillsRoot } : {}),
    storageHealthBucket,
    ...(workerConcurrency ? { workerConcurrency } : {}),
    ...(workerImageConcurrency ? { workerImageConcurrency } : {}),
    ...(workerVideoConcurrency ? { workerVideoConcurrency } : {}),
    ...(workerId ? { workerId } : {}),
    ...(workerPollIntervalMs ? { workerPollIntervalMs } : {}),
    ...(workerMaxBatchSize ? { workerMaxBatchSize } : {}),
  };
}

function parseAgentModel(rawModel: string | undefined) {
  return normalizeOptionalString(rawModel);
}

function parseBooleanEnv(rawValue: string | undefined, defaultValue: boolean): boolean {
  const value = rawValue?.trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Invalid boolean environment value: ${rawValue}`);
}

function normalizeOptionalString(value: string | undefined) {
  const normalizedValue = value?.trim();
  return normalizedValue || undefined;
}

function parsePort(rawPort: string | undefined) {
  if (!rawPort) {
    return DEFAULT_SERVER_PORT;
  }

  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid LOOMIC_SERVER_PORT value: ${rawPort}`);
  }

  return port;
}

function readServerVersion() {
  const packageJson = readFileSync(
    new URL("../../package.json", import.meta.url),
    "utf8",
  );

  const parsed = JSON.parse(packageJson) as { version?: string };
  return parsed.version ?? "0.0.0";
}
