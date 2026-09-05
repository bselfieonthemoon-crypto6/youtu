import {
  DynamicStructuredTool,
  type StructuredTool,
} from "@langchain/core/tools";

import {
  type AgentDesignToolErrorCode,
  type ApplyDesignTemplateToolInput,
  type DesignCommand,
  type DesignObject,
  type ExportDesignToolInput,
  type GetDesignObjectsToolInput,
  type InspectDesignToolInput,
  type ManipulateDesignToolInput,
  type SearchDesignResourcesToolInput,
  agentDesignToolErrorOutputSchema,
  applyDesignTemplateToolInputSchema,
  applyDesignTemplateToolOutputSchema,
  exportDesignToolInputSchema,
  exportDesignToolOutputSchema,
  getDesignObjectsToolInputSchema,
  getDesignObjectsToolOutputSchema,
  inspectDesignToolInputSchema,
  inspectDesignToolOutputSchema,
  manipulateDesignToolInputSchema,
  manipulateDesignModelInputSchema,
  manipulateDesignToolOutputSchema,
  searchDesignResourcesToolInputSchema,
  searchDesignResourcesToolOutputSchema,
} from "@loomic/shared";

import type { DestructiveConfirmationService } from "../../features/agent-actions/destructive-confirmation-service.js";
import type { DesignResourceService } from "../../features/design-resources/design-resource-service.js";
import type { DesignTemplateService } from "../../features/design-resources/design-template-service.js";
import type { DesignExportService } from "../../features/designs/design-export-service.js";
import type { DesignPreviewService } from "../../features/designs/design-preview-service.js";
import {
  type DesignService,
  DesignServiceError,
} from "../../features/designs/design-service.js";
import type { AuthenticatedUser } from "../../supabase/user.js";

export type DesignToolDependencies = {
  designService: DesignService;
  designResourceService: Pick<DesignResourceService, "list">;
  designTemplateService: Pick<DesignTemplateService, "get">;
  designExportService?:
    | Pick<DesignExportService, "enqueueWithReplay">
    | undefined;
  designPreviewService?: Pick<DesignPreviewService, "enqueue"> | undefined;
  destructiveConfirmationService?: DestructiveConfirmationService | undefined;
};

function tool<Input>(
  handler: (input: Input, config: unknown) => Promise<string>,
  fields: { name: string; description: string; schema: unknown },
): StructuredTool {
  return new DynamicStructuredTool({
    name: fields.name,
    description: fields.description,
    schema: fields.schema as never,
    func: async (input: Input, runManager, config) =>
      handler(input, {
        ...config,
        configurable: {
          ...config?.configurable,
          ...(runManager?.runId ? { tool_execution_id: runManager.runId } : {}),
        },
      }),
  }) as StructuredTool;
}

