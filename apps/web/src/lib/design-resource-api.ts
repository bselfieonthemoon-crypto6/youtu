import {
  type CreateDesignCategoryRequest,
  type CreateDesignFontFaceRequest,
  type CreateDesignFontFamilyRequest,
  type CreateDesignImportRequest,
  type CreateDesignImportResponse,
  type CreateDesignResourceRequest,
  type CreateDesignTagRequest,
  type CreateDesignTextPresetRequest,
  type DeleteDesignCatalogEntryRequest,
  type DesignCatalogMutationResponse,
  type DesignFontFaceDto,
  type DesignFontFamilyDto,
  type DesignImportItemDto,
  type DesignImportJobDto,
  type DesignResourceCategoryDto,
  type DesignResourceListRequest,
  type DesignResourceListResponse,
  type DesignResourceTagDto,
  type DesignTemplateDetailDto,
  type DesignTemplateDto,
  type DesignTemplateReplaceApplyRequest,
  type DesignTemplateReplaceApplyResponse,
  type DesignTemplateReplacePreviewRequest,
  type DesignTemplateReplacePreviewResponse,
  type DesignTextPresetDto,
  type RestoreDesignCatalogEntryRequest,
  type SetDesignCatalogStatusRequest,
  type UpdateDesignCategoryRequest,
  type UpdateDesignFontFaceRequest,
  type UpdateDesignFontFamilyRequest,
  type UpdateDesignResourceRequest,
  type UpdateDesignTagRequest,
  type UpdateDesignTemplateRequest,
  type UpdateDesignTemplateVariablesRequest,
  type UpdateDesignTextPresetRequest,
  createDesignCategoryRequestSchema,
  createDesignFontFaceRequestSchema,
  createDesignFontFamilyRequestSchema,
  createDesignImportRequestSchema,
  createDesignImportResponseSchema,
  createDesignResourceRequestSchema,
  createDesignTagRequestSchema,
  createDesignTextPresetRequestSchema,
  deleteDesignCatalogEntryRequestSchema,
  designCatalogMutationResponseSchema,
designCatalogPreviewUrlResponseSchema,
  designFontFaceDtoSchema,
  designFontFamilyDtoSchema,
  designImportItemDtoSchema,
  designImportJobDtoSchema,
  designResourceCategoryDtoSchema,
  designResourceDtoSchema,
  designResourceListRequestSchema,
  designResourceListResponseSchema,
  designResourceTagDtoSchema,
  designTemplateDetailDtoSchema,
  designTemplateDtoSchema,
  designTemplateReplaceApplyRequestSchema,
  designTemplateReplaceApplyResponseSchema,
  designTemplateReplacePreviewRequestSchema,
  designTemplateReplacePreviewResponseSchema,
  designTextPresetDtoSchema,
  designUuidSchema,
  restoreDesignCatalogEntryRequestSchema,
  setDesignCatalogStatusRequestSchema,
  updateDesignCategoryRequestSchema,
  updateDesignFontFaceRequestSchema,
  updateDesignFontFamilyRequestSchema,
  updateDesignResourceRequestSchema,
  updateDesignTagRequestSchema,
  updateDesignTemplateRequestSchema,
  updateDesignTemplateVariablesRequestSchema,
  updateDesignTextPresetRequestSchema,
} from "@loomic/shared";

import { getServerBaseUrl } from "./env";

type FetchImplementation = typeof globalThis.fetch;
type ItemSchema<T> = { parse(value: unknown): T };

export type DesignCatalogCollection = "all" | "favorites" | "recent";
export type DesignCatalogListRequest = Omit<
  DesignResourceListRequest,
  "limit" | "collection" | "collection_workspace_id"
> & {
  limit?: number | undefined;
  collection?: DesignCatalogCollection;
  workspace_id?: string;
  deleted?: "false" | "true" | "all";
};
export type DesignCatalogPage<T> = {
  items: T[];
  next_cursor: string | null;
};
export type DesignFontCatalogItem = {
  family: DesignFontFamilyDto;
  faces: DesignFontFaceDto[];
};
export type AdminCatalogEntityKind =
  | "resource"
  | "template"
  | "text_preset"
  | "font_family"
  | "font_face"
  | "category"
  | "tag";
