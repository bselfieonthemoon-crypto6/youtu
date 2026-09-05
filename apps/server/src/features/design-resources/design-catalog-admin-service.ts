import {
  type DeleteDesignCatalogEntryRequest,
  type DesignCatalogMutationResponse,
  type DesignResourceScope,
  type RestoreDesignCatalogEntryRequest,
  type SetDesignCatalogStatusRequest,
  designCatalogMutationResponseSchema,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import { DesignResourceServiceError } from "./design-resource-service.js";

type DesignCatalogEntityKind =
  | "resource"
  | "template"
  | "text_preset"
  | "font_family"
  | "font_face"
  | "category"
  | "tag";

export type DesignCatalogAdminService = {
  create(
    user: AuthenticatedUser,
    input: {
      request_id: string;
      entity_kind: DesignCatalogEntityKind;
      scope: DesignResourceScope;
      workspace_id: string | null;
      payload: Record<string, unknown>;
    },
  ): Promise<DesignCatalogMutationResponse>;
  update(
    user: AuthenticatedUser,
    input: {
      request_id: string;
      entity_kind: DesignCatalogEntityKind;
      entity_id: string;
      expected_revision: number;
      patch: Record<string, unknown>;
    },
  ): Promise<DesignCatalogMutationResponse>;
  references(
    user: AuthenticatedUser,
    entityKind: DesignCatalogEntityKind,
    entityId: string,
  ): Promise<{
    entity_kind: DesignCatalogEntityKind;
    entity_id: string;
    references: Array<Record<string, unknown>>;
  }>;
  setStatus(
    user: AuthenticatedUser,
    input: SetDesignCatalogStatusRequest,
  ): Promise<DesignCatalogMutationResponse>;
  setDeleted(
    user: AuthenticatedUser,
    input: DeleteDesignCatalogEntryRequest | RestoreDesignCatalogEntryRequest,
    deleted: boolean,
  ): Promise<DesignCatalogMutationResponse>;
};

export function createDesignCatalogAdminService(options: {
  getAdminClient: () => AdminSupabaseClient;
  createUserClient: (token: string) => UserSupabaseClient;
}): DesignCatalogAdminService {
  return {
    async create(user, input) {
      const { data, error } = await callRpc(
        options.getAdminClient(),
        "loomic_catalog_create",
        {
          p_request_id: input.request_id,
          p_entity_kind: input.entity_kind,
          p_scope: input.scope,
          p_workspace_id: input.workspace_id,
          p_payload: input.payload,
          p_actor_user_id: user.id,
        },
      );
      if (error) throw mutationError(error);
      return designCatalogMutationResponseSchema.parse(data);
    },
    async update(user, input) {
      const { data, error } = await callRpc(
        options.getAdminClient(),
        "loomic_catalog_update",
        {
          p_request_id: input.request_id,
          p_entity_kind: input.entity_kind,
          p_entity_id: input.entity_id,
          p_expected_revision: input.expected_revision,
          p_patch: input.patch,
          p_actor_user_id: user.id,
        },
      );
      if (error) throw mutationError(error);
      return designCatalogMutationResponseSchema.parse(data);
    },
    async references(user, entityKind, entityId) {
      const table = entityTable(entityKind);
      const client = options.createUserClient(user.accessToken);
      const visible = await dynamicFrom(client, table)
        .select("id")
        .eq("id", entityId)
        .maybeSingle();
      if (visible.error) throw mutationError(visible.error);
      if (!visible.data)
        throw new DesignResourceServiceError(
          "resource_not_found",
          "Catalog item not found.",
          404,
        );
      const admin = options.getAdminClient();
      const specs = referenceSpecs(entityKind, entityId);
      const references: Array<Record<string, unknown>> = [];
      for (const spec of specs) {
        const result = await dynamicFrom(admin, spec.table)
          .select(spec.columns)
          .eq(spec.foreignKey, entityId)
          .limit(1001);
        if (result.error) throw mutationError(result.error);
        references.push(
          ...(result.data ?? []).map((row: Record<string, unknown>) => ({
            kind: spec.kind,
            ...row,
          })),
        );
      }
      return { entity_kind: entityKind, entity_id: entityId, references };
    },
    async setStatus(user, input) {
      const { data, error } = await callRpc(
        options.getAdminClient(),
        "loomic_catalog_set_status",
        {
          p_request_id: input.request_id,
          p_entity_kind: input.entity_kind,
          p_entity_id: input.entity_id,
          p_expected_revision: input.expected_revision,
          p_status: input.status,
          p_actor_user_id: user.id,
        },
      );
      if (error) throw mutationError(error);
      return designCatalogMutationResponseSchema.parse(data);
    },
    async setDeleted(user, input, deleted) {
      const { data, error } = await callRpc(
        options.getAdminClient(),
        "loomic_catalog_set_deleted",
        {
          p_request_id: input.request_id,
          p_entity_kind: input.entity_kind,
          p_entity_id: input.entity_id,
          p_expected_revision: input.expected_revision,
          p_deleted: deleted,
          p_actor_user_id: user.id,
        },
      );
      if (error) throw mutationError(error);
      return designCatalogMutationResponseSchema.parse(data);
    },
  };
}

function entityTable(kind: DesignCatalogEntityKind) {
  return (
    {
      resource: "design_resources",
      template: "design_templates",
      text_preset: "text_presets",
      font_family: "font_families",
      font_face: "font_faces",
      category: "resource_categories",
      tag: "resource_tags",
    } as const
  )[kind];
}
function referenceSpecs(kind: DesignCatalogEntityKind, _id: string) {
  const map: Record<
    DesignCatalogEntityKind,
    Array<{ table: string; foreignKey: string; columns: string; kind: string }>
  > = {
    resource: [
      {
        table: "design_document_asset_refs",
        foreignKey: "resource_id",
        columns: "design_id,object_id,slot",
        kind: "design",
      },
      {
        table: "design_template_asset_refs",
        foreignKey: "resource_id",
        columns: "template_id,object_id,slot",
        kind: "template",
      },
    ],
    template: [
      {
        table: "design_documents",
        foreignKey: "source_template_id",
        columns: "id,name",
        kind: "design",
      },
    ],
    text_preset: [],
    font_family: [
      {
        table: "font_faces",
        foreignKey: "family_id",
        columns: "id,style,weight",
        kind: "font_face",
      },
    ],
    font_face: [
      {
        table: "design_document_font_refs",
        foreignKey: "font_face_id",
        columns: "design_id,object_id",
        kind: "design",
      },
      {
        table: "design_template_font_refs",
        foreignKey: "font_face_id",
        columns: "template_id,object_id",
        kind: "template",
      },
      {
        table: "text_preset_font_refs",
        foreignKey: "font_face_id",
        columns: "text_preset_id,object_id",
        kind: "text_preset",
      },
    ],
    category: [
      {
        table: "design_resources",
        foreignKey: "category_id",
        columns: "id,name",
        kind: "resource",
      },
      {
        table: "design_templates",
        foreignKey: "category_id",
        columns: "id,name",
        kind: "template",
      },
      {
        table: "text_presets",
        foreignKey: "category_id",
        columns: "id,name",
        kind: "text_preset",
      },
    ],
    tag: [
      {
        table: "resource_tag_links",
        foreignKey: "tag_id",
        columns: "resource_id",
        kind: "resource",
      },
      {
        table: "design_template_tag_links",
        foreignKey: "tag_id",
        columns: "template_id",
        kind: "template",
      },
      {
        table: "text_preset_tag_links",
        foreignKey: "tag_id",
        columns: "text_preset_id",
        kind: "text_preset",
      },
    ],
  };
  return map[kind];
}
function dynamicFrom(
  client: UserSupabaseClient | AdminSupabaseClient,
  table: string,
): ReturnType<UserSupabaseClient["from"]> {
  return (
    client.from as unknown as (
      name: string,
    ) => ReturnType<UserSupabaseClient["from"]>
  ).call(client, table);
}

type CatalogRpc = (
  name:
    | "loomic_catalog_create"
    | "loomic_catalog_update"
    | "loomic_catalog_set_status"
    | "loomic_catalog_set_deleted",
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

function callRpc(
  client: AdminSupabaseClient,
  name: Parameters<CatalogRpc>[0],
  args: Parameters<CatalogRpc>[1],
) {
  return (client.rpc as unknown as CatalogRpc)(name, args);
}

function mutationError(error: { code?: string; message?: string }) {
  const message = error.message ?? "";
  if (error.code === "42501")
    return new DesignResourceServiceError(
      "resource_forbidden",
      "Catalog mutation forbidden.",
      403,
    );
  if (error.code === "P0002")
    return new DesignResourceServiceError(
      "resource_not_found",
      "Catalog item not found.",
      404,
    );
  if (error.code === "40001" || error.code === "23505")
    return new DesignResourceServiceError(
      "resource_write_failed",
      "Catalog mutation conflict.",
      409,
    );
  if (
    error.code === "23514" ||
    message.includes("dependency") ||
    message.includes("in_use")
  )
    return new DesignResourceServiceError(
      "resource_in_use",
      "Catalog dependencies prevent this mutation.",
      409,
    );
  if (error.code === "22023")
    return new DesignResourceServiceError(
      "resource_invalid",
      "Invalid catalog mutation.",
      400,
    );
  return new DesignResourceServiceError(
    "resource_write_failed",
    "Catalog mutation failed.",
    500,
  );
}