export function createDesignTools(deps: DesignToolDependencies) {
  const inspect = tool(
    async (input: InspectDesignToolInput, config) => {
      const user = contextUser(config);
      if (!user) return noContext();
      try {
        const design = await deps.designService.get(user, input.design_id);
        if (!workspaceMatches(config, design.workspace_id))
          return failure(
            "design_forbidden",
            "Design is outside the active workspace.",
          );
        const offset = input.offset ?? 0;
        if (offset > 0 && input.expected_revision === undefined)
          return failure("validation_error", "Pagination requires expected_revision from the first page.");
        if (input.expected_revision !== undefined && input.expected_revision !== design.revision)
          return conflict(design.id, design.revision);
        const objects = design.scene.objects.slice(offset, offset + input.object_limit);
        const nextOffset = offset + objects.length < design.scene.objects.length
          ? offset + objects.length : null;
        return parsedJson(inspectDesignToolOutputSchema, {
          design_id: design.id,
          name: design.name,
          width: design.width,
          height: design.height,
          revision: design.revision,
          object_count: design.scene.objects.length,
          objects: objects.map((object) =>
            summarizeObject(object, input.text_limit),
          ),
          selection_object_ids: input.selection_object_ids,
          truncated: nextOffset !== null,
          next_offset: nextOffset,
        });
      } catch (error) {
        return designError(error);
      }
    },
    {
      name: "inspect_design",
      description:
        "Inspect native design layers in back-to-front order, including z_index, visibility and group children. Follow next_offset with offset and the same expected_revision until null. On revision conflict restart at offset 0. Read exact object details with get_design_objects.",
      schema: inspectDesignToolInputSchema,
    },
  );

  const getObjects = tool(
    async (input: GetDesignObjectsToolInput, config) => {
      const user = contextUser(config);
      if (!user) return noContext();
      try {
        const design = await deps.designService.get(user, input.design_id);
        if (!workspaceMatches(config, design.workspace_id))
          return failure(
            "design_forbidden",
            "Design is outside the active workspace.",
          );
        if (design.revision !== input.expected_revision)
          return conflict(design.id, design.revision);
        if (input.object_ids.length > 10)
          return failure(
            "validation_error",
            "Read at most 10 detailed objects per request.",
          );
        const requested = new Set(input.object_ids);
        const objects = design.scene.objects.filter((object) =>
          requested.has(object.objectId),
        );
        if (Buffer.byteLength(JSON.stringify(objects), "utf8") > 256_000)
          return failure(
            "validation_error",
            "The requested object details exceed the 256 KB response budget; request fewer objects.",
          );
        const found = new Set(objects.map((object) => object.objectId));
        return parsedJson(getDesignObjectsToolOutputSchema, {
          design_id: design.id,
          revision: design.revision,
          objects,
          missing_object_ids: input.object_ids.filter((id) => !found.has(id)),
        });
      } catch (error) {
        return designError(error);
      }
    },
    {
      name: "get_design_objects",
      description:
        "Read up to 10 named native design objects at an exact optimistic revision.",
      schema: getDesignObjectsToolInputSchema,
    },
  );

  const manipulate = tool(
    async (input: ManipulateDesignToolInput, config) => {
      const parsedInput = manipulateDesignToolInputSchema.safeParse(input);
      if (!parsedInput.success)
        return failure(
          "validation_error",
          "Design commands do not match the strict mutation contract.",
        );
      input = parsedInput.data;
      const user = contextUser(config);
      const audit = contextAudit(config);
      if (!user || !audit) return noContext();
      let confirmationId: string | undefined;
      const execute = async () => {
        const result = await deps.designService.mutate(user, input, {
          actorKind: "agent",
          agentRunId: audit.agentRunId,
          toolExecutionId: audit.toolExecutionId,
          operation: "manipulate_design",
          ...(confirmationId
            ? {
                confirmationId,
                destructiveConfirmed: true,
              }
            : {}),
        });
        await enqueuePreviewBestEffort(
          deps.designPreviewService,
          user.id,
          input.design_id,
          result.revision,
          input.idempotency_key,
        );
        return result;
      };
      const destructive = input.commands.some(
        (command) =>
          command.action === "object.remove" ||
          command.action === "scene.replace",
      );
      if (destructive) {
        const canvasId = contextString(config, "canvas_id");
        if (!deps.destructiveConfirmationService || !canvasId)
          return failure(
            "internal_error",
            "Destructive design changes require product confirmation.",
          );
        try {
          const current = await deps.designService.get(user, input.design_id);
          if (current.revision !== input.expected_revision)
            return conflict(current.id, current.revision);
          const proposal = deps.destructiveConfirmationService.proposeAction({
            userId: user.id,
            canvasId,
            kind: "design_mutation",
            details: {
              design_id: current.id,
              expected_revision: current.revision,
              actions: input.commands.map((command) => command.action),
            },
            originRunId: audit.agentRunId,
            execute,
          });
          confirmationId = proposal.confirmationId;
          return parsedJson(manipulateDesignToolOutputSchema, {
            status: "confirmation_required",
            design_id: current.id,
            expected_revision: current.revision,
            confirmation_id: proposal.confirmationId,
            summary: confirmationSummary(input.commands),
            affected_object_ids: commandObjectIds(input.commands),
            expires_at: proposal.expiresAt,
          });
        } catch (error) {
          return designError(error);
        }
      }
      try {
        return parsedJson(manipulateDesignToolOutputSchema, {
          status: "applied",
          ...(await execute()),
        });
      } catch (error) {
        return designError(error);
      }
    },
    {
      name: "manipulate_design",
      description:
        'Modify a native design document with CAS and idempotency. The JSON schema is authoritative. For a text edit use commands:[{action:"object.update", object_id:"UUID", expected_object_version:1, patch:{object_type:"text", text:"new text"}}]. Execute a complete valid non-destructive request immediately; deletion and full scene replacement require product confirmation.',
      schema: manipulateDesignModelInputSchema,
    },
  );

  const searchResources = tool(
    async (input: SearchDesignResourcesToolInput, config) => {
      const user = contextUser(config);
      if (!user) return noContext();
      if (contextString(config, "workspace_id") !== input.workspace_id)
        return failure(
          "design_forbidden",
          "Resource search must use the active workspace.",
        );
      try {
        const result = await deps.designResourceService.list(
          user,
          {
            query: input.query,
            kind: input.kind,
            category_id: input.category_id,
            tag_id: input.tag_id,
            cursor: input.cursor,
            limit: input.limit,
            status: "published",
          },
          { activeWorkspaceId: input.workspace_id },
        );
        return parsedJson(searchDesignResourcesToolOutputSchema, {
          items: result.items.map((item) => ({
            id: item.id,
            scope: item.scope,
            workspace_id: item.workspace_id,
            kind: item.kind,
            name: item.name,
            summary:
              item.description?.slice(0, input.summary_max_chars) ?? null,
            width: item.width,
            height: item.height,
            preview_asset_object_id: item.preview_asset_object_id,
            category_id: item.category_id,
            tag_ids: item.tag_ids,
          })),
          next_cursor: result.next_cursor,
          truncated: result.next_cursor !== null,
        });
      } catch (error) {
        return failure(
          "internal_error",
          error instanceof Error ? error.message : "Resource search failed.",
        );
      }
    },
    {
      name: "search_design_resources",
      description:
        "Search published design resources visible in the authenticated workspace using stable cursor pagination.",
      schema: searchDesignResourcesToolInputSchema,
    },
  );

  const applyTemplate = tool(
    async (input: ApplyDesignTemplateToolInput, config) => {
      const user = contextUser(config);
      const audit = contextAudit(config);
      const canvasId = contextString(config, "canvas_id");
      if (!user || !audit) return noContext();
      if (!deps.destructiveConfirmationService || !canvasId)
        return failure(
          "internal_error",
          "Applying a full template requires product confirmation.",
        );
      try {
        const [design, template] = await Promise.all([
          deps.designService.get(user, input.design_id),
          deps.designTemplateService.get(user, input.template_id),
        ]);
        if (!workspaceMatches(config, design.workspace_id))
          return failure(
            "design_forbidden",
            "Design is outside the active workspace.",
          );
        if (design.revision !== input.expected_revision)
          return conflict(design.id, design.revision);
        if (template.template.revision !== input.expected_template_revision)
          return failure(
            "template_revision_conflict",
            `Template revision is ${template.template.revision}; refresh before applying it.`,
            true,
            template.template.revision,
          );
        if (template.template.status !== "published")
          return failure("template_not_found", "Template is not published.");
        const activeWorkspaceId = contextString(config, "workspace_id");
        if (
          template.template.scope !== "platform" &&
          template.template.workspace_id !== activeWorkspaceId
        )
          return failure(
            "template_not_found",
            "Template is not available in the active workspace.",
          );
        const mutation = {
          design_id: design.id,
          expected_revision: design.revision,
          idempotency_key: input.idempotency_key,
          commands: [
            { action: "scene.replace" as const, scene: template.scene },
          ],
        };
        const confirmation = { id: undefined as string | undefined };
        const proposal = deps.destructiveConfirmationService.proposeAction({
          userId: user.id,
          canvasId,
          kind: "design_template_apply",
          details: {
            design_id: design.id,
            template_id: input.template_id,
            expected_revision: design.revision,
          },
          originRunId: audit.agentRunId,
          execute: async () => {
            const result = await deps.designService.mutate(user, mutation, {
              actorKind: "agent",
              agentRunId: audit.agentRunId,
              toolExecutionId: audit.toolExecutionId,
              operation: "apply_design_template",
              templateId: input.template_id,
              expectedTemplateRevision: input.expected_template_revision,
              confirmationId: confirmation.id,
              destructiveConfirmed: true,
            });
            await enqueuePreviewBestEffort(
              deps.designPreviewService,
              user.id,
              input.design_id,
              result.revision,
              input.idempotency_key,
            );
            return {
              status: "applied" as const,
              template_id: input.template_id,
              ...result,
            };
          },
        });
        confirmation.id = proposal.confirmationId;
        return parsedJson(applyDesignTemplateToolOutputSchema, {
          status: "confirmation_required",
          design_id: design.id,
          expected_revision: design.revision,
          confirmation_id: proposal.confirmationId,
          summary: `Replace the current design with template “${template.template.name}”.`,
          affected_object_ids: design.scene.objects
            .map((object) => object.objectId)
            .slice(0, 100),
          expires_at: proposal.expiresAt,
          template_id: input.template_id,
        });
      } catch (error) {
        return designError(error);
      }
    },
    {
      name: "apply_design_template",
      description:
        "Replace a design with an exact published template revision after mandatory product confirmation.",
      schema: applyDesignTemplateToolInputSchema,
    },
  );

  const exportDesign = tool(
    async (input: ExportDesignToolInput, config) => {
      const user = contextUser(config);
      if (!user) return noContext();
      if (!deps.designExportService)
        return failure(
          "job_unavailable",
          "Design export is unavailable in this deployment.",
        );
      try {
        const design = await deps.designService.get(user, input.design_id);
        if (!workspaceMatches(config, design.workspace_id))
          return failure(
            "design_forbidden",
            "Design is outside the active workspace.",
          );
        const { job, replayed } =
          await deps.designExportService.enqueueWithReplay(user, {
            design_id: input.design_id,
            revision: input.expected_revision,
            idempotency_key: input.idempotency_key,
            format: input.format,
            multiplier: input.multiplier,
            transparent: input.transparent,
          });
        return parsedJson(exportDesignToolOutputSchema, {
          design_id: input.design_id,
          revision: input.expected_revision,
          job_id: job.id,
          status: job.status,
          replayed,
        });
      } catch (error) {
        return designError(error);
      }
    },
    {
      name: "export_design",
      description:
        "Queue an idempotent authorized export for an exact native design revision.",
      schema: exportDesignToolInputSchema,
    },
  );

  return [
    inspect,
    getObjects,
    manipulate,
    searchResources,
    applyTemplate,
    exportDesign,
  ] as unknown as StructuredTool[];
}