export type AdminCatalogReferenceReport = Record<string, unknown>;
export type DesignImportDetail = {
  job: DesignImportJobDto;
  items: DesignImportItemDto[];
};
export type AdminDirectoryImportRequest = {
  request_id: string;
  scope: "workspace";
  workspace_id: string;
  source_kind: "server_directory";
  directory_path: string;
};
export type AdminFontFileUpload = {
  asset_object_id: string;
  family_name: string;
  style: "normal" | "italic";
  weight: number;
  format: "woff" | "ttf" | "otf";
  checksum_sha256: string;
  allow_web_embed: boolean;
};

export class DesignResourceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesignResourceApiError";
  }
}

export type DesignResourceApiClient = {
  listResources(
    accessToken: string,
    request?: DesignCatalogListRequest,
    signal?: AbortSignal,
  ): Promise<DesignResourceListResponse>;
  getResourceContent(
    accessToken: string,
    resourceId: string,
    signal?: AbortSignal,
  ): Promise<Blob>;
  getResourcePreview(
    accessToken: string,
    resourceId: string,
    signal?: AbortSignal,
  ): Promise<Blob>;
  setFavorite(
    accessToken: string,
    resourceId: string,
    favorite: boolean,
  ): Promise<boolean>;
  recordRecentUse(
    accessToken: string,
    resourceId: string,
    workspaceId: string,
  ): Promise<{ used_at: string; use_count: number }>;
  listTemplates(
    accessToken: string,
    request?: CatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<DesignCatalogPage<DesignTemplateDto>>;
  getTemplate(
    accessToken: string,
    templateId: string,
    signal?: AbortSignal,
  ): Promise<DesignTemplateDetailDto>;
  previewTemplateReplacement(
    accessToken: string,
    request: DesignTemplateReplacePreviewRequest,
  ): Promise<DesignTemplateReplacePreviewResponse>;
  applyTemplateReplacement(
    accessToken: string,
    request: DesignTemplateReplaceApplyRequest,
  ): Promise<DesignTemplateReplaceApplyResponse>;
  listTextPresets(
    accessToken: string,
    request?: CatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<DesignCatalogPage<DesignTextPresetDto>>;
  listFonts(
    accessToken: string,
    request?: CatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<DesignCatalogPage<DesignFontCatalogItem>>;
  getFontFaceContent(
    accessToken: string,
    faceId: string,
    signal?: AbortSignal,
  ): Promise<Blob>;
  listAdminResources(
    accessToken: string,
    request?: DesignCatalogListRequest,
    signal?: AbortSignal,
  ): Promise<DesignResourceListResponse>;
  listAdminTemplates(
    accessToken: string,
    request?: CatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<DesignCatalogPage<DesignTemplateDto>>;
  /**
   * A short-lived signed thumbnail URL for one catalog entry. The list rows carry
   * the preview asset id, but the bytes come from an endpoint that needs the bearer
   * token, which an `<img src>` cannot send - so the server signs instead.
   */
  getAdminCatalogPreviewUrl(
    accessToken: string,
    collection: string,
    entityId: string,
    signal?: AbortSignal,
  ): Promise<{ url: string | null; uses_preview: boolean }>;
  createAdminTemplateFromDesign(
    accessToken: string,
    request: {
      request_id: string;
      design_id: string;
      scope: "platform" | "workspace";
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
    },
  ): Promise<DesignTemplateDto>;
  updateAdminTemplateVariables(
    accessToken: string,
    templateId: string,
    request: UpdateDesignTemplateVariablesRequest,
  ): Promise<DesignCatalogMutationResponse>;
  listAdminTextPresets(
    accessToken: string,
    request?: CatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<DesignCatalogPage<DesignTextPresetDto>>;
  listAdminFontFamilies(
    accessToken: string,
    request?: CatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<DesignCatalogPage<DesignFontCatalogItem>>;
  listAdminFontFaces(
    accessToken: string,
    request?: CatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<DesignCatalogPage<DesignFontFaceDto>>;
  uploadAdminFontFile(
    accessToken: string,
    workspaceId: string,
    file: File,
    signal?: AbortSignal,
  ): Promise<AdminFontFileUpload>;
  listAdminCategories(
    accessToken: string,
    request?: CatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<DesignCatalogPage<DesignResourceCategoryDto>>;
  listAdminTags(
    accessToken: string,
    request?: CatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<DesignCatalogPage<DesignResourceTagDto>>;
  createAdminResource(
    accessToken: string,
    request: CreateDesignResourceRequest,
  ): Promise<DesignResourceListResponse["items"][number]>;
  createAdminCatalogEntry(
    accessToken: string,
    collection:
      | "text-presets"
      | "font-families"
      | "font-faces"
      | "categories"
      | "tags",
    request:
      | CreateDesignTextPresetRequest
      | CreateDesignFontFamilyRequest
      | CreateDesignFontFaceRequest
      | CreateDesignCategoryRequest
      | CreateDesignTagRequest,
  ): Promise<DesignCatalogMutationResponse>;
  updateAdminCatalogEntry(
    accessToken: string,
    collection:
      | "resources"
      | "templates"
      | "text-presets"
      | "font-families"
      | "font-faces"
      | "categories"
      | "tags",
    entityId: string,
    request:
      | UpdateDesignTextPresetRequest
      | UpdateDesignResourceRequest
      | UpdateDesignTemplateRequest
      | UpdateDesignFontFamilyRequest
      | UpdateDesignFontFaceRequest
      | UpdateDesignCategoryRequest
      | UpdateDesignTagRequest,
  ): Promise<DesignCatalogMutationResponse>;
  setAdminCatalogStatus(
    accessToken: string,
    request: SetDesignCatalogStatusRequest,
  ): Promise<DesignCatalogMutationResponse>;
  setAdminCatalogDeleted(
    accessToken: string,
    request: DeleteDesignCatalogEntryRequest | RestoreDesignCatalogEntryRequest,
    deleted: boolean,
  ): Promise<DesignCatalogMutationResponse>;
  getAdminReferences(
    accessToken: string,
    entityKind: AdminCatalogEntityKind,
    entityId: string,
  ): Promise<AdminCatalogReferenceReport>;
  createImport(
    accessToken: string,
    request: CreateDesignImportRequest,
  ): Promise<CreateDesignImportResponse>;
  createImportPackage(
    accessToken: string,
    input: {
      request_id: string;
      workspace_id: string;
      file: File;
    },
    signal?: AbortSignal,
  ): Promise<CreateDesignImportResponse>;
  createDirectoryImport(
    accessToken: string,
    input: AdminDirectoryImportRequest,
  ): Promise<CreateDesignImportResponse>;
  listImports(
    accessToken: string,
    request?: Pick<CatalogPageRequest, "cursor" | "limit">,
    signal?: AbortSignal,
  ): Promise<DesignCatalogPage<DesignImportJobDto>>;
  getImport(
    accessToken: string,
    jobId: string,
    report?: boolean,
  ): Promise<DesignImportDetail>;
  updateImport(
    accessToken: string,
    jobId: string,
    action: "cancel" | "retry",
  ): Promise<DesignImportJobDto>;
};

export type CatalogPageRequest = {
  query?: string | undefined;
  cursor?: string | undefined;
  limit?: number;
  scope?: "platform" | "workspace" | undefined;
  status?:
    | "draft"
    | "pending_review"
    | "published"
    | "rejected"
    | "disabled"
    | undefined;
  deleted?: "false" | "true" | "all" | undefined;
};

export function createDesignResourceApiClient(
  options: { baseUrl?: string; fetch?: FetchImplementation } = {},
): DesignResourceApiClient {
  const baseUrl = (options.baseUrl ?? getServerBaseUrl()).replace(/\/$/, "");
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  const request = async (input: {
    accessToken: string;
    path: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    formData?: FormData | undefined;
    signal?: AbortSignal | undefined;
  }) => {
    let response: Response;
    try {
      response = await fetchImplementation(`${baseUrl}${input.path}`, {
        method: input.method ?? "GET",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          ...(input.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(input.formData
          ? { body: input.formData }
          : input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body) }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      throw new DesignResourceApiError("无法连接资源服务。", 0, {
        cause: error,
      });
    }
    if (!response.ok) {
      let message = `资源服务请求失败（${response.status}）`;
      try {
        const body = (await response.json()) as {
          error?: { message?: unknown };
          message?: unknown;
        };
        const candidate = body.error?.message ?? body.message;
        if (typeof candidate === "string" && candidate.trim())
          message = candidate;
      } catch {
        // A non-JSON error is still represented by the HTTP status above.
      }
      throw new DesignResourceApiError(message, response.status);
    }
    return response;
  };

  const requestJson = async <T>(
    input: Parameters<typeof request>[0],
    parse: (value: unknown) => T,
  ) => {
    const response = await request(input);
    try {
      return parse(await response.json());
    } catch (error) {
      if (error instanceof DesignResourceApiError) throw error;
      throw new DesignResourceApiError(
        "资源服务返回了无效数据。",
        response.status,
        {
          cause: error,
        },
      );
    }
  };

  return {
    listResources(accessToken, rawRequest = {}, signal?: AbortSignal) {
      const {
        collection = "all",
        workspace_id: rawWorkspaceId,
        ...candidate
      } = rawRequest;
      const workspaceId = rawWorkspaceId
        ? designUuidSchema.parse(rawWorkspaceId)
        : undefined;
      const parsed = designResourceListRequestSchema.parse({
        ...candidate,
        collection: collection === "all" ? undefined : collection,
        collection_workspace_id:
          collection === "recent" ? workspaceId : undefined,
      });
      const { collection_workspace_id: _collectionWorkspaceId, ...query } =
        parsed;
      return requestJson(
        {
          accessToken,
          signal,
          path: `/api/design-resources${toQuery({
            ...query,
            workspace_id: collection === "recent" ? workspaceId : undefined,
          })}`,
        },
        (value) => designResourceListResponseSchema.parse(value),
      );
    },
    async getResourceContent(accessToken, rawResourceId, signal) {
      const resourceId = designUuidSchema.parse(rawResourceId);
      return (
        await request({
          accessToken,
          signal,
          path: `/api/design-resources/${encodeURIComponent(resourceId)}/content`,
        })
      ).blob();
    },
    async getResourcePreview(accessToken, rawResourceId, signal) {
      const resourceId = designUuidSchema.parse(rawResourceId);
      return (
        await request({
          accessToken,
          signal,
          path: `/api/design-resources/${encodeURIComponent(resourceId)}/preview`,
        })
      ).blob();
    },
    async setFavorite(accessToken, rawResourceId, favorite) {
      const resourceId = designUuidSchema.parse(rawResourceId);
      return requestJson(
        {
          accessToken,
          path: `/api/design-resources/${encodeURIComponent(resourceId)}/favorite`,
          method: favorite ? "PUT" : "DELETE",
        },
        (value) => {
          if (!isRecord(value) || typeof value.favorite !== "boolean")
            throw new Error("invalid favorite response");
          return value.favorite;
        },
      );
    },
    async recordRecentUse(accessToken, rawResourceId, rawWorkspaceId) {
      const resourceId = designUuidSchema.parse(rawResourceId);
      const workspaceId = designUuidSchema.parse(rawWorkspaceId);
      return requestJson(
        {
          accessToken,
          path: `/api/design-resources/${encodeURIComponent(resourceId)}/recent`,
          method: "POST",
          body: { workspace_id: workspaceId },
        },
        (value) => {
          if (
            !isRecord(value) ||
            typeof value.used_at !== "string" ||
            typeof value.use_count !== "number"
          )
            throw new Error("invalid recent response");
          return { used_at: value.used_at, use_count: value.use_count };
        },
      );
    },
    listTemplates(accessToken, rawRequest = {}, signal?: AbortSignal) {
      const parsed = parsePageRequest(rawRequest);
      return requestJson(
        {
          accessToken,
          signal,
          path: `/api/design-templates${toQuery(parsed)}`,
        },
        (value) => parsePage(value, designTemplateDtoSchema),
      );
    },
    getTemplate(accessToken, rawTemplateId, signal) {
      const templateId = designUuidSchema.parse(rawTemplateId);
      return requestJson(
        {
          accessToken,
          signal,
          path: `/api/design-templates/${encodeURIComponent(templateId)}`,
        },
        (value) => designTemplateDetailDtoSchema.parse(value),
      );
    },
    previewTemplateReplacement(accessToken, rawInput) {
      const input = designTemplateReplacePreviewRequestSchema.parse(rawInput);
      return requestJson(
        {
          accessToken,
          path: `/api/design-templates/${encodeURIComponent(input.template_id)}/replace-preview`,
          method: "POST",
          body: input,
        },
        (value) => designTemplateReplacePreviewResponseSchema.parse(value),
      );
    },
    applyTemplateReplacement(accessToken, rawInput) {
      const input = designTemplateReplaceApplyRequestSchema.parse(rawInput);
      return requestJson(
        {
          accessToken,
          path: `/api/design-templates/${encodeURIComponent(input.template_id)}/replace-apply`,
          method: "POST",
          body: input,
        },
        (value) => designTemplateReplaceApplyResponseSchema.parse(value),
      );
    },
    listTextPresets(accessToken, rawRequest = {}, signal?: AbortSignal) {
      const parsed = parsePageRequest(rawRequest);
      return requestJson(
        {
          accessToken,
          signal,
          path: `/api/design-text-presets${toQuery(parsed)}`,
        },
        (value) => parsePage(value, designTextPresetDtoSchema),
      );
    },
    listFonts(accessToken, rawRequest = {}, signal?: AbortSignal) {
      const parsed = parsePageRequest(rawRequest);
      return requestJson(
        { accessToken, signal, path: `/api/design-fonts${toQuery(parsed)}` },
        (value) => parsePage(value, { parse: parseFontItem }),
      );
    },
    async getFontFaceContent(accessToken, rawFaceId, signal) {
      const faceId = designUuidSchema.parse(rawFaceId);
      return (
        await request({
          accessToken,
          signal,
          path: `/api/design-fonts/faces/${encodeURIComponent(faceId)}/content`,
        })
      ).blob();
    },
    listAdminResources(accessToken, rawRequest = {}, signal?: AbortSignal) {
      const {
        collection: _collection,
        workspace_id: _workspaceId,
        deleted,
        ...candidate
      } = rawRequest;
      const parsed = designResourceListRequestSchema.parse(candidate);
      return requestJson(
        {
          accessToken,
          signal,
          path: `/api/admin/design-catalog/resources${toQuery({ ...parsed, deleted })}`,
        },
        (value) => designResourceListResponseSchema.parse(value),
      );
    },
    listAdminTemplates(accessToken, rawRequest = {}, signal?: AbortSignal) {
      const parsed = parsePageRequest(rawRequest);
      return requestJson(
        {
          accessToken,
          signal,
          path: `/api/admin/design-catalog/templates${toQuery(parsed)}`,
        },
        (value) => parsePage(value, designTemplateDtoSchema),
      );
    },
    getAdminCatalogPreviewUrl(accessToken, collection, entityId, signal?: AbortSignal) {
      return requestJson(
        {
          accessToken,
          signal,
          path: `/api/admin/design-catalog/${encodeURIComponent(collection)}/${encodeURIComponent(entityId)}/preview-url`,
        },
        (value) => {
          const parsed = designCatalogPreviewUrlResponseSchema.parse(value);
          return { url: parsed.url, uses_preview: parsed.uses_preview };
        },
      );
    },
    createAdminTemplateFromDesign(accessToken, input) {
      return requestJson(
        {
          accessToken,
          path: "/api/admin/design-catalog/templates/from-design",
          method: "POST",
          body: input,
        },
        (value) => designTemplateDtoSchema.parse(value),
      );
    },
    updateAdminTemplateVariables(accessToken, rawTemplateId, rawInput) {
      const templateId = designUuidSchema.parse(rawTemplateId);
      const input = updateDesignTemplateVariablesRequestSchema.parse(rawInput);
      return requestJson(
        {
          accessToken,
          path: `/api/admin/design-catalog/templates/${encodeURIComponent(templateId)}/variables`,
          method: "PUT",
          body: input,
        },
        (value) => designCatalogMutationResponseSchema.parse(value),
      );
    },
    listAdminTextPresets(accessToken, rawRequest = {}, signal?: AbortSignal) {
      return listAdminPage(
        "text-presets",
        rawRequest,
        signal,
        designTextPresetDtoSchema,
        accessToken,
      );
    },
    listAdminFontFamilies(accessToken, rawRequest = {}, signal?: AbortSignal) {
      return listAdminPage(
        "font-families",
        rawRequest,
        signal,
        { parse: parseFontItem },
        accessToken,
      );
    },
    listAdminFontFaces(accessToken, rawRequest = {}, signal?: AbortSignal) {
      return listAdminPage(
        "font-faces",
        rawRequest,
        signal,
        designFontFaceDtoSchema,
        accessToken,
      );
    },
    uploadAdminFontFile(accessToken, rawWorkspaceId, file, signal) {
      const workspaceId = designUuidSchema.parse(rawWorkspaceId);
      const formData = new FormData();
      formData.append("workspace_id", workspaceId);
      formData.append("file", file, file.name);
      return requestJson(
        {
          accessToken,
          signal,
          path: "/api/admin/design-catalog/font-files",
          method: "POST",
          formData,
        },
        parseAdminFontFileUpload,
      );
    },
    listAdminCategories(accessToken, rawRequest = {}, signal?: AbortSignal) {
      return listAdminPage(
        "categories",
        rawRequest,
        signal,
        designResourceCategoryDtoSchema,
        accessToken,
      );
    },
    listAdminTags(accessToken, rawRequest = {}, signal?: AbortSignal) {
      return listAdminPage(
        "tags",
        rawRequest,
        signal,
        designResourceTagDtoSchema,
        accessToken,
      );
    },
    createAdminResource(accessToken, rawInput) {
      const input = createDesignResourceRequestSchema.parse(rawInput);
      return requestJson(
        {
          accessToken,
          path: "/api/admin/design-catalog/resources",
          method: "POST",
          body: input,
        },
        (value) => designResourceDtoSchema.parse(value),
      );
    },
    createAdminCatalogEntry(accessToken, collection, rawInput) {
      const input = parseAdminCreate(collection, rawInput);
      return requestJson(
        {
          accessToken,
          path: `/api/admin/design-catalog/${collection}`,
          method: "POST",
          body: input,
        },
        (value) => designCatalogMutationResponseSchema.parse(value),
      );
    },
    updateAdminCatalogEntry(accessToken, collection, rawEntityId, rawInput) {
      const entityId = designUuidSchema.parse(rawEntityId);
      const input = parseAdminUpdate(collection, rawInput);
      return requestJson(
        {
          accessToken,
          path: `/api/admin/design-catalog/${collection}/${encodeURIComponent(entityId)}`,
          method: "PATCH",
          body: input,
        },
        (value) => designCatalogMutationResponseSchema.parse(value),
      );
    },
    setAdminCatalogStatus(accessToken, rawInput) {
      const input = setDesignCatalogStatusRequestSchema.parse(rawInput);
      return requestJson(
        {
          accessToken,
          path: "/api/admin/design-catalog/status",
          method: "POST",
          body: input,
        },
        (value) => designCatalogMutationResponseSchema.parse(value),
      );
    },
    setAdminCatalogDeleted(accessToken, rawInput, deleted) {
      const input = (
        deleted
          ? deleteDesignCatalogEntryRequestSchema
          : restoreDesignCatalogEntryRequestSchema
      ).parse(rawInput);
      return requestJson(
        {
          accessToken,
          path: `/api/admin/design-catalog/${deleted ? "delete" : "restore"}`,
          method: "POST",
          body: input,
        },
        (value) => designCatalogMutationResponseSchema.parse(value),
      );
    },
    getAdminReferences(accessToken, entityKind, rawEntityId) {
      const entityId = designUuidSchema.parse(rawEntityId);
      const collection = {
        resource: "resources",
        template: "templates",
        text_preset: "text-presets",
        font_family: "font-families",
        font_face: "font-faces",
        category: "categories",
        tag: "tags",
      }[entityKind];
      return requestJson(
        {
          accessToken,
          path: `/api/admin/design-catalog/${collection}/${encodeURIComponent(entityId)}/references`,
        },
        (value) => {
          if (!isRecord(value)) throw new Error("invalid reference report");
          return value;
        },
      );
    },
    createImport(accessToken, rawInput) {
      const input = createDesignImportRequestSchema.parse(rawInput);
      return requestJson(
        {
          accessToken,
          path: "/api/admin/design-catalog/imports",
          method: "POST",
          body: input,
        },
        (value) => createDesignImportResponseSchema.parse(value),
      );
    },
    createImportPackage(accessToken, rawInput, signal) {
      const requestId = designUuidSchema.parse(rawInput.request_id);
      const workspaceId = designUuidSchema.parse(rawInput.workspace_id);
      const formData = new FormData();
      formData.append("request_id", requestId);
      formData.append("workspace_id", workspaceId);
      formData.append("file", rawInput.file, rawInput.file.name);
      return requestJson(
        {
          accessToken,
          signal,
          path: "/api/admin/design-catalog/imports",
          method: "POST",
          formData,
        },
        (value) => createDesignImportResponseSchema.parse(value),
      );
    },
    createDirectoryImport(accessToken, rawInput) {
      const input: AdminDirectoryImportRequest = {
        request_id: designUuidSchema.parse(rawInput.request_id),
        scope: "workspace",
        workspace_id: designUuidSchema.parse(rawInput.workspace_id),
        source_kind: "server_directory",
        directory_path: rawInput.directory_path.trim(),
      };
      if (!input.directory_path || input.directory_path.length > 4_096)
        throw new Error("directory_path must be between 1 and 4096 characters");
      return requestJson(
        {
          accessToken,
          path: "/api/admin/design-catalog/imports",
          method: "POST",
          body: input,
        },
        (value) => createDesignImportResponseSchema.parse(value),
      );
    },
    listImports(accessToken, rawRequest = {}, signal?: AbortSignal) {
      const parsed = parsePageRequest({
        ...rawRequest,
        limit: rawRequest.limit ?? 30,
      });
      return requestJson(
        {
          accessToken,
          signal,
          path: `/api/admin/design-catalog/imports${toQuery({ cursor: parsed.cursor, limit: parsed.limit })}`,
        },
        (value) => parsePage(value, designImportJobDtoSchema),
      );
    },
    getImport(accessToken, rawJobId, report = false) {
      const jobId = designUuidSchema.parse(rawJobId);
      return requestJson(
        {
          accessToken,
          path: `/api/admin/design-catalog/imports/${encodeURIComponent(jobId)}${report ? "/report" : ""}`,
        },
        parseImportDetail,
      );
    },
    updateImport(accessToken, rawJobId, action) {
      const jobId = designUuidSchema.parse(rawJobId);
      return requestJson(
        {
          accessToken,
          path: `/api/admin/design-catalog/imports/${encodeURIComponent(jobId)}/${action}`,
          method: "POST",
        },
        (value) => designImportJobDtoSchema.parse(value),
      );
    },
  };

  function listAdminPage<T>(
    collection: string,
    rawRequest: CatalogPageRequest,
    signal: AbortSignal | undefined,
    schema: ItemSchema<T>,
    accessToken: string,
  ) {
    const parsed = parsePageRequest(rawRequest);
    return requestJson(
      {
        accessToken,
        ...(signal ? { signal } : {}),
        path: `/api/admin/design-catalog/${collection}${toQuery(parsed)}`,
      },
      (value) => parsePage(value, schema),
    );
  }
}

function parseAdminCreate(collection: string, value: unknown) {
  const schemas = {
    "text-presets": createDesignTextPresetRequestSchema,
    "font-families": createDesignFontFamilyRequestSchema,
    "font-faces": createDesignFontFaceRequestSchema,
    categories: createDesignCategoryRequestSchema,
    tags: createDesignTagRequestSchema,
  } as const;
  return schemas[collection as keyof typeof schemas].parse(value);
}

function parseAdminUpdate(collection: string, value: unknown) {
  const schemas = {
    resources: updateDesignResourceRequestSchema,
    templates: updateDesignTemplateRequestSchema,
    "text-presets": updateDesignTextPresetRequestSchema,
    "font-families": updateDesignFontFamilyRequestSchema,
    "font-faces": updateDesignFontFaceRequestSchema,
    categories: updateDesignCategoryRequestSchema,
    tags: updateDesignTagRequestSchema,
  } as const;
  return schemas[collection as keyof typeof schemas].parse(value);
}

function parseImportDetail(value: unknown): DesignImportDetail {
  if (!isRecord(value) || !Array.isArray(value.items))
    throw new Error("invalid import detail");
  return {
    job: designImportJobDtoSchema.parse(value.job),
    items: value.items.map((item) => designImportItemDtoSchema.parse(item)),
  };
}

function parseAdminFontFileUpload(value: unknown): AdminFontFileUpload {
  if (!isRecord(value)) throw new Error("invalid font upload response");
  const assetObjectId = designUuidSchema.parse(value.asset_object_id);
  if (
    typeof value.family_name !== "string" ||
    value.family_name.trim().length === 0 ||
    (value.style !== "normal" && value.style !== "italic") ||
    !Number.isInteger(value.weight) ||
    Number(value.weight) < 1 ||
    Number(value.weight) > 1000 ||
    (value.format !== "woff" &&
      value.format !== "ttf" &&
      value.format !== "otf") ||
    typeof value.checksum_sha256 !== "string" ||
    !/^[a-f\d]{64}$/iu.test(value.checksum_sha256) ||
    typeof value.allow_web_embed !== "boolean"
  )
    throw new Error("invalid font upload response");
  return {
    asset_object_id: assetObjectId,
    family_name: value.family_name,
    style: value.style,
    weight: Number(value.weight),
    format: value.format,
    checksum_sha256: value.checksum_sha256,
    allow_web_embed: value.allow_web_embed,
  };
}

function parsePageRequest(input: CatalogPageRequest) {
  const limit = input.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("limit must be between 1 and 100");
  const query = input.query?.trim();
  if (query && query.length > 200) throw new Error("query is too long");
  return {
    query: query || undefined,
    cursor: input.cursor,
    limit,
    scope: input.scope,
    status: input.status,
    deleted: input.deleted,
  };
}

function parsePage<T>(
  value: unknown,
  schema: ItemSchema<T>,
): DesignCatalogPage<T> {
  if (!isRecord(value) || !Array.isArray(value.items))
    throw new Error("invalid catalog page");
  if (value.next_cursor !== null && typeof value.next_cursor !== "string")
    throw new Error("invalid catalog cursor");
  return {
    items: value.items.map((item) => schema.parse(item)),
    next_cursor: value.next_cursor,
  };
}

function parseFontItem(value: unknown): DesignFontCatalogItem {
  if (!isRecord(value) || !Array.isArray(value.faces))
    throw new Error("invalid font catalog item");
  return {
    family: designFontFamilyDtoSchema.parse(value.family),
    faces: value.faces.map((face) => designFontFaceDtoSchema.parse(face)),
  };
}

function toQuery(input: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
