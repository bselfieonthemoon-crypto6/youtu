import { z } from "zod";
import { agentCollaborationSettingsUpdateSchema } from "./agent-collaboration-contracts.js";

import {
  assetObjectSchema,
  canvasContentSchema,
  canvasDetailSchema,
  chatMessageSchema,
  chatSessionSummarySchema,
  modelInfoSchema,
  projectSummarySchema,
  runIdSchema,
  viewerProfileSchema,
  workspaceMembershipSchema,
  workspaceSettingsSchema,
  workspaceSummarySchema,
} from "./contracts.js";

/**
 * Health is a truthful liveness+readiness report, not a constant.
 *
 * The complaint that produced this contract: `/api/health` answered
 * `{ok:true}` while the database could not accept a message write, so every
 * monitor and acceptance script believed the stack was healthy. `ok` is now
 * derived from independently probed components.
 *
 * Vocabulary, fixed on purpose so the payload stays comparable across runs:
 *   - `ok`      : at least one CRITICAL component is `failed` (traffic cannot be
 *                 served). Degraded-but-serving is still `ok:true`, which keeps
 *                 the existing readiness probes (Playwright `webServer.url`,
 *                 `scripts/start-local-api.ps1`, the acceptance scripts) working
 *                 while still surfacing the problem in `components`.
 *   - `degraded`: the component works but is not fully healthy (an offline
 *                 worker on a laptop, a queue with a backlog).
 *   - `failed`  : the component did not answer its probe.
 *
 * `detail` is a short SANITIZED token list: no secrets, no provider text, no
 * stack traces. `latencyMs` is the measured probe duration.
 */
export const healthComponentStatusSchema = z.enum(["ok", "degraded", "failed"]);

export const healthComponentSchema = z.object({
  status: healthComponentStatusSchema,
  detail: z.string().min(1).max(200),
  latencyMs: z.number().int().nonnegative(),
});

export const healthComponentsSchema = z.object({
  /** A real WRITE (upsert) plus a read-back of the same row, not `select 1`. */
  database: healthComponentSchema,
  /** Mastra runtime mode plus the bound run factory/probe. */
  agentRuntime: healthComponentSchema,
  /** pgmq reachability and depth of the worker queues. */
  queue: healthComponentSchema,
  /** Authenticated storage call; its own timeout. */
  storage: healthComponentSchema,
  /** Freshest worker heartbeat row in `private.loomic_worker_heartbeats`. */
  worker: healthComponentSchema,
});

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.literal("loomic-server"),
  version: z.string().min(1),
  agentRuntime: z.literal("mastra"),
  components: healthComponentsSchema,
  /** Bounded server-side cache window, so a polling probe cannot stampede. */
  cached: z.boolean(),
  checkedAt: z.string().min(1),
});

export const runCancelResponseSchema = z.object({
  runId: runIdSchema,
  status: z.enum(["canceling", "canceled"]),
});

export const viewerCreditsSchema = z.object({
  balance: z.number().int(),
  plan: z.string(),
  dailyClaimed: z.boolean(),
  limits: z.object({
    maxConcurrentJobs: z.number().int(),
    maxResolution: z.string(),
    monthlyCredits: z.number().int(),
    dailyCredits: z.number().int(),
  }),
});

export const viewerResponseSchema = z.object({
  profile: viewerProfileSchema,
  workspace: workspaceSummarySchema,
  membership: workspaceMembershipSchema,
  credits: viewerCreditsSchema.optional(),
});

export const projectListResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
});

export const projectCreateRequestSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
});

export const projectCreateResponseSchema = z.object({
  project: projectSummarySchema,
});

export const unauthenticatedErrorResponseSchema = z.object({
  error: z.object({
    code: z.literal("unauthorized"),
    message: z.string().min(1),
  }),
});

