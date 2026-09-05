import {
  type CreateDesignImportRequest,
  type CreateDesignImportResponse,
  type DesignImportItemDto,
  type DesignImportJobDto,
  type Json,
  createDesignImportResponseSchema,
  designImportItemDtoSchema,
  designImportJobDtoSchema,
  designUuidSchema,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import { DesignResourceServiceError } from "./design-resource-service.js";

export type DesignImportApiService = {
  create(
    user: AuthenticatedUser,
    input: CreateDesignImportRequest,
  ): Promise<CreateDesignImportResponse>;
  list(
    user: AuthenticatedUser,
    input: { cursor?: string | undefined; limit: number },
  ): Promise<{ items: DesignImportJobDto[]; next_cursor: string | null }>;
  get(
    user: AuthenticatedUser,
    jobId: string,
  ): Promise<{ job: DesignImportJobDto; items: DesignImportItemDto[] }>;
  cancel(user: AuthenticatedUser, jobId: string): Promise<DesignImportJobDto>;
  retry(user: AuthenticatedUser, jobId: string): Promise<DesignImportJobDto>;
  attachItemMetadata(
    user: AuthenticatedUser,
    jobId: string,
    metadataByAssetId: Map<string, Record<string, unknown>>,
  ): Promise<void>;
  enqueueManifest(
    user: AuthenticatedUser,
    input: {
      request_id: string;
      scope: "platform" | "workspace";
      workspace_id: string | null;
      items: Array<{
        source_key: string;
        entity_kind:
          | "resource"
          | "template"
          | "text_preset"
          | "font_family"
          | "font_face"
          | "category"
          | "tag";
        asset_object_id: string | null;
        metadata: Record<string, unknown>;
      }>;
    },
  ): Promise<CreateDesignImportResponse>;
};

type Rpc = (
  name: "loomic_resource_import_create",
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;
const JOB_COLUMNS =
  "id, scope, workspace_id, source_kind, request_id, background_job_id, status, total_items, completed_items, failed_items, created_by, created_at, started_at, completed_at";
const ITEM_COLUMNS =
  "id, import_job_id, source_key, status, result_entity_kind, result_entity_id, resource_id, asset_object_id, error_code, error_message, metadata, created_at, completed_at";

export function createDesignImportApiService(options: {
  createUserClient: (token: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
}): DesignImportApiService {
  return {
    async enqueueManifest(user, input) {
      const { data, error } = await (
        options.getAdminClient().rpc as unknown as (
          name: "loomic_resource_import_manifest_enqueue",
          args: Record<string, unknown>,
        ) => Promise<{
          data: unknown;
          error: { code?: string; message?: string } | null;
        }>
      )("loomic_resource_import_manifest_enqueue", {
        p_request_id: input.request_id,
        p_scope: input.scope,
        p_workspace_id: input.workspace_id,
        p_manifest_items: input.items,
        p_actor_user_id: user.id,
      });
      if (error) throw mapError(error);
      return createDesignImportResponseSchema.parse(data);
    },
    async create(user, input) {
      if (input.source_kind === "manifest_inline") {
        const { data, error } = await (
          options.getAdminClient().rpc as unknown as (
            name: "loomic_resource_import_manifest_enqueue",
            args: Record<string, unknown>,
          ) => Promise<{
            data: unknown;
            error: { code?: string; message?: string } | null;
          }>
        )("loomic_resource_import_manifest_enqueue", {
          p_request_id: input.request_id,
          p_scope: input.scope,
          p_workspace_id: input.workspace_id,
          p_manifest_items: input.manifest.items.map((item) => ({
            source_key: item.source_key,
            entity_kind: item.entity_kind,
            asset_object_id: item.asset_object_id ?? null,
            metadata: {
              ...(item.depends_on ? { depends_on: item.depends_on } : {}),
              ...(item.payload ? { payload: item.payload } : {}),
              ...(item.source_url ? { source_url: item.source_url } : {}),
            },
          })),
          p_actor_user_id: user.id,
        });
        if (error) throw mapError(error);
        return createDesignImportResponseSchema.parse(data);
      }
      let effective = input as Exclude<
        CreateDesignImportRequest,
        { source_kind: "manifest_inline" }
      >;
      let metadataBySource = new Map<string, Record<string, unknown>>();
      if (input.source_kind === "manifest") {
        const expanded = await expandManifest(options, user, input);
        effective = expanded.input;
        metadataBySource = expanded.metadata;
      }
      const source =
        effective.source_kind === "local_upload"
          ? { asset_object_ids: effective.asset_object_ids }
          : effective.source_kind === "url"
            ? { source_urls: effective.source_urls }
            : { manifest_asset_object_id: effective.manifest_asset_object_id };
      const { data, error } = await (
        options.getAdminClient().rpc as unknown as Rpc
      )("loomic_resource_import_create", {
        p_request_id: input.request_id,
        p_scope: input.scope,
        p_workspace_id: input.workspace_id,
        p_source_kind: effective.source_kind,
        p_source: source,
        p_actor_user_id: user.id,
      });
      if (error) throw mapError(error);
      const created = createDesignImportResponseSchema.parse(data);
      if (metadataBySource.size) {
        const admin = options.getAdminClient();
        for (const [sourceKey, metadata] of metadataBySource) {
          const update = await admin
            .from("resource_import_items")
            .update({ metadata: metadata as Json })
            .eq("import_job_id", created.import_job_id)
            .eq("source_key", sourceKey);
          if (update.error) throw mapError(update.error);
        }
      }
      return created;
    },
    async list(user, input) {
      const client = options.createUserClient(user.accessToken);
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      let query = client
        .from("resource_import_jobs")
        .select(JOB_COLUMNS)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(input.limit + 1);
      if (cursor)
        query = query.or(
          `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
        );
      const { data, error } = await query;
      if (error) throw mapError(error);
      const rows = data ?? [];
      const page = rows
        .slice(0, input.limit)
        .map((row) => designImportJobDtoSchema.parse(row));
      const last = page.at(-1);
      return {
        items: page,
        next_cursor:
          rows.length > input.limit && last
            ? encodeCursor(last.created_at, last.id)
            : null,
      };
    },
    async get(user, jobId) {
      const client = options.createUserClient(user.accessToken);
      const [job, items] = await Promise.all([
        client
          .from("resource_import_jobs")
          .select(JOB_COLUMNS)
          .eq("id", jobId)
          .maybeSingle(),
        client
          .from("resource_import_items")
          .select(ITEM_COLUMNS)
          .eq("import_job_id", jobId)
          .order("created_at"),
      ]);
      if (job.error || items.error)
        throw mapError(job.error ?? items.error ?? {});
      if (!job.data) throw notFound();
      return {
        job: designImportJobDtoSchema.parse(job.data),
        items: (items.data ?? []).map((item) =>
          designImportItemDtoSchema.parse({
            ...item,
            metadata: item.metadata ?? {},
          }),
        ),
      };
    },
    async cancel(user, jobId) {
      await this.get(user, jobId);
      const { data, error } = await options
        .getAdminClient()
        .from("resource_import_jobs")
        .update({
          status: "canceled",
          completed_at: new Date().toISOString(),
          claimed_at: null,
          claim_token: null,
        })
        .eq("id", jobId)
        .in("status", ["queued", "running"])
        .select(JOB_COLUMNS)
        .maybeSingle();
      if (error) throw mapError(error);
      if (!data) throw conflict("Import job cannot be canceled.");
      return designImportJobDtoSchema.parse(data);
    },
    async retry(user, jobId) {
      const current = await this.get(user, jobId);
      if (current.job.status !== "failed" && current.job.status !== "canceled")
        throw conflict("Only failed or canceled imports can be retried.");
      const admin = options.getAdminClient();
      const resetItems = await admin
        .from("resource_import_items")
        .update({
          status: "pending",
          error_code: null,
          error_message: null,
          completed_at: null,
        })
        .eq("import_job_id", jobId)
        .in("status", ["failed", "rejected"]);
      if (resetItems.error) throw mapError(resetItems.error);
      const { data, error } = await admin
        .from("resource_import_jobs")
        .update({
          status: "queued",
          completed_at: null,
          claimed_at: null,
          claim_token: null,
          available_at: new Date().toISOString(),
          attempt_count: 0,
          last_error: null,
          failed_items: 0,
        })
        .eq("id", jobId)
        .in("status", ["failed", "canceled"])
        .select(JOB_COLUMNS)
        .maybeSingle();
      if (error) throw mapError(error);
      if (!data) throw conflict("Import job changed concurrently.");
      return designImportJobDtoSchema.parse(data);
    },
    async attachItemMetadata(user, jobId, metadataByAssetId) {
      await this.get(user, jobId);
      const admin = options.getAdminClient();
      for (const [assetId, metadata] of metadataByAssetId) {
        const { error } = await admin
          .from("resource_import_items")
          .update({ metadata: metadata as Json })
          .eq("import_job_id", jobId)
          .eq("asset_object_id", assetId);
        if (error) throw mapError(error);
      }
    },
  };
}

async function expandManifest(
  options: {
    createUserClient: (token: string) => UserSupabaseClient;
    getAdminClient: () => AdminSupabaseClient;
  },
  user: AuthenticatedUser,
  input: Extract<CreateDesignImportRequest, { source_kind: "manifest" }>,
): Promise<{
  input: Exclude<CreateDesignImportRequest, { source_kind: "manifest_inline" }>;
  metadata: Map<string, Record<string, unknown>>;
}> {
  const client = options.createUserClient(user.accessToken);
  const { data: asset, error } = await client
    .from("asset_objects")
    .select("id,bucket,object_path,scope,workspace_id,byte_size")
    .eq("id", input.manifest_asset_object_id)
    .maybeSingle();
  if (
    error ||
    !asset ||
    asset.scope !== input.scope ||
    asset.workspace_id !== input.workspace_id ||
    (asset.byte_size ?? 0) > 1024 * 1024
  )
    throw new DesignResourceServiceError(
      "resource_forbidden",
      "Manifest asset is unavailable.",
      403,
    );
  const downloaded = await client.storage
    .from(asset.bucket)
    .download(asset.object_path);
  if (downloaded.error || !downloaded.data)
    throw new DesignResourceServiceError(
      "resource_query_failed",
      "Manifest could not be read.",
      500,
    );
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    throw new DesignResourceServiceError(
      "resource_invalid",
      "ZIP manifests must use multipart package upload.",
      400,
    );
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new DesignResourceServiceError(
      "resource_invalid",
      "Manifest is invalid JSON.",
      400,
    );
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 100
  )
    throw new DesignResourceServiceError(
      "resource_invalid",
      "Manifest version 1 items[] is required.",
      400,
    );
  const metadata = new Map<string, Record<string, unknown>>();
  const urls: string[] = [];
  const assets: string[] = [];
  for (const candidate of value.items) {
    if (!isRecord(candidate))
      throw new DesignResourceServiceError(
        "resource_invalid",
        "Manifest item is invalid.",
        400,
      );
    const url =
      typeof candidate.source_url === "string" ? candidate.source_url : null;
    const assetId =
      typeof candidate.asset_object_id === "string"
        ? candidate.asset_object_id
        : null;
    if ((url ? 1 : 0) + (assetId ? 1 : 0) !== 1)
      throw new DesignResourceServiceError(
        "resource_invalid",
        "Each manifest item requires exactly one source.",
        400,
      );
    const key = url ?? designUuidSchema.parse(assetId);
    if (metadata.has(key))
      throw new DesignResourceServiceError(
        "resource_invalid",
        "Manifest sources must be unique.",
        400,
      );
    const { source_url: _url, asset_object_id: _asset, ...rest } = candidate;
    metadata.set(key, rest);
    if (url) urls.push(new URL(url).toString());
    else assets.push(key);
  }
  if (urls.length && assets.length)
    throw new DesignResourceServiceError(
      "resource_invalid",
      "Manifest source kinds cannot be mixed.",
      400,
    );
  return {
    input: urls.length
      ? {
          request_id: input.request_id,
          scope: input.scope,
          workspace_id: input.workspace_id,
          source_kind: "url",
          source_urls: urls,
        }
      : {
          request_id: input.request_id,
          scope: input.scope,
          workspace_id: input.workspace_id,
          source_kind: "local_upload",
          asset_object_ids: assets,
        },
    metadata,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeCursor(createdAt: string, id: string) {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url");
}
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.id !== "string"
    )
      throw new Error();
    return value;
  } catch {
    throw new DesignResourceServiceError(
      "resource_invalid",
      "Invalid import cursor.",
      400,
    );
  }
}
function mapError(error: { code?: string; message?: string }) {
  if (error.code === "42501")
    return new DesignResourceServiceError(
      "resource_forbidden",
      "Import access forbidden.",
      403,
    );
  if (error.code === "P0002") return notFound();
  if (error.code === "23505" || error.code === "40001")
    return conflict("Import request conflict.");
  if (error.code === "22023")
    return new DesignResourceServiceError(
      "resource_invalid",
      "Invalid import request.",
      400,
    );
  return new DesignResourceServiceError(
    "resource_query_failed",
    "Import operation failed.",
    500,
  );
}
function notFound() {
  return new DesignResourceServiceError(
    "resource_not_found",
    "Import job not found.",
    404,
  );
}
function conflict(message: string) {
  return new DesignResourceServiceError("resource_write_failed", message, 409);
}
