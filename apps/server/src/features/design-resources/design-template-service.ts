import {
  type DesignCatalogMutationResponse,
  type DesignCommand,
  type DesignDocumentDto,
  type DesignObject,
  type DesignResourceScope,
  type DesignTemplateDetailDto,
  type DesignTemplateDto,
  type DesignTemplateReplaceApplyRequest,
  type DesignTemplateReplaceApplyResponse,
  type DesignTemplateReplacePreviewRequest,
  type DesignTemplateReplacePreviewResponse,
  type Json,
  type UpdateDesignTemplateVariablesRequest,
  designCatalogMutationResponseSchema,
  designTemplateDetailDtoSchema,
  designTemplateDtoSchema,
  designTemplateReplaceApplyResponseSchema,
  designTemplateReplacePreviewResponseSchema,
  designTemplateVariablesSchema,
  loomicSceneV1Schema,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import type { DesignService } from "../designs/design-service.js";
import { DesignResourceServiceError } from "./design-resource-service.js";

type DatabaseError = { code?: string; message?: string };

export type DesignTemplateListInput = {
  scope?: DesignResourceScope | undefined;
  status?:
    | "draft"
    | "pending_review"
    | "published"
    | "rejected"
    | "disabled"
    | undefined;
  query?: string | undefined;
  cursor?: string | undefined;
  limit: number;
  deleted?: "exclude" | "only" | "all" | undefined;
};

export type CreateTemplateFromDesignInput = {
  request_id: string;
  design_id: string;
  scope: DesignResourceScope;
  workspace_id: string | null;
  name: string;
  description: string | null;
  preview_asset_object_id: string | null;
  category_id: string | null;
  tag_ids: string[];
  source_url: string | null;
  author: string | null;
  license_name: string | null;
  license_url: string | null;
  attribution: string | null;
  usage_restrictions: string | null;
};

export type DesignTemplateService = {
  list(
    user: AuthenticatedUser,
    input: DesignTemplateListInput,
  ): Promise<{ items: DesignTemplateDto[]; next_cursor: string | null }>;
  get(
    user: AuthenticatedUser,
    templateId: string,
  ): Promise<DesignTemplateDetailDto>;
  createFromDesign(
    user: AuthenticatedUser,
    input: CreateTemplateFromDesignInput,
  ): Promise<DesignTemplateDetailDto>;
  updateVariables(
    user: AuthenticatedUser,
    templateId: string,
    input: UpdateDesignTemplateVariablesRequest,
  ): Promise<DesignCatalogMutationResponse>;
  previewReplace(
    user: AuthenticatedUser,
    input: DesignTemplateReplacePreviewRequest,
  ): Promise<DesignTemplateReplacePreviewResponse>;
  applyReplace(
    user: AuthenticatedUser,
    input: DesignTemplateReplaceApplyRequest,
  ): Promise<DesignTemplateReplaceApplyResponse>;
};

const TEMPLATE_COLUMNS =
  "id, scope, workspace_id, name, description, scene, schema_version, engine_version, width, height, preview_asset_object_id, revision, status, category_id, source_url, author, license_name, license_url, attribution, usage_restrictions, variables, deleted_at, created_at, updated_at";

export function createDesignTemplateService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  designService: DesignService;
}): DesignTemplateService {
  return {
    async list(user, input) {
      const client = options.createUserClient(user.accessToken);
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      let query = client
        .from("design_templates")
        .select(TEMPLATE_COLUMNS)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(input.limit + 1);
      if (!input.deleted || input.deleted === "exclude")
        query = query.is("deleted_at", null);
      else if (input.deleted === "only")
        query = query.not("deleted_at", "is", null);
      if (input.scope) query = query.eq("scope", input.scope);
      if (input.status) query = query.eq("status", input.status);
      if (input.query)
        query = query.ilike("name", `%${escapeLike(input.query)}%`);
      if (cursor) {
        query = query.or(
          `updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`,
        );
      }
      const { data, error } = await query;
      if (error) throw queryError(error);
      const rows = (data ?? []) as unknown as Array<
        Record<string, unknown> & { id: string; updated_at: string }
      >;
      const page = rows.slice(0, input.limit);
      const tagIds = await loadTemplateTagIds(
        client,
        page.map((row) => row.id),
      );
      const items = page.map((row) =>
        toTemplateDto(row, tagIds.get(row.id) ?? []),
      );
      const last = page.at(-1);
      return {
        items,
        next_cursor:
          rows.length > input.limit && last
            ? encodeCursor(last.updated_at, last.id)
            : null,
      };
    },

    async get(user, templateId) {
      const client = options.createUserClient(user.accessToken);
      return loadDetail(client, templateId);
    },

    async createFromDesign(user, input) {
      const design = await options.designService.get(user, input.design_id);
      if (
        input.scope === "workspace" &&
        input.workspace_id !== design.workspace_id
      ) {
        throw forbidden();
      }
      const admin = options.getAdminClient();
      const { data, error } = await (admin.rpc as unknown as RpcCaller)(
        "loomic_catalog_create",
        {
          p_request_id: input.request_id,
          p_entity_kind: "template",
          p_scope: input.scope,
          p_workspace_id: input.workspace_id,
          p_payload: {
            name: input.name,
            description: input.description,
            scene: inputScene(design),
            preview_asset_object_id:
              input.preview_asset_object_id ?? design.preview_asset_object_id,
            category_id: input.category_id,
            tag_ids: input.tag_ids,
            source_url: input.source_url,
            author: input.author,
            license_name: input.license_name,
            license_url: input.license_url,
            attribution: input.attribution,
            usage_restrictions: input.usage_restrictions,
          } as unknown as Json,
          p_actor_user_id: user.id,
        },
      );
      if (error) throw writeError(error);
      const entityId = resultId(data);
      return loadDetail(admin, entityId);
    },
    async updateVariables(user, templateId, input) {
      const admin = options.getAdminClient();
      const { data, error } = await (admin.rpc as unknown as RpcCaller)(
        "loomic_template_variables_update",
        {
          p_request_id: input.request_id,
          p_template_id: templateId,
          p_expected_revision: input.expected_revision,
          p_variables: designTemplateVariablesSchema.parse(
            input.variables,
          ) as unknown as Json,
          p_actor_user_id: user.id,
        },
      );
      if (error) throw writeError(error);
      return designCatalogMutationResponseSchema.parse(data);
    },
    async previewReplace(user, input) {
      const [template, design] = await Promise.all([
        this.get(user, input.template_id),
        options.designService.get(user, input.design_id),
      ]);
      return buildDesignTemplateReplacementPreview(template, design, input);
    },
    async applyReplace(user, input) {
      const preview = await this.previewReplace(user, input);
      if (preview.unresolved_keys.length > 0) {
        throw invalidTemplate(
          `Required template values are unresolved: ${preview.unresolved_keys.join(", ")}`,
        );
      }
      if (preview.commands.length === 0) {
        throw invalidTemplate("No template replacements were resolved.");
      }
      const mutation = await options.designService.mutate(user, {
        design_id: input.design_id,
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
        commands: preview.commands,
      });
      return designTemplateReplaceApplyResponseSchema.parse({
        preview,
        mutation,
      });
    },
  };
}

