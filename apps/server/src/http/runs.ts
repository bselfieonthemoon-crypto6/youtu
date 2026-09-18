import type { FastifyInstance, FastifyReply } from "fastify";
import { resolveChatSelection } from "../features/providers/resolve-chat-selection.js";

import {
  applicationErrorResponseSchema,
  runCancelResponseSchema,
  runCreateRequestSchema,
  runCreateResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import type { AgentRunService } from "../agent/runtime.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  AgentRunPersistenceError,
  type AgentRunMetadataService,
} from "../features/agent-runs/agent-run-service.js";
import {
  ThreadServiceError,
  type ThreadService,
} from "../features/chat/thread-service.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import type { ProviderSnapshotService, WorkspaceModelCatalogService } from "../features/providers/index.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";

export async function registerRunRoutes(
  app: FastifyInstance,
  agentRuns: AgentRunService,
  options: {
    agentRunMetadataService?: AgentRunMetadataService;
    auth?: RequestAuthenticator;
    settingsService?: SettingsService;
    threadService?: ThreadService;
    viewerService?: ViewerService;
    providerSnapshotService?: ProviderSnapshotService;
    workspaceModelCatalogService?: WorkspaceModelCatalogService;
  } = {},
) {
  app.post("/api/agent/runs", async (request, reply) => {
    try {
      const payload = runCreateRequestSchema.parse(request.body);
      const authenticatedUser = options.auth
        ? await options.auth.authenticate(request)
        : null;

      if (!authenticatedUser) {
        return sendUnauthorized(reply);
      }

      const sessionThread =
        options?.threadService
          ? await options.threadService.resolveOwnedSessionThread(
              authenticatedUser,
              payload.sessionId,
            )
          : null;

      // Resolve per-workspace model if auth context is available
      let configuredDefaultModel: string | undefined;
      let workspaceId: string | undefined;
      if (
        authenticatedUser &&
        options.settingsService &&
        options.viewerService
      ) {
        try {
          const viewer =
            await options.viewerService.ensureViewer(authenticatedUser);
          workspaceId = viewer.workspace.id;
          const settings = await options.settingsService.getWorkspaceSettings(
            authenticatedUser,
            viewer.workspace.id,
          );
          configuredDefaultModel = settings.defaultModel;
        } catch {
          // Fall through to server default model if settings lookup fails
        }
      }

      let resolvedModel: string | undefined;
      if (!workspaceId && options.viewerService) {
        try {
          workspaceId = (await options.viewerService.ensureViewer(authenticatedUser)).workspace.id;
        } catch {
          // Workspace-bound models fail closed below; legacy models may continue.
        }
      }
      try {
        resolvedModel = await resolveChatSelection({ user: authenticatedUser,
          ...(workspaceId ? { workspaceId } : {}),
          ...(payload.model ? { requested: payload.model } : {}),
          ...(configuredDefaultModel ? { defaultModel: configuredDefaultModel } : {}),
          ...(options.workspaceModelCatalogService ? { catalog: options.workspaceModelCatalogService } : {}),
        });
      } catch {
          return reply.code(422).send(applicationErrorResponseSchema.parse({
            error: { code: "model_not_accessible", message: "The selected text model is not available in this workspace." },
          }));
      }
      let routedPayload;
      try { routedPayload = typeof agentRuns.routeTaskSubmission === "function"
        ? await agentRuns.routeTaskSubmission(payload, authenticatedUser.id) : payload; }
      catch (error) {
        // Keep the client message generic, but never hide a real backend
        // failure from server logs: "task changed" and an outage look identical
        // to the caller otherwise.
        request.log.error({ err: error }, "design task routing failed");
        return reply.code(409).send({ error: { code: "design_task_rejected", message: "Current task changed; the follow-up was not submitted." } });
      }
      const response = runCreateResponseSchema.parse(
        agentRuns.createRun(routedPayload, {
          accessToken: authenticatedUser.accessToken,
          userId: authenticatedUser.id,
          ...(workspaceId ? { workspaceId } : {}),
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(sessionThread ? { threadId: sessionThread.threadId } : {}),
        }),
      );

      if (sessionThread && options.agentRunMetadataService) {
        try {
          await options.agentRunMetadataService.createAcceptedRun({
          createdBy: authenticatedUser.id,
          executionMode: payload.executionMode ?? "fast",
          ...(resolvedModel ? { model: resolvedModel } : {}),
          prompt: payload.prompt,
          ...(payload.userMessageId ? { requestMessageId: payload.userMessageId } : {}),
          runId: response.runId,
          sessionId: payload.sessionId,
          threadId: sessionThread.threadId,
          });
        } catch (error) {
          // The in-memory run must not survive a rejected durable request.
          agentRuns.cancelRun(response.runId, authenticatedUser.id);
          throw error;
        }
      }

      if (resolvedModel?.startsWith("workspace:")) {
        if (!workspaceId || !sessionThread || !options.agentRunMetadataService || !options.providerSnapshotService) {
          agentRuns.cancelRun(response.runId, authenticatedUser.id);
          return reply.code(503).send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "provider_snapshot_unavailable",
                message: "Workspace model execution is unavailable.",
              },
            }),
          );
        }
        try {
          await options.providerSnapshotService.createRunSnapshot({
            workspaceId,
            runId: response.runId,
            modelRef: resolvedModel,
          });
        } catch {
          agentRuns.cancelRun(response.runId, authenticatedUser.id);
          await options.agentRunMetadataService.updateRun({
            runId: response.runId,
            status: "failed",
            completedAt: new Date().toISOString(),
            errorCode: "provider_snapshot_invalid",
            errorMessage: "Workspace model execution could not be prepared.",
          }).catch(() => undefined);
          return reply.code(409).send(
            applicationErrorResponseSchema.parse({
              error: {
                code: "provider_snapshot_invalid",
                message: "Workspace model execution could not be prepared.",
              },
            }),
          );
        }
      }

      return reply.code(202).send(response);
    } catch (error) {
      if (error instanceof ThreadServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: error.code,
              message: error.message,
            },
          }),
        );
      }

      if (error instanceof AgentRunPersistenceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: error.code,
              message: error.message,
            },
          }),
        );
      }

      return handleZodError(error, reply);
    }
  });

  app.get("/api/chat/sessions/:sessionId/runs", async (request, reply) => {
    const authenticatedUser = options.auth
      ? await options.auth.authenticate(request)
      : null;
    if (!authenticatedUser) return sendUnauthorized(reply);
    if (!options.threadService || !options.agentRunMetadataService) {
      return sendHistoryError(
        reply,
        503,
        "application_error",
        "Run history is unavailable.",
      );
    }

    const { sessionId } = request.params as { sessionId: string };
    const query = request.query as { cursor?: unknown; limit?: unknown };
    try {
      await options.threadService.resolveOwnedSessionThread(authenticatedUser, sessionId);
      const parsedLimit = query.limit === undefined ? undefined : Number(query.limit);
      if (
        parsedLimit !== undefined &&
        (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50)
      ) {
        return sendHistoryError(
          reply,
          400,
          "application_error",
          "Invalid limit.",
        );
      }
      if (
        query.cursor !== undefined &&
        (typeof query.cursor !== "string" || query.cursor.trim().length === 0)
      ) {
        return sendHistoryError(
          reply,
          400,
          "application_error",
          "Invalid run history cursor.",
        );
      }
      const page = await options.agentRunMetadataService.listSessionRuns(sessionId, {
        ...(typeof query.cursor === "string" ? { cursor: query.cursor } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      });
      return reply.code(200).send(page);
    } catch (error) {
      if (error instanceof ThreadServiceError) return sendRunNotFound(reply);
      if (error instanceof AgentRunPersistenceError) {
        return sendHistoryError(
          reply,
          error.statusCode,
          "application_error",
          error.message,
        );
      }
      console.error("[run-history] Failed to list session runs:", error);
      return sendHistoryError(
        reply,
        500,
        "application_error",
        "Run history request failed.",
      );
    }
  });

  app.get("/api/chat/sessions/:sessionId/runs/:runId", async (request, reply) => {
    const authenticatedUser = options.auth
      ? await options.auth.authenticate(request)
      : null;
    if (!authenticatedUser) return sendUnauthorized(reply);
    if (!options.threadService || !options.agentRunMetadataService) {
      return sendHistoryError(
        reply,
        503,
        "application_error",
        "Run history is unavailable.",
      );
    }

    const { runId, sessionId } = request.params as {
      runId: string;
      sessionId: string;
    };
    try {
      await options.threadService.resolveOwnedSessionThread(
        authenticatedUser,
        sessionId,
      );
      const runSessionId =
        await options.agentRunMetadataService.getRunSessionId(runId);
      if (!runSessionId || runSessionId !== sessionId) {
        return sendRunNotFound(reply);
      }
      const run = await options.agentRunMetadataService.getRunDetail(
        runId,
        sessionId,
      );
      if (!run) return sendRunNotFound(reply);
      return reply.code(200).send({ run });
    } catch (error) {
      if (error instanceof ThreadServiceError) return sendRunNotFound(reply);
      if (error instanceof AgentRunPersistenceError) {
        return sendHistoryError(
          reply,
          error.statusCode,
          "application_error",
          error.message,
        );
      }
      console.error("[run-history] Failed to get run detail:", error);
      return sendHistoryError(
        reply,
        500,
        "application_error",
        "Run history request failed.",
      );
    }
  });

  app.post("/api/agent/runs/:runId/cancel", async (request, reply) => {
    const authenticatedUser = options.auth
      ? await options.auth.authenticate(request)
      : null;
    if (!authenticatedUser) {
      return sendUnauthorized(reply);
    }

    const { runId } = request.params as { runId: string };
    const canceledRun = agentRuns.cancelRun(runId, authenticatedUser.id);

    if (!canceledRun) {
      return sendRunNotFound(reply);
    }

    await options.agentRunMetadataService?.updateRun({
      completedAt: new Date().toISOString(),
      runId,
      status: "canceled",
    });

    const response = runCancelResponseSchema.parse(canceledRun);
    return reply.code(202).send(response);
  });
}

function sendRunNotFound(reply: FastifyReply) {
  return sendHistoryError(
    reply,
    404,
    "session_not_found",
    "Run not found or access denied.",
  );
}

function sendHistoryError(
  reply: FastifyReply,
  statusCode: number,
  code: "application_error" | "session_not_found",
  message: string,
) {
  return reply.code(statusCode).send(
    applicationErrorResponseSchema.parse({
      error: { code, message },
    }),
  );
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

function handleZodError(error: unknown, reply: FastifyReply) {
  if (isZodError(error)) {
    return reply.code(400).send({
      issues: error.issues,
      message: "Invalid request body",
    });
  }

  throw error;
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
