import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  createDesignResourceRequestSchema,
  designResourceListRequestSchema,
  designUuidSchema,
  recordDesignResourceRecentUseRequestSchema,
} from "@loomic/shared";

import {
  type DesignResourceService,
  DesignResourceServiceError,
} from "../features/design-resources/design-resource-service.js";
import {
  type UploadService,
  UploadServiceError,
} from "../features/uploads/upload-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const deleteCatalogEntrySchema = z
  .object({
    request_id: z.string().uuid(),
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();

export async function registerDesignResourceRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    resourceService: DesignResourceService;
    uploadService: UploadService;
  },
) {
  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/api/design-resources",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const raw = request.query;
        const collection = raw.collection;
        if (
          collection !== undefined &&
          collection !== "favorites" &&
          collection !== "recent"
        ) {
          throw new DesignResourceServiceError(
            "resource_invalid",
            "collection must be favorites or recent.",
            400,
          );
        }
        const workspaceId = raw.workspace_id
          ? designUuidSchema.parse(raw.workspace_id)
          : undefined;
        const input = designResourceListRequestSchema.parse({
          ...(raw.scope ? { scope: raw.scope } : {}),
          ...(raw.kind ? { kind: raw.kind } : {}),
          ...(raw.status ? { status: raw.status } : {}),
          ...(raw.query ? { query: raw.query } : {}),
          ...(raw.category_id ? { category_id: raw.category_id } : {}),
          ...(raw.tag_id ? { tag_id: raw.tag_id } : {}),
          ...(raw.format ? { format: raw.format } : {}),
          ...(raw.aspect_ratio ? { aspect_ratio: raw.aspect_ratio } : {}),
          ...(raw.cursor ? { cursor: raw.cursor } : {}),
          ...(raw.limit ? { limit: Number(raw.limit) } : {}),
        });
        return reply.code(200).send(
          await options.resourceService.list(user, input, {
            ...(collection ? { collection } : {}),
            ...(workspaceId ? { workspaceId } : {}),
          }),
        );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.get<{ Params: { resourceId: string } }>(
    "/api/design-resources/:resourceId",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const id = designUuidSchema.parse(request.params.resourceId);
        return reply
          .code(200)
          .send(await options.resourceService.get(user, id));
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  for (const preview of [false, true]) {
    const suffix = preview ? "preview" : "content";
    app.get<{ Params: { resourceId: string } }>(
      `/api/design-resources/:resourceId/${suffix}`,
      async (request, reply) => {
        try {
          const user = await options.auth.authenticate(request);
          if (!user) return unauthorized(reply);
          const resource = await options.resourceService.get(
            user,
            designUuidSchema.parse(request.params.resourceId),
          );
          const assetId = preview
            ? (resource.preview_asset_object_id ?? resource.asset_object_id)
            : resource.asset_object_id;
          const content = await options.uploadService.getAssetContent(
            user,
            assetId,
            {
              preview,
            },
          );
          return reply
            .header("content-type", content.mimeType)
            .header("content-length", String(content.buffer.length))
            .header("cache-control", "private, max-age=900")
            .code(200)
            .send(content.buffer);
        } catch (error) {
          return sendError(error, reply);
        }
      },
    );
  }

  app.put<{ Params: { resourceId: string } }>(
    "/api/design-resources/:resourceId/favorite",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const resourceId = designUuidSchema.parse(request.params.resourceId);
        return reply.code(200).send(
          await options.resourceService.setFavorite(user, {
            resource_id: resourceId,
            favorite: true,
          }),
        );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.delete<{ Params: { resourceId: string } }>(
    "/api/design-resources/:resourceId/favorite",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const resourceId = designUuidSchema.parse(request.params.resourceId);
        return reply.code(200).send(
          await options.resourceService.setFavorite(user, {
            resource_id: resourceId,
            favorite: false,
          }),
        );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post<{ Params: { resourceId: string } }>(
    "/api/design-resources/:resourceId/recent",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const input = recordDesignResourceRecentUseRequestSchema.parse({
          ...(request.body as Record<string, unknown>),
          resource_id: designUuidSchema.parse(request.params.resourceId),
        });
        return reply
          .code(200)
          .send(await options.resourceService.recordRecentUse(user, input));
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post("/api/admin/design-catalog/resources", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthorized(reply);
      const input = createDesignResourceRequestSchema.parse(request.body);
      return reply
        .code(201)
        .send(await options.resourceService.create(user, input));
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/api/admin/design-catalog/resources",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const raw = request.query;
        const deleted = raw.deleted ?? "false";
        if (!["false", "true", "all"].includes(deleted))
          throw new DesignResourceServiceError(
            "resource_invalid",
            "Invalid deleted filter.",
            400,
          );
        const input = designResourceListRequestSchema.parse({
          ...(raw.scope ? { scope: raw.scope } : {}),
          ...(raw.kind ? { kind: raw.kind } : {}),
          ...(raw.status ? { status: raw.status } : {}),
          ...(raw.query ? { query: raw.query } : {}),
          ...(raw.category_id ? { category_id: raw.category_id } : {}),
          ...(raw.tag_id ? { tag_id: raw.tag_id } : {}),
          ...(raw.format ? { format: raw.format } : {}),
          ...(raw.aspect_ratio ? { aspect_ratio: raw.aspect_ratio } : {}),
          ...(raw.cursor ? { cursor: raw.cursor } : {}),
          ...(raw.limit ? { limit: Number(raw.limit) } : {}),
        });
        return reply.code(200).send(
          await options.resourceService.list(user, input, {
            deleted:
              deleted === "all"
                ? "all"
                : deleted === "true"
                  ? "only"
                  : "exclude",
          }),
        );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.get<{ Params: { resourceId: string } }>(
    "/api/admin/design-catalog/resources/:resourceId/references",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        return reply
          .code(200)
          .send(
            await options.resourceService.references(
              user,
              designUuidSchema.parse(request.params.resourceId),
            ),
          );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.delete<{ Params: { resourceId: string } }>(
    "/api/admin/design-catalog/resources/:resourceId",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        const input = deleteCatalogEntrySchema.parse(request.body);
        await options.resourceService.softDelete(user, {
          resourceId: designUuidSchema.parse(request.params.resourceId),
          requestId: input.request_id,
          expectedRevision: input.expected_revision,
        });
        return reply.code(200).send({ ok: true });
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
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
  if (isZodError(error)) {
    return reply.code(400).send({
      error: { code: "resource_invalid", message: "Invalid request." },
    });
  }
  if (error instanceof DesignResourceServiceError) {
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof UploadServiceError) {
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  }
  return reply.code(500).send({
    error: { code: "resource_write_failed", message: "Internal server error." },
  });
}

function isZodError(error: unknown): error is { name: "ZodError" } {
  return typeof error === "object" && error !== null && "issues" in error;
}
