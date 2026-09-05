import {
  type DesignFontFaceDto,
  type DesignFontFamilyDto,
  type DesignResourceCategoryDto,
  type DesignResourceScope,
  type DesignResourceTagDto,
  type DesignTextPresetDetailDto,
  type DesignTextPresetDto,
  designFontFaceDtoSchema,
  designFontFamilyDtoSchema,
  designResourceCategoryDtoSchema,
  designResourceTagDtoSchema,
  designTextPresetDetailDtoSchema,
  designTextPresetDtoSchema,
} from "@loomic/shared";

import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import { DesignResourceServiceError } from "./design-resource-service.js";

export type CatalogReadListInput = {
  scope?: DesignResourceScope | undefined;
  query?: string | undefined;
  cursor?: string | undefined;
  limit: number;
  deleted?: "exclude" | "only" | "all" | undefined;
};

export type DesignFontCatalogItem = {
  family: DesignFontFamilyDto;
  faces: DesignFontFaceDto[];
};

export type DesignCatalogReadService = {
  listTextPresets(
    user: AuthenticatedUser,
    input: CatalogReadListInput,
  ): Promise<{ items: DesignTextPresetDto[]; next_cursor: string | null }>;
  getTextPreset(
    user: AuthenticatedUser,
    presetId: string,
  ): Promise<DesignTextPresetDetailDto>;
  listFonts(
    user: AuthenticatedUser,
    input: CatalogReadListInput,
  ): Promise<{ items: DesignFontCatalogItem[]; next_cursor: string | null }>;
  getFont(
    user: AuthenticatedUser,
    familyId: string,
  ): Promise<DesignFontCatalogItem>;
  getFontFace(
    user: AuthenticatedUser,
    faceId: string,
  ): Promise<DesignFontFaceDto>;
  listFontFaces(
    user: AuthenticatedUser,
    input: CatalogReadListInput,
  ): Promise<{ items: DesignFontFaceDto[]; next_cursor: string | null }>;
  listCategories(
    user: AuthenticatedUser,
    input: CatalogReadListInput,
  ): Promise<{
    items: DesignResourceCategoryDto[];
    next_cursor: string | null;
  }>;
  listTags(
    user: AuthenticatedUser,
    input: CatalogReadListInput,
  ): Promise<{ items: DesignResourceTagDto[]; next_cursor: string | null }>;
};

type Row = Record<string, unknown> & { id: string; updated_at: string };
// Dynamic catalog helpers are limited to a fixed set of table/column names in
// this module; Supabase's generated generic query type cannot represent that union.
// biome-ignore lint/suspicious/noExplicitAny: constrained dynamic Supabase query builder
type UntypedClient = { from(table: string): any };

const PRESET_COLUMNS =
  "id, scope, workspace_id, name, style, preview_asset_object_id, revision, status, category_id, source_url, author, license_name, license_url, attribution, usage_restrictions, deleted_at, created_at, updated_at";
const FAMILY_COLUMNS =
  "id, scope, workspace_id, name, revision, status, source_url, author, license_name, license_url, attribution, usage_restrictions, deleted_at, created_at, updated_at";
const FACE_COLUMNS =
  "id, family_id, scope, workspace_id, style, weight, format, asset_object_id, status, checksum_sha256, allow_web_embed, revision, deleted_at, created_at, updated_at";
const CATEGORY_COLUMNS =
  "id, scope, workspace_id, parent_id, name, slug, sort_order, revision, status, deleted_at, created_at, updated_at";
const TAG_COLUMNS =
  "id, scope, workspace_id, name, slug, revision, status, deleted_at, created_at, updated_at";

