import { isDeepStrictEqual } from "node:util";
import { authorizeConversationImageJobs, ImageJobAccessError, scopeConversationImageJobs,
  type ConversationImageJobScope } from "./conversation-image-job-access.js";

import type {
  BackgroundJob,
  BackgroundJobStatus,
  BackgroundJobType,
  DesignJobTarget,
  JobTarget,
  JobTargetFinalizationDto,
  Json,
} from "@loomic/shared";
import {
  canvasJobTargetSchema,
  designJobTargetSchema,
  imageForegroundPolicySchema,
  jobTargetFinalizationDtoSchema,
  jobTargetSchema,
  loomicSceneV1Schema,
  isUuid,
} from "@loomic/shared";

import type { PgmqClient } from "../../queue/pgmq-client.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import type { ProviderSnapshotService } from "../providers/provider-snapshot-service.js";
import type { ProviderExecutionBillingSnapshot } from "../providers/provider-snapshot-service.js";
import { CreditServiceError } from "../credits/credit-service.js";
import {
  normalizeGenerationPayloadForCreation,
  targetColumns,
} from "./design-target-normalizer.js";

// Queue name mapping
const QUEUE_MAP: Record<BackgroundJobType, string> = {
  image_generation: "image_generation_jobs",
  video_generation: "video_generation_jobs",
  code_execution: "code_execution_jobs",
  design_preview: "design_preview_jobs",
  design_export: "design_export_jobs",
  design_resource_import: "design_resource_import_jobs",
};

export class JobServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "job_not_found"
    | "job_create_failed"
    | "job_query_failed"
    | "job_cancel_failed"
    | "job_attempt_increment_failed"
    | "mastra_commit_rejected"
    | "mastra_commit_unknown"
    | "video_commit_rejected"
    | "video_commit_unknown"
    | "image_generation_run_limit"
    | "image_quality_not_authorized"
    | "image_resolution_not_authorized"
    | "image_generation_requested_count_unsupported"
    | "image_execution_tier_invalid"
    | "image_legacy_background_removal_contract_required";

  constructor(
    code: JobServiceError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "JobServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type CreateJobInput = {
  /** Internal durable image proposal ID, never sourced from an HTTP job payload. */
  proposalId?: string;
  workspaceId: string;
  projectId?: string;
  canvasId?: string;
  target?: JobTarget | null;
  sessionId?: string;
  threadId?: string;
  jobType: BackgroundJobType;
  payload: Record<string, unknown>;
  /** Create the durable record without publishing to PGMQ. Defaults to false. */
  deferEnqueue?: boolean;
  providerBilling?: ProviderExecutionBillingSnapshot;
  /** Server-owned Mastra submission identity. Never accepted from a tool call. */
  mastraSubmission?: { runId: string; key: string; defaultRunLimit?: number };
  /** Server-owned durable video identity. Never accepted from an HTTP body or tool call. */
  videoSubmission?:
    | { kind: "mastra"; runId: string; key: string }
    | { kind: "http"; key: string };
};