function summarizeObject(object: DesignObject, textLimit: number) {
  const text = "text" in object ? object.text.slice(0, textLimit) : undefined;
  const resourceId =
    "resourceId" in object ? (object.resourceId ?? null) : undefined;
  return {
    object_id: object.objectId,
    object_version: object.objectVersion,
    z_index: object.zIndex,
    locked: object.locked,
    visible: object.visible,
    child_object_ids: object.type === "group" ? object.childObjectIds : [],
    ...(object.type === "image" ? { asset_object_id: object.assetObjectId } : {}),
    type: object.type,
    role: object.role ?? null,
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    ...(text !== undefined ? { text } : {}),
    ...(resourceId !== undefined ? { resource_id: resourceId } : {}),
  };
}

function commandObjectIds(commands: DesignCommand[]) {
  const ids = new Set<string>();
  for (const command of commands) {
    switch (command.action) {
      case "object.add":
        ids.add(command.object.objectId);
        break;
      case "object.update":
      case "object.remove":
      case "object.reorder":
      case "object.set_role":
        ids.add(command.object_id);
        break;
      case "object.clone":
        ids.add(command.source_object_id);
        ids.add(command.object.objectId);
        break;
      case "objects.group":
        ids.add(command.group.objectId);
        for (const child of command.children) ids.add(child.object_id);
        break;
      case "objects.ungroup":
        ids.add(command.group_object_id);
        break;
      case "objects.align":
      case "objects.distribute":
        for (const object of command.objects) ids.add(object.object_id);
        break;
      case "canvas.update":
      case "scene.replace":
        break;
    }
  }
  return [...ids].slice(0, 100);
}

