import { isDeepStrictEqual } from "node:util";

import {
  type CopyDesignRequest,
  type CreateDesignRequest,
  type CreateDesignResponse,
  type DeleteDesignRequest,
  type DesignDocumentAssetRefDto,
  type DesignDocumentDto,
  type DesignDocumentFontRefDto,
  type DesignLifecycleResponse,
  type DesignMutationRequest,
  type DesignMutationResponse,
  type Json,
  type LoomicSceneV1,
  type ManualCanvasImageImportRequest,
  type ManualCanvasImageImportResponse,
  type RenameDesignRequest,
  type RestoreDesignRequest,
  type UndoManualCanvasImageImportRequest,
  type UndoManualCanvasImageImportResponse,
  copyDesignRequestSchema,
  createDesignRequestSchema,
  createDesignResponseSchema,
  deleteDesignRequestSchema,
  designDocumentAssetRefDtoSchema,
  designDocumentDtoSchema,
  designDocumentFontRefDtoSchema,
  designLifecycleResponseSchema,
  designMutationRequestSchema,
  designMutationResponseSchema,
  manualCanvasImageImportRequestSchema,
  manualCanvasImageImportResponseSchema,
  renameDesignRequestSchema,
  restoreDesignRequestSchema,
  undoManualCanvasImageImportRequestSchema,
  undoManualCanvasImageImportResponseSchema,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import {
  DesignCommandApplyError,
  applyDesignCommands,
} from "./design-command-applier.js";
import {
  ManualCanvasImageImportBuildError,
  buildManualCanvasImageObject,
  manualCanvasImageImportObjectId,
} from "./manual-canvas-image-import.js";

type DatabaseError = {
  code?: string;
  details?: string | null;
  message?: string;
};

export type DesignReferences = {
  assets: DesignDocumentAssetRefDto[];
  fonts: DesignDocumentFontRefDto[];
};

export class DesignServiceError extends Error {
  constructor(
    readonly code:
      | "design_not_found"
      | "design_forbidden"
      | "design_conflict"
      | "design_invalid"
      | "design_create_failed"
      | "design_query_failed"
      | "design_write_failed",
    message: string,
    readonly statusCode: number,
    readonly conflict?: {
      designId?: string;
      canvasId?: string;
      latestRevision: number;
      conflictObjectIds: string[];
      retryable: boolean;
    },
  ) {
    super(message);
    this.name = "DesignServiceError";
  }
}

export type DesignService = {
  create(
    user: AuthenticatedUser,
    input: CreateDesignRequest,
  ): Promise<CreateDesignResponse>;
  get(user: AuthenticatedUser, designId: string): Promise<DesignDocumentDto>;
  mutate(
    user: AuthenticatedUser,
    input: DesignMutationRequest,
    context?: {
      actorKind: "user" | "agent" | "system" | "job";
      agentRunId?: string | undefined;
      toolExecutionId?: string | undefined;
      operation?: "manipulate_design" | "apply_design_template" | undefined;
      templateId?: string | undefined;
      expectedTemplateRevision?: number | undefined;
      confirmationId?: string | undefined;
      destructiveConfirmed?: boolean | undefined;
    },
  ): Promise<DesignMutationResponse>;
  importCanvasImage(
    user: AuthenticatedUser,
    input: ManualCanvasImageImportRequest,
  ): Promise<ManualCanvasImageImportResponse>;
  undoCanvasImageImport(
    user: AuthenticatedUser,
    designId: string,
    operationId: string,
    input: UndoManualCanvasImageImportRequest,
  ): Promise<UndoManualCanvasImageImportResponse>;
  rename(
    user: AuthenticatedUser,
    input: RenameDesignRequest,
  ): Promise<DesignLifecycleResponse>;
  copy(
    user: AuthenticatedUser,
    input: CopyDesignRequest,
  ): Promise<CreateDesignResponse>;
  softDelete(
    user: AuthenticatedUser,
    input: DeleteDesignRequest,
  ): Promise<DesignLifecycleResponse>;
  restore(
    user: AuthenticatedUser,
    input: RestoreDesignRequest,
  ): Promise<DesignLifecycleResponse>;
  references(
    user: AuthenticatedUser,
    designId: string,
  ): Promise<DesignReferences>;
};

export function createDesignService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
}): DesignService {
  return {
    async create(user, rawInput) {
      const input = createDesignRequestSchema.parse(rawInput);
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await (
        client.rpc as unknown as (
          functionName: string,
          parameters: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: DatabaseError | null }>
      )("loomic_design_create", {
        p_request_id: input.request_id,
        p_canvas_id: input.canvas_id,
        p_expected_canvas_revision: input.expected_canvas_revision,
        p_canvas_element_id: input.canvas_element_id,
        p_name: input.name ?? "未命名设计",
        p_width: input.width,
        p_height: input.height,
        p_node_x: input.node.x,
        p_node_y: input.node.y,
        p_node_width: input.node.width,
        p_node_height: input.node.height,
        p_background: input.background,
        p_template_id: input.template_id ?? null,
      });
      if (error) {
        throw mapDatabaseError(error, "create", {
          canvasId: input.canvas_id,
        });
      }
      return createDesignResponseSchema.parse(data);
    },

    async get(user, designId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("design_documents")
        .select(DESIGN_COLUMNS)
        .eq("id", designId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw mapDatabaseError(error, "query", { designId });
      if (!data) throw notFound();
      return designDocumentDtoSchema.parse(data);
    },

    async mutate(user, rawInput, context) {
      const input = designMutationRequestSchema.parse(rawInput);
      const admin = options.getAdminClient();
      const current = await this.get(user, input.design_id);
      if (context?.actorKind === "agent") {
        const replay = await loadAgentMutationReplay(admin, input, context);
        if (replay) return replay;
      }
      let nextScene: LoomicSceneV1;
      try {
        if (
          context?.actorKind !== "agent" &&
          current.revision !== input.expected_revision
        ) {
          // A successful add/remove/update cannot be applied a second time to
          // the latest scene. Validate its durable receipt before reaching the
          // RPC, which still enforces write permission and returns the replay.
          const { data: receipt, error: receiptError } = await admin
            .from("design_document_versions")
            .select("parent_revision, command_batch, actor_kind, actor_user_id")
            .eq("design_id", input.design_id)
            .eq("idempotency_key", input.idempotency_key)
            .maybeSingle();
          if (receiptError)
            throw mapDatabaseError(receiptError, "query", {
              designId: input.design_id,
            });
          if (
            !receipt ||
            receipt.parent_revision !== input.expected_revision ||
            !isDeepStrictEqual(receipt.command_batch, input.commands) ||
            receipt.actor_kind !== (context?.actorKind ?? "user") ||
            receipt.actor_user_id !== user.id
          ) {
            throw conflictError(input.design_id, current.revision, []);
          }
          nextScene = current.scene;
        } else {
          nextScene = applyDesignCommands(current.scene, input.commands);
        }
      } catch (error) {
        if (error instanceof DesignCommandApplyError) {
          if (error.code === "object_version_conflict") {
            throw conflictError(
              input.design_id,
              current.revision,
              error.objectId ? [error.objectId] : [],
            );
          }
          if (error.code === "object_not_found") {
            throw conflictError(
              input.design_id,
              current.revision,
              error.objectId ? [error.objectId] : [],
            );
          }
          throw new DesignServiceError("design_invalid", error.message, 400);
        }
        throw error;
      }

      const agentContext =
        context?.actorKind === "agent" &&
        context.agentRunId &&
        context.toolExecutionId &&
        context.operation
          ? {
              ...context,
              agentRunId: context.agentRunId,
              toolExecutionId: context.toolExecutionId,
              operation: context.operation,
            }
          : null;
      if (context?.actorKind === "agent" && !agentContext) {
        throw new DesignServiceError(
          "design_invalid",
          "Agent mutations require a complete durable audit context.",
          400,
        );
      }
      const { data, error } = agentContext
        ? await callAgentMutationRpcWithLedgerRetry(admin, {
            p_operation: agentContext.operation,
            p_design_id: input.design_id,
            p_expected_revision: input.expected_revision,
            p_idempotency_key: input.idempotency_key,
            p_commands: input.commands as unknown as Json,
            p_next_scene: nextScene as unknown as Json,
            p_actor_user_id: user.id,
            p_agent_run_id: agentContext.agentRunId,
            p_tool_execution_id: agentContext.toolExecutionId,
            ...(agentContext.templateId
              ? { p_template_id: agentContext.templateId }
              : {}),
            ...(agentContext.expectedTemplateRevision !== undefined
              ? {
                  p_expected_template_revision:
                    agentContext.expectedTemplateRevision,
                }
              : {}),
            ...(agentContext.confirmationId
              ? { p_confirmation_id: agentContext.confirmationId }
              : {}),
            ...(agentContext.destructiveConfirmed
              ? { p_destructive_confirmed: true }
              : {}),
          })
        : await admin.rpc("loomic_design_mutate", {
            p_design_id: input.design_id,
            p_expected_revision: input.expected_revision,
            p_idempotency_key: input.idempotency_key,
            p_commands: input.commands as unknown as Json,
            p_next_scene: nextScene as unknown as Json,
            p_actor_kind: context?.actorKind ?? "user",
            p_actor_user_id: user.id,
            ...(context?.agentRunId
              ? { p_agent_run_id: context.agentRunId }
              : {}),
            ...(context?.toolExecutionId
              ? { p_tool_execution_id: context.toolExecutionId }
              : {}),
          });
      if (error) {
        throw mapDatabaseError(error, "write", {
          designId: input.design_id,
        });
      }
      const result = data as Record<string, unknown>;
      return designMutationResponseSchema.parse({
        design_id: result.design_id,
        revision: result.revision,
        changed_object_ids: result.changed_object_ids,
        replayed: result.replayed,
      });
    },

    async importCanvasImage(user, rawInput) {
      const input = manualCanvasImageImportRequestSchema.parse(rawInput);
      const design = await this.get(user, input.design_id);
      const admin = options.getAdminClient();
      const replay = await loadManualCanvasImageImportReplay(
        admin,
        input,
        user.id,
      );
      const client = options.createUserClient(user.accessToken);
      const canvas = await loadImportCanvas(client, input.canvas_id);
      if (canvas.project_id !== design.project_id) {
        throw new DesignServiceError(
          "design_forbidden",
          "The canvas image and design board are not in the same project.",
          403,
        );
      }
      if (replay) {
        const objectId = manualCanvasImageImportObjectId(input);
        return manualCanvasImageImportResponseSchema.parse({
          operation_id: objectId,
          design_id: input.design_id,
          design_revision: replay.revision,
          object_id: objectId,
          object_version: 1,
          source_canvas_id: input.canvas_id,
          source_canvas_revision: canvas.revision,
          source_element_id: input.source_element_id,
          source_element_version: input.expected_source_element_version,
          mode: input.mode,
          replayed: true,
        });
      }

      let object;
      try {
        object = buildManualCanvasImageObject({
          request: input,
          design,
          elements: readCanvasElements(canvas.content),
        });
      } catch (error) {
        if (error instanceof ManualCanvasImageImportBuildError) {
          if (error.code === "source_changed" || error.code === "board_changed") {
            throw new DesignServiceError(
              "design_conflict",
              error.message,
              409,
              {
                canvasId: input.canvas_id,
                latestRevision: canvas.revision,
                conflictObjectIds: [],
                retryable: false,
              },
            );
          }
          throw new DesignServiceError("design_invalid", error.message, 400);
        }
        throw error;
      }

      const result = await this.mutate(user, {
        design_id: input.design_id,
        expected_revision: input.expected_design_revision,
        idempotency_key: input.request_id,
        commands: [{ action: "object.add", object }],
      });
      return manualCanvasImageImportResponseSchema.parse({
        operation_id: object.objectId,
        design_id: input.design_id,
        design_revision: result.revision,
        object_id: object.objectId,
        object_version: object.objectVersion,
        source_canvas_id: input.canvas_id,
        source_canvas_revision: canvas.revision,
        source_element_id: input.source_element_id,
        source_element_version: input.expected_source_element_version,
        mode: input.mode,
        replayed: result.replayed,
      });
    },

    async undoCanvasImageImport(user, designId, operationId, rawInput) {
      const input = undoManualCanvasImageImportRequestSchema.parse(rawInput);
      const result = await this.mutate(user, {
        design_id: designId,
        expected_revision: input.expected_design_revision,
        idempotency_key: input.idempotency_key,
        commands: [
          {
            action: "object.remove",
            object_id: operationId,
            expected_object_version: input.expected_object_version,
          },
        ],
      });
      return undoManualCanvasImageImportResponseSchema.parse({
        operation_id: operationId,
        design_id: designId,
        design_revision: result.revision,
        object_id: operationId,
        removed: true,
        replayed: result.replayed,
      });
    },

    async rename(user, rawInput) {
      const input = renameDesignRequestSchema.parse(rawInput);
      return callLifecycleRpc(
        options.getAdminClient(),
        "loomic_design_rename",
        {
          p_design_id: input.design_id,
          p_expected_revision: input.expected_revision,
          p_idempotency_key: input.idempotency_key,
          p_name: input.name,
          p_actor_user_id: user.id,
        },
        input.design_id,
      );
    },

    async copy(user, rawInput) {
      const input = copyDesignRequestSchema.parse(rawInput);
      const data = await callRawRpc(
        options.getAdminClient(),
        "loomic_design_copy",
        {
          p_request_id: input.request_id,
          p_source_design_id: input.source_design_id,
          p_canvas_id: input.canvas_id,
          p_expected_canvas_revision: input.expected_canvas_revision,
          p_canvas_element_id: input.canvas_element_id,
          p_name: input.name ?? null,
          p_node_x: input.node.x,
          p_node_y: input.node.y,
          p_node_width: input.node.width,
          p_node_height: input.node.height,
          p_actor_user_id: user.id,
        },
        {
          designId: input.source_design_id,
          canvasId: input.canvas_id,
        },
      );
      return createDesignResponseSchema.parse(data);
    },

    async softDelete(user, rawInput) {
      const input = deleteDesignRequestSchema.parse(rawInput);
      return callLifecycleRpc(
        options.getAdminClient(),
        "loomic_design_soft_delete",
        lifecycleArgs(input, user.id),
        input.design_id,
      );
    },

    async restore(user, rawInput) {
      const input = restoreDesignRequestSchema.parse(rawInput);
      return callLifecycleRpc(
        options.getAdminClient(),
        "loomic_design_restore",
        lifecycleArgs(input, user.id),
        input.design_id,
      );
    },

    async references(user, designId) {
      // Loading the document first gives deleted documents the same default-hide
      // behavior and avoids distinguishing inaccessible IDs from unknown IDs.
      await this.get(user, designId);
      const client = options.createUserClient(user.accessToken);
      const [assetResult, fontResult] = await Promise.all([
        client
          .from("design_document_asset_refs")
          .select(
            "design_id, workspace_id, object_id, slot, asset_object_id, resource_id",
          )
          .eq("design_id", designId)
          .order("object_id"),
        client
          .from("design_document_font_refs")
          .select("design_id, workspace_id, object_id, font_face_id")
          .eq("design_id", designId)
          .order("object_id"),
      ]);
      if (assetResult.error || fontResult.error) {
        const referenceError = assetResult.error ?? fontResult.error;
        if (!referenceError) {
          throw new DesignServiceError(
            "design_query_failed",
            "Unable to load design references.",
            500,
          );
        }
        throw mapDatabaseError(referenceError, "query", { designId });
      }
      return {
        assets: (assetResult.data ?? []).map((row) =>
          designDocumentAssetRefDtoSchema.parse(row),
        ),
        fonts: (fontResult.data ?? []).map((row) =>
          designDocumentFontRefDtoSchema.parse(row),
        ),
      };
    },
  };
}

async function callAgentMutationRpcWithLedgerRetry(
  admin: AdminSupabaseClient,
  args: Record<string, unknown>,
) {
  const rpc = admin.rpc.bind(admin) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: DatabaseError | null }>;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await rpc("loomic_agent_design_mutate_v2", args);
    if (
      !result.error ||
      result.error.code !== "42501" ||
      !result.error.message?.includes("agent_design_execution_invalid") ||
      attempt === 5
    ) {
      return result;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, 20 * (attempt + 1)),
    );
  }
  throw new Error("unreachable");
}