export type JobService = {
  /** Server-trusted lookup; agent_runs intentionally has no authenticated RLS policy. */
  assertMastraImageRun(user: AuthenticatedUser, input: {
    runId: string;
    sessionId: string;
  }): Promise<{ requestMessageId: string }>;
  /** Validate a native design target before any provider snapshot or billing. */
  assertMastraDesignImageTarget(user: AuthenticatedUser, input: {
    workspaceId: string;
    canvasId: string;
    target: DesignJobTarget;
  }): Promise<DesignJobTarget>;
  /** Read an already-created direct image job without rerunning mutable preflight checks. */
  findMastraImageSubmission(user: AuthenticatedUser, input: {
    workspaceId: string;
    sessionId: string;
    canvasId: string;
    runId: string;
    submissionKey: string;
    designId?: string;
  }): Promise<BackgroundJob | null>;
  commitImageJob(user: AuthenticatedUser, jobId: string): Promise<void>;
  commitMastraImageJob(user: AuthenticatedUser, input: {
    jobId: string;
    runId: string;
    submissionKey: string;
    creditsCost: number;
  }): Promise<void>;
  /** CAS compensation: never cancels a job that may already be published or running. */
  cancelUncommittedMastraImageJob(user: AuthenticatedUser, input: {
    jobId: string;
    runId: string;
    submissionKey: string;
  }): Promise<boolean>;
  findVideoSubmission(user: AuthenticatedUser, input: {
    workspaceId: string;
    submissionKey: string;
    kind: "mastra" | "http";
    sessionId?: string;
    canvasId?: string;
    runId?: string;
    expectedPayload?: Record<string, unknown>;
  }): Promise<BackgroundJob | null>;
  commitVideoJob(user: AuthenticatedUser, input: {
    jobId: string;
    submissionKey: string;
    creditsCost: number;
    runId?: string;
  }): Promise<void>;
  /** CAS compensation: only an unpublished durable video submission is cancelable. */
  cancelUncommittedVideoJob(user: AuthenticatedUser, input: {
    jobId: string;
    submissionKey: string;
  }): Promise<boolean>;
  resolveDesignOperationTarget(
    user: AuthenticatedUser,
    target: DesignJobTarget,
  ): Promise<{
    workspaceId: string;
    projectId: string;
    target: DesignJobTarget;
  }>;
  createJob(
    user: AuthenticatedUser,
    input: CreateJobInput,
  ): Promise<BackgroundJob>;
  createJobWithReplay(
    user: AuthenticatedUser,
    input: CreateJobInput,
  ): Promise<{
    job: BackgroundJob;
    replayed: boolean;
    billingCommitted: boolean;
  }>;
  enqueueJob(user: AuthenticatedUser, jobId: string): Promise<void>;
  findDesignExportJob(
    user: AuthenticatedUser,
    designId: string,
    idempotencyKey: string,
  ): Promise<BackgroundJob | null>;
  getJob(user: AuthenticatedUser, jobId: string): Promise<BackgroundJob>;
  getTargetFinalization(
    user: AuthenticatedUser,
    jobId: string,
  ): Promise<JobTargetFinalizationDto | null>;
  getBillingTransactionId(jobId: string): Promise<string | null>;
  listJobs(
    user: AuthenticatedUser,
    filters?: { status?: BackgroundJobStatus; jobType?: BackgroundJobType },
  ): Promise<BackgroundJob[]>;
  cancelJob(user: AuthenticatedUser, jobId: string): Promise<BackgroundJob>;
  getConversationImageJob(user: AuthenticatedUser, scope: ConversationImageJobScope, jobId?: string): Promise<Record<string, unknown> | null>;
  cancelJobAdmin(user: AuthenticatedUser, jobId: string, scope: ConversationImageJobScope): Promise<BackgroundJob>;
  /**
   * Stop the still-in-flight jobs of a turn the user just replaced.
   *
   * "重新编辑" is an edit, not an append: the superseded turn's queued/running
   * generations must actually stop, otherwise the provider keeps working on a
   * result the user no longer wants and its finalizer writes the discarded card
   * back into the chat. Only the caller's OWN jobs in the given session are
   * touched, so a collaborator's paid work is never canceled by someone else's
   * edit. Marking `canceled` is sufficient for refunds: the worker's periodic
   * `reconcileTerminalJobRefunds` scan already refunds canceled jobs that were
   * charged.
   */
  cancelDiscardedTurnJobs(
    user: AuthenticatedUser,
    input: { sessionId: string; jobIds: readonly string[] },
  ): Promise<{ canceled: number }>;
  getJobAdmin(jobId: string): Promise<BackgroundJob>;

  // Admin-only methods (use admin client, no user auth)
  setCreditsInfo(
    jobId: string,
    creditsCost: number,
    transactionId: string,
  ): Promise<void>;
  getCreditsCost(jobId: string): Promise<number>;
  /** Atomically claims queued/retryable work, or work abandoned for 30 minutes. */
  markRunning(jobId: string): Promise<boolean>;
  markSucceeded(
    jobId: string,
    result: Record<string, unknown>,
  ): Promise<boolean>;
  markFailed(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean>;
  markDeadLetter(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean>;
  incrementAttempt(
    jobId: string,
  ): Promise<{ attempt_count: number; max_attempts: number }>;
};

export function createJobService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  pgmq: PgmqClient;
  providerSnapshotService?: ProviderSnapshotService;
}): JobService {
  function mapJobRow(row: Record<string, unknown>): BackgroundJob {
    return {
      id: row.id as string,
      workspace_id: row.workspace_id as string,
      project_id: (row.project_id as string) ?? null,
      canvas_id: (row.canvas_id as string) ?? null,
      target_kind: (row.target_kind as BackgroundJob["target_kind"]) ?? null,
      design_id: (row.design_id as string) ?? null,
      session_id: (row.session_id as string) ?? null,
      thread_id: (row.thread_id as string) ?? null,
      queue_name: row.queue_name as string,
      job_type: row.job_type as BackgroundJob["job_type"],
      status: row.status as BackgroundJob["status"],
      payload: (row.payload as Record<string, unknown>) ?? {},
      result: (row.result as Record<string, unknown>) ?? null,
      error_code: (row.error_code as string) ?? null,
      error_message: (row.error_message as string) ?? null,
      attempt_count: row.attempt_count as number,
      max_attempts: row.max_attempts as number,
      created_by: row.created_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      started_at: (row.started_at as string) ?? null,
      completed_at: (row.completed_at as string) ?? null,
      failed_at: (row.failed_at as string) ?? null,
      canceled_at: (row.canceled_at as string) ?? null,
    };
  }

  const SELECT_COLS =
    "id, workspace_id, project_id, canvas_id, target_kind, design_id, session_id, thread_id, queue_name, job_type, status, payload, result, error_code, error_message, attempt_count, max_attempts, credits_transaction_id, created_by, created_at, updated_at, started_at, completed_at, failed_at, canceled_at";

  // Both authorization paths share the existing conditional state transition.
  // Refunds remain the responsibility of the existing worker/accounting flow.
  async function cancelWithClient(client: any, jobId: string, scope?: ConversationImageJobScope) {
    let query = client.from("background_jobs")
      .update({ status: "canceled", canceled_at: new Date().toISOString() }).eq("id", jobId)
      .in("status", ["queued", "running"]);
    if (scope) query = scopeConversationImageJobs(query, scope);
    const { data: job, error } = await query.select(SELECT_COLS).maybeSingle();
    if (error) throw new JobServiceError("job_cancel_failed", "Failed to cancel job.", 500);
    if (!job) throw new JobServiceError("job_not_found", "Job not found or already completed.", 404);
    return mapJobRow(job as Record<string, unknown>);
  }

  return {
    async assertMastraImageRun(user, input) {
      const { data, error } = await (options.getAdminClient().from("agent_runs") as any)
        .select("request_message_id")
        .eq("id", input.runId)
        .eq("session_id", input.sessionId)
        .eq("created_by", user.id)
        .in("status", ["accepted", "running"])
        .maybeSingle();
      if (error || !data || typeof data.request_message_id !== "string")
        throw new JobServiceError(
          "job_query_failed",
          "Direct image run scope is unavailable.",
          error ? 500 : 403,
        );
      return { requestMessageId: data.request_message_id };
    },

    async assertMastraDesignImageTarget(user, input) {
      const target = designJobTargetSchema.parse(input.target);
      const client = options.createUserClient(user.accessToken);
      const [documentResult, nodeResult] = await Promise.all([
        client.from("design_documents")
          .select("id,workspace_id,project_id,revision,deleted_at")
          .eq("id", target.design_id)
          .maybeSingle(),
        client.from("design_nodes")
          .select("design_id")
          .eq("design_id", target.design_id)
          .eq("canvas_id", input.canvasId)
          .eq("workspace_id", input.workspaceId)
          .is("deleted_at", null)
          .maybeSingle(),
      ]);
      const document = documentResult.data as {
        workspace_id?: unknown; project_id?: unknown; revision?: unknown; deleted_at?: unknown;
      } | null;
      if (documentResult.error || nodeResult.error || !document || !nodeResult.data
        || document.workspace_id !== input.workspaceId || document.deleted_at !== null)
        throw new JobServiceError(
          "job_create_failed",
          "Direct image design target is unavailable.",
          documentResult.error || nodeResult.error ? 500 : 403,
        );
      if (document.revision !== target.expected_revision)
        throw new JobServiceError(
          "job_create_failed",
          "The design changed before image submission.",
          409,
        );
      if (target.source_object_id || target.placement?.replace_object_id) {
        const resolved = await this.resolveDesignOperationTarget(user, target);
        if (resolved.workspaceId !== input.workspaceId || resolved.projectId !== document.project_id)
          throw new JobServiceError("job_create_failed", "Direct image design target is unavailable.", 403);
        return resolved.target;
      }
      return target;
    },

    async findMastraImageSubmission(user, input) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client.from("background_jobs")
        .select(SELECT_COLS)
        .eq("created_by", user.id)
        .eq("workspace_id", input.workspaceId)
        .eq("session_id", input.sessionId)
        .eq("job_type", "image_generation")
        .contains("payload", { mastra_submission_key: input.submissionKey,
          mastra_origin_run_id: input.runId })
        .maybeSingle();
      if (error)
        throw new JobServiceError("job_query_failed", "Failed to read direct image submission.", 500);
      if (!data) return null;
      const job = mapJobRow(data as unknown as Record<string, unknown>);
      const target = job.payload.target as Record<string, unknown> | null | undefined;
      if (input.designId === undefined) {
        if (job.target_kind !== "canvas" || job.canvas_id !== input.canvasId || job.design_id !== null
          || target?.kind !== "canvas" || target.canvas_id !== input.canvasId)
          throw new JobServiceError("job_create_failed", "Direct image replay scope mismatch.", 409);
        return job;
      }
      if (job.target_kind !== "design" || job.canvas_id !== null || job.design_id !== input.designId
        || target?.kind !== "design" || target.design_id !== input.designId)
        throw new JobServiceError("job_create_failed", "Direct image replay scope mismatch.", 409);
      const [documentResult, nodeResult] = await Promise.all([
        client.from("design_documents").select("workspace_id,deleted_at")
          .eq("id", input.designId).maybeSingle(),
        client.from("design_nodes").select("design_id")
          .eq("design_id", input.designId).eq("canvas_id", input.canvasId)
          .eq("workspace_id", input.workspaceId).is("deleted_at", null).maybeSingle(),
      ]);
      const document = documentResult.data as { workspace_id?: unknown; deleted_at?: unknown } | null;
      if (documentResult.error || nodeResult.error || !document || !nodeResult.data
        || document.workspace_id !== input.workspaceId || document.deleted_at !== null)
        throw new JobServiceError("job_create_failed", "Direct image replay scope mismatch.",
          documentResult.error || nodeResult.error ? 500 : 403);
      return job;
    },

    async resolveDesignOperationTarget(user, rawTarget) {
      const target = designJobTargetSchema.parse(rawTarget);
      const sourceObjectId =
        target.source_object_id ?? target.placement?.replace_object_id;
      if (!sourceObjectId) {
        throw new JobServiceError(
          "job_create_failed",
          "A design image operation requires a source object.",
          400,
        );
      }
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("design_documents")
        .select("workspace_id, project_id, revision, scene, deleted_at")
        .eq("id", target.design_id)
        .maybeSingle();
      if (
        error ||
        !data ||
        data.deleted_at !== null ||
        typeof data.project_id !== "string"
      ) {
        throw new JobServiceError(
          "job_create_failed",
          error
            ? "Unable to validate the design target."
            : "The design target is unavailable.",
          error ? 500 : 403,
        );
      }
      if (data.revision !== target.expected_revision) {
        throw new JobServiceError(
          "job_create_failed",
          "The design target changed.",
          409,
        );
      }
      const scene = loomicSceneV1Schema.parse(data.scene);
      const source = scene.objects.find(
        (object) => object.objectId === sourceObjectId,
      );
      // inspect_design exposes both object_id and asset_object_id. Models can
      // place the former in source_asset_object_id while still identifying the
      // exact same live object through source_object_id/replace_object_id. That
      // mix-up is safe to normalize only for this one proven object; arbitrary
      // asset mismatches remain a stale/unauthorized target failure.
      if (!source || source.type !== "image") {
        throw new JobServiceError(
          "job_create_failed",
          "The source image changed or is unavailable.",
          409,
        );
      }
      const sourceAssetMatches = target.source_asset_object_id === undefined
        || target.source_asset_object_id === source.assetObjectId
        || target.source_asset_object_id === source.objectId;
      if ((target.expected_object_version !== undefined &&
          source.objectVersion !== target.expected_object_version) || !sourceAssetMatches) {
        throw new JobServiceError(
          "job_create_failed",
          "The source image changed or is unavailable.",
          409,
        );
      }
      const resolvedTarget = designJobTargetSchema.parse({
        ...target,
        source_object_id: source.objectId,
        expected_object_version: source.objectVersion,
        source_asset_object_id: source.assetObjectId,
        placement: {
          x: target.placement?.x ?? source.x,
          y: target.placement?.y ?? source.y,
          width: target.placement?.width ?? source.width,
          height: target.placement?.height ?? source.height,
          fit: target.placement?.fit ?? source.fit,
          ...(target.placement?.role ? { role: target.placement.role } : {}),
          replace_object_id: source.objectId,
        },
      });
      return {
        workspaceId: data.workspace_id,
        projectId: data.project_id,
        target: resolvedTarget,
      };
    },

    async createJob(user, input) {
      return (await this.createJobWithReplay(user, input)).job;
    },

    async createJobWithReplay(user, input) {
      const client = options.createUserClient(user.accessToken);
      const queueName = QUEUE_MAP[input.jobType];
      const fallbackTarget = input.canvasId
        ? canvasJobTargetSchema.parse({
            kind: "canvas",
            canvas_id: input.canvasId,
            ...(typeof input.payload.placeholder_element_id === "string"
              ? { element_id: input.payload.placeholder_element_id }
              : {}),
            ...(typeof input.payload.placement_x === "number" &&
            typeof input.payload.placement_y === "number"
              ? {
                  placement: {
                    x: input.payload.placement_x,
                    y: input.payload.placement_y,
                    ...(typeof input.payload.placement_width === "number"
                      ? { width: input.payload.placement_width }
                      : {}),
                    ...(typeof input.payload.placement_height === "number"
                      ? { height: input.payload.placement_height }
                      : {}),
                  },
                }
              : {}),
          })
        : null;
      const explicitTarget =
        input.target !== undefined
          ? input.target
          : input.payload.target !== undefined
            ? jobTargetSchema.parse(input.payload.target)
            : fallbackTarget;
      if (input.target !== undefined && input.payload.target !== undefined) {
        throw new JobServiceError(
          "job_create_failed",
          "Specify the job target once, outside the payload.",
          400,
        );
      }
      if (input.proposalId && (input.mastraSubmission || input.videoSubmission))
        throw new JobServiceError("job_create_failed", "Image submission identity is ambiguous.", 400);
      if (input.mastraSubmission && input.videoSubmission)
        throw new JobServiceError("job_create_failed", "Submission identity is ambiguous.", 400);
      if ("mastra_submission_key" in input.payload || "mastra_origin_run_id" in input.payload
        || "mastra_credits_cost" in input.payload || "mastra_pricing_version" in input.payload
        || "mastra_default_run_limit" in input.payload)
        throw new JobServiceError("job_create_failed", "Reserved image submission metadata is not accepted in payload.", 400);
      if (input.mastraSubmission) {
        const [keyRunId, digest, extra] = input.mastraSubmission.key.split(":");
        if (!input.sessionId
          || !isUuid(input.mastraSubmission.runId)
          || keyRunId !== input.mastraSubmission.runId || !/^[0-9a-f]{64}$/.test(digest ?? "") || extra !== undefined)
          throw new JobServiceError("job_create_failed", "Invalid server image submission identity.", 400);
      }
      if (["video_submission_key", "video_submission_kind", "video_origin_run_id",
        "video_credits_cost", "video_pricing_version"].some(key => key in input.payload))
        throw new JobServiceError("job_create_failed", "Reserved video submission metadata is not accepted in payload.", 400);
      if (input.videoSubmission) {
        if (input.jobType !== "video_generation")
          throw new JobServiceError("job_create_failed", "Video submission identity requires a video job.", 400);
        const parts = input.videoSubmission.key.split(":");
        const validMastra = input.videoSubmission.kind === "mastra"
          && Boolean(input.sessionId) && Boolean(input.canvasId)
          && isUuid(input.videoSubmission.runId)
          && parts.length === 2 && parts[0] === input.videoSubmission.runId
          && /^[0-9a-f]{64}$/.test(parts[1] ?? "");
        const validHttp = input.videoSubmission.kind === "http"
          && parts.length === 2 && parts[0] === "http"
          && /^[0-9a-f]{64}$/.test(parts[1] ?? "")
          && !input.sessionId && !input.canvasId;
        if (!validMastra && !validHttp)
          throw new JobServiceError("job_create_failed", "Invalid server video submission identity.", 400);
      }
      const normalizedGenerationPayload =
        input.jobType === "image_generation" ||
        input.jobType === "video_generation"
          ? normalizeGenerationPayloadForCreation({
              jobType: input.jobType,
              payload: input.payload,
              fallbackTarget: explicitTarget,
            })
          : input.payload;
      const normalizedPayload = input.mastraSubmission ? {
        ...normalizedGenerationPayload,
        mastra_submission_key: input.mastraSubmission.key,
        mastra_origin_run_id: input.mastraSubmission.runId,
        mastra_credits_cost: input.providerBilling?.creditsCost ?? 0,
        mastra_pricing_version: input.providerBilling?.pricingVersion ?? "credits-v1",
        mastra_default_run_limit: input.mastraSubmission.defaultRunLimit ?? 4,
      } : input.videoSubmission ? {
        ...normalizedGenerationPayload,
        video_submission_key: input.videoSubmission.key,
        video_submission_kind: input.videoSubmission.kind,
        ...(input.videoSubmission.kind === "mastra"
          ? { video_origin_run_id: input.videoSubmission.runId }
          : {}),
        video_credits_cost: input.providerBilling?.creditsCost ?? 0,
        video_pricing_version: input.providerBilling?.pricingVersion ?? "credits-v1",
      } : normalizedGenerationPayload;
      const columns = targetColumns(explicitTarget);
      const projectId = await resolveTargetProject({
        admin: options.getAdminClient(),
        workspaceId: input.workspaceId,
        ...(input.projectId !== undefined
          ? { projectId: input.projectId }
          : {}),
        target: explicitTarget,
      });

      const designReplayKey =
        input.jobType === "image_generation" &&
        explicitTarget?.kind === "design"
          ? explicitTarget.idempotency_key
          : null;
      const canvasImageEditOperation =
        input.jobType === "image_generation" &&
        ["local_repaint", "outpaint"].includes(
          (normalizedPayload as Record<string, unknown>).operation as string,
        )
          ? ((normalizedPayload as Record<string, unknown>).operation as
              | "local_repaint"
              | "outpaint")
          : null;
      const canvasImageEditReplayKey =
        canvasImageEditOperation &&
        explicitTarget?.kind === "canvas" &&
        explicitTarget.element_id
          ? explicitTarget.element_id
          : null;
      const mastraReplayKey = input.mastraSubmission?.key ?? null;
      const videoReplayKey = input.videoSubmission?.key ?? null;
      const findReplay = async () => {
        if (input.proposalId) {
          const { data, error } = await client
            .from("background_jobs")
            .select(SELECT_COLS)
            .eq("id", input.proposalId)
            .eq("created_by", user.id)
            .maybeSingle();
          if (error)
            throw new JobServiceError(
              "job_query_failed",
              "Failed to read confirmed image job.",
              500,
            );
          if (!data) return null;
          const existing = mapJobRow(
            data as unknown as Record<string, unknown>,
          );
          if (
            existing.workspace_id !== input.workspaceId ||
            existing.session_id !== input.sessionId
          )
            throw new JobServiceError(
              "job_create_failed",
              "Image proposal context mismatch.",
              409,
            );
          return {
            job: existing,
            billingCommitted: Boolean(data.credits_transaction_id),
          };
        }
        if (mastraReplayKey && input.mastraSubmission) {
          const { data, error } = await client.from("background_jobs")
            .select(SELECT_COLS).eq("created_by", user.id).eq("session_id", input.sessionId!)
            .eq("job_type", "image_generation")
            .contains("payload", { mastra_submission_key: mastraReplayKey,
              mastra_origin_run_id: input.mastraSubmission.runId }).maybeSingle();
          if (error) throw new JobServiceError("job_query_failed", "Failed to read direct image submission.", 500);
          if (!data) return null;
          const existing = mapJobRow(data as unknown as Record<string, unknown>);
          const comparablePayload = (payload: Record<string, unknown>) => {
            const { mastra_pricing_version: _pricingVersion, mastra_default_run_limit: _runLimit, ...request } = payload;
            return request;
          };
          if (existing.workspace_id !== input.workspaceId || existing.project_id !== projectId
            || existing.canvas_id !== columns.canvasId || existing.design_id !== columns.designId
            || !isDeepStrictEqual(comparablePayload(existing.payload as Record<string, unknown>), comparablePayload(normalizedPayload)))
            throw new JobServiceError("job_create_failed", "Direct image submission context mismatch.", 409);
          return { job: existing, billingCommitted: Boolean(data.credits_transaction_id) };
        }
        if (videoReplayKey && input.videoSubmission) {
          const expectedIdentity = {
            video_submission_key: videoReplayKey,
            video_submission_kind: input.videoSubmission.kind,
            ...(input.videoSubmission.kind === "mastra"
              ? { video_origin_run_id: input.videoSubmission.runId }
              : {}),
          };
          const { data, error } = await client.from("background_jobs")
            .select(SELECT_COLS).eq("created_by", user.id)
            .eq("workspace_id", input.workspaceId)
            .eq("job_type", "video_generation")
            .contains("payload", expectedIdentity).maybeSingle();
          if (error)
            throw new JobServiceError("job_query_failed", "Failed to read durable video submission.", 500);
          if (!data) return null;
          const existing = mapJobRow(data as unknown as Record<string, unknown>);
          if (existing.session_id !== (input.sessionId ?? null)
            || existing.canvas_id !== columns.canvasId
            || existing.project_id !== projectId
            || !isDeepStrictEqual(existing.payload as Record<string, unknown>, normalizedPayload))
            throw new JobServiceError("job_create_failed", "Durable video submission context mismatch.", 409);
          return { job: existing, billingCommitted: Boolean(data.credits_transaction_id) };
        }
        if (
          canvasImageEditOperation &&
          canvasImageEditReplayKey &&
          explicitTarget?.kind === "canvas"
        ) {
          const { data, error } = await client
            .from("background_jobs")
            .select(SELECT_COLS)
            .eq("created_by", user.id)
            .eq("job_type", "image_generation")
            .eq("canvas_id", explicitTarget.canvas_id)
            .contains("payload", {
              operation: canvasImageEditOperation,
              target: { element_id: canvasImageEditReplayKey },
            })
            .maybeSingle();
          if (error)
            throw new JobServiceError(
              "job_query_failed",
              "Failed to query canvas image edit job.",
              500,
            );
          if (data) {
            const existing = mapJobRow(data as unknown as Record<string, unknown>);
            if (
              existing.workspace_id !== input.workspaceId ||
              existing.project_id !== projectId ||
              !isDeepStrictEqual(existing.payload, normalizedPayload)
            ) {
              throw new JobServiceError(
                "job_create_failed",
                "The canvas image edit placeholder was reused with different input.",
                409,
              );
            }
            return {
              job: existing,
              billingCommitted: Boolean(data.credits_transaction_id),
            };
          }
        }
        if (!designReplayKey || explicitTarget?.kind !== "design") return null;
        const { data, error } = await client
          .from("background_jobs")
          .select(SELECT_COLS)
          .eq("created_by", user.id)
          .eq("job_type", "image_generation")
          .eq("design_id", explicitTarget.design_id)
          .contains("payload", {
            target: { idempotency_key: designReplayKey },
          })
          .maybeSingle();
        if (error)
          throw new JobServiceError(
            "job_query_failed",
            "Failed to query design image job.",
            500,
          );
        if (!data) return null;
        const replay = mapJobRow(data as unknown as Record<string, unknown>);
        if (
          JSON.stringify(replay.payload) !==
            JSON.stringify(normalizedPayload) ||
          replay.workspace_id !== input.workspaceId ||
          replay.project_id !== projectId
        ) {
          throw new JobServiceError(
            "job_create_failed",
            "The design image idempotency key was reused with different input.",
            409,
          );
        }
        return {
          job: replay,
          billingCommitted:
            typeof (data as Record<string, unknown>).credits_transaction_id ===
            "string",
        };
      };
      const replay = await findReplay();
      if (replay)
        return {
          job: replay.job,
          replayed: true,
          billingCommitted: replay.billingCommitted,
        };

      if (input.proposalId) {
        const { error } = await options.getAdminClient().rpc(
          "loomic_prepare_image_submission" as never,
          {
            p_id: input.proposalId,
            p_user: user.id,
            p_session: input.sessionId,
            p_cost: input.providerBilling?.creditsCost ?? 0,
          } as never,
        );
        if (error)
          throw new JobServiceError(
            "job_create_failed",
            "Cannot prepare confirmed image submission.",
            409,
          );
      }
      // Durable video metadata is server authority. Insert those rows with the
      // service client so direct authenticated table writes cannot forge a
      // zero-cost submission that the commit RPC would later trust.
      const persistenceClient = input.videoSubmission
        ? options.getAdminClient()
        : client;
      const { data: job, error } = await persistenceClient
        .from("background_jobs")
        .insert({
          ...(input.proposalId ? { id: input.proposalId } : {}),
          workspace_id: input.workspaceId,
          project_id: projectId,
          canvas_id: columns.canvasId,
          target_kind: columns.targetKind,
          design_id: columns.designId,
          session_id: input.sessionId ?? null,
          thread_id: input.threadId ?? null,
          queue_name: queueName,
          job_type: input.jobType,
          payload: normalizedPayload as Json,
          created_by: user.id,
        })
        .select(SELECT_COLS)
        .single();

      if (error || !job) {
        const concurrentReplay = await findReplay();
        if (concurrentReplay)
          return {
            job: concurrentReplay.job,
            replayed: true,
            billingCommitted: concurrentReplay.billingCommitted,
          };
        const policyCode = ["image_generation_run_limit", "image_quality_not_authorized", "image_resolution_not_authorized", "image_generation_requested_count_unsupported", "image_execution_tier_invalid", "image_legacy_background_removal_contract_required"]
          .find(code => error?.message?.includes(code));
        if (input.mastraSubmission && policyCode)
          throw new JobServiceError(policyCode as JobServiceError["code"],
            policyCode === "image_generation_run_limit"
              ? "本轮图片生成与编辑已达到输出上限。未创建新任务、未扣费。"
              : "当前用户原文未授权该图片档位或数量。未创建新任务、未扣费。", 422);
        throw new JobServiceError(
          "job_create_failed",
          "Failed to create job record.",
          500,
        );
      }

      const requestedModel = normalizedPayload.model;
      if (
        typeof requestedModel === "string" &&
        requestedModel.startsWith("workspace:")
      ) {
        try {
          if (!options.providerSnapshotService) {
            throw new Error("Provider snapshot service is unavailable.");
          }
          const snapshotInput = {
            workspaceId: input.workspaceId,
            jobId: job.id,
            modelRef: requestedModel,
            ...(input.providerBilling
              ? { billing: { ...input.providerBilling,
                  ...((normalizedPayload as any).foreground_policy ? { creditsCost: (normalizedPayload as any).foreground_policy.generationCredits } : {}),
                } }
              : {}),
          };
          if (
            input.jobType === "image_generation" &&
            options.providerSnapshotService.createImageGenerationPlan
          ) {
            await options.providerSnapshotService.createImageGenerationPlan(snapshotInput);
          } else {
            await options.providerSnapshotService.createJobSnapshot(snapshotInput);
          }
        } catch (snapshotError) {
          console.error(
            "[job-service] provider snapshot creation failed:",
            snapshotError,
          );
          await persistenceClient.from("background_jobs").delete().eq("id", job.id);
          throw new JobServiceError(
            "job_create_failed",
            "Failed to create job record.",
            500,
          );
        }
      }

      {
        const foreground = (normalizedPayload as any).foreground_policy;
        if (foreground?.mode === "api_matting" && foreground.mattingModel?.startsWith("workspace:")) {
          try {
            if (!options.providerSnapshotService?.createForegroundSnapshot) throw new Error("Foreground snapshot service unavailable");
            await options.providerSnapshotService.createForegroundSnapshot({ workspaceId: input.workspaceId, jobId: job.id });
          } catch {
            await persistenceClient.from("background_jobs").delete().eq("id", job.id);
            throw new JobServiceError("job_create_failed", "Cannot freeze the confirmed foreground provider; no job was queued.", 409);
          }
        }
      }
      if (input.deferEnqueue) {
        return {
          job: mapJobRow(job as unknown as Record<string, unknown>),
          replayed: false,
          billingCommitted: false,
        };
      }

      // Enqueue to pgmq — rollback on failure. Existing callers retain this
      // immediate-enqueue behavior unless they explicitly defer it.
      try {
        await options.pgmq.send(queueName, {
          job_id: job.id,
          job_type: input.jobType,
          workspace_id: input.workspaceId,
          ...(columns.targetKind ? { target_kind: columns.targetKind } : {}),
          ...(columns.canvasId ? { canvas_id: columns.canvasId } : {}),
          ...(columns.designId ? { design_id: columns.designId } : {}),
          ...(input.sessionId ? { session_id: input.sessionId } : {}),
        });
      } catch (enqueueErr) {
        console.error("[job-service] pgmq.send failed:", enqueueErr);
        await persistenceClient.from("background_jobs").delete().eq("id", job.id);
        throw new JobServiceError(
          "job_create_failed",
          "Failed to enqueue job.",
          500,
        );
      }

      return {
        job: mapJobRow(job as unknown as Record<string, unknown>),
        replayed: false,
        billingCommitted: false,
      };
    },

    async commitImageJob(user, jobId) {
      const job = await this.getJob(user, jobId);
      if (job.created_by !== user.id)
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      const foreground = job.payload.foreground_policy === undefined
        ? undefined
        : imageForegroundPolicySchema.parse(job.payload.foreground_policy);
      if (job.status === "queued" && typeof job.payload.model === "string" && job.payload.model.startsWith("workspace:")) {
        if (!options.providerSnapshotService)
          throw new JobServiceError("job_create_failed", "Primary provider snapshot service unavailable", 409);
        let primaryCredits: number;
        let pricingVersion = "credits-v1";
        if (foreground) {
          primaryCredits = foreground.generationCredits;
          pricingVersion = foreground.pricingVersion;
        } else {
          const { data: proposal, error } = await (options
            .getAdminClient() as any)
            .from("image_generation_proposals")
            .select("approved_cost")
            .eq("id", jobId)
            .maybeSingle();
          const approvedCost = (proposal as { approved_cost?: unknown } | null)?.approved_cost;
          if (error || !Number.isSafeInteger(approvedCost) || (approvedCost as number) < 0)
            throw new JobServiceError("job_create_failed", "Confirmed image price unavailable", 409);
          primaryCredits = approvedCost as number;
        }
        const snapshotInput = {
          workspaceId: job.workspace_id,
          jobId,
          modelRef: job.payload.model,
          billing: { creditsCost: primaryCredits, pricingVersion, unit: "image" },
        } as const;
        if (options.providerSnapshotService.createImageGenerationPlan) {
          await options.providerSnapshotService.createImageGenerationPlan(snapshotInput);
        } else {
          await options.providerSnapshotService.createJobSnapshot(snapshotInput);
        }
      }
      if (job.status === "queued" && foreground?.mode === "api_matting" && foreground.mattingModel?.startsWith("workspace:")) {
        if (!options.providerSnapshotService?.createForegroundSnapshot) throw new JobServiceError("job_create_failed", "Foreground snapshot service unavailable", 409);
        await options.providerSnapshotService.createForegroundSnapshot({ workspaceId: job.workspace_id, jobId });
      }
      const { error } = await options
        .getAdminClient()
        .rpc("loomic_commit_image_job" as never, { p_job: jobId } as never);
      if (error)
        throw new JobServiceError(
          "job_create_failed",
          `Image submission not committed: ${error.message}`,
          500,
        );
    },

    async commitMastraImageJob(user, input) {
      if (!Number.isSafeInteger(input.creditsCost) || input.creditsCost < 0)
        throw new JobServiceError("job_create_failed", "Invalid direct image price.", 400);
      let response: { error: { message: string; code?: string } | null };
      try {
        response = await options.getAdminClient().rpc(
          "loomic_commit_mastra_image_job" as never,
          { p_job: input.jobId, p_user: user.id, p_run: input.runId,
            p_submission_key: input.submissionKey, p_cost: input.creditsCost } as never,
        ) as { error: { message: string; code?: string } | null };
      } catch {
        throw new JobServiceError("mastra_commit_unknown", "Direct image commit outcome is unknown.", 503);
      }
      if (response.error) {
        if (response.error.code === "P0001" && response.error.message === "INSUFFICIENT_CREDITS")
          throw new CreditServiceError("insufficient_credits", "Insufficient credits", 402);
        const isDefinitiveDatabaseRejection = response.error.code === "P0001"
          && (/^(?:mastra_|image_|loomic_)/.test(response.error.message)
            || /^credit_(?:balance_not_found|invalid_amount|job_required|job_not_found|job_not_chargeable|price_mismatch)$/.test(response.error.message));
        throw new JobServiceError(isDefinitiveDatabaseRejection
          ? "mastra_commit_rejected" : "mastra_commit_unknown",
        isDefinitiveDatabaseRejection
          ? "Direct image submission was rejected before enqueue."
          : "Direct image commit outcome is unknown.",
        isDefinitiveDatabaseRejection ? 409 : 503);
      }
    },

    async cancelUncommittedMastraImageJob(user, input) {
      const { data, error } = await options.getAdminClient().from("background_jobs")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("id", input.jobId)
        .eq("created_by", user.id)
        .eq("status", "queued")
        .is("image_enqueued_at", null)
        .contains("payload", { mastra_origin_run_id: input.runId,
          mastra_submission_key: input.submissionKey })
        .select("id")
        .maybeSingle();
      if (error)
        throw new JobServiceError("job_cancel_failed", "Failed to compensate direct image submission.", 500);
      return Boolean(data);
    },

    async findVideoSubmission(user, input) {
      const client = options.createUserClient(user.accessToken);
      const identity = {
        video_submission_key: input.submissionKey,
        video_submission_kind: input.kind,
        ...(input.kind === "mastra" && input.runId
          ? { video_origin_run_id: input.runId }
          : {}),
      };
      const { data, error } = await client.from("background_jobs")
        .select(SELECT_COLS)
        .eq("created_by", user.id)
        .eq("workspace_id", input.workspaceId)
        .eq("job_type", "video_generation")
        .contains("payload", identity)
        .maybeSingle();
      if (error)
        throw new JobServiceError("job_query_failed", "Failed to read durable video submission.", 500);
      if (!data) return null;
      const job = mapJobRow(data as unknown as Record<string, unknown>);
      if (input.kind === "mastra") {
        if (!input.runId || !input.sessionId || !input.canvasId
          || job.session_id !== input.sessionId || job.canvas_id !== input.canvasId)
          throw new JobServiceError("job_query_failed", "Durable video submission scope mismatch.", 403);
      } else if (job.session_id !== null || job.canvas_id !== null) {
        throw new JobServiceError("job_query_failed", "Durable video submission scope mismatch.", 403);
      }
      if (input.expectedPayload) {
        const { video_submission_key: _key, video_submission_kind: _kind,
          video_origin_run_id: _run, video_credits_cost: _cost,
          video_pricing_version: _pricing, ...storedPayload } = job.payload as Record<string, unknown>;
        if (!isDeepStrictEqual(storedPayload, input.expectedPayload))
          throw new JobServiceError("job_create_failed", "Idempotency key was reused with different video input.", 409);
      }
      return job;
    },

    async commitVideoJob(user, input) {
      if (!Number.isSafeInteger(input.creditsCost) || input.creditsCost < 0)
        throw new JobServiceError("job_create_failed", "Invalid durable video price.", 400);
      let response: { error: { message: string; code?: string } | null };
      try {
        response = await options.getAdminClient().rpc(
          "loomic_commit_video_job" as never,
          { p_job: input.jobId, p_user: user.id,
            p_submission_key: input.submissionKey, p_cost: input.creditsCost,
            p_run: input.runId ?? null } as never,
        ) as { error: { message: string; code?: string } | null };
      } catch {
        throw new JobServiceError("video_commit_unknown", "Video commit outcome is unknown.", 503);
      }
      if (response.error) {
        if (response.error.code === "P0001" && response.error.message === "INSUFFICIENT_CREDITS")
          throw new CreditServiceError("insufficient_credits", "Insufficient credits", 402);
        const definitive = (response.error.code === "P0001"
          && /^video_submission_(?:invalid|forbidden|run_forbidden|http_invalid|kind_invalid)$/.test(response.error.message))
          || /^(?:credit_(?:balance_not_found|invalid_amount|job_required|job_not_found|job_not_chargeable|price_mismatch))$/.test(response.error.message);
        throw new JobServiceError(definitive ? "video_commit_rejected" : "video_commit_unknown",
          definitive ? "Video submission was rejected before enqueue."
            : "Video commit outcome is unknown.", definitive ? 409 : 503);
      }
    },

    async cancelUncommittedVideoJob(user, input) {
      const { data, error } = await options.getAdminClient().from("background_jobs")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("id", input.jobId)
        .eq("created_by", user.id)
        .eq("status", "queued")
        .is("video_enqueued_at", null)
        .contains("payload", { video_submission_key: input.submissionKey })
        .select("id")
        .maybeSingle();
      if (error)
        throw new JobServiceError("job_cancel_failed", "Failed to compensate durable video submission.", 500);
      return Boolean(data);
    },

    async enqueueJob(user, jobId) {
      const client = options.createUserClient(user.accessToken);
      const { data: job, error } = await client
        .from("background_jobs")
        .select(
          "id, workspace_id, canvas_id, target_kind, design_id, session_id, job_type, queue_name, status",
        )
        .eq("id", jobId)
        .eq("created_by", user.id)
        .maybeSingle();

      if (error || !job || job.status !== "queued") {
        throw new JobServiceError(
          "job_create_failed",
          "Job is not available for enqueue.",
          error ? 500 : 409,
        );
      }

      try {
        await options.pgmq.send(job.queue_name, {
          job_id: job.id,
          job_type: job.job_type,
          workspace_id: job.workspace_id,
          ...(job.target_kind ? { target_kind: job.target_kind } : {}),
          ...(job.canvas_id ? { canvas_id: job.canvas_id } : {}),
          ...(job.design_id ? { design_id: job.design_id } : {}),
          ...(job.session_id ? { session_id: job.session_id } : {}),
        });
      } catch (enqueueError) {
        console.error("[job-service] deferred pgmq.send failed:", enqueueError);
        throw new JobServiceError(
          "job_create_failed",
          "Failed to enqueue job.",
          500,
        );
      }
    },

    async getJob(user, jobId) {
      const client = options.createUserClient(user.accessToken);
      const { data: job, error } = await client
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("id", jobId)
        .maybeSingle();

      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to query job.",
          500,
        );
      }
      if (!job) {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      }
      return mapJobRow(job as unknown as Record<string, unknown>);
    },

    async getTargetFinalization(user, jobId) {
      // Authorize through the RLS-backed job read before accessing the
      // FORCE-RLS finalization ledger with the server client.
      await this.getJob(user, jobId);
      const { data, error } = await options
        .getAdminClient()
        .from("job_target_finalizations")
        .select(
          "id, job_id, workspace_id, target_kind, target_id, status, command_id, result, error_code, error_message, attempt_count, created_at, updated_at, completed_at",
        )
        .eq("job_id", jobId)
        .maybeSingle();
      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to query job finalization.",
          500,
        );
      }
      return data ? jobTargetFinalizationDtoSchema.parse(data) : null;
    },

    async getBillingTransactionId(jobId) {
      const { data, error } = await options
        .getAdminClient()
        .from("background_jobs")
        .select("credits_transaction_id")
        .eq("id", jobId)
        .maybeSingle();
      if (error || !data)
        throw new JobServiceError(
          "job_query_failed",
          "Failed to query job billing state.",
          error ? 500 : 404,
        );
      return data.credits_transaction_id ?? null;
    },

    async findDesignExportJob(user, designId, idempotencyKey) {
      const client = options.createUserClient(user.accessToken);
      const { data: job, error } = await client
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("created_by", user.id)
        .eq("job_type", "design_export")
        .eq("design_id", designId)
        .contains("payload", { idempotency_key: idempotencyKey })
        .maybeSingle();

      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to query export job.",
          500,
        );
      }
      return job ? mapJobRow(job as unknown as Record<string, unknown>) : null;
    },

    async listJobs(user, filters) {
      const client = options.createUserClient(user.accessToken);
      let query = client
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("created_by", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (filters?.status) query = query.eq("status", filters.status);
      if (filters?.jobType) query = query.eq("job_type", filters.jobType);

      const { data: jobs, error } = await query;
      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to list jobs.",
          500,
        );
      }
      return (jobs ?? []).map((row) =>
        mapJobRow(row as unknown as Record<string, unknown>),
      );
    },

    async cancelJob(user, jobId) {
      return cancelWithClient(options.createUserClient(user.accessToken), jobId);
    },

    async getConversationImageJob(user, scope, jobId) {
      const admin = options.getAdminClient();
      await authorizeConversationImageJobs(admin, user.id, scope);
      let query = scopeConversationImageJobs(admin.from("background_jobs")
        .select("id,status,result,error_code,error_message,created_at,model:payload->>model,requestedAspectRatio:payload->>aspect_ratio,creditsCost:payload->>mastra_credits_cost,creditsCostColumn:credits_cost,pricingVersion:payload->>mastra_pricing_version,quality:payload->>quality,resolution:payload->>resolution"), scope);
      if (jobId) query = query.eq("id", jobId);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new JobServiceError("job_query_failed", "Failed to query image status.", 500);
      return data;
    },

    async cancelJobAdmin(user, jobId, scope) {
      const admin = options.getAdminClient();
      const role = await authorizeConversationImageJobs(admin, user.id, scope);
      const { data: job, error } = await scopeConversationImageJobs(admin.from("background_jobs")
        .select(SELECT_COLS).eq("id", jobId), scope).maybeSingle();
      if (error) throw new JobServiceError("job_query_failed", "Failed to query job.", 500);
      if (!job) throw new JobServiceError("job_not_found", "Job not found.", 404);
      if (job.created_by !== user.id && role !== "owner" && role !== "admin") throw new ImageJobAccessError();
      if (["succeeded", "failed", "dead_letter", "canceled"].includes(job.status))
        return mapJobRow(job as Record<string, unknown>);
      return cancelWithClient(admin, jobId, scope);
    },

    async cancelDiscardedTurnJobs(user, { sessionId, jobIds }) {
      const ids = [...new Set(jobIds)];
      if (!ids.length) return { canceled: 0 };
      const admin = options.getAdminClient();
      // Scope by session AND creator. The caller already proved session access
      // when it truncated the messages, but a shared session may also contain a
      // collaborator's jobs, and only the user's own paid work may be stopped.
      const { data, error } = await admin
        .from("background_jobs")
        .update({ status: "canceled", canceled_at: new Date().toISOString(),
          error_code: "superseded_by_edit" })
        .in("id", ids)
        .eq("session_id", sessionId)
        .eq("created_by", user.id)
        .eq("job_type", "image_generation")
        .in("status", ["queued", "running"])
        .select("id");
      if (error)
        throw new JobServiceError("job_cancel_failed", "Failed to stop superseded jobs.", 500);
      return { canceled: Array.isArray(data) ? data.length : 0 };
    },

    async getJobAdmin(jobId) {      const admin = options.getAdminClient();
      const { data: job, error } = await admin
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("id", jobId)
        .maybeSingle();

      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to query job.",
          500,
        );
      }
      if (!job) {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      }
      return mapJobRow(job as unknown as Record<string, unknown>);
    },

    // --- Admin-only methods (admin client, bypasses RLS) ---

    async setCreditsInfo(jobId, creditsCost, transactionId) {
      const admin = options.getAdminClient();
      const { error } = await admin
        .from("background_jobs")
        .update({
          credits_cost: creditsCost,
          credits_transaction_id: transactionId,
        })
        .eq("id", jobId);
      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to attach billing information to job.",
          500,
        );
      }
    },

    async getCreditsCost(jobId) {
      const admin = options.getAdminClient();
      const { data, error } = await admin
        .from("background_jobs")
        .select("credits_cost")
        .eq("id", jobId)
        .maybeSingle();
      if (error || !data) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to query job billing information.",
          error ? 500 : 404,
        );
      }
      return data.credits_cost ?? 0;
    },

    async markRunning(jobId) {
      const admin = options.getAdminClient();
      const startedAt = new Date().toISOString();
      const { data, error } = await admin
        .from("background_jobs")
        .update({
          status: "running",
          started_at: startedAt,
          error_code: null,
          error_message: null,
          failed_at: null,
        })
        .eq("id", jobId)
        .in("status", ["queued", "failed"])
        .select("id")
        .maybeSingle();

      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to claim job.",
          500,
        );
      }
      if (data !== null) return true;

      // If a worker hard-crashes, PGMQ redelivers the message after its VT but
      // the durable row remains running. Reclaim only after a conservative lease
      // so a slow, healthy generation is not executed twice.
      const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
      const { data: reclaimed, error: reclaimError } = await admin
        .from("background_jobs")
        .update({ status: "running", started_at: startedAt })
        .eq("id", jobId)
        .eq("status", "running")
        .lt("started_at", staleBefore)
        .select("id")
        .maybeSingle();
      if (reclaimError) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to reclaim stale job.",
          500,
        );
      }
      return reclaimed !== null;
    },

    async markSucceeded(jobId, result) {
      const admin = options.getAdminClient();
      const { data, error } = await admin
        .from("background_jobs")
        .update({
          status: "succeeded",
          result: result as Json,
          completed_at: new Date().toISOString(),
          error_code: null,
          error_message: null,
          failed_at: null,
        })
        .eq("id", jobId)
        .eq("status", "running")
        .select("id")
        .maybeSingle();
      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to complete job.",
          500,
        );
      }
      return data !== null;
    },

    async markFailed(jobId, errorCode, errorMessage) {
      const admin = options.getAdminClient();
      const { data, error } = await admin
        .from("background_jobs")
        .update({
          status: "failed",
          error_code: errorCode,
          error_message: errorMessage,
          failed_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .eq("status", "running")
        .select("id")
        .maybeSingle();
      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to fail job.",
          500,
        );
      }
      return data !== null;
    },

    async markDeadLetter(jobId, errorCode, errorMessage) {
      const admin = options.getAdminClient();
      const { data, error } = await admin
        .from("background_jobs")
        .update({
          status: "dead_letter",
          error_code: errorCode,
          error_message: errorMessage,
          failed_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .eq("status", "running")
        .select("id")
        .maybeSingle();
      if (error) {
        throw new JobServiceError(
          "job_query_failed",
          "Failed to dead-letter job.",
          500,
        );
      }
      return data !== null;
    },

    async incrementAttempt(jobId) {
      const admin = options.getAdminClient();
      // NOTE: increment_job_attempt may not be in generated Supabase types yet
      let data: unknown;
      let error: { message?: string } | null;
      try {
        ({ data, error } = await (
          admin.rpc as unknown as (
            name: string,
            args: Record<string, unknown>,
          ) => Promise<{
            data: unknown;
            error: { message?: string } | null;
          }>
        )("increment_job_attempt", { p_job_id: jobId }));
      } catch (rpcError) {
        console.error(
          "[job-service] increment_job_attempt RPC threw:",
          rpcError,
        );
        throw new JobServiceError(
          "job_attempt_increment_failed",
          "Job attempt could not be recorded.",
          503,
        );
      }

      if (error) {
        console.error(
          "[job-service] increment_job_attempt RPC failed:",
          error.message,
        );
        throw new JobServiceError(
          "job_attempt_increment_failed",
          "Job attempt could not be recorded.",
          503,
        );
      }

      const row = Array.isArray(data) ? data[0] : data;
      if (row && typeof row === "object") {
        const record = row as Record<string, unknown>;
        const attemptCount = record.attempt_count;
        const maxAttempts = record.max_attempts;
        if (
          typeof attemptCount === "number" && Number.isSafeInteger(attemptCount) &&
          attemptCount >= 1 &&
          typeof maxAttempts === "number" && Number.isSafeInteger(maxAttempts) &&
          maxAttempts >= 1
        ) {
          return {
            attempt_count: attemptCount,
            max_attempts: maxAttempts,
          };
        }
      }
      console.error(
        "[job-service] increment_job_attempt returned an invalid result:",
        data,
      );
      throw new JobServiceError(
        "job_attempt_increment_failed",
        "Job attempt could not be recorded.",
        503,
      );
    },
  };
}

async function resolveTargetProject(input: {
  admin: AdminSupabaseClient;
  workspaceId: string;
  projectId?: string;
  target: JobTarget | null;
}): Promise<string | null> {
  if (!input.target) return input.projectId ?? null;

  const query =
    input.target.kind === "canvas"
      ? input.admin
          .from("canvases")
          .select("workspace_id, project_id")
          .eq("id", input.target.canvas_id)
          .maybeSingle()
      : input.admin
          .from("design_documents")
          .select("workspace_id, project_id, deleted_at")
          .eq("id", input.target.design_id)
          .maybeSingle();
  const { data, error } = await query;
  if (
    error ||
    !data ||
    data.workspace_id !== input.workspaceId ||
    typeof data.project_id !== "string" ||
    ("deleted_at" in data && data.deleted_at !== null) ||
    (input.projectId !== undefined && input.projectId !== data.project_id)
  ) {
    throw new JobServiceError(
      "job_create_failed",
      "Job target is not available in this workspace and project.",
      error ? 500 : 403,
    );
  }
  return data.project_id;
}
