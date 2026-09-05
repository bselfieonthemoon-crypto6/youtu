import {
  type CreateDesignResourceRequest,
  type DesignResourceDto,
  type DesignResourceListRequest,
  type DesignResourceListResponse,
  type Json,
  type RecordDesignResourceRecentUseRequest,
  type SetDesignResourceFavoriteRequest,
  createDesignResourceRequestSchema,
  designResourceDtoSchema,
  designResourceListRequestSchema,
  recordDesignResourceRecentUseRequestSchema,
  setDesignResourceFavoriteRequestSchema,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

type DatabaseError = { code?: string; message?: string };
type ResourceRow = Record<string, unknown> & { id: string; updated_at: string };

export class DesignResourceServiceError extends Error {
  constructor(
    readonly code:
      | "resource_not_found"
      | "resource_forbidden"
      | "resource_invalid"
      | "resource_query_failed"
      | "resource_write_failed"
      | "resource_in_use",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "DesignResourceServiceError";
  }
}

export type DesignResourceReferences = {
  resource_id: string;
  design_references: Array<{
    design_id: string;
    object_id: string;
    slot: string;
  }>;
  favorite_count: number;
  recent_use_count: number;
};

export type DesignResourceService = {
  list(
    user: AuthenticatedUser,
    input: DesignResourceListRequest,
    options?: {
      collection?: "favorites" | "recent";
      workspaceId?: string;
      /** Restrict the page to platform rows plus this active workspace. */
      activeWorkspaceId?: string;
      deleted?: "exclude" | "only" | "all";
    },
  ): Promise<DesignResourceListResponse>;
  get(user: AuthenticatedUser, resourceId: string): Promise<DesignResourceDto>;
  create(
    user: AuthenticatedUser,
    input: CreateDesignResourceRequest,
  ): Promise<DesignResourceDto>;
  setFavorite(
    user: AuthenticatedUser,
    input: SetDesignResourceFavoriteRequest,
  ): Promise<{ favorite: boolean }>;
  recordRecentUse(
    user: AuthenticatedUser,
    input: RecordDesignResourceRecentUseRequest,
  ): Promise<{ used_at: string; use_count: number }>;
  references(
    user: AuthenticatedUser,
    resourceId: string,
  ): Promise<DesignResourceReferences>;
  softDelete(
    user: AuthenticatedUser,
    input: { resourceId: string; requestId: string; expectedRevision: number },
  ): Promise<void>;
};

const RESOURCE_COLUMNS =
  "id, scope, workspace_id, kind, name, description, asset_object_id, preview_asset_object_id, width, height, checksum_sha256, revision, status, category_id, source_url, author, license_name, license_url, attribution, usage_restrictions, deleted_at, created_at, updated_at";

export function createDesignResourceService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
}): DesignResourceService {
  return {
    async list(user, rawInput, listOptions = {}) {
      const input = designResourceListRequestSchema.parse(rawInput);
      const client = options.createUserClient(user.accessToken);
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      if (listOptions.deleted && listOptions.deleted !== "exclude") {
        return listAdminRows(client, input, cursor, listOptions.deleted);
      }
      let collectionIds: string[] | null = null;
      if (listOptions.collection) {
        collectionIds = await resolveCollectionIds(
          client,
          user.id,
          listOptions.collection,
          listOptions.workspaceId,
        );
      }
      if (collectionIds !== null && collectionIds.length === 0) {
        return { items: [], next_cursor: null };
      }
      const raw = await callUserRpc(
        client,
        listOptions.activeWorkspaceId
          ? "loomic_design_resources_list_scoped"
          : "loomic_design_resources_list",
        {
          p_scope: input.scope ?? null,
          p_kind: input.kind ?? null,
          p_status: input.status ?? null,
          p_query: input.query ?? null,
          p_category_id: input.category_id ?? null,
          p_tag_id: input.tag_id ?? null,
          p_format: input.format ?? null,
          p_aspect_ratio: input.aspect_ratio ?? null,
          p_cursor_updated_at: cursor?.updatedAt ?? null,
          p_cursor_id: cursor?.id ?? null,
          p_limit: input.limit,
          ...(listOptions.activeWorkspaceId
            ? { p_active_workspace_id: listOptions.activeWorkspaceId }
            : {}),
        },
      );
      if (!Array.isArray(raw)) {
        throw queryError({ message: "Invalid catalog page." });
      }
      const rows = raw.map((entry) => {
        const envelope = asRecord(entry);
        return asRecord(envelope.item) as ResourceRow;
      });
      const scanned = rows.slice(0, input.limit);
      const allowed = collectionIds ? new Set(collectionIds) : null;
      const items = scanned
        .filter((row) => !allowed || allowed.has(row.id))
        .map(toResourceDto);
      const last = scanned.at(-1);
      return {
        items,
        next_cursor:
          rows.length > input.limit && last
            ? encodeCursor(last.updated_at, last.id)
            : null,
      };
    },

    async get(user, resourceId) {
      return loadResource(
        options.createUserClient(user.accessToken),
        resourceId,
      );
    },

    async create(user, rawInput) {
      const input = createDesignResourceRequestSchema.parse(rawInput);
      const admin = options.getAdminClient();
      const {
        request_id: requestId,
        scope,
        workspace_id: workspaceId,
        ...payload
      } = input;
      const result = await callCatalogRpc(admin, "loomic_catalog_create", {
        p_request_id: requestId,
        p_entity_kind: "resource",
        p_scope: scope,
        p_workspace_id: workspaceId,
        p_payload: {
          ...payload,
          width: null,
          height: null,
          checksum_sha256: null,
        } as unknown as Json,
        p_actor_user_id: user.id,
      });
      return loadResource(admin, resultId(result));
    },

    async setFavorite(user, rawInput) {
      const input = setDesignResourceFavoriteRequestSchema.parse(rawInput);
      const client = options.createUserClient(user.accessToken);
      await callUserRpc(client, "loomic_resource_favorite_set", {
        p_resource_id: input.resource_id,
        p_favorite: input.favorite,
      });
      return { favorite: input.favorite };
    },

    async recordRecentUse(user, rawInput) {
      const input = recordDesignResourceRecentUseRequestSchema.parse(rawInput);
      const client = options.createUserClient(user.accessToken);
      const result = await callUserRpc(
        client,
        "loomic_record_resource_recent_use",
        {
          p_resource_id: input.resource_id,
          p_workspace_id: input.workspace_id,
        },
      );
      const row = asRecord(result);
      if (
        typeof row.used_at !== "string" ||
        typeof row.use_count !== "number"
      ) {
        throw writeError(null);
      }
      return { used_at: row.used_at, use_count: row.use_count };
    },

    async references(user, resourceId) {
      const resource = await loadResource(
        options.createUserClient(user.accessToken),
        resourceId,
      );
      await assertCanManage(
        options.getAdminClient(),
        user.id,
        resource.scope,
        resource.workspace_id,
      );
      return loadReferences(options.getAdminClient(), resourceId);
    },

    async softDelete(user, input) {
      const admin = options.getAdminClient();
      await callCatalogRpc(admin, "loomic_catalog_set_deleted", {
        p_request_id: input.requestId,
        p_entity_kind: "resource",
        p_entity_id: input.resourceId,
        p_expected_revision: input.expectedRevision,
        p_deleted: true,
        p_actor_user_id: user.id,
      });
    },
  };
}