async function loadAgentMutationReplay(
  admin: AdminSupabaseClient,
  input: DesignMutationRequest,
  context: NonNullable<Parameters<DesignService["mutate"]>[2]>,
): Promise<DesignMutationResponse | null> {
  const { data: version, error } = await admin
    .from("design_document_versions")
    .select(
      "revision, parent_revision, command_batch, changed_object_ids, tool_execution_id",
    )
    .eq("design_id", input.design_id)
    .eq("idempotency_key", input.idempotency_key)
    .maybeSingle();
  if (error)
    throw mapDatabaseError(error, "query", { designId: input.design_id });
  if (!version) return null;
  const toolExecutionId = version.tool_execution_id;
  const { data: request, error: requestError } = toolExecutionId
    ? await admin
        .from("design_agent_tool_requests")
        .select("operation, template_id, expected_template_revision")
        .eq("tool_execution_id", toolExecutionId)
        .maybeSingle()
    : { data: null, error: null };
  if (requestError)
    throw mapDatabaseError(requestError, "query", {
      designId: input.design_id,
    });
  const same =
    version.parent_revision === input.expected_revision &&
    JSON.stringify(version.command_batch) === JSON.stringify(input.commands) &&
    request !== null &&
    request.operation === context.operation &&
    (request.template_id ?? null) === (context.templateId ?? null) &&
    (request.expected_template_revision ?? null) ===
      (context.expectedTemplateRevision ?? null);
  if (!same) {
    throw new DesignServiceError(
      "design_conflict",
      "The idempotency key was already used for a different design mutation.",
      409,
      {
        designId: input.design_id,
        latestRevision: Number(version.revision),
        conflictObjectIds: [],
        retryable: false,
      },
    );
  }
  return designMutationResponseSchema.parse({
    design_id: input.design_id,
    revision: version.revision,
    changed_object_ids: version.changed_object_ids,
    replayed: true,
  });
}

