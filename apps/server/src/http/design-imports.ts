import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  createDesignImportRequestSchema,
  designUuidSchema,
} from "@loomic/shared";

import type { DesignImportApiService } from "../features/design-resources/design-import-api-service.js";
import { DesignResourceServiceError } from "../features/design-resources/design-resource-service.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import {
  ImportDirectoryError,
  readImportDirectory,
} from "../security/safe-import-directory.js";
import { SafeZipError, readSafeZip } from "../security/safe-zip.js";
import type { RequestAuthenticator } from "../supabase/user.js";

const listSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    items: z
      .array(
        z
          .object({
            source_key: z.string().trim().min(1).max(500),
            entity_kind: z.enum([
              "resource",
              "template",
              "text_preset",
              "font_family",
              "font_face",
              "category",
              "tag",
            ]),
            path: z.string().min(1).optional(),
            source_url: z.string().url().optional(),
            depends_on: z
              .array(z.string().trim().min(1).max(500))
              .max(100)
              .optional(),
            payload: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const directoryImportSchema = z
  .object({
    request_id: z.string().uuid().optional(),
    scope: z.literal("workspace"),
    workspace_id: z.string().uuid(),
    source_kind: z.literal("server_directory"),
    directory_path: z.string().trim().min(1).max(4_096),
  })
  .strict();

export async function registerDesignImportRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    service: DesignImportApiService;
    uploadService: UploadService;
    importRoot?: string | undefined;
  },
) {
  app.post("/api/admin/design-catalog/imports", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthorized(reply);
      if (request.isMultipart?.())
        return reply
          .code(202)
          .send(await createMultipartImport(request, user, options));
      if (
        typeof request.body === "object" &&
        request.body !== null &&
        "source_kind" in request.body &&
        request.body.source_kind === "server_directory"
      ) {
        const input = directoryImportSchema.parse(request.body);
        const entries = await readImportDirectory(
          options.importRoot,
          input.directory_path,
        );
        return reply.code(202).send(
          await createEntriesImport(entries, user, options, {
            requestId: String(input.request_id ?? randomUUID()),
            workspaceId: String(input.workspace_id),
          }),
        );
      }
      const parsed = createDesignImportRequestSchema.parse(request.body);
      if (parsed.source_kind === "manifest_inline")
        return reply.code(202).send(
          await options.service.enqueueManifest(user, {
            request_id: parsed.request_id,
            scope: parsed.scope,
            workspace_id: parsed.workspace_id,
            items: parsed.manifest.items.map((item) => ({
              source_key: item.source_key,
              entity_kind: item.entity_kind,
              asset_object_id: item.asset_object_id ?? null,
              metadata: {
                ...(item.depends_on ? { depends_on: item.depends_on } : {}),
                ...(item.payload ? { payload: item.payload } : {}),
                ...(item.source_url ? { source_url: item.source_url } : {}),
              },
            })),
          }),
        );
      return reply.code(202).send(await options.service.create(user, parsed));
    } catch (error) {
      return sendError(error, reply);
    }
  });
  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/api/admin/design-catalog/imports",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return unauthorized(reply);
        return reply
          .code(200)
          .send(
            await options.service.list(user, listSchema.parse(request.query)),
          );
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
  app.get<{ Params: { jobId: string } }>(
    "/api/admin/design-catalog/imports/:jobId",
    async (request, reply) => detail(request, reply, options),
  );
  app.get<{ Params: { jobId: string } }>(
    "/api/admin/design-catalog/imports/:jobId/report",
    async (request, reply) => detail(request, reply, options),
  );
  for (const action of ["cancel", "retry"] as const) {
    app.post<{ Params: { jobId: string } }>(
      `/api/admin/design-catalog/imports/:jobId/${action}`,
      async (request, reply) => {
        try {
          const user = await options.auth.authenticate(request);
          if (!user) return unauthorized(reply);
          const id = designUuidSchema.parse(request.params.jobId);
          return reply.code(200).send(await options.service[action](user, id));
        } catch (error) {
          return sendError(error, reply);
        }
      },
    );
  }
}

async function createMultipartImport(
  request: FastifyRequest,
  user: NonNullable<Awaited<ReturnType<RequestAuthenticator["authenticate"]>>>,
  options: { service: DesignImportApiService; uploadService: UploadService },
) {
  const file = await request.file();
  if (!file)
    throw new DesignResourceServiceError(
      "resource_invalid",
      "Import package is required.",
      400,
    );
  const workspaceId = designUuidSchema.parse(
    field(file.fields, "workspace_id"),
  );
  const requestId = designUuidSchema.parse(
    field(file.fields, "request_id") ?? randomUUID(),
  );
  const buffer = await file.toBuffer();
  const isZip =
    file.mimetype === "application/zip" ||
    file.filename.toLowerCase().endsWith(".zip");
  const entries = isZip
    ? await readSafeZip(buffer)
    : [{ path: file.filename, data: buffer }];
  return createEntriesImport(entries, user, options, {
    requestId,
    workspaceId,
    allowSingleJsonManifest: !isZip,
  });
}