async function listAdminRows(
  client: UserSupabaseClient,
  input: DesignResourceListRequest,
  cursor: { updatedAt: string; id: string } | null,
  deleted: "only" | "all",
) {
  let query = client
    .from("design_resources")
    .select(RESOURCE_COLUMNS)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(input.limit + 1);
  if (deleted === "only") query = query.not("deleted_at", "is", null);
  if (input.scope) query = query.eq("scope", input.scope);
  if (input.kind) query = query.eq("kind", input.kind);
  if (input.status) query = query.eq("status", input.status);
  if (input.query)
    query = query.ilike(
      "name",
      `%${input.query.replace(/[\\%_]/g, (value) => `\\${value}`)}%`,
    );
  if (input.category_id) query = query.eq("category_id", input.category_id);
  if (cursor)
    query = query.or(
      `updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`,
    );
  const { data, error } = await query;
  if (error) throw queryError(error);
  const rows = (data ?? []) as unknown as ResourceRow[];
  const page = rows.slice(0, input.limit);
  const tags = await loadTagIds(
    client,
    page.map((row) => row.id),
  );
  const items = page.map((row) =>
    toResourceDto({ ...row, tag_ids: tags.get(row.id) ?? [] }),
  );
  const last = page.at(-1);
  return {
    items,
    next_cursor:
      rows.length > input.limit && last
        ? encodeCursor(last.updated_at, last.id)
        : null,
  };
}