async function loadManualCanvasImageImportReplay(
  admin: AdminSupabaseClient,
  input: ManualCanvasImageImportRequest,
  actorUserId: string,
): Promise<DesignMutationResponse | null> {
  const { data: version, error } = await admin
    .from("design_document_versions")
    .select(
      "revision, parent_revision, command_batch, changed_object_ids, actor_kind, actor_user_id",
    )
    .eq("design_id", input.design_id)
    .eq("idempotency_key", input.request_id)
    .maybeSingle();
  if (error)
    throw mapDatabaseError(error, "query", { designId: input.design_id });
  if (!version) return null;
  const commands = Array.isArray(version.command_batch)
    ? version.command_batch
    : [];
  const command = commands[0] as Record<string, unknown> | undefined;
  const object = command?.object as Record<string, unknown> | undefined;
  const expectedObjectId = manualCanvasImageImportObjectId(input);
  const same =
    version.parent_revision === input.expected_design_revision &&
    version.actor_kind === "user" &&
    version.actor_user_id === actorUserId &&
    commands.length === 1 &&
    command?.action === "object.add" &&
    object?.type === "image" &&
    object.objectId === expectedObjectId &&
    Array.isArray(version.changed_object_ids) &&
    version.changed_object_ids.includes(expectedObjectId);
  if (!same) {
    throw new DesignServiceError(
      "design_conflict",
      "The request ID was already used for a different design mutation.",
      409,
      {
        designId: input.design_id,
        latestRevision: Number(version.revision),
        conflictObjectIds: [],
        retryable: false,
      },
    );
  }
  return designMutationResponseSchema.parse({
    design_id: input.design_id,
    revision: version.revision,
    changed_object_ids: version.changed_object_ids,
    replayed: true,
  });
}

