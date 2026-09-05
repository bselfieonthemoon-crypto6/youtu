import type { FastifyInstance, FastifyReply } from "fastify";

import {
  designConflictResponseSchema,
  designErrorResponseSchema,
  designExportRequestSchema,
  designUuidSchema,
  jobResponseSchema,
  queueDesignPreviewRequestSchema,
  queueDesignPreviewResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import {
  DesignExportError,
  type DesignExportService,
} from "../features/designs/design-export-service.js";
import {
  DesignPreviewError,
  type DesignPreviewService,
} from "../features/designs/design-preview-service.js";
import { DesignServiceError } from "../features/designs/design-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

export async function registerDesignAsyncRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    previewService: Pick<DesignPreviewService, "enqueue">;
    exportService: Pick<DesignExportService, "enqueue">;
  },
) {
  app.post<{ Params: { designId: string } }>(
    "/api/designs/:designId/preview",
    async (request, reply) => {
      let designId: string | undefined;
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        designId = designUuidSchema.parse(request.params.designId);
        const input = queueDesignPreviewRequestSchema.parse(request.body);
        assertMatchingDesignId(designId, input.design_id);
        const result = queueDesignPreviewResponseSchema.parse(
          await options.previewService.enqueue({
            designId,
            expectedRevision: input.expected_revision,
            idempotencyKey: input.idempotency_key,
            actorUserId: user.id,
          }),
        );
        return reply.code(result.status === "queued" ? 202 : 200).send(result);
      } catch (error) {
        return sendAsyncDesignError(error, reply, designId);
      }
    },
  );

  app.post<{ Params: { designId: string } }>(
    "/api/designs/:designId/exports",
    async (request, reply) => {
      let designId: string | undefined;
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        designId = designUuidSchema.parse(request.params.designId);
        const input = designExportRequestSchema.parse(request.body);
        assertMatchingDesignId(designId, input.design_id);
        const job = await options.exportService.enqueue(user, input);
        return reply.code(202).send(jobResponseSchema.parse({ job }));
      } catch (error) {
        return sendAsyncDesignError(error, reply, designId);
      }
    },
  );
}

function assertMatchingDesignId(pathId: string, bodyId: string) {
  if (pathId !== bodyId) {
    throw new DesignServiceError(
      "design_invalid",
      "Path design ID does not match the request body.",
      400,
    );
  }
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function sendAsyncDesignError(
  error: unknown,
  reply: FastifyReply,
  designId?: string,
) {
  if (isZodError(error)) {
    return sendDesignError(reply, 400, "design_invalid", "Invalid request.");
  }
  if (error instanceof DesignPreviewError) {
    if (error.code === "design_conflict") {
      if (!designId) {
        return sendDesignError(
          reply,
          500,
          "design_write_failed",
          "Internal server error.",
        );
      }
      return sendDesignConflict(
        reply,
        error.message,
        designId,
        error.latestRevision ?? 0,
      );
    }
    return sendDesignError(reply, error.statusCode, error.code, error.message);
  }
  if (error instanceof DesignExportError) {
    if (error.code === "design_export_revision_conflict" && error.conflict) {
      return sendDesignConflict(
        reply,
        error.message,
        error.conflict.designId,
        error.conflict.latestRevision,
      );
    }
    return sendDesignError(
      reply,
      error.statusCode,
      "design_invalid",
      error.message,
    );
  }
  if (error instanceof DesignServiceError) {
    if (error.code === "design_conflict") {
      if (error.conflict?.designId) {
        return sendDesignConflict(
          reply,
          error.message,
          error.conflict.designId,
          error.conflict.latestRevision,
        );
      }
      return sendDesignError(
        reply,
        500,
        "design_write_failed",
        "Internal server error.",
      );
    }
    return sendDesignError(reply, error.statusCode, error.code, error.message);
  }
  return sendDesignError(
    reply,
    500,
    "design_write_failed",
    "Internal server error.",
  );
}

function sendDesignError(
  reply: FastifyReply,
  statusCode: number,
  code:
    | "design_not_found"
    | "design_forbidden"
    | "design_invalid"
    | "design_create_failed"
    | "design_query_failed"
    | "design_write_failed",
  message: string,
) {
  return reply.code(statusCode).send(
    designErrorResponseSchema.parse({
      error: { code, message },
    }),
  );
}

function sendDesignConflict(
  reply: FastifyReply,
  message: string,
  designId: string,
  latestRevision: number,
) {
  return reply.code(409).send(
    designConflictResponseSchema.parse({
      error: {
        code: "DESIGN_CONFLICT",
        message,
        design_id: designId,
        latest_revision: latestRevision,
        conflict_object_ids: [],
        retryable: false,
      },
    }),
  );
}

function isZodError(
  error: unknown,
): error is { issues: unknown[]; name: string } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}