async function loadResource(
  client: UserSupabaseClient | AdminSupabaseClient,
  resourceId: string,
): Promise<DesignResourceDto> {
  const { data, error } = await client
    .from("design_resources")
    .select(RESOURCE_COLUMNS)
    .eq("id", resourceId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw queryError(error);
  if (!data) throw notFound();
  const row = data as unknown as Record<string, unknown>;
  const tags = await loadTagIds(client, [resourceId]);
  return designResourceDtoSchema.parse({
    ...row,
    tag_ids: tags.get(resourceId) ?? [],
  });
}

async function loadTagIds(
  client: UserSupabaseClient | AdminSupabaseClient,
  resourceIds: string[],
) {
  const result = new Map<string, string[]>();
  if (resourceIds.length === 0) return result;
  const { data, error } = await client
    .from("resource_tag_links")
    .select("resource_id, tag_id")
    .in("resource_id", resourceIds);
  if (error) throw queryError(error);
  for (const row of data ?? []) {
    const ids = result.get(row.resource_id) ?? [];
    ids.push(row.tag_id);
    result.set(row.resource_id, ids);
  }
  return result;
}

async function resolveCollectionIds(
  client: UserSupabaseClient,
  userId: string,
  collection: "favorites" | "recent",
  workspaceId: string | undefined,
) {
  if (collection === "favorites") {
    const { data, error } = await client
      .from("resource_favorites")
      .select("resource_id")
      .eq("user_id", userId);
    if (error) throw queryError(error);
    return (data ?? []).map((row) => row.resource_id);
  }
  if (!workspaceId) {
    throw new DesignResourceServiceError(
      "resource_invalid",
      "workspace_id is required for the recent collection.",
      400,
    );
  }
  const { data, error } = await client
    .from("resource_recent_uses")
    .select("resource_id")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId);
  if (error) throw queryError(error);
  return (data ?? []).map((row) => row.resource_id);
}

async function assertCanManage(
  admin: AdminSupabaseClient,
  userId: string,
  scope: "platform" | "workspace",
  workspaceId: string | null,
) {
  const lookup =
    scope === "platform"
      ? await admin
          .from("platform_admins")
          .select("user_id")
          .eq("user_id", userId)
          .is("revoked_at", null)
          .maybeSingle()
      : await admin
          .from("workspace_members")
          .select("user_id")
          .eq("user_id", userId)
          .eq("workspace_id", workspaceId ?? "")
          .in("role", ["owner", "admin"])
          .maybeSingle();
  if (lookup.error) throw queryError(lookup.error);
  if (!lookup.data) {
    throw new DesignResourceServiceError(
      "resource_forbidden",
      "You do not have permission to manage this catalog scope.",
      403,
    );
  }
}