function inputScene(design: DesignDocumentDto) {
  return loomicSceneV1Schema.parse(design.scene);
}

async function loadDetail(
  client: UserSupabaseClient | AdminSupabaseClient,
  templateId: string,
) {
  const [templateResult, refsResult, tagIds] = await Promise.all([
    client
      .from("design_templates")
      .select(TEMPLATE_COLUMNS)
      .eq("id", templateId)
      .is("deleted_at", null)
      .maybeSingle(),
    client
      .from("design_template_asset_refs")
      .select("template_id, object_id, slot, asset_object_id, resource_id")
      .eq("template_id", templateId)
      .order("object_id"),
    loadTemplateTagIds(client, [templateId]),
  ]);
  const failure = templateResult.error ?? refsResult.error;
  if (failure) throw queryError(failure);
  if (!templateResult.data) throw notFound();
  const templateRow = templateResult.data as unknown as Record<string, unknown>;
  const scene = loomicSceneV1Schema.parse(templateRow.scene);
  const fontFaceIds = [
    ...new Set(
      scene.objects.flatMap((object) =>
        "fontFaceId" in object && object.fontFaceId ? [object.fontFaceId] : [],
      ),
    ),
  ];
  return designTemplateDetailDtoSchema.parse({
    template: toTemplateDto(templateRow, tagIds.get(templateId) ?? []),
    scene,
    asset_refs: refsResult.data ?? [],
    font_face_ids: fontFaceIds,
  });
}

function toTemplateDto(row: Record<string, unknown>, tagIds: string[]) {
  const { scene: _scene, ...template } = row;
  return designTemplateDtoSchema.parse({
    ...template,
    tag_ids: tagIds,
    variables: template.variables ?? [],
  });
}

