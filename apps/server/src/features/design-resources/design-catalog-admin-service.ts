import {
  type DeleteDesignCatalogEntryRequest,
  type DesignCatalogMutationResponse,
  type DesignCatalogPreviewUrlResponse,
  type DesignResourceScope,
  type RestoreDesignCatalogEntryRequest,
  type SetDesignCatalogStatusRequest,
  designCatalogMutationResponseSchema,
  designCatalogPreviewUrlResponseSchema,
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
  /**
   * Sign a thumbnail for one catalog entry. Only the collections that actually
   * carry an asset (resource, template) are supported; the caller must be able to
   * see the row through their own client, so this never widens what they can read.
   */
  previewUrl(
    user: AuthenticatedUser,
    entityKind: DesignCatalogEntityKind,
    entityId: string,
  ): Promise<DesignCatalogPreviewUrlResponse>;
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
    async previewUrl(user, entityKind, entityId) {
      // Only these two collections carry an asset of their own. Everything else
      // (presets, fonts, categories, tags) has either no preview or its own route.
      if (entityKind !== "resource" && entityKind !== "template") {
        throw new DesignResourceServiceError(
          "resource_invalid",
          "This catalog collection has no preview image.",
          400,
        );
      }
      // Visibility first, through the caller's own client: signing must never show
      // an asset from a row the caller cannot read. Templates have no content asset
      // of their own - only resources do - so the selected columns differ.
      const visible = await dynamicFrom(
        options.createUserClient(user.accessToken),
        entityTable(entityKind),
      )
        .select(
          entityKind === "resource"
            ? "id,asset_object_id,preview_asset_object_id"
            : "id,preview_asset_object_id",
        )
        .eq("id", entityId)
        .maybeSingle();
      if (visible.error) throw mutationError(visible.error);
      const row = visible.data as
        | { asset_object_id?: unknown; preview_asset_object_id?: unknown }
        | null;
      if (!row) {
        throw new DesignResourceServiceError(
          "resource_not_found",
          "Catalog item not found.",
          404,
        );
      }

      const previewId =
        typeof row.preview_asset_object_id === "string"
          ? row.preview_asset_object_id
          : null;
      const assetObjectId =
        previewId ??
        (typeof row.asset_object_id === "string" ? row.asset_object_id : null);
      if (!assetObjectId) {
        throw new DesignResourceServiceError(
          "resource_not_found",
          "Catalog item has no image.",
          404,
        );
      }

      const asset = await dynamicFrom(options.getAdminClient(), "asset_objects")
        .select("bucket,object_path,mime_type")
        .eq("id", assetObjectId)
        .maybeSingle();
      if (asset.error) throw mutationError(asset.error);
      const assetRow = asset.data as
        | { bucket?: unknown; object_path?: unknown; mime_type?: unknown }
        | null;

      // A failed signature is reported as null, not as an error: the console shows
      // a placeholder, which is more useful than a broken thumbnail.
      let url: string | null = null;
      if (assetRow?.bucket && assetRow.object_path) {
        const signed = await (
          options.getAdminClient() as unknown as {
            storage: {
              from: (bucket: string) => {
                createSignedUrl: (
                  path: string,
                  expiresIn: number,
                ) => Promise<{ data?: { signedUrl?: string } | null }>;
              };
            };
          }
        ).storage
          .from(String(assetRow.bucket))
          .createSignedUrl(String(assetRow.object_path), 900);
        url =
          typeof signed.data?.signedUrl === "string"
            ? signed.data.signedUrl
            : null;
      }

      return designCatalogPreviewUrlResponseSchema.parse({
        entity_kind: entityKind,
        entity_id: entityId,
        uses_preview: previewId !== null,
        asset_object_id: assetObjectId,
        mime_type:
          typeof assetRow?.mime_type === "string" ? assetRow.mime_type : null,
        url,
      });
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
    // Instantiation copies the template scene into an independent document.
    // There is no live template FK (or source_template_id column) to inspect.
    template: [],
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
