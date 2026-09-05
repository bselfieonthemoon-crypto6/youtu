import {
  type BackgroundJob,
  type DesignExportResult,
  backgroundJobSchema,
  designExportPayloadSchema,
  designExportResultSchema,
} from "@loomic/shared";
import { z } from "zod";

import type { PgmqClient } from "../../queue/pgmq-client.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import {
  type ExecutorContext,
  type JobExecutor,
  registerExecutor,
} from "../jobs/job-executor.js";
import type { DesignPreviewRepository } from "./design-preview-service.js";

const previewPayloadSchema = z
  .object({
    design_id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    idempotency_key: z.string().uuid(),
    requested_by: z.string().uuid(),
  })
  .strict();

const previewRenderResultSchema = z
  .object({ preview_asset_object_id: z.string().uuid() })
  .strict();

const previewFailureResultSchema = z
  .object({
    job_id: z.string().uuid(),
    design_id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    updated: z.boolean(),
    error_code: z.string(),
    error_message: z.string(),
  })
  .strict();

const queuedPreviewJobSchema = z
  .object({
    id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    design_id: z.string().uuid(),
    queue_name: z.literal("design_preview_jobs"),
    job_type: z.literal("design_preview"),
    status: z.literal("queued"),
  })
  .strict();

const queuedExportJobSchema = z
  .object({
    id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    design_id: z.string().uuid(),
    queue_name: z.literal("design_export_jobs"),
    job_type: z.literal("design_export"),
    status: z.literal("queued"),
  })
  .strict();

export type DesignAsyncRenderContext = Pick<
  ExecutorContext,
  "env" | "getAdminClient" | "renewVt"
>;

export type DesignPreviewRenderer = {
  render(
    input: {
      job: BackgroundJob;
      designId: string;
      revision: number;
      requestedBy: string;
    },
    context: DesignAsyncRenderContext,
  ): Promise<{ preview_asset_object_id: string }>;
};

export type DesignExportRenderer = {
  render(
    input: {
      job: BackgroundJob;
      payload: ReturnType<typeof designExportPayloadSchema.parse>;
    },
    context: DesignAsyncRenderContext,
  ): Promise<DesignExportResult>;
};

