import type { FastifyInstance, FastifyReply } from "fastify";

import {
  canvasRevisionConflictResponseSchema,
  copyDesignRequestSchema,
  createDesignRequestSchema,
  createDesignResponseSchema,
  deleteDesignRequestSchema,
  designConflictResponseSchema,
  designErrorResponseSchema,
  designGetResponseSchema,
  designLifecycleResponseSchema,
  manualCanvasImageImportRequestSchema,
  manualCanvasImageImportResponseSchema,
  designMutationRequestSchema,
  designMutationResponseSchema,
  designReferencesResponseSchema,
  designUuidSchema,
  renameDesignRequestSchema,
  restoreDesignRequestSchema,
  undoManualCanvasImageImportRequestSchema,
  undoManualCanvasImageImportResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import {
  type DesignService,
  DesignServiceError,
} from "../features/designs/design-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";

export async function registerDesignRoutes(
  app: FastifyInstance,
  options: { auth: RequestAuthenticator; designService: DesignService },
) {
  app.post("/api/designs", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthorized(reply);
      const input = createDesignRequestSchema.parse(request.body);
      return reply
        .code(201)
        .send(
          createDesignResponseSchema.parse(
            await options.designService.create(user, input),
          ),
        );
    } catch (error) {
      return sendDesignError(error, reply);
    }
  });

  app.get<{ Params: { designId: string } }>(
    "/api/designs/:designId",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const designId = designUuidSchema.parse(request.params.designId);
        return reply.code(200).send(
          designGetResponseSchema.parse({
            design: await options.designService.get(user, designId),
          }),
        );
      } catch (error) {
        return sendDesignError(error, reply);
      }
    },
  );

  app.post<{ Params: { designId: string } }>(
    "/api/designs/:designId/mutations",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const designId = designUuidSchema.parse(request.params.designId);
        const input = designMutationRequestSchema.parse(request.body);
        assertMatchingDesignId(designId, input.design_id);
        return reply
          .code(200)
          .send(
            designMutationResponseSchema.parse(
              await options.designService.mutate(user, input),
            ),
          );
      } catch (error) {
        return sendDesignError(error, reply);
      }
    },
  );

  app.post<{ Params: { designId: string } }>(
    "/api/designs/:designId/canvas-image-imports",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const designId = designUuidSchema.parse(request.params.designId);
        const input = manualCanvasImageImportRequestSchema.parse(request.body);
        assertMatchingDesignId(designId, input.design_id);
        return reply.code(200).send(
          manualCanvasImageImportResponseSchema.parse(
            await options.designService.importCanvasImage(user, input),
          ),
        );
      } catch (error) {
        return sendDesignError(error, reply);
      }
    },
  );

  app.post<{ Params: { designId: string; operationId: string } }>(
    "/api/designs/:designId/canvas-image-imports/:operationId/undo",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const designId = designUuidSchema.parse(request.params.designId);
        const operationId = designUuidSchema.parse(request.params.operationId);
        const input = undoManualCanvasImageImportRequestSchema.parse(
          request.body,
        );
        return reply.code(200).send(
          undoManualCanvasImageImportResponseSchema.parse(
            await options.designService.undoCanvasImageImport(
              user,
              designId,
              operationId,
              input,
            ),
          ),
        );
      } catch (error) {
        return sendDesignError(error, reply);
      }
    },
  );

  app.patch<{ Params: { designId: string } }>(
    "/api/designs/:designId/name",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const designId = designUuidSchema.parse(request.params.designId);
        const input = renameDesignRequestSchema.parse(request.body);
        assertMatchingDesignId(designId, input.design_id);
        return reply
          .code(200)
          .send(
            designLifecycleResponseSchema.parse(
              await options.designService.rename(user, input),
            ),
          );
      } catch (error) {
        return sendDesignError(error, reply);
      }
    },
  );

  app.post<{ Params: { designId: string } }>(
    "/api/designs/:designId/copy",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const designId = designUuidSchema.parse(request.params.designId);
        const input = copyDesignRequestSchema.parse(request.body);
        assertMatchingDesignId(designId, input.source_design_id);
        return reply
          .code(201)
          .send(
            createDesignResponseSchema.parse(
              await options.designService.copy(user, input),
            ),
          );
      } catch (error) {
        return sendDesignError(error, reply);
      }
    },
  );

  app.delete<{ Params: { designId: string } }>(
    "/api/designs/:designId",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const designId = designUuidSchema.parse(request.params.designId);
        const input = deleteDesignRequestSchema.parse(request.body);
        assertMatchingDesignId(designId, input.design_id);
        return reply
          .code(200)
          .send(
            designLifecycleResponseSchema.parse(
              await options.designService.softDelete(user, input),
            ),
          );
      } catch (error) {
        return sendDesignError(error, reply);
      }
    },
  );

  app.post<{ Params: { designId: string } }>(
    "/api/designs/:designId/restore",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const designId = designUuidSchema.parse(request.params.designId);
        const input = restoreDesignRequestSchema.parse(request.body);
        assertMatchingDesignId(designId, input.design_id);
        return reply
          .code(200)
          .send(
            designLifecycleResponseSchema.parse(
              await options.designService.restore(user, input),
            ),
          );
      } catch (error) {
        return sendDesignError(error, reply);
      }
    },
  );

  app.get<{ Params: { designId: string } }>(
    "/api/designs/:designId/references",
    async (request, reply) => {
      try {
        const user = await options.auth.authenticate(request);
        if (!user) return sendUnauthorized(reply);
        const designId = designUuidSchema.parse(request.params.designId);
        return reply
          .code(200)
          .send(
            designReferencesResponseSchema.parse(
              await options.designService.references(user, designId),
            ),
          );
      } catch (error) {
        return sendDesignError(error, reply);
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

function sendDesignError(error: unknown, reply: FastifyReply) {
  if (isZodError(error)) {
    return sendStrictDesignError(
      reply,
      400,
      "design_invalid",
      "Invalid request.",
    );
  }
  if (error instanceof DesignServiceError) {
    if (error.code === "design_conflict") {
      const conflict = error.conflict;
      if (conflict?.canvasId) {
        return reply.code(409).send(
          canvasRevisionConflictResponseSchema.parse({
            error: {
              code: "CANVAS_REVISION_CONFLICT",
              message: error.message,
              canvas_id: conflict.canvasId,
              latest_revision: conflict.latestRevision,
              retryable: conflict.retryable,
            },
          }),
        );
      }
      if (conflict?.designId) {
        return reply.code(409).send(
          designConflictResponseSchema.parse({
            error: {
              code: "DESIGN_CONFLICT",
              message: error.message,
              design_id: conflict.designId,
              latest_revision: conflict.latestRevision,
              conflict_object_ids: conflict.conflictObjectIds,
              retryable: conflict.retryable,
            },
          }),
        );
      }
      return sendStrictDesignError(
        reply,
        500,
        "design_write_failed",
        "Internal server error.",
      );
    }
    return sendStrictDesignError(
      reply,
      error.statusCode,
      error.code,
      error.message,
    );
  }
  return sendStrictDesignError(
    reply,
    500,
    "design_write_failed",
    "Internal server error.",
  );
}

function sendStrictDesignError(
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
  return reply
    .code(statusCode)
    .send(designErrorResponseSchema.parse({ error: { code, message } }));
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
