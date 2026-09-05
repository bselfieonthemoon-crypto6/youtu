import { randomUUID } from "node:crypto";

import {
  type QueueDesignPreviewResponse,
  commitDesignPreviewRequestSchema,
  queueDesignPreviewResponseSchema,
} from "@loomic/shared";
import { z } from "zod";

import type { AdminSupabaseClient } from "../../supabase/admin.js";

const previewCommitResultSchema = z
  .object({
    design_id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    committed: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();

export type PreviewQueueResult = QueueDesignPreviewResponse;
export type PreviewCommitResult = z.infer<typeof previewCommitResultSchema>;

export class DesignPreviewError extends Error {
  constructor(
    readonly code:
      | "design_conflict"
      | "design_forbidden"
      | "design_not_found"
      | "design_write_failed",
    message: string,
    readonly statusCode: number,
    readonly latestRevision?: number,
  ) {
    super(message);
    this.name = "DesignPreviewError";
  }
}

export type DesignPreviewRepository = {
  queue(input: {
    designId: string;
    expectedRevision: number;
    idempotencyKey: string;
    jobId: string;
    actorUserId: string;
  }): Promise<PreviewQueueResult>;
  commit(input: {
    designId: string;
    expectedRevision: number;
    idempotencyKey: string;
    previewAssetObjectId: string;
    previewRevision: number;
    actorUserId: string;
  }): Promise<PreviewCommitResult>;
};

export type PreviewQueuePublisher = {
  publish(message: {
    job_id: string;
    job_type: "design_preview";
    design_id: string;
  }): Promise<void>;
};

export class DesignPreviewService {
  constructor(
    private readonly repository: DesignPreviewRepository,
    private readonly publisher: PreviewQueuePublisher,
  ) {}

  async enqueue(input: {
    designId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorUserId: string;
  }): Promise<PreviewQueueResult> {
    const queued = await this.repository.queue({
      ...input,
      jobId: randomUUID(),
    });
    if (queued.job_id) {
      await this.publisher.publish({
        job_id: queued.job_id,
        job_type: "design_preview",
        design_id: queued.design_id,
      });
    }
    return queued;
  }

  async finalize(
    rawInput: unknown,
    actorUserId: string,
  ): Promise<PreviewCommitResult> {
    const input = commitDesignPreviewRequestSchema.parse(rawInput);
    return this.repository.commit({
      designId: input.design_id,
      expectedRevision: input.expected_revision,
      idempotencyKey: input.idempotency_key,
      previewAssetObjectId: input.preview_asset_object_id,
      previewRevision: input.preview_revision,
      actorUserId,
    });
  }
}

type RpcResult = {
  data: unknown;
  error: { message?: string; details?: string | null } | null;
};

class PreviewRpcError extends Error {
  constructor(
    message: string,
    readonly details?: string | null,
  ) {
    super(message);
  }
}

async function rpc(
  admin: AdminSupabaseClient,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await (
    admin.rpc as unknown as (
      functionName: string,
      parameters: Record<string, unknown>,
    ) => Promise<RpcResult>
  )(name, args);
  if (result.error) {
    throw new PreviewRpcError(
      result.error.message ?? `${name}_failed`,
      result.error.details,
    );
  }
  return result.data;
}

function asPreviewError(error: unknown): DesignPreviewError {
  if (!(error instanceof Error)) {
    return new DesignPreviewError(
      "design_write_failed",
      "Design preview request failed.",
      500,
    );
  }
  if (error.message.includes("design_revision_conflict")) {
    let latestRevision: number | undefined;
    if (error instanceof PreviewRpcError && error.details) {
      try {
        const details = JSON.parse(error.details) as {
          latest_revision?: unknown;
        };
        if (
          typeof details.latest_revision === "number" &&
          Number.isSafeInteger(details.latest_revision) &&
          details.latest_revision >= 0
        ) {
          latestRevision = details.latest_revision;
        }
      } catch {
        // Invalid database details are not exposed to callers.
      }
    }
    return new DesignPreviewError(
      "design_conflict",
      "The design revision changed before preview rendering was queued.",
      409,
      latestRevision,
    );
  }
  if (
    error.message.includes("design_read_forbidden") ||
    error.message.includes("design_write_forbidden") ||
    error.message.includes("preview_asset_not_usable")
  ) {
    return new DesignPreviewError(
      "design_forbidden",
      "Design preview is not permitted.",
      403,
    );
  }
  if (error.message.includes("design_not_found")) {
    return new DesignPreviewError("design_not_found", "Design not found.", 404);
  }
  return new DesignPreviewError(
    "design_write_failed",
    "Design preview request failed.",
    500,
  );
}

export function createSupabaseDesignPreviewRepository(
  getAdminClient: () => AdminSupabaseClient,
): DesignPreviewRepository {
  return {
    async queue(input) {
      try {
        return queueDesignPreviewResponseSchema.parse(
          await rpc(getAdminClient(), "loomic_design_preview_queue", {
            p_design_id: input.designId,
            p_expected_revision: input.expectedRevision,
            p_idempotency_key: input.idempotencyKey,
            p_job_id: input.jobId,
            p_actor_user_id: input.actorUserId,
          }),
        );
      } catch (error) {
        throw asPreviewError(error);
      }
    },
    async commit(input) {
      try {
        return previewCommitResultSchema.parse(
          await rpc(getAdminClient(), "loomic_design_preview_commit", {
            p_design_id: input.designId,
            p_expected_revision: input.expectedRevision,
            p_idempotency_key: input.idempotencyKey,
            p_preview_asset_object_id: input.previewAssetObjectId,
            p_preview_revision: input.previewRevision,
            p_actor_user_id: input.actorUserId,
          }),
        );
      } catch (error) {
        throw asPreviewError(error);
      }
    },
  };
}