async function loadImportCanvas(
  client: UserSupabaseClient,
  canvasId: string,
) {
  const { data, error } = await client
    .from("canvases")
    .select("id, project_id, revision, content")
    .eq("id", canvasId)
    .maybeSingle();
  if (error) throw mapDatabaseError(error, "query", { canvasId });
  if (!data) {
    throw new DesignServiceError(
      "design_not_found",
      "Canvas not found.",
      404,
    );
  }
  return data;
}

function readCanvasElements(content: unknown): readonly unknown[] {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return [];
  }
  const elements = (content as Record<string, unknown>).elements;
  return Array.isArray(elements) ? elements : [];
}

const DESIGN_COLUMNS =
  "id, workspace_id, project_id, name, width, height, revision, scene, preview_asset_object_id, preview_revision, preview_status, deleted_at, created_at, updated_at";

function lifecycleArgs(
  input: DeleteDesignRequest | RestoreDesignRequest,
  actorUserId: string,
) {
  return {
    p_design_id: input.design_id,
    p_expected_revision: input.expected_revision,
    p_idempotency_key: input.idempotency_key,
    p_actor_user_id: actorUserId,
  };
}

async function callLifecycleRpc(
  admin: AdminSupabaseClient,
  name: string,
  args: Record<string, unknown>,
  designId: string,
) {
  return designLifecycleResponseSchema.parse(
    await callRawRpc(admin, name, args, designId),
  );
}