export function buildDesignTemplateReplacementPreview(
  detail: DesignTemplateDetailDto,
  design: DesignDocumentDto,
  input: DesignTemplateReplacePreviewRequest,
) {
  if (
    (detail.template.scope === "platform" &&
      detail.template.status !== "published") ||
    (detail.template.scope === "workspace" &&
      detail.template.workspace_id !== design.workspace_id)
  ) {
    throw forbidden();
  }
  if (design.revision !== input.expected_revision) {
    throw new DesignResourceServiceError(
      "resource_write_failed",
      "The design changed; refresh before applying template values.",
      409,
    );
  }
  if (detail.template.revision !== input.expected_template_revision) {
    throw new DesignResourceServiceError(
      "resource_write_failed",
      "The template changed; refresh before applying it.",
      409,
    );
  }
  const variables = detail.template.variables;
  const variableKeys = new Set(variables.map((variable) => variable.key));
  for (const binding of input.bindings) {
    if (!variableKeys.has(binding.key)) {
      throw invalidTemplate(`Unknown template variable: ${binding.key}`);
    }
  }
  const bindingByKey = new Map(input.bindings.map((item) => [item.key, item]));
  const designObjects = new Map(
    design.scene.objects.map((object) => [object.objectId, object]),
  );
  const templateObjects = new Map(
    detail.scene.objects.map((object) => [object.objectId, object]),
  );
  const patches = new Map<
    string,
    { object: DesignObject; patch: Record<string, unknown> }
  >();
  const differences: Array<Record<string, unknown>> = [];
  const unresolvedKeys: string[] = [];

  for (const variable of variables) {
    const target = designObjects.get(variable.target.object_id);
    const templateTarget = templateObjects.get(variable.target.object_id);
    if (!target || !templateTarget) {
      throw invalidTemplate(
        `Template target ${variable.target.object_id} is missing.`,
      );
    }
    const direct = bindingByKey.get(variable.key);
    if (direct && direct.type !== variable.type) {
      throw invalidTemplate(`Binding type does not match ${variable.key}.`);
    }
    const smart = !direct
      ? input.smart_bindings.find(
          (candidate) =>
            candidate.type === variable.type &&
            selectorMatches(candidate.selector, templateTarget),
        )
      : undefined;
    const source = direct
      ? ("binding" as const)
      : smart
        ? ("smart" as const)
        : variable.default_value !== undefined
          ? ("default" as const)
          : null;
    const value = direct?.value ?? smart?.value ?? variable.default_value;
    if (!source || value === undefined) {
      if (variable.required) unresolvedKeys.push(variable.key);
      continue;
    }
    const entry = patches.get(target.objectId) ?? {
      object: target,
      patch: { object_type: target.type },
    };
    const { before, after } = applyVariablePatch(
      entry.patch,
      target,
      variable,
      value,
    );
    patches.set(target.objectId, entry);
    differences.push({
      variable_key: variable.key,
      type: variable.type,
      object_id: target.objectId,
      property: variable.target.property,
      source,
      before,
      after,
    });
  }

  const commands: DesignCommand[] = design.scene.objects.flatMap((object) => {
    const entry = patches.get(object.objectId);
    return entry
      ? [
          {
            action: "object.update" as const,
            object_id: object.objectId,
            expected_object_version: object.objectVersion,
            patch: entry.patch,
          } as DesignCommand,
        ]
      : [];
  });
  return designTemplateReplacePreviewResponseSchema.parse({
    design_id: design.id,
    template_id: detail.template.id,
    design_revision: design.revision,
    template_revision: detail.template.revision,
    commands,
    differences,
    unresolved_keys: unresolvedKeys,
  });
}

function selectorMatches(
  selector: { role?: string | undefined; name?: string | undefined },
  object: DesignObject,
) {
  if (selector.role && object.role !== selector.role) return false;
  if (selector.name) {
    const name = object.name?.trim().toLocaleLowerCase();
    if (!name?.includes(selector.name.trim().toLocaleLowerCase())) return false;
  }
  return true;
}