export const applicationErrorCodeSchema = z.enum([
  "application_error",
  "bootstrap_failed",
  "brand_kit_not_found",
  "brand_kit_create_failed",
  "brand_kit_update_failed",
  "brand_kit_delete_failed",
  "brand_kit_query_failed",
  "brand_kit_asset_not_found",
  "brand_kit_asset_create_failed",
  "canvas_not_found",
  "canvas_save_failed",
  "chat_error",
  "profile_update_failed",
  "project_query_failed",
  "project_create_failed",
  "project_delete_failed",
  "project_not_found",
  "project_slug_taken",
  "project_update_failed",
  "session_not_found",
  "settings_not_found",
  "settings_update_failed",
  "settings_forbidden",
  "settings_model_not_accessible",
  "upload_failed",
  "asset_not_found",
  "job_not_found",
  "job_create_failed",
  "job_query_failed",
  "job_cancel_failed",
  "skill_not_found",
  "skill_create_failed",
  "skill_update_failed",
  "skill_delete_failed",
  "skill_query_failed",
  "skill_install_failed",
  "skill_uninstall_failed",
  "skill_toggle_failed",
  "skill_import_failed",
  "skill_file_query_failed",
  "skill_forbidden",
  "skill_conflict",
  "skill_invalid_package",
  "skill_invalid_request",
  "skill_save_failed",
  "marketplace_search_failed",
  "marketplace_detail_failed",
  "marketplace_install_failed",
  "marketplace_failed",
  "marketplace_invalid_request",
  "insufficient_credits",
  "credit_query_failed",
  "credit_claim_failed",
  "credit_deduct_failed",
  "credit_refund_failed",
  "credit_plan_update_failed",
  "model_not_accessible",
  "resolution_not_allowed",
  "concurrency_limit",
  "variant_not_found",
  "checkout_failed",
  "generation_failed",
  "provider_snapshot_invalid",
  "provider_snapshot_unavailable",
]);

export const applicationErrorResponseSchema = z.object({
  error: z.object({
    code: applicationErrorCodeSchema,
    message: z.string().min(1),
  }),
});

export const canvasGetResponseSchema = z.object({
  canvas: canvasDetailSchema,
});

export const canvasSaveRequestSchema = z.object({
  content: canvasContentSchema,
});

export const canvasSaveResponseSchema = z.object({
  ok: z.literal(true),
  revision: z.number().int().nonnegative(),
});

export type HealthComponentStatus = z.infer<typeof healthComponentStatusSchema>;
export type HealthComponent = z.infer<typeof healthComponentSchema>;
export type HealthComponents = z.infer<typeof healthComponentsSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type RunCancelResponse = z.infer<typeof runCancelResponseSchema>;
export type ViewerCredits = z.infer<typeof viewerCreditsSchema>;
export type ViewerResponse = z.infer<typeof viewerResponseSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>;
export type ProjectCreateResponse = z.infer<typeof projectCreateResponseSchema>;
export type UnauthenticatedErrorResponse = z.infer<
  typeof unauthenticatedErrorResponseSchema
>;
export type ApplicationErrorCode = z.infer<typeof applicationErrorCodeSchema>;
export type ApplicationErrorResponse = z.infer<
  typeof applicationErrorResponseSchema
>;
export const profileUpdateResponseSchema = z.object({
  profile: viewerProfileSchema,
});

export const workspaceSettingsResponseSchema = z.object({
  settings: workspaceSettingsSchema,
});

export const workspaceSettingsUpdateRequestSchema = workspaceSettingsSchema.partial()
  .extend({ agentCollaboration: agentCollaborationSettingsUpdateSchema.optional() }).strict()
  .refine(value => value.defaultModel !== undefined || value.agentCollaboration !== undefined, "At least one setting is required.");

export const modelListResponseSchema = z.object({
  models: z.array(modelInfoSchema),
});

export const sessionListResponseSchema = z.object({
  sessions: z.array(chatSessionSummarySchema),
});

export const sessionCreateResponseSchema = z.object({
  session: chatSessionSummarySchema,
});

export const messageListResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
});

export const messageCreateResponseSchema = z.object({
  message: chatMessageSchema,
});

export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type SessionCreateResponse = z.infer<typeof sessionCreateResponseSchema>;
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;
export type MessageCreateResponse = z.infer<typeof messageCreateResponseSchema>;
export type CanvasGetResponse = z.infer<typeof canvasGetResponseSchema>;
export type CanvasSaveRequest = z.infer<typeof canvasSaveRequestSchema>;
export type CanvasSaveResponse = z.infer<typeof canvasSaveResponseSchema>;
export type ProfileUpdateResponse = z.infer<typeof profileUpdateResponseSchema>;
export type WorkspaceSettingsResponse = z.infer<typeof workspaceSettingsResponseSchema>;
export type WorkspaceSettingsUpdateRequest = z.infer<typeof workspaceSettingsUpdateRequestSchema>;
export type ModelListResponse = z.infer<typeof modelListResponseSchema>;

export const uploadResponseSchema = z.object({
  asset: assetObjectSchema,
  url: z.string().min(1),
});

export const assetSignedUrlResponseSchema = z.object({
  url: z.string().min(1),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
export type AssetSignedUrlResponse = z.infer<typeof assetSignedUrlResponseSchema>;

export const projectUpdateRequestSchema = z.object({
  brand_kit_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(100).optional(),
});
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;