function confirmationSummary(commands: DesignCommand[]) {
  const actions = [...new Set(commands.map((command) => command.action))];
  return `Apply ${commands.length} destructive design command(s): ${actions.join(", ")}.`.slice(
    0,
    500,
  );
}

function contextUser(config: unknown): AuthenticatedUser | null {
  const id = contextString(config, "user_id");
  const accessToken = contextString(config, "access_token");
  return id && accessToken
    ? { id, accessToken, email: "", userMetadata: {} }
    : null;
}

function contextAudit(config: unknown) {
  const agentRunId = contextString(config, "run_id");
  const toolExecutionId = contextString(config, "tool_execution_id");
  return isUuid(agentRunId) && isUuid(toolExecutionId)
    ? { agentRunId, toolExecutionId }
    : null;
}

function workspaceMatches(config: unknown, workspaceId: string) {
  return contextString(config, "workspace_id") === workspaceId;
}

function contextString(config: unknown, key: string) {
  if (!config || typeof config !== "object" || !("configurable" in config))
    return null;
  const configurable = config.configurable;
  if (
    !configurable ||
    typeof configurable !== "object" ||
    !(key in configurable)
  )
    return null;
  const value = configurable[key as keyof typeof configurable];
  return typeof value === "string" && value ? value : null;
}