async function createEntriesImport(
  entries: Array<{ path: string; data: Buffer }>,
  user: NonNullable<Awaited<ReturnType<RequestAuthenticator["authenticate"]>>>,
  options: { service: DesignImportApiService; uploadService: UploadService },
  identifiers: {
    requestId: string;
    workspaceId: string;
    allowSingleJsonManifest?: boolean;
  },
) {
  const { requestId, workspaceId, allowSingleJsonManifest } = identifiers;
  const manifestEntry =
    entries.find((entry) => /(^|\/)manifest\.json$/i.test(entry.path)) ??
    (allowSingleJsonManifest &&
    entries.length === 1 &&
    entries[0]?.path.toLowerCase().endsWith(".json")
      ? entries[0]
      : undefined);
  if (!manifestEntry)
    throw new DesignResourceServiceError(
      "resource_invalid",
      "A version 1 manifest.json is required.",
      400,
    );
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(
      JSON.parse(manifestEntry.data.toString("utf8")),
    );
  } catch {
    throw new DesignResourceServiceError(
      "resource_invalid",
      "Invalid version 1 manifest.",
      400,
    );
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const uploaded: string[] = [];
  try {
    const queuedItems = [] as Parameters<
      DesignImportApiService["enqueueManifest"]
    >[1]["items"];
    for (const item of manifest.items) {
      if (item.path && item.source_url)
        throw new DesignResourceServiceError(
          "resource_invalid",
          "A manifest item cannot use path and source_url together.",
          400,
        );
      let assetObjectId: string | null = null;
      if (item.path) {
        const entry = byPath.get(item.path);
        if (!entry || entry === manifestEntry)
          throw new DesignResourceServiceError(
            "resource_invalid",
            "Manifest path is missing from the package.",
            400,
          );
        const result = await options.uploadService.uploadFile(user, {
          bucket: "workspace-assets",
          fileName: entry.path,
          fileBuffer: entry.data,
          mimeType: mimeFor(entry.path),
          workspaceId,
        });
        assetObjectId = result.asset.id;
        uploaded.push(assetObjectId);
      }
      if (
        ["resource", "font_face"].includes(item.entity_kind) &&
        !assetObjectId &&
        !item.source_url
      )
        throw new DesignResourceServiceError(
          "resource_invalid",
          "Binary manifest items require path or source_url.",
          400,
        );
      const {
        path: _path,
        source_url,
        source_key,
        entity_kind,
        ...metadata
      } = item;
      queuedItems.push({
        source_key,
        entity_kind,
        asset_object_id: assetObjectId,
        metadata: { ...metadata, ...(source_url ? { source_url } : {}) },
      });
    }
    return await options.service.enqueueManifest(user, {
      request_id: requestId,
      scope: "workspace",
      workspace_id: workspaceId,
      items: queuedItems,
    });
  } catch (error) {
    await Promise.allSettled(
      uploaded.map((assetId) =>
        options.uploadService.deleteAsset(user, assetId),
      ),
    );
    throw error;
  }
}

function field(fields: Record<string, unknown>, name: string) {
  const value = fields[name];
  return typeof value === "object" && value !== null && "value" in value
    ? String(value.value)
    : undefined;
}

function mimeFor(path: string) {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  return (
    (
      {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        svg: "image/svg+xml",
        woff2: "font/woff2",
        woff: "font/woff",
        ttf: "font/ttf",
        otf: "font/otf",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}

async function detail(
  request: Parameters<RequestAuthenticator["authenticate"]>[0] & {
    params: { jobId: string };
  },
  reply: FastifyReply,
  options: { auth: RequestAuthenticator; service: DesignImportApiService },
) {
  try {
    const user = await options.auth.authenticate(request);
    if (!user) return unauthorized(reply);
    return reply
      .code(200)
      .send(
        await options.service.get(
          user,
          designUuidSchema.parse(request.params.jobId),
        ),
      );
  } catch (error) {
    return sendError(error, reply);
  }
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
  if (error instanceof DesignResourceServiceError)
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } });
  if (error instanceof SafeZipError)
    return reply.code(400).send({
      error: { code: error.code, message: "Unsafe or invalid ZIP package." },
    });
  if (error instanceof ImportDirectoryError)
    return reply.code(400).send({
      error: { code: error.code, message: "Unsafe import directory." },
    });
  return reply.code(500).send({
    error: {
      code: "resource_query_failed",
      message: "Internal server error.",
    },
  });
}
