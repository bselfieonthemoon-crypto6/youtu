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
  jobTargetFinalizationDtoSchema,
  jobTargetSchema,
  loomicSceneV1Schema,
} from "@loomic/shared";

import type { PgmqClient } from "../../queue/pgmq-client.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import type { ProviderSnapshotService } from "../providers/provider-snapshot-service.js";
import type { ProviderExecutionBillingSnapshot } from "../providers/provider-snapshot-service.js";
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
    | "job_cancel_failed";

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
};

export type JobService = {
  commitImageJob(user: AuthenticatedUser, jobId: string): Promise<void>;
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

  return {
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
      if (
        !source ||
        source.type !== "image" ||
        (target.expected_object_version !== undefined &&
          source.objectVersion !== target.expected_object_version) ||
        (target.source_asset_object_id !== undefined &&
          source.assetObjectId !== target.source_asset_object_id)
      ) {
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
      const normalizedPayload =
        input.jobType === "image_generation" ||
        input.jobType === "video_generation"
          ? normalizeGenerationPayloadForCreation({
              jobType: input.jobType,
              payload: input.payload,
              fallbackTarget: explicitTarget,
            })
          : input.payload;
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
      const { data: job, error } = await client
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
          await options.providerSnapshotService.createJobSnapshot({
            workspaceId: input.workspaceId,
            jobId: job.id,
            modelRef: requestedModel,
            ...(input.providerBilling
              ? { billing: input.providerBilling }
              : {}),
          });
        } catch (snapshotError) {
          console.error(
            "[job-service] provider snapshot creation failed:",
            snapshotError,
          );
          await client.from("background_jobs").delete().eq("id", job.id);
          throw new JobServiceError(
            "job_create_failed",
            "Failed to create job record.",
            500,
          );
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
        await client.from("background_jobs").delete().eq("id", job.id);
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
      const client = options.createUserClient(user.accessToken);
      const { data: job, error } = await client
        .from("background_jobs")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("id", jobId)
        .in("status", ["queued", "running"])
        .select(SELECT_COLS)
        .maybeSingle();

      if (error) {
        throw new JobServiceError(
          "job_cancel_failed",
          "Failed to cancel job.",
          500,
        );
      }
      if (!job) {
        throw new JobServiceError(
          "job_not_found",
          "Job not found or already completed.",
          404,
        );
      }
      return mapJobRow(job as unknown as Record<string, unknown>);
    },

    async getJobAdmin(jobId) {
      const admin = options.getAdminClient();
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
      const { data, error } = await (
        admin.rpc as unknown as (
          name: string,
          args: Record<string, unknown>,
        ) => Promise<{
          data: unknown;
          error: { message?: string } | null;
        }>
      )("increment_job_attempt", { p_job_id: jobId });

      if (error) {
        console.error(
          "[job-service] increment_job_attempt RPC failed:",
          error.message,
        );
        return { attempt_count: 1, max_attempts: 3 };
      }

      const row = Array.isArray(data) ? data[0] : data;
      if (row && typeof row === "object") {
        const record = row as Record<string, unknown>;
        return {
          attempt_count:
            typeof record.attempt_count === "number" ? record.attempt_count : 1,
          max_attempts:
            typeof record.max_attempts === "number" ? record.max_attempts : 3,
        };
      }
      // Job not found — return safe defaults
      return { attempt_count: 1, max_attempts: 3 };
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