function isUuid(value: string | null): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  );
}

function noContext() {
  return failure(
    "internal_error",
    "Authenticated agent run and tool execution context is required.",
  );
}

function conflict(
  designId: string,
  latestRevision: number,
  objectIds: string[] = [],
) {
  void designId;
  void objectIds;
  return failure(
    "design_revision_conflict",
    "The design changed; inspect it again before retrying.",
    true,
    latestRevision,
  );
}

function designError(error: unknown) {
  console.error("[agent-design-tool] Design operation failed:", error);
  if (error instanceof DesignServiceError && error.code === "design_conflict")
    return conflict(
      error.conflict?.designId ?? "00000000-0000-4000-8000-000000000000",
      error.conflict?.latestRevision ?? 0,
      error.conflict?.conflictObjectIds ?? [],
    );
  const code =
    error instanceof DesignServiceError
      ? error.code === "design_not_found"
        ? "design_not_found"
        : error.code === "design_forbidden"
          ? "design_forbidden"
          : error.code === "design_invalid"
            ? "validation_error"
            : "internal_error"
      : "internal_error";
  return failure(
    code,
    error instanceof Error ? error.message : "Design operation failed.",
  );
}

function failure(
  code: AgentDesignToolErrorCode,
  message: string,
  retryable = false,
  currentRevision?: number,
) {
  return parsedJson(agentDesignToolErrorOutputSchema, {
    status: "error",
    code,
    message: message.slice(0, 500),
    retryable,
    ...(currentRevision !== undefined
      ? { current_revision: currentRevision }
      : {}),
  });
}

function parsedJson<T>(schema: { parse(value: unknown): T }, value: unknown) {
  return JSON.stringify(schema.parse(value));
}

async function enqueuePreviewBestEffort(
  previews: Pick<DesignPreviewService, "enqueue"> | undefined,
  actorUserId: string,
  designId: string,
  revision: number,
  idempotencyKey: string,
) {
  if (!previews) return;
  try {
    await previews.enqueue({
      actorUserId,
      designId,
      expectedRevision: revision,
      idempotencyKey,
    });
  } catch {
    // Preview is derived delivery and must not turn a durable edit into a retry.
  }
}
