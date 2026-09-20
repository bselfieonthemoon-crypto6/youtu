import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  createDesignCategoryRequestSchema,
  createDesignFontFaceRequestSchema,
  createDesignFontFamilyRequestSchema,
  createDesignResourceRequestSchema,
  createDesignTagRequestSchema,
  createDesignTemplateRequestSchema,
  createDesignTextPresetRequestSchema,
  deleteDesignCatalogEntryRequestSchema,
  restoreDesignCatalogEntryRequestSchema,
  setDesignCatalogStatusRequestSchema,
  updateDesignCategoryRequestSchema,
  updateDesignFontFaceRequestSchema,
  updateDesignFontFamilyRequestSchema,
  updateDesignResourceRequestSchema,
  updateDesignTagRequestSchema,
  updateDesignTemplateRequestSchema,
  updateDesignTextPresetRequestSchema,
} from "@loomic/shared";

import type { DesignCatalogAdminService } from "../features/design-resources/design-catalog-admin-service.js";
import {
  DesignResourceImportError,
  inspectImportBuffer,
} from "../features/design-resources/design-resource-import-service.js";
import { DesignResourceServiceError } from "../features/design-resources/design-resource-service.js";
import {
  type UploadService,
  UploadServiceError,
} from "../features/uploads/upload-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

export async function registerDesignCatalogAdminRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    service: DesignCatalogAdminService;
    uploadService?: UploadService | undefined;
  },
) {
  app.post("/api/admin/design-catalog/font-files", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthorized(reply);
      if (!options.uploadService)
        throw new DesignResourceServiceError(
          "resource_query_failed",
          "Font upload is unavailable.",
          503,
        );
      const file = await request.file();
      if (!file)
        throw new DesignResourceServiceError(
          "resource_invalid",
          "Font file is required.",
          400,
        );
      const workspaceId = z
        .string()
        .uuid()
        .parse(multipartField(file.fields, "workspace_id"));
      const buffer = await file.toBuffer();
      if (buffer.length > 10 * 1024 * 1024)
        throw new DesignResourceServiceError(
          "resource_invalid",
          "Font file exceeds 10 MB.",
          400,
        );
      const inspected = await inspectImportBuffer(buffer, file.mimetype);
      if (inspected.kind !== "font")
        throw new DesignResourceServiceError(
          "resource_invalid",
          "The uploaded file is not a supported font.",
          400,
        );
      const uploaded = await options.uploadService.uploadFile(user, {
        bucket: "workspace-assets",
        fileName: file.filename,
        fileBuffer: buffer,
        mimeType: inspected.mimeType,
        workspaceId,
      });
      return reply.code(201).send({
        asset_object_id: uploaded.asset.id,
        family_name: inspected.familyName,
        style: inspected.style,
        weight: inspected.weight,
        format: inspected.format,
        checksum_sha256: inspected.sha256,
        allow_web_embed: inspected.webEmbedAllowed,
      });
    } catch (error) {
      return sendError(error, reply);
    }
  });
  app.post<{ Params: { collection: string } }>(
    "/api/admin/design-catalog/:collection",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const config = collectionConfig(request.params.collection);
        const input = config.create.parse(request.body) as Record<
          string,
          unknown
        >;
        const { request_id, scope, workspace_id, ...payload } = input;
        return reply.code(201).send(
          await options.service.create(user, {
            request_id: String(request_id),
            entity_kind: config.kind,
            scope: scope as "platform" | "workspace",
            workspace_id: workspace_id as string | null,
            payload,
          }),
        );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
  app.patch<{ Params: { collection: string; entityId: string } }>(
    "/api/admin/design-catalog/:collection/:entityId",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const config = collectionConfig(request.params.collection);
        const input = config.update.parse({
          ...(request.body as Record<string, unknown>),
          [config.updateIdKey]: request.params.entityId,
        }) as Record<string, unknown>;
        const {
          request_id,
          entity_id,
          resource_id,
          expected_revision,
          ...patch
        } = input;
        return reply.code(200).send(
          await options.service.update(user, {
            request_id: String(request_id),
            entity_kind: config.kind,
            entity_id: String(entity_id ?? resource_id),
            expected_revision: Number(expected_revision),
            patch,
          }),
        );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
  app.get<{ Params: { collection: string; entityId: string } }>(
    "/api/admin/design-catalog/:collection/:entityId/references",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const config = collectionConfig(request.params.collection);
        return reply
          .code(200)
          .send(
            await options.service.references(
              user,
              config.kind,
              request.params.entityId,
            ),
          );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
  app.get<{ Params: { collection: string; entityId: string } }>(
    "/api/admin/design-catalog/:collection/:entityId/preview-url",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const config = collectionConfig(request.params.collection);
        return reply
          .code(200)
          .send(
            await options.service.previewUrl(
              user,
              config.kind,
              request.params.entityId,
            ),
          );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
  app.post("/api/admin/design-catalog/status", async (request, reply) =>
    run(request, reply, options, "status"),
  );
  app.post("/api/admin/design-catalog/delete", async (request, reply) =>
    run(request, reply, options, "delete"),
  );
  app.post("/api/admin/design-catalog/restore", async (request, reply) =>
    run(request, reply, options, "restore"),
  );
}

function collectionConfig(value: string) {
  const configs = {
    "text-presets": {
      kind: "text_preset",
      updateIdKey: "entity_id",
      create: createDesignTextPresetRequestSchema,
      update: updateDesignTextPresetRequestSchema,
    },
    "font-families": {
      kind: "font_family",
      updateIdKey: "entity_id",
      create: createDesignFontFamilyRequestSchema,
      update: updateDesignFontFamilyRequestSchema,
    },
    "font-faces": {
      kind: "font_face",
      updateIdKey: "entity_id",
      create: createDesignFontFaceRequestSchema,
      update: updateDesignFontFaceRequestSchema,
    },
    categories: {
      kind: "category",
      updateIdKey: "entity_id",
      create: createDesignCategoryRequestSchema,
      update: updateDesignCategoryRequestSchema,
    },
    tags: {
      kind: "tag",
      updateIdKey: "entity_id",
      create: createDesignTagRequestSchema,
      update: updateDesignTagRequestSchema,
    },
    resources: {
      kind: "resource",
      updateIdKey: "resource_id",
      create: createDesignResourceRequestSchema,
      update: updateDesignResourceRequestSchema,
    },
    templates: {
      kind: "template",
      updateIdKey: "entity_id",
      create: createDesignTemplateRequestSchema,
      update: updateDesignTemplateRequestSchema,
    },
  } as const;
  const config = configs[value as keyof typeof configs];
  if (!config)
    throw new DesignResourceServiceError(
      "resource_invalid",
      "Unknown catalog collection.",
      400,
    );
  return config;
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    error: {
      code: "unauthorized",
      message: "Missing or invalid bearer token.",
    },
  });
}

function multipartField(fields: Record<string, unknown>, name: string) {
  const value = fields[name];
  return typeof value === "object" && value !== null && "value" in value
    ? String(value.value)
    : undefined;
}

async function run(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { auth: RequestAuthenticator; service: DesignCatalogAdminService },
  operation: "status" | "delete" | "restore",
) {
  try {
    const user = await options.auth.authenticate(request);
    if (!user) return unauthorized(reply);
    const result =
      operation === "status"
        ? await options.service.setStatus(
            user,
            setDesignCatalogStatusRequestSchema.parse(request.body),
          )
        : await options.service.setDeleted(
            user,
            (operation === "delete"
              ? deleteDesignCatalogEntryRequestSchema
              : restoreDesignCatalogEntryRequestSchema
            ).parse(request.body),
            operation === "delete",
          );
    return reply.code(200).send(result);
  } catch (error) {
    return sendError(error, reply);
  }
}

function sendError(error: unknown, reply: FastifyReply) {
  if (typeof error === "object" && error !== null && "issues" in error)
    return reply.code(400).send({
      error: { code: "resource_invalid", message: "Invalid request." },
    });
  if (error instanceof DesignResourceServiceError)
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof UploadServiceError)
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof DesignResourceImportError)
    return reply
      .code(error.retryable ? 503 : 400)
      .send({ error: { code: error.code, message: error.message } });
  return reply.code(500).send({
    error: {
      code: "resource_write_failed",
      message: "Internal server error.",
    },
  });
}
