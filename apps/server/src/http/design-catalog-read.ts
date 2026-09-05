import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { designUuidSchema } from "@loomic/shared";

import type { DesignCatalogReadService } from "../features/design-resources/design-catalog-read-service.js";
import { DesignResourceServiceError } from "../features/design-resources/design-resource-service.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import { UploadServiceError } from "../features/uploads/upload-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const listSchema = z
  .object({
    scope: z.enum(["platform", "workspace"]).optional(),
    query: z.string().trim().max(200).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
const adminListSchema = listSchema.extend({
  deleted: z.enum(["false", "true", "all"]).optional(),
});

export async function registerDesignCatalogReadRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    catalogService: DesignCatalogReadService;
    uploadService: UploadService;
  },
) {
  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/api/design-text-presets",
    async (request, reply) => list(request, reply, options, "presets"),
  );
  app.get<{ Params: { presetId: string } }>(
    "/api/design-text-presets/:presetId",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        return reply
          .code(200)
          .send(
            await options.catalogService.getTextPreset(
              user,
              designUuidSchema.parse(request.params.presetId),
            ),
          );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
  app.get<{ Params: { presetId: string } }>(
    "/api/design-text-presets/:presetId/preview",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const detail = await options.catalogService.getTextPreset(
          user,
          designUuidSchema.parse(request.params.presetId),
        );
        if (!detail.preset.preview_asset_object_id)
          return reply.code(404).send({
            error: {
              code: "resource_not_found",
              message: "Preview not found.",
            },
          });
        return sendAsset(
          reply,
          await options.uploadService.getAssetContent(
            user,
            detail.preset.preview_asset_object_id,
            { preview: true },
          ),
        );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/api/design-fonts",
    async (request, reply) => list(request, reply, options, "fonts"),
  );
  for (const collection of [
    "text-presets",
    "font-families",
    "font-faces",
    "categories",
    "tags",
  ] as const) {
    app.get<{ Querystring: Record<string, string | undefined> }>(
      `/api/admin/design-catalog/${collection}`,
      async (request, reply) => {
        try {
          const user = await options.auth.authenticate(request);
          if (!user) return unauthorized(reply);
          const raw = adminListSchema.parse(request.query);
          const { deleted, ...base } = raw;
          const input = {
            ...base,
            deleted:
              deleted === "all"
                ? ("all" as const)
                : deleted === "true"
                  ? ("only" as const)
                  : ("exclude" as const),
          };
          const result =
            collection === "text-presets"
              ? await options.catalogService.listTextPresets(user, input)
              : collection === "font-families"
                ? await options.catalogService.listFonts(user, input)
                : collection === "font-faces"
                  ? await options.catalogService.listFontFaces(user, input)
                  : collection === "categories"
                    ? await options.catalogService.listCategories(user, input)
                    : await options.catalogService.listTags(user, input);
          return reply.code(200).send(result);
        } catch (error) {
          return sendError(error, reply);
        }
      },
    );
  }
  app.get<{ Params: { familyId: string } }>(
    "/api/design-fonts/:familyId",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        return reply
          .code(200)
          .send(
            await options.catalogService.getFont(
              user,
              designUuidSchema.parse(request.params.familyId),
            ),
          );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
  app.get<{ Params: { faceId: string } }>(
    "/api/design-fonts/faces/:faceId/content",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const face = await options.catalogService.getFontFace(
          user,
          designUuidSchema.parse(request.params.faceId),
        );
        if (!face.allow_web_embed)
          return reply.code(403).send({
            error: {
              code: "resource_forbidden",
              message: "Font embedding is not permitted.",
            },
          });
        return sendAsset(
          reply,
          await options.uploadService.getAssetContent(
            user,
            face.asset_object_id,
          ),
          true,
        );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
}

async function list(
  request: FastifyRequest<{ Querystring: Record<string, string | undefined> }>,
  reply: FastifyReply,
  options: {
    auth: RequestAuthenticator;
    catalogService: DesignCatalogReadService;
  },
  kind: "presets" | "fonts",
) {
  try {
    const user = await options.auth.authenticate(request);
    if (!user) return unauthorized(reply);
    const input = listSchema.parse(request.query);
    const result =
      kind === "presets"
        ? await options.catalogService.listTextPresets(user, input)
        : await options.catalogService.listFonts(user, input);
    return reply.code(200).send(result);
  } catch (error) {
    return sendError(error, reply);
  }
}

function sendAsset(
  reply: FastifyReply,
  content: { buffer: Buffer; mimeType: string },
  font = false,
) {
  reply.header("content-type", content.mimeType);
  reply.header("cache-control", "private, max-age=900");
  if (font) reply.header("x-content-type-options", "nosniff");
  return reply.code(200).send(content.buffer);
}
function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    error: {
      code: "unauthorized",
      message: "Missing or invalid bearer token.",
    },
  });
}
function sendError(error: unknown, reply: FastifyReply) {
  if (typeof error === "object" && error !== null && "issues" in error)
    return reply.code(400).send({
      error: { code: "resource_invalid", message: "Invalid request." },
    });
  if (
    error instanceof DesignResourceServiceError ||
    error instanceof UploadServiceError
  )
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  return reply.code(500).send({
    error: {
      code: "resource_query_failed",
      message: "Internal server error.",
    },
  });
}