export type DesignPreviewFailureRepository = {
  markError(input: {
    jobId: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<{ updated: boolean }>;
};

export class DesignRendererUnavailableError extends Error {
  readonly code = "design_renderer_unavailable";

  constructor(kind: "preview" | "export") {
    super(`The ${kind} renderer is not available in this deployment.`);
    this.name = "DesignRendererUnavailableError";
  }
}

export function createDesignPreviewExecutor(options: {
  repository: Pick<DesignPreviewRepository, "commit">;
  renderer?: DesignPreviewRenderer;
}): JobExecutor {
  const renderer = options.renderer ?? unavailablePreviewRenderer;
  return async (jobId, _message, context) => {
    const job = backgroundJobSchema.parse(
      await context.jobService.getJobAdmin(jobId),
    );
    if (
      job.job_type !== "design_preview" ||
      job.target_kind !== "design" ||
      !job.design_id
    ) {
      throw invalidInput("The preview job target is invalid.");
    }
    const payload = previewPayloadSchema.parse(job.payload);
    if (payload.design_id !== job.design_id) {
      throw invalidInput("The preview job payload does not match its target.");
    }
    const rendered = previewRenderResultSchema.parse(
      await renderer.render(
        {
          job,
          designId: job.design_id,
          revision: payload.revision,
          requestedBy: payload.requested_by,
        },
        renderContext(context),
      ),
    );
    const committed = await options.repository.commit({
      designId: job.design_id,
      expectedRevision: payload.revision,
      idempotencyKey: job.id,
      previewAssetObjectId: rendered.preview_asset_object_id,
      previewRevision: payload.revision,
      actorUserId: payload.requested_by,
    });
    return {
      design_id: job.design_id,
      revision: committed.revision,
      preview_revision: payload.revision,
      preview_asset_object_id: rendered.preview_asset_object_id,
      committed: committed.committed,
      replayed: committed.replayed,
    };
  };
}

export function createDesignExportExecutor(options?: {
  renderer?: DesignExportRenderer;
}): JobExecutor {
  const renderer = options?.renderer ?? unavailableExportRenderer;
  return async (jobId, _message, context) => {
    const job = backgroundJobSchema.parse(
      await context.jobService.getJobAdmin(jobId),
    );
    if (
      job.job_type !== "design_export" ||
      job.target_kind !== "design" ||
      !job.design_id
    ) {
      throw invalidInput("The export job target is invalid.");
    }
    const payload = designExportPayloadSchema.parse(job.payload);
    if (payload.design_id !== job.design_id) {
      throw invalidInput("The export job payload does not match its target.");
    }
    const result = designExportResultSchema.parse(
      await renderer.render({ job, payload }, renderContext(context)),
    );
    if (
      result.design_id !== job.design_id ||
      result.revision !== payload.revision ||
      result.format !== payload.format
    ) {
      throw invalidInput("The export renderer returned a mismatched result.");
    }
    return result;
  };
}

export function registerDesignAsyncExecutors(options: {
  previewRepository: Pick<DesignPreviewRepository, "commit">;
  previewRenderer?: DesignPreviewRenderer;
  exportRenderer?: DesignExportRenderer;
}) {
  registerExecutor(
    "design_preview",
    createDesignPreviewExecutor({
      repository: options.previewRepository,
      ...(options.previewRenderer ? { renderer: options.previewRenderer } : {}),
    }),
  );
  registerExecutor(
    "design_export",
    createDesignExportExecutor(
      options.exportRenderer ? { renderer: options.exportRenderer } : undefined,
    ),
  );
}

export function createSupabaseDesignPreviewFailureRepository(
  getAdminClient: () => AdminSupabaseClient,
): DesignPreviewFailureRepository {
  return {
    async markError(input) {
      const { data, error } = await (
        getAdminClient().rpc as unknown as (
          name: string,
          args: Record<string, unknown>,
        ) => Promise<{
          data: unknown;
          error: { message?: string } | null;
        }>
      )("loomic_design_preview_mark_error", {
        p_job_id: input.jobId,
        p_error_code: input.errorCode,
        p_error_message: input.errorMessage,
      });
      if (error) {
        throw new Error(error.message ?? "design_preview_mark_error_failed");
      }
      return previewFailureResultSchema.parse(data);
    },
  };
}

export async function requeueQueuedDesignPreviewJobs(
  admin: AdminSupabaseClient,
  pgmq: Pick<PgmqClient, "send">,
  limit = 100,
): Promise<{ checked: number; published: number; failed: number }> {
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
  const { data, error } = await admin
    .from("background_jobs")
    .select("id, workspace_id, design_id, queue_name, job_type, status")
    .eq("job_type", "design_preview")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(safeLimit);
  if (error) {
    throw new Error(`design_preview_requeue_scan_failed:${error.message}`);
  }

  let published = 0;
  let failed = 0;
  for (const rawRow of data ?? []) {
    try {
      const row = queuedPreviewJobSchema.parse(rawRow);
      await pgmq.send(row.queue_name, {
        job_id: row.id,
        job_type: row.job_type,
        workspace_id: row.workspace_id,
        target_kind: "design",
        design_id: row.design_id,
      });
      published += 1;
    } catch (publishError) {
      failed += 1;
      console.error(
        `[design-preview] Failed to republish queued preview job ${String(
          (rawRow as { id?: unknown }).id,
        )}:`,
        publishError,
      );
    }
  }
  return { checked: data?.length ?? 0, published, failed };
}

export async function requeueQueuedDesignExportJobs(
  admin: AdminSupabaseClient,
  pgmq: Pick<PgmqClient, "send">,
  limit = 100,
): Promise<{ checked: number; published: number; failed: number }> {
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
  const { data, error } = await admin
    .from("background_jobs")
    .select("id, workspace_id, design_id, queue_name, job_type, status")
    .eq("job_type", "design_export")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(safeLimit);
  if (error) {
    throw new Error(`design_export_requeue_scan_failed:${error.message}`);
  }
  let published = 0;
  let failed = 0;
  for (const rawRow of data ?? []) {
    try {
      const row = queuedExportJobSchema.parse(rawRow);
      await pgmq.send(row.queue_name, {
        job_id: row.id,
        job_type: row.job_type,
        workspace_id: row.workspace_id,
        target_kind: "design",
        design_id: row.design_id,
      });
      published += 1;
    } catch (publishError) {
      failed += 1;
      console.error(
        `[design-export] Failed to republish queued export job ${String((rawRow as { id?: unknown }).id)}:`,
        publishError,
      );
    }
  }
  return { checked: data?.length ?? 0, published, failed };
}

const unavailablePreviewRenderer: DesignPreviewRenderer = {
  async render() {
    throw new DesignRendererUnavailableError("preview");
  },
};

const unavailableExportRenderer: DesignExportRenderer = {
  async render() {
    throw new DesignRendererUnavailableError("export");
  },
};

function renderContext(context: ExecutorContext): DesignAsyncRenderContext {
  return {
    env: context.env,
    getAdminClient: context.getAdminClient,
    renewVt: context.renewVt,
  };
}

function invalidInput(message: string) {
  return Object.assign(new Error(message), { code: "invalid_input" as const });
}