async function loadReferences(
  admin: AdminSupabaseClient,
  resourceId: string,
): Promise<DesignResourceReferences> {
  const [designs, favorites, recents] = await Promise.all([
    admin
      .from("design_document_asset_refs")
      .select("design_id, object_id, slot")
      .eq("resource_id", resourceId),
    admin
      .from("resource_favorites")
      .select("resource_id", { count: "exact", head: true })
      .eq("resource_id", resourceId),
    admin
      .from("resource_recent_uses")
      .select("resource_id", { count: "exact", head: true })
      .eq("resource_id", resourceId),
  ]);
  const failure = designs.error ?? favorites.error ?? recents.error;
  if (failure) throw queryError(failure);
  return {
    resource_id: resourceId,
    design_references: designs.data ?? [],
    favorite_count: favorites.count ?? 0,
    recent_use_count: recents.count ?? 0,
  };
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
    ) as { updatedAt?: unknown; id?: unknown };
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
      "Invalid resource cursor.",
      400,
    );
  }
}

function queryError(error: DatabaseError) {
  return new DesignResourceServiceError(
    "resource_query_failed",
    error.message ?? "Unable to load design resources.",
    500,
  );
}

function writeError(error: DatabaseError | null) {
  const message = error?.message ?? "";
  if (message.includes("catalog_entity_in_use")) {
    return new DesignResourceServiceError(
      "resource_in_use",
      "Resource is still referenced and cannot be deleted.",
      409,
    );
  }
  if (error?.code === "42501") {
    return new DesignResourceServiceError(
      "resource_forbidden",
      "You do not have permission to manage this catalog scope.",
      403,
    );
  }
  if (error?.code === "P0002") return notFound();
  if (error?.code === "40001" || message.includes("idempotency_conflict")) {
    return new DesignResourceServiceError(
      "resource_invalid",
      "The catalog entry changed or the request ID was reused.",
      409,
    );
  }
  if (error?.code === "23514" || error?.code === "23503") {
    return new DesignResourceServiceError(
      "resource_invalid",
      error.message ?? "Invalid resource relationship.",
      400,
    );
  }
  return new DesignResourceServiceError(
    "resource_write_failed",
    "Unable to update design resources.",
    500,
  );
}

async function callCatalogRpc(
  admin: AdminSupabaseClient,
  name: "loomic_catalog_create" | "loomic_catalog_set_deleted",
  args: Record<string, unknown>,
) {
  const { data, error } = await (admin.rpc as unknown as RpcCaller)(name, args);
  if (error) throw writeError(error);
  return data;
}

async function callUserRpc(
  client: UserSupabaseClient,
  name:
    | "loomic_design_resources_list"
    | "loomic_design_resources_list_scoped"
    | "loomic_resource_favorite_set"
    | "loomic_record_resource_recent_use",
  args: Record<string, unknown>,
) {
  const { data, error } = await (client.rpc as unknown as RpcCaller)(
    name,
    args,
  );
  if (error) throw writeError(error);
  return data;
}

type RpcCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: DatabaseError | null }>;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw writeError(null);
  }
  return value as Record<string, unknown>;
}

function resultId(value: unknown) {
  const id = asRecord(value).entity_id;
  if (typeof id !== "string") throw writeError(null);
  return id;
}

function toResourceDto(row: ResourceRow) {
  return designResourceDtoSchema.parse({
    id: row.id,
    scope: row.scope,
    workspace_id: row.workspace_id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    asset_object_id: row.asset_object_id,
    preview_asset_object_id: row.preview_asset_object_id,
    width: row.width,
    height: row.height,
    checksum_sha256: row.checksum_sha256,
    revision: row.revision,
    status: row.status,
    category_id: row.category_id,
    tag_ids: row.tag_ids ?? [],
    source_url: row.source_url,
    author: row.author,
    license_name: row.license_name,
    license_url: row.license_url,
    attribution: row.attribution,
    usage_restrictions: row.usage_restrictions,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

function notFound() {
  return new DesignResourceServiceError(
    "resource_not_found",
    "Design resource not found.",
    404,
  );
}