export function createDesignCatalogReadService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): DesignCatalogReadService {
  return {
    async listTextPresets(user, input) {
      const client = options.createUserClient(user.accessToken);
      const rows = await listRows(
        client,
        "text_presets",
        PRESET_COLUMNS,
        input,
      );
      const page = rows.slice(0, input.limit);
      const tags = await loadLinkIds(
        client,
        "text_preset_tag_links",
        "text_preset_id",
        page.map((row) => row.id),
      );
      return pageResult(
        rows,
        page,
        input.limit,
        page.map((row) => toPreset(row, tags.get(row.id) ?? [])),
      );
    },

    async getTextPreset(user, presetId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await untyped(client)
        .from("text_presets")
        .select(PRESET_COLUMNS)
        .eq("id", presetId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw queryError(error);
      if (!data) throw notFound();
      const [tags, fonts] = await Promise.all([
        loadLinkIds(client, "text_preset_tag_links", "text_preset_id", [
          presetId,
        ]),
        loadLinkIds(
          client,
          "text_preset_font_refs",
          "text_preset_id",
          [presetId],
          "font_face_id",
        ),
      ]);
      return designTextPresetDetailDtoSchema.parse({
        preset: toPreset(data as Row, tags.get(presetId) ?? []),
        font_face_ids: fonts.get(presetId) ?? [],
      });
    },

    async listFonts(user, input) {
      const client = options.createUserClient(user.accessToken);
      const rows = await listRows(
        client,
        "font_families",
        FAMILY_COLUMNS,
        input,
      );
      const page = rows.slice(0, input.limit);
      const faces = await loadFaces(
        client,
        page.map((row) => row.id),
      );
      const items = page.map((row) => ({
        family: toFamily(row),
        faces: faces.get(row.id) ?? [],
      }));
      return pageResult(rows, page, input.limit, items);
    },

    async getFont(user, familyId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await untyped(client)
        .from("font_families")
        .select(FAMILY_COLUMNS)
        .eq("id", familyId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw queryError(error);
      if (!data) throw notFound();
      const faces = await loadFaces(client, [familyId]);
      return {
        family: toFamily(data as Row),
        faces: faces.get(familyId) ?? [],
      };
    },

    async getFontFace(user, faceId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await untyped(client)
        .from("font_faces")
        .select(FACE_COLUMNS)
        .eq("id", faceId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw queryError(error);
      if (!data) throw notFound();
      const family = await this.getFont(user, String(data.family_id));
      const face = family.faces.find((item) => item.id === faceId);
      if (!face) throw notFound();
      return face;
    },
    async listFontFaces(user, input) {
      const client = options.createUserClient(user.accessToken);
      const rows = await listRows(client, "font_faces", FACE_COLUMNS, input);
      const page = rows.slice(0, input.limit);
      const items = await hydrateFaces(client, page);
      return pageResult(rows, page, input.limit, items);
    },
    async listCategories(user, input) {
      const client = options.createUserClient(user.accessToken);
      const rows = await listRows(
        client,
        "resource_categories",
        CATEGORY_COLUMNS,
        input,
      );
      const page = rows.slice(0, input.limit);
      return pageResult(
        rows,
        page,
        input.limit,
        page.map((row) => designResourceCategoryDtoSchema.parse(row)),
      );
    },
    async listTags(user, input) {
      const client = options.createUserClient(user.accessToken);
      const rows = await listRows(client, "resource_tags", TAG_COLUMNS, input);
      const page = rows.slice(0, input.limit);
      return pageResult(
        rows,
        page,
        input.limit,
        page.map((row) => designResourceTagDtoSchema.parse(row)),
      );
    },
  };
}

async function hydrateFaces(client: UserSupabaseClient, rows: Row[]) {
  const ids = [...new Set(rows.map((row) => String(row.family_id)))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data, error } = await untyped(client)
      .from("font_families")
      .select("id, name")
      .in("id", ids);
    if (error) throw queryError(error);
    for (const family of data ?? [])
      names.set(String(family.id), String(family.name));
  }
  return rows.map((row) =>
    designFontFaceDtoSchema.parse({
      ...row,
      family_name: names.get(String(row.family_id)),
    }),
  );
}

async function listRows(
  client: UserSupabaseClient,
  table: string,
  columns: string,
  input: CatalogReadListInput,
): Promise<Row[]> {
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  let query = untyped(client)
    .from(table)
    .select(columns)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(input.limit + 1);
  if (!input.deleted || input.deleted === "exclude")
    query = query.is("deleted_at", null);
  else if (input.deleted === "only")
    query = query.not("deleted_at", "is", null);
  if (input.scope) query = query.eq("scope", input.scope);
  if (input.query) query = query.ilike("name", `%${escapeLike(input.query)}%`);
  if (cursor)
    query = query.or(
      `updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`,
    );
  const { data, error } = await query;
  if (error) throw queryError(error);
  return (data ?? []) as Row[];
}

async function loadFaces(client: UserSupabaseClient, familyIds: string[]) {
  const result = new Map<string, DesignFontFaceDto[]>();
  if (familyIds.length === 0) return result;
  const { data, error } = await untyped(client)
    .from("font_faces")
    .select(FACE_COLUMNS)
    .in("family_id", familyIds)
    .is("deleted_at", null)
    .order("weight")
    .order("style");
  if (error) throw queryError(error);
  const familyNames = new Map<string, string>();
  const { data: families, error: familyError } = await untyped(client)
    .from("font_families")
    .select("id, name")
    .in("id", familyIds);
  if (familyError) throw queryError(familyError);
  for (const family of families ?? [])
    familyNames.set(String(family.id), String(family.name));
  for (const row of data ?? []) {
    const familyId = String(row.family_id);
    const face = designFontFaceDtoSchema.parse({
      ...row,
      family_name: familyNames.get(familyId),
    });
    result.set(familyId, [...(result.get(familyId) ?? []), face]);
  }
  return result;
}

async function loadLinkIds(
  client: UserSupabaseClient,
  table: string,
  ownerColumn: string,
  ownerIds: string[],
  valueColumn = "tag_id",
) {
  const result = new Map<string, string[]>();
  if (ownerIds.length === 0) return result;
  const { data, error } = await untyped(client)
    .from(table)
    .select(`${ownerColumn}, ${valueColumn}`)
    .in(ownerColumn, ownerIds);
  if (error) throw queryError(error);
  for (const row of data ?? []) {
    const owner = String(row[ownerColumn]);
    result.set(owner, [...(result.get(owner) ?? []), String(row[valueColumn])]);
  }
  return result;
}

function toPreset(row: Row, tagIds: string[]) {
  return designTextPresetDtoSchema.parse({ ...row, tag_ids: tagIds });
}
function toFamily(row: Row) {
  return designFontFamilyDtoSchema.parse(row);
}
function pageResult<T>(rows: Row[], page: Row[], limit: number, items: T[]) {
  const last = page.at(-1);
  return {
    items,
    next_cursor:
      rows.length > limit && last
        ? encodeCursor(last.updated_at, last.id)
        : null,
  };
}
function untyped(client: UserSupabaseClient): UntypedClient {
  return client as unknown as UntypedClient;
}
function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
function encodeCursor(updatedAt: string, id: string) {
  return Buffer.from(JSON.stringify({ updatedAt, id }), "utf8").toString(
    "base64url",
  );
}
function decodeCursor(value: string): { updatedAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(parsed.id)
    )
      throw new Error();
    return parsed;
  } catch {
    throw new DesignResourceServiceError(
      "resource_invalid",
      "Invalid cursor.",
      400,
    );
  }
}
function notFound() {
  return new DesignResourceServiceError(
    "resource_not_found",
    "Catalog item not found.",
    404,
  );
}
function queryError(error: unknown) {
  const code =
    typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "";
  if (code === "42501")
    return new DesignResourceServiceError(
      "resource_forbidden",
      "Catalog access denied.",
      403,
    );
  return new DesignResourceServiceError(
    "resource_query_failed",
    "Failed to read catalog.",
    500,
  );
}
