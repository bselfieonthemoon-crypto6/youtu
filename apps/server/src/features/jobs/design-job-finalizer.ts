import { createHash } from "node:crypto";
import {
  type BackgroundJob,
  type DesignCommand,
  type DesignDocumentDto,
  type DesignMutationResponse,
  type JobTargetFinalizationDto,
  type Json,
  backgroundJobSchema,
  designDocumentDtoSchema,
  designMutationRequestSchema,
  designMutationResponseSchema,
  jobTargetFinalizationDtoSchema,
} from "@loomic/shared";
import { z } from "zod";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { applyDesignCommands } from "../designs/design-command-applier.js";
import { normalizePersistedGenerationJob } from "./design-target-normalizer.js";
import { isAgentTaskAttachmentRejected } from "../agent-tasks/agent-task-service.js";

const generatedAssetSchema = z
  .object({
    asset_id: z.string().uuid(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    mime_type: z.string().min(1),
    source_width: z.number().int().positive().optional(),
    source_height: z.number().int().positive().optional(),
    layers: z
      .array(
        z
          .object({
            asset_id: z.string().uuid(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            mime_type: z.string().min(1),
            kind: z.enum(["foreground", "background", "element"]),
            x: z.number().finite(),
            y: z.number().finite(),
            index: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const claimSchema = z
  .object({
    acquired: z.boolean(),
    finalization: z.unknown(),
  })
  .strict();

export type DesignFinalizationRepository = {
  claim(
    jobId: string,
    commandId: string,
  ): Promise<{
    acquired: boolean;
    finalization: JobTargetFinalizationDto;
  }>;
  finish(input: {
    jobId: string;
    commandId: string;
    status: "completed" | "needs_attention" | "failed";
    result?: Record<string, unknown>;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<JobTargetFinalizationDto>;
};

export type DesignJobMutationPort = {
  get(designId: string): Promise<DesignDocumentDto>;
  mutate(input: {
    designId: string;
    expectedRevision: number;
    idempotencyKey: string;
    commands: DesignCommand[];
    actorUserId: string;
  }): Promise<DesignMutationResponse>;
};

export type DesignJobPreviewPort = {
  enqueue(input: {
    designId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actorUserId: string;
  }): Promise<unknown>;
};

export class DesignJobMutationConflict extends Error {
  constructor(message = "design_revision_conflict") {
    super(message);
    this.name = "DesignJobMutationConflict";
  }
}

export type DesignJobFinalizationOutcome = {
  finalization: JobTargetFinalizationDto;
  inserted: boolean;
};

export class DesignJobFinalizer {
  constructor(
    private readonly repository: DesignFinalizationRepository,
    private readonly mutations: DesignJobMutationPort,
    private readonly previews?: DesignJobPreviewPort,
  ) {}

  async finalize(
    rawJob: BackgroundJob,
  ): Promise<DesignJobFinalizationOutcome | null> {
    const job = normalizePersistedGenerationJob(rawJob);
    if (
      job.job_type !== "image_generation" ||
      job.status !== "succeeded" ||
      job.payload.target?.kind !== "design"
    ) {
      return null;
    }

    const target = job.payload.target;
    const asset = generatedAssetSchema.parse(job.result);
    const commandId = target.idempotency_key;
    const claim = await this.repository.claim(job.id, commandId);
    if (!claim.acquired) {
      return {
        finalization: claim.finalization,
        inserted: false,
      };
    }

    if (job.payload.operation === "split_layers") {
      return this.finalizeSplitLayers({ job, target, asset, commandId });
    }

    if (target.placement?.replace_object_id) {
      return this.finalizeReplacement({
        job,
        target,
        asset,
        commandId,
      });
    }
    return this.finalizeInsertion({ job, target, asset, commandId });
  }

  private async finalizeSplitLayers(input: {
    job: Extract<
      ReturnType<typeof normalizePersistedGenerationJob>,
      { job_type: "image_generation" }
    >;
    target: Extract<
      NonNullable<
        Extract<
          ReturnType<typeof normalizePersistedGenerationJob>,
          { job_type: "image_generation" }
        >["payload"]["target"]
      >,
      { kind: "design" }
    >;
    asset: z.infer<typeof generatedAssetSchema>;
    commandId: string;
  }): Promise<DesignJobFinalizationOutcome> {
    const document = await this.mutations.get(input.target.design_id);
    const sourceId =
      input.target.source_object_id ??
      input.target.placement?.replace_object_id;
    const source = document.scene.objects.find(
      (object) => object.objectId === sourceId,
    );
    if (
      document.revision !== input.target.expected_revision ||
      !source ||
      source.type !== "image" ||
      source.objectVersion !== input.target.expected_object_version ||
      source.assetObjectId !== input.target.source_asset_object_id
    ) {
      return this.needsAttention(
        input.job.id,
        input.commandId,
        "design_split_source_changed",
        "The source image changed before layer splitting completed.",
      );
    }
    const layers = input.asset.layers ?? [];
    const background = layers.find((layer) => layer.kind === "background");
    const elements = layers
      .filter((layer) => layer !== background)
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    const sourceWidth = input.asset.source_width;
    const sourceHeight = input.asset.source_height;
    if (!background || !sourceWidth || !sourceHeight || elements.length === 0) {
      return this.needsAttention(
        input.job.id,
        input.commandId,
        "design_split_result_invalid",
        "Layer splitting did not return a background and element layers.",
      );
    }
    const semantic = input.job.payload.layer_backend === "semantic";
    const layout = semantic ? {
      x: input.target.placement?.x ?? source.x + source.width + 24,
      y: input.target.placement?.y ?? source.y,
      width: input.target.placement?.width ?? source.width,
      height: input.target.placement?.height ?? source.height,
    } : source;
    const commands: DesignCommand[] = [
      semantic ? {
        action: "object.add",
        object: {
          objectId: deterministicObjectId(input.commandId, 0),
          objectVersion: 1,
          type: "image",
          name: typeof background.name === "string" ? background.name : "修补底图",
          x: layout.x, y: layout.y, width: layout.width, height: layout.height,
          rotation: source.rotation, opacity: source.opacity,
          zIndex: source.zIndex + 1, locked: false, visible: true,
          assetObjectId: background.asset_id, fit: "fill",
        },
      } : {
        action: "object.update",
        object_id: source.objectId,
        expected_object_version: source.objectVersion,
        patch: {
          object_type: "image",
          asset_object_id: background.asset_id,
          resource_id: null,
        },
      },
      ...elements.map((layer, index): DesignCommand => {
        const width = (layer.width / sourceWidth) * layout.width;
        const height = (layer.height / sourceHeight) * layout.height;
        const localCenterX =
          layout.x + ((layer.x + layer.width / 2) / sourceWidth) * layout.width;
        const localCenterY =
          layout.y +
          ((layer.y + layer.height / 2) / sourceHeight) * layout.height;
        const center = rotatePoint(
          localCenterX,
          localCenterY,
          layout.x + layout.width / 2,
          layout.y + layout.height / 2,
          source.rotation,
        );
        return {
          action: "object.add",
          object: {
            objectId: deterministicObjectId(input.commandId, semantic ? index + 1 : index),
            objectVersion: 1,
            type: "image",
            ...(typeof layer.name === "string" ? { name: layer.name } : {}),
            x: center.x - width / 2,
            y: center.y - height / 2,
            width,
            height,
            rotation: source.rotation,
            opacity: source.opacity,
            zIndex: source.zIndex + (semantic ? 2 : 1) + index,
            locked: false,
            visible: true,
            assetObjectId: layer.asset_id,
            fit: "fill",
          },
        };
      }),
    ];
    try {
      const mutation = await this.mutations.mutate({
        designId: document.id,
        expectedRevision: document.revision,
        idempotencyKey: input.commandId,
        commands,
        actorUserId: input.job.created_by,
      });
      const previewStatus = await this.enqueuePreview(
        document.id,
        mutation.revision,
        input.commandId,
        input.job.created_by,
      );
      const objectIds = [
        semantic ? deterministicObjectId(input.commandId, 0) : source.objectId,
        ...elements.map((_, index) =>
          deterministicObjectId(input.commandId, semantic ? index + 1 : index),
        ),
      ];
      const finalization = await this.repository.finish({
        jobId: input.job.id,
        commandId: input.commandId,
        status: "completed",
        result: {
          design_id: document.id,
          revision: mutation.revision,
          object_ids: objectIds,
          asset_object_ids: [
            background.asset_id,
            ...elements.map((layer) => layer.asset_id),
          ],
          replayed: mutation.replayed,
          preview_status: previewStatus,
        },
      });
      return { finalization, inserted: !mutation.replayed };
    } catch (error) {
      if (isAgentTaskAttachmentRejected(error)) return this.superseded(input.job.id, input.commandId);
      if (error instanceof DesignJobMutationConflict) {
        return this.needsAttention(
          input.job.id,
          input.commandId,
          "design_split_conflict",
          "The design changed while applying the split layers.",
        );
      }
      throw error;
    }
  }

  private async finalizeInsertion(input: {
    job: Extract<
      ReturnType<typeof normalizePersistedGenerationJob>,
      { job_type: "image_generation" }
    >;
    target: Extract<
      NonNullable<
        Extract<
          ReturnType<typeof normalizePersistedGenerationJob>,
          { job_type: "image_generation" }
        >["payload"]["target"]
      >,
      { kind: "design" }
    >;
    asset: z.infer<typeof generatedAssetSchema>;
    commandId: string;
  }): Promise<DesignJobFinalizationOutcome> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const document = await this.mutations.get(input.target.design_id);
      const existing = document.scene.objects.find(
        (object) => object.objectId === input.commandId,
      );
      if (existing) {
        if (
          existing.type !== "image" ||
          existing.assetObjectId !== input.asset.asset_id
        ) {
          return this.needsAttention(
            input.job.id,
            input.commandId,
            "design_object_id_conflict",
            "The deterministic generated-image object id is already in use.",
          );
        }
        const previewStatus = await this.enqueuePreview(
          document.id,
          document.revision,
          input.commandId,
          input.job.created_by,
        );
        const finalization = await this.repository.finish({
          jobId: input.job.id,
          commandId: input.commandId,
          status: "completed",
          result: resultPayload(
            document.id,
            document.revision,
            existing.objectId,
            input.asset.asset_id,
            true,
            previewStatus,
          ),
        });
        return { finalization, inserted: false };
      }

      const placement = input.target.placement;
      const command: DesignCommand = {
        action: "object.add",
        object: {
          objectId: input.commandId,
          objectVersion: 1,
          type: "image",
          x: placement?.x ?? 0,
          y: placement?.y ?? 0,
          width: placement?.width ?? input.asset.width,
          height: placement?.height ?? input.asset.height,
          rotation: 0,
          opacity: 1,
          zIndex: Math.min(placement?.layer_index ?? document.scene.objects.length, document.scene.objects.length),
          locked: false,
          visible: true,
          ...(placement?.role ? { role: placement.role } : {}),
          assetObjectId: input.asset.asset_id,
          fit: placement?.fit ?? "contain",
        },
      };
      try {
        const mutation = await this.mutations.mutate({
          designId: input.target.design_id,
          expectedRevision: document.revision,
          idempotencyKey: input.commandId,
          commands: [command],
          actorUserId: input.job.created_by,
        });
        const previewStatus = await this.enqueuePreview(
          input.target.design_id,
          mutation.revision,
          input.commandId,
          input.job.created_by,
        );
        const finalization = await this.repository.finish({
          jobId: input.job.id,
          commandId: input.commandId,
          status: "completed",
          result: resultPayload(
            input.target.design_id,
            mutation.revision,
            input.commandId,
            input.asset.asset_id,
            mutation.replayed,
            previewStatus,
          ),
        });
        return { finalization, inserted: !mutation.replayed };
      } catch (error) {
        if (isAgentTaskAttachmentRejected(error)) return this.superseded(input.job.id, input.commandId);
        if (error instanceof DesignJobMutationConflict) continue;
        await this.repository.finish({
          jobId: input.job.id,
          commandId: input.commandId,
          status: "failed",
          errorCode: "design_finalization_failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const finalization = await this.repository.finish({
      jobId: input.job.id,
      commandId: input.commandId,
      status: "failed",
      errorCode: "design_revision_busy",
      errorMessage:
        "The design kept changing while inserting the generated image.",
    });
    return { finalization, inserted: false };
  }

  private async finalizeReplacement(input: {
    job: Extract<
      ReturnType<typeof normalizePersistedGenerationJob>,
      { job_type: "image_generation" }
    >;
    target: Extract<
      NonNullable<
        Extract<
          ReturnType<typeof normalizePersistedGenerationJob>,
          { job_type: "image_generation" }
        >["payload"]["target"]
      >,
      { kind: "design" }
    >;
    asset: z.infer<typeof generatedAssetSchema>;
    commandId: string;
  }): Promise<DesignJobFinalizationOutcome> {
    const document = await this.mutations.get(input.target.design_id);
    const placement = input.target.placement;
    const replaceObjectId = placement?.replace_object_id;
    if (!placement || !replaceObjectId) {
      return this.needsAttention(
        input.job.id,
        input.commandId,
        "design_replace_target_changed",
        "The replacement placement is no longer valid.",
      );
    }
    const object = document.scene.objects.find(
      (candidate) => candidate.objectId === replaceObjectId,
    );
    if (document.revision !== input.target.expected_revision) {
      return this.needsAttention(
        input.job.id,
        input.commandId,
        "design_revision_conflict",
        "The design changed after this replacement was requested.",
      );
    }
    if (
      !object ||
      object.type !== "image" ||
      (input.target.source_object_id !== undefined &&
        object.objectId !== input.target.source_object_id) ||
      (input.target.expected_object_version !== undefined &&
        object.objectVersion !== input.target.expected_object_version) ||
      (input.target.source_asset_object_id !== undefined &&
        object.assetObjectId !== input.target.source_asset_object_id)
    ) {
      return this.needsAttention(
        input.job.id,
        input.commandId,
        "design_replace_target_changed",
        "The image selected for replacement was removed or changed type.",
      );
    }

    const command: DesignCommand = {
      action: "object.update",
      object_id: object.objectId,
      expected_object_version: object.objectVersion,
      patch: {
        object_type: "image",
        asset_object_id: input.asset.asset_id,
        resource_id: null,
        x: placement.x,
        y: placement.y,
        ...(placement.width ? { width: placement.width } : {}),
        ...(placement.height ? { height: placement.height } : {}),
        ...(placement.fit ? { fit: placement.fit } : {}),
      },
    };
    try {
      const mutation = await this.mutations.mutate({
        designId: input.target.design_id,
        expectedRevision: document.revision,
        idempotencyKey: input.commandId,
        commands: [command],
        actorUserId: input.job.created_by,
      });
      const previewStatus = await this.enqueuePreview(
        input.target.design_id,
        mutation.revision,
        input.commandId,
        input.job.created_by,
      );
      const finalization = await this.repository.finish({
        jobId: input.job.id,
        commandId: input.commandId,
        status: "completed",
        result: resultPayload(
          input.target.design_id,
          mutation.revision,
          object.objectId,
          input.asset.asset_id,
          mutation.replayed,
          previewStatus,
        ),
      });
      return { finalization, inserted: false };
    } catch (error) {
      if (isAgentTaskAttachmentRejected(error)) return this.superseded(input.job.id, input.commandId);
      if (error instanceof DesignJobMutationConflict) {
        return this.needsAttention(
          input.job.id,
          input.commandId,
          "design_replace_conflict",
          "The replacement target changed before the result was applied.",
        );
      }
      await this.repository.finish({
        jobId: input.job.id,
        commandId: input.commandId,
        status: "failed",
        errorCode: "design_finalization_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async superseded(jobId: string, commandId: string): Promise<DesignJobFinalizationOutcome> {
    const finalization = await this.repository.finish({
      jobId,
      commandId,
      status: "needs_attention",
      result: { attachment_status: "superseded" },
      errorCode: "agent_task_superseded",
      errorMessage: "图片已生成并保留；任务已更新，未应用到当前设计。",
    });
    return { finalization, inserted: false };
  }

  private async needsAttention(
    jobId: string,
    commandId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<DesignJobFinalizationOutcome> {
    const finalization = await this.repository.finish({
      jobId,
      commandId,
      status: "needs_attention",
      errorCode,
      errorMessage,
    });
    return { finalization, inserted: false };
  }

  private async enqueuePreview(
    designId: string,
    revision: number,
    idempotencyKey: string,
    actorUserId: string,
  ): Promise<"queued" | "failed" | "unavailable"> {
    if (!this.previews) return "unavailable";
    try {
      await this.previews.enqueue({
        designId,
        expectedRevision: revision,
        idempotencyKey,
        actorUserId,
      });
      return "queued";
    } catch {
      // Preview delivery is a derived, retryable side effect. The paid provider
      // result and canonical design mutation are already durable at this point.
      return "failed";
    }
  }
}

function deterministicObjectId(commandId: string, index: number) {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${commandId}:design-layer:${index}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rotatePoint(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  degrees: number,
) {
  const radians = (degrees * Math.PI) / 180;
  const deltaX = x - centerX;
  const deltaY = y - centerY;
  return {
    x: centerX + deltaX * Math.cos(radians) - deltaY * Math.sin(radians),
    y: centerY + deltaX * Math.sin(radians) + deltaY * Math.cos(radians),
  };
}

function resultPayload(
  designId: string,
  revision: number,
  objectId: string,
  assetObjectId: string,
  replayed: boolean,
  previewStatus: "queued" | "failed" | "unavailable",
) {
  return {
    design_id: designId,
    revision,
    object_id: objectId,
    asset_object_id: assetObjectId,
    replayed,
    preview_status: previewStatus,
  };
}

type RpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

async function rpc(
  admin: AdminSupabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await (
    admin.rpc as unknown as (
      functionName: string,
      parameters: Record<string, unknown>,
    ) => Promise<RpcResult>
  )(name, args);
  if (error) {
    if (
      error.code === "40001" ||
      error.message?.includes("revision_conflict")
    ) {
      throw new DesignJobMutationConflict(error.message);
    }
    throw new Error(error.message ?? `${name}_failed`);
  }
  return data;
}

export function createSupabaseDesignFinalizationRepository(
  getAdminClient: () => AdminSupabaseClient,
): DesignFinalizationRepository {
  return {
    async claim(jobId, commandId) {
      const claim = claimSchema.parse(
        await rpc(getAdminClient(), "loomic_job_finalization_claim", {
          p_job_id: jobId,
          p_command_id: commandId,
          p_now: new Date().toISOString(),
        }),
      );
      return {
        acquired: claim.acquired,
        finalization: jobTargetFinalizationDtoSchema.parse(claim.finalization),
      };
    },
    async finish(input) {
      return jobTargetFinalizationDtoSchema.parse(
        await rpc(getAdminClient(), "loomic_job_finalization_finish", {
          p_job_id: input.jobId,
          p_command_id: input.commandId,
          p_status: input.status,
          p_result: (input.result ?? null) as Json,
          p_error_code: input.errorCode ?? null,
          p_error_message: input.errorMessage ?? null,
        }),
      );
    },
  };
}

export function createDesignJobMutationPort(
  getAdminClient: () => AdminSupabaseClient,
): DesignJobMutationPort {
  return {
    async get(designId) {
      const { data, error } = await getAdminClient()
        .from("design_documents")
        .select(
          "id, workspace_id, project_id, name, width, height, revision, scene, preview_asset_object_id, preview_revision, preview_status, deleted_at, created_at, updated_at",
        )
        .eq("id", designId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error || !data) throw new Error(error?.message ?? "design_not_found");
      return designDocumentDtoSchema.parse(data);
    },
    async mutate(input) {
      const request = designMutationRequestSchema.parse({
        design_id: input.designId,
        expected_revision: input.expectedRevision,
        idempotency_key: input.idempotencyKey,
        commands: input.commands,
      });
      const current = await this.get(input.designId);
      const nextScene = applyDesignCommands(current.scene, request.commands);
      return designMutationResponseSchema.parse(
        await rpc(getAdminClient(), "loomic_design_mutate", {
          p_design_id: request.design_id,
          p_expected_revision: request.expected_revision,
          p_idempotency_key: request.idempotency_key,
          p_commands: request.commands as unknown as Json,
          p_next_scene: nextScene as unknown as Json,
          p_actor_kind: "job",
          p_actor_user_id: input.actorUserId,
          p_agent_run_id: null,
          p_tool_execution_id: null,
        }),
      );
    },
  };
}

export async function reconcileSucceededDesignImageJobs(
  admin: AdminSupabaseClient,
  finalizer: DesignJobFinalizer,
  limit = 100,
): Promise<{ checked: number; finalized: number; failed: number }> {
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
  const { data, error } = await (
    admin.rpc as unknown as (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{
      data: unknown[] | null;
      error: { message?: string } | null;
    }>
  )("loomic_design_finalization_candidates", { p_limit: safeLimit });
  if (error)
    throw new Error(`design_finalization_scan_failed:${error.message}`);

  let finalized = 0;
  let failed = 0;
  for (const rawRow of data ?? []) {
    const row = backgroundJobSchema.parse(pickBackgroundJob(rawRow));
    try {
      const outcome = await finalizer.finalize(row);
      if (outcome?.finalization.status === "completed") finalized += 1;
    } catch (reconcileError) {
      failed += 1;
      console.error(
        `[design-finalizer] Failed to finalize job ${row.id}:`,
        reconcileError,
      );
    }
  }
  return { checked: data?.length ?? 0, finalized, failed };
}

function pickBackgroundJob(rawRow: unknown) {
  if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
    return rawRow;
  }
  const row = rawRow as Record<string, unknown>;
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    canvas_id: row.canvas_id,
    target_kind: row.target_kind,
    design_id: row.design_id,
    session_id: row.session_id,
    thread_id: row.thread_id,
    queue_name: row.queue_name,
    job_type: row.job_type,
    status: row.status,
    payload: row.payload,
    result: row.result,
    error_code: row.error_code,
    error_message: row.error_message,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    failed_at: row.failed_at,
    canceled_at: row.canceled_at,
  };
}