async function callRawRpc(
  admin: AdminSupabaseClient,
  name: string,
  args: Record<string, unknown>,
  target: string | { designId?: string; canvasId?: string },
): Promise<unknown> {
  // Lifecycle RPCs are introduced by the lifecycle migration. Keeping this
  // narrow cast local avoids weakening generated database types elsewhere.
  const { data, error } = await (
    admin.rpc as unknown as (
      functionName: string,
      parameters: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: DatabaseError | null }>
  )(name, args);
  if (error) {
    throw mapDatabaseError(
      error,
      "write",
      typeof target === "string" ? { designId: target } : target,
    );
  }
  return data;
}

function mapDatabaseError(
  error: DatabaseError,
  operation: "create" | "query" | "write",
  target: { designId?: string; canvasId?: string },
): DesignServiceError {
  const message = error.message ?? "Design operation failed.";
  if (error.code === "40001" || message.includes("_revision_conflict")) {
    const detail = parseErrorDetail(error.details);
    const conflictTarget =
      message.includes("canvas_revision_conflict") && target.canvasId
        ? { canvasId: target.canvasId }
        : target.designId
          ? { designId: target.designId }
          : target;
    return conflictError(
      conflictTarget,
      numberFrom(detail.latest_revision),
      typeof detail.object_id === "string" ? [detail.object_id] : [],
    );
  }
  if (error.code === "42501" || message.includes("forbidden")) {
    return new DesignServiceError(
      "design_forbidden",
      "You do not have permission to modify this design.",
      403,
    );
  }
  if (error.code === "P0002" || message.includes("design_not_found")) {
    return notFound();
  }
  if (message.includes("idempotency_conflict")) {
    return conflictError(target, 0, []);
  }
  if (
    error.code === "22023" ||
    error.code === "23505" ||
    error.code === "23514"
  ) {
    return new DesignServiceError("design_invalid", message, 400);
  }
  return new DesignServiceError(
    operation === "create"
      ? "design_create_failed"
      : operation === "query"
        ? "design_query_failed"
        : "design_write_failed",
    operation === "query"
      ? "Unable to load design."
      : operation === "create"
        ? "Unable to create design."
        : "Unable to update design.",
    500,
  );
}

function parseErrorDetail(detail: string | null | undefined) {
  if (!detail) return {} as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(detail);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function numberFrom(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function conflictError(
  target: { designId?: string; canvasId?: string } | string,
  latestRevision: number,
  conflictObjectIds: string[],
) {
  const normalizedTarget =
    typeof target === "string" ? { designId: target } : target;
  return new DesignServiceError(
    "design_conflict",
    "Design changed while saving. Reload and retry your changes.",
    409,
    {
      ...normalizedTarget,
      latestRevision,
      conflictObjectIds,
      retryable: false,
    },
  );
}

function notFound() {
  return new DesignServiceError("design_not_found", "Design not found.", 404);
}