function applyVariablePatch(
  patch: Record<string, unknown>,
  object: DesignObject,
  variable: DesignTemplateDetailDto["template"]["variables"][number],
  value: unknown,
) {
  switch (variable.type) {
    case "text":
      assertObjectType(object, ["text", "textbox"], variable.key);
      patch.text = value;
      return {
        before: (object as Extract<DesignObject, { type: "text" | "textbox" }>)
          .text,
        after: value,
      };
    case "image": {
      assertObjectType(object, ["image"], variable.key);
      const imageObject = object as Extract<DesignObject, { type: "image" }>;
      const image = value as {
        asset_object_id: string;
        resource_id?: string | null;
      };
      patch.asset_object_id = image.asset_object_id;
      // A replacement asset without catalog provenance must not inherit the
      // source object's resource id. That stale pair would retain the wrong
      // catalog dependency and misreport the new image's origin.
      patch.resource_id = image.resource_id ?? null;
      return {
        before: {
          asset_object_id: imageObject.assetObjectId,
          resource_id: imageObject.resourceId ?? null,
        },
        after: image,
      };
    }
    case "color": {
      const property = variable.target.property;
      const before =
        property === "fill" && "fill" in object
          ? object.fill
          : "stroke" in object
            ? object.stroke
            : undefined;
      if (before === undefined)
        throw invalidTemplate(`Invalid color target ${variable.key}.`);
      const after = { kind: "solid", color: value };
      patch[property] = after;
      return { before, after };
    }
    case "font": {
      assertObjectType(object, ["text", "textbox"], variable.key);
      const textObject = object as Extract<
        DesignObject,
        { type: "text" | "textbox" }
      >;
      const font = value as { font_face_id: string; font_family: string };
      patch.font_face_id = font.font_face_id;
      patch.font_family = font.font_family;
      return {
        before: {
          font_face_id: textObject.fontFaceId ?? null,
          font_family: textObject.fontFamily,
        },
        after: font,
      };
    }
  }
}

function assertObjectType(
  object: DesignObject,
  expected: DesignObject["type"][],
  key: string,
) {
  if (!expected.includes(object.type)) {
    throw invalidTemplate(
      `Template variable ${key} targets an incompatible object.`,
    );
  }
}

function invalidTemplate(message: string) {
  return new DesignResourceServiceError("resource_invalid", message, 400);
}

async function loadTemplateTagIds(
  client: UserSupabaseClient | AdminSupabaseClient,
  templateIds: string[],
) {
  const result = new Map<string, string[]>();
  if (templateIds.length === 0) return result;
  const { data, error } = await client
    .from("design_template_tag_links")
    .select("template_id, tag_id")
    .in("template_id", templateIds);
  if (error) throw queryError(error);
  for (const row of data ?? []) {
    const ids = result.get(row.template_id) ?? [];
    ids.push(row.tag_id);
    result.set(row.template_id, ids);
  }
  return result;
}

function encodeCursor(updatedAt: string, id: string) {
  return Buffer.from(JSON.stringify({ updatedAt, id }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof value.updatedAt !== "string" ||
      Number.isNaN(Date.parse(value.updatedAt)) ||
      typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.id)
    ) {
      throw new Error("invalid cursor");
    }
    return { updatedAt: value.updatedAt, id: value.id };
  } catch {
    throw new DesignResourceServiceError(
      "resource_invalid",
      "Invalid template cursor.",
      400,
    );
  }
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function queryError(error: DatabaseError) {
  return new DesignResourceServiceError(
    "resource_query_failed",
    error.message ?? "Unable to load design templates.",
    500,
  );
}

function writeError(error: DatabaseError | null) {
  if (error?.code === "42501") return forbidden();
  if (error?.code === "P0002") return notFound();
  if (
    error?.code === "40001" ||
    error?.message?.includes("catalog_idempotency_conflict")
  ) {
    return new DesignResourceServiceError(
      "resource_invalid",
      "The template changed or the request ID was reused.",
      409,
    );
  }
  if (error?.code === "23503" || error?.code === "23514") {
    return new DesignResourceServiceError(
      "resource_invalid",
      error.message ?? "Invalid template relationship.",
      400,
    );
  }
  return new DesignResourceServiceError(
    "resource_write_failed",
    "Unable to create design template.",
    500,
  );
}

type RpcCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: DatabaseError | null }>;

function resultId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw writeError(null);
  }
  const id = (value as Record<string, unknown>).entity_id;
  if (typeof id !== "string") throw writeError(null);
  return id;
}

function notFound() {
  return new DesignResourceServiceError(
    "resource_not_found",
    "Design template not found.",
    404,
  );
}

function forbidden() {
  return new DesignResourceServiceError(
    "resource_forbidden",
    "You do not have permission to create this template.",
    403,
  );
}
