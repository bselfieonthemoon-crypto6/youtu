import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

import {
  type RunCreateRequest,
  wsCommandSchema,
  wsRpcResponseSchema,
} from "@loomic/shared";
import type {
  ContentBlock,
  PlanBlock,
  StreamEvent,
  ToolBlock,
} from "@loomic/shared";
import type { AgentRunService } from "../agent/runtime.js";
import type { RetryableReadToolExecutor } from "../agent/tools/read-tool-registry.js";
import type { DestructiveConfirmationService } from "../features/agent-actions/destructive-confirmation-service.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import type { ToolExecutionService } from "../features/agent-runs/tool-execution-service.js";
import { ToolExecutionServiceError } from "../features/agent-runs/tool-execution-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CanvasService } from "../features/canvas/canvas-service.js";
import type { ChatService } from "../features/chat/chat-service.js";
import type { ThreadService } from "../features/chat/thread-service.js";
import type { ProviderSnapshotService } from "../features/providers/index.js";
import type { SettingsService } from "../features/settings/settings-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";
import type { ConnectionManager } from "./connection-manager.js";
import type { CanvasEventBuffer } from "./event-buffer.js";
import { createPipelineLogger } from "./logger.js";

type RegisterWsOptions = {
  agentRuns: AgentRunService;
  agentRunMetadataService?: AgentRunMetadataService;
  auth?: RequestAuthenticator;
  chatService?: ChatService;
  canvasService?: CanvasService;
  connectionManager: ConnectionManager;
  destructiveConfirmationService?: DestructiveConfirmationService;
  eventBuffer?: CanvasEventBuffer;
  settingsService?: SettingsService;
  threadService?: ThreadService;
  toolExecutionService?: ToolExecutionService;
  retryReadTool?: RetryableReadToolExecutor;
  viewerService?: ViewerService;
  providerSnapshotService?: ProviderSnapshotService;
};

export async function registerWsRoute(
  app: FastifyInstance,
  options: RegisterWsOptions,
) {
  const { agentRuns, connectionManager } = options;

  app.get(
    "/api/ws",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const token = url.searchParams.get("token");

      if (!token || !options.auth) {
        socket.close(4001, "Unauthorized");
        return;
      }

      void authenticateAndBind(
        socket,
        token,
        request,
        options,
        agentRuns,
        connectionManager,
      );
    },
  );
}

async function authenticateAndBind(
  socket: WebSocket,
  token: string,
  _request: FastifyRequest,
  options: RegisterWsOptions,
  agentRuns: AgentRunService,
  connectionManager: ConnectionManager,
) {
  const log = createPipelineLogger("ws");

  let authenticatedUser: AuthenticatedUser;
  try {
    const fakeRequest = {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as FastifyRequest;
    const user = await options.auth!.authenticate(fakeRequest);
    if (!user) {
      log.warn("auth_rejected", { reason: "invalid_token" });
      socket.close(4001, "Unauthorized");
      return;
    }
    authenticatedUser = user;
    log.info("connected", { userId: user.id });
  } catch (err) {
    log.warn("auth_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    socket.close(4001, "Unauthorized");
    return;
  }

  if (socket.readyState !== 1) return;

  // Use client-provided connectionId for reconnect identity; fallback to server UUID
  const urlForParams = new URL(_request.url, `http://${_request.headers.host}`);
  const connectionId =
    urlForParams.searchParams.get("connectionId") || randomUUID();
  connectionManager.register(connectionId, authenticatedUser.id, socket);

  // Heartbeat with pong timeout (spec §1.3: 60s no-pong → disconnect)
  let lastPong = Date.now();
  socket.on("pong", () => {
    lastPong = Date.now();
  });

  const pingInterval = setInterval(() => {
    if (Date.now() - lastPong > 60_000) {
      log.warn("pong_timeout", { userId: authenticatedUser.id });
      socket.terminate();
      return;
    }
    if (socket.readyState === 1) {
      socket.ping();
    }
  }, 30_000);

  socket.on("message", (raw: Buffer | string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof raw === "string" ? raw : raw.toString("utf-8"),
      );
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const obj = parsed as Record<string, unknown>;

    if (obj.type === "rpc.response") {
      try {
        const rpcResponse = wsRpcResponseSchema.parse(parsed);
        connectionManager.handleRpcResponse(connectionId, {
          type: rpcResponse.type,
          id: rpcResponse.id,
          ...(rpcResponse.result !== undefined
            ? { result: rpcResponse.result }
            : {}),
          ...(rpcResponse.error !== undefined
            ? { error: rpcResponse.error }
            : {}),
        });
      } catch {
        // Ignore malformed RPC responses
      }
      return;
    }

    if (obj.type === "command") {
      let msg;
      try {
        msg = wsCommandSchema.parse(parsed);
      } catch {
        socket.send(
          JSON.stringify({ type: "error", message: "Invalid command format" }),
        );
        return;
      }

      if (msg.action === "agent.run") {
        const p = msg.payload;
        void handleRunCommand(
          authenticatedUser,
          connectionId,
          {
            sessionId: p.sessionId,
            conversationId: p.conversationId,
            prompt: p.prompt,
            ...(p.activeDesignId ? { activeDesignId: p.activeDesignId } : {}),
            ...(p.imageConfirmation
              ? { imageConfirmation: p.imageConfirmation }
              : {}),
            ...(p.canvasId !== undefined ? { canvasId: p.canvasId } : {}),
            ...(p.attachments !== undefined
              ? { attachments: p.attachments }
              : {}),
            ...(p.imageGenerationPreference !== undefined
              ? { imageGenerationPreference: p.imageGenerationPreference }
              : {}),
            ...(p.videoGenerationPreference !== undefined
              ? { videoGenerationPreference: p.videoGenerationPreference }
              : {}),
            ...(p.mentions !== undefined ? { mentions: p.mentions } : {}),
            ...(p.model !== undefined ? { model: p.model } : {}),
            executionMode: "thinking",
          },
          agentRuns,
          connectionManager,
          options,
        );
      } else if (msg.action === "agent.cancel") {
        log.info("run_cancel", {
          userId: authenticatedUser.id,
          runId: msg.payload.runId,
        });
        const cancelResult = agentRuns.cancelRun(
          msg.payload.runId,
          authenticatedUser.id,
        );
        if (!cancelResult) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: `Run not found: ${msg.payload.runId}`,
            }),
          );
        }
      } else if (msg.action === "agent.confirm_action") {
        const canvasId = connectionManager.getEntry(connectionId)?.canvasId;
        const confirmationService = options.destructiveConfirmationService;
        if (!canvasId || !confirmationService) {
          connectionManager.sendTo(connectionId, {
            type: "command.ack",
            action: "agent.confirm_action",
            payload: {
              confirmationId: msg.payload.confirmationId,
              status: "failed",
              code: "confirmation_unavailable",
              message: "当前画布的确认操作不可用，请重新发起。",
            },
          });
          return;
        }
        void handleConfirmedAction(
          authenticatedUser,
          connectionId,
          canvasId,
          msg.payload,
          confirmationService,
          connectionManager,
        );
      } else if (msg.action === "agent.retry_tool") {
        void handleRetryTool(
          authenticatedUser,
          connectionId,
          msg.payload,
          options,
          connectionManager,
        );
      } else if (msg.action === "canvas.resume") {
        const p = msg.payload;
        void resumeOwnedCanvas(
          authenticatedUser,
          connectionId,
          p.canvasId,
          p.lastSeq,
          socket,
          options,
          connectionManager,
          log,
        );
      }
    }
  });

  socket.on("close", () => {
    log.info("disconnected", { userId: authenticatedUser.id, connectionId });
    clearInterval(pingInterval);
    connectionManager.remove(connectionId);
  });

  socket.on("error", () => {
    log.error("socket_error", { userId: authenticatedUser.id, connectionId });
    clearInterval(pingInterval);
    connectionManager.remove(connectionId);
  });
}

async function handleRetryTool(
  user: AuthenticatedUser,
  connectionId: string,
  payload: { toolExecutionId: string; requestId: string },
  services: RegisterWsOptions,
  connectionManager: ConnectionManager,
) {
  const ledger = services.toolExecutionService;
  const execute = services.retryReadTool;
  if (!ledger || !execute || !services.chatService) {
    connectionManager.sendTo(connectionId, {
      type: "error",
      message: "Tool retry is unavailable.",
    });
    return;
  }

  try {
    const context = await ledger.prepareRetry(
      user,
      payload.toolExecutionId,
      payload.requestId,
    );
    const { execution } = context;
    if (!context.isNew) {
      connectionManager.sendTo(connectionId, {
        type: "command.ack",
        action: "agent.retry_tool",
        payload: {
          toolExecutionId: execution.id,
          toolCallId: execution.toolCallId,
          status: execution.status,
        },
      });
      return;
    }

    const started: StreamEvent = {
      type: "tool.started",
      runId: execution.runId,
      toolExecutionId: execution.id,
      toolCallId: execution.toolCallId,
      toolName: execution.toolName,
      ...(execution.input ? { input: execution.input } : {}),
      ...(execution.planId && execution.planStepId
        ? { planId: execution.planId, planStepId: execution.planStepId }
        : {}),
      retryable: true,
      timestamp: new Date().toISOString(),
    };
    services.eventBuffer?.push(context.canvasId, started);
    connectionManager.pushToCanvas(context.canvasId, started);

    let block: ToolBlock;
    try {
      const output = await execute({
        accessToken: user.accessToken,
        canvasId: context.canvasId,
        input: execution.input ?? {},
        threadId: context.threadId,
        toolName: execution.toolName,
        userId: user.id,
      });
      const outputSummary = "Retried inspect_canvas successfully.";
      await ledger.recordCompleted(execution.id, { output, outputSummary });
      const completed: StreamEvent = {
        type: "tool.completed",
        runId: execution.runId,
        toolExecutionId: execution.id,
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        output,
        outputSummary,
        ...(execution.planId && execution.planStepId
          ? { planId: execution.planId, planStepId: execution.planStepId }
          : {}),
        timestamp: new Date().toISOString(),
      };
      services.eventBuffer?.push(context.canvasId, completed);
      connectionManager.pushToCanvas(context.canvasId, completed);
      block = {
        type: "tool",
        toolExecutionId: execution.id,
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        status: "completed",
        ...(execution.input ? { input: execution.input } : {}),
        output,
        outputSummary,
        ...(execution.planId && execution.planStepId
          ? { planId: execution.planId, planStepId: execution.planStepId }
          : {}),
        retryable: true,
      };
    } catch (error) {
      const message = sanitizeErrorForClient(error);
      await ledger.recordFailed(execution.id, {
        code: "tool_failed",
        message,
      });
      const failed: StreamEvent = {
        type: "tool.failed",
        runId: execution.runId,
        toolExecutionId: execution.id,
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        error: { code: "tool_failed", message },
        ...(execution.planId && execution.planStepId
          ? { planId: execution.planId, planStepId: execution.planStepId }
          : {}),
        timestamp: new Date().toISOString(),
      };
      services.eventBuffer?.push(context.canvasId, failed);
      connectionManager.pushToCanvas(context.canvasId, failed);
      block = {
        type: "tool",
        toolExecutionId: execution.id,
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        status: "failed",
        ...(execution.input ? { input: execution.input } : {}),
        ...(execution.planId && execution.planStepId
          ? { planId: execution.planId, planStepId: execution.planStepId }
          : {}),
        retryable: true,
      };
    }

    await services.chatService.createMessage(user, context.sessionId, {
      role: "assistant",
      content: "",
      contentBlocks: [block],
    });
    connectionManager.sendTo(connectionId, {
      type: "command.ack",
      action: "agent.retry_tool",
      payload: {
        toolExecutionId: execution.id,
        toolCallId: execution.toolCallId,
        status: block.status,
      },
    });
  } catch (error) {
    connectionManager.sendTo(connectionId, {
      type: "error",
      message:
        error instanceof ToolExecutionServiceError
          ? error.message
          : "Tool retry failed.",
    });
  }
}

async function handleConfirmedAction(
  user: AuthenticatedUser,
  connectionId: string,
  canvasId: string,
  payload: { confirmationId: string; decision: "confirm" | "cancel" },
  service: DestructiveConfirmationService,
  connectionManager: ConnectionManager,
) {
  try {
    if (payload.decision === "cancel") {
      service.cancel({
        confirmationId: payload.confirmationId,
        userId: user.id,
        canvasId,
      });
      connectionManager.sendTo(connectionId, {
        type: "command.ack",
        action: "agent.confirm_action",
        payload: {
          confirmationId: payload.confirmationId,
          status: "canceled",
        },
      });
      return;
    }

    const confirmationPromise = service.confirm({
      confirmationId: payload.confirmationId,
      userId: user.id,
      canvasId,
    });

    // Validation errors settle immediately. Generation itself may take
    // minutes, so acknowledge once it has been safely claimed instead of
    // keeping the UI waiting for the final image.
    const immediate = await Promise.race([
      confirmationPromise.then(
        (result) => ({ status: "applied" as const, result }),
        (error: unknown) => ({ status: "failed" as const, error }),
      ),
      new Promise<{ status: "accepted" }>((resolve) =>
        setTimeout(() => resolve({ status: "accepted" }), 0),
      ),
    ]);

    if (immediate.status === "failed") throw immediate.error;

    const pushCanvasSync = () =>
      connectionManager.pushToCanvas(canvasId, {
        type: "canvas.sync",
        runId: `confirmation_${payload.confirmationId}`,
        timestamp: new Date().toISOString(),
      });

    if (immediate.status === "accepted") {
      connectionManager.sendTo(connectionId, {
        type: "command.ack",
        action: "agent.confirm_action",
        payload: {
          confirmationId: payload.confirmationId,
          status: "accepted",
        },
      });
      void confirmationPromise
        .then((result) => {
          const resultRecord =
            result && typeof result === "object" && !Array.isArray(result)
              ? (result as Record<string, unknown>)
              : null;
          pushCanvasSync();
          connectionManager.sendTo(connectionId, {
            type: "command.ack",
            action: "agent.confirm_action",
            payload: {
              confirmationId: payload.confirmationId,
              status:
                resultRecord && typeof resultRecord.error === "string"
                  ? "failed"
                  : "applied",
              result:
                result && typeof result === "object"
                  ? result
                  : { value: result ?? null },
            },
          });
        })
        .catch((error) => {
          console.error("[confirmation] Async image generation failed:", error);
          connectionManager.sendTo(connectionId, {
            type: "command.ack",
            action: "agent.confirm_action",
            payload: {
              confirmationId: payload.confirmationId,
              status: "failed",
              code: "confirmation_execution_failed",
              message:
                error instanceof Error
                  ? error.message
                  : "图片生成失败，请重试。",
            },
          });
        });
      return;
    }

    pushCanvasSync();
    connectionManager.sendTo(connectionId, {
      type: "command.ack",
      action: "agent.confirm_action",
      payload: {
        confirmationId: payload.confirmationId,
        status: "applied",
        result:
          immediate.result && typeof immediate.result === "object"
            ? immediate.result
            : { value: immediate.result ?? null },
      },
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "confirmation_failed";
    connectionManager.sendTo(connectionId, {
      type: "command.ack",
      action: "agent.confirm_action",
      payload: {
        confirmationId: payload.confirmationId,
        status: "failed",
        code,
        message:
          error instanceof Error ? error.message : "确认操作失败，请重新发起。",
      },
    });
  }
}

async function resumeOwnedCanvas(
  user: AuthenticatedUser,
  connectionId: string,
  canvasId: string,
  lastSeq: number,
  socket: WebSocket,
  options: RegisterWsOptions,
  connectionManager: ConnectionManager,
  log: ReturnType<typeof createPipelineLogger>,
) {
  try {
    if (!options.canvasService)
      throw new Error("Canvas authorization unavailable");
    await options.canvasService.getCanvas(user, canvasId);
  } catch {
    socket.send(
      JSON.stringify({
        type: "error",
        message: "Canvas not found or access denied",
      }),
    );
    return;
  }

  log.info("canvas_resume", { userId: user.id, canvasId, lastSeq });
  connectionManager.bindCanvas(connectionId, canvasId);

  const missed = options.eventBuffer?.getAfter(canvasId, lastSeq) ?? [];
  const activeRun = connectionManager.getActiveRun(canvasId);
  connectionManager.sendTo(connectionId, {
    type: "command.ack",
    action: "canvas.resume",
    payload: {
      canvasId,
      latestSeq: options.eventBuffer?.getLatestSeq(canvasId) ?? 0,
      activeRunId: activeRun?.runId ?? null,
      replayed: missed.length,
    },
  });

  for (const entry of missed) {
    connectionManager.sendTo(connectionId, {
      type: "event",
      event: entry.event,
    });
  }
}

async function handleRunCommand(
  authenticatedUser: AuthenticatedUser,
  connectionId: string,
  payload: Omit<RunCreateRequest, "accessToken">,
  agentRuns: AgentRunService,
  connectionManager: ConnectionManager,
  services: RegisterWsOptions,
) {
  const log = createPipelineLogger("agent.run", {
    userId: authenticatedUser.id,
    sessionId: payload.sessionId,
  });
  log.info("started", { prompt: payload.prompt.slice(0, 80) });
  let workspaceId: string | undefined;

  if (payload.canvasId) {
    try {
      if (!services.canvasService)
        throw new Error("Canvas authorization unavailable");
      await services.canvasService.getCanvas(
        authenticatedUser,
        payload.canvasId,
      );
      if (!services.canvasService.getCanvasWorkspaceId)
        throw new Error("Canvas workspace authorization unavailable");
      workspaceId = await services.canvasService.getCanvasWorkspaceId(
        authenticatedUser,
        payload.canvasId,
      );
    } catch {
      connectionManager.sendTo(connectionId, {
        type: "error",
        message: "Canvas not found or access denied",
      });
      return;
    }
  }

  // Resolve thread + model in parallel. When persisted sessions are enabled,
  // a missing/unauthorized session must stop the run instead of silently
  // creating an untracked in-memory execution.
  let threadResolutionFailed = false;
  const [threadId, model] = await Promise.all([
    (async (): Promise<string | undefined> => {
      if (!services.threadService) return undefined;
      try {
        const sessionThread =
          await services.threadService.resolveOwnedSessionThread(
            authenticatedUser,
            payload.sessionId,
          );
        return sessionThread.threadId;
      } catch (error) {
        threadResolutionFailed = true;
        log.warn("thread_resolve_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    })(),
    (async (): Promise<string | undefined> => {
      if (!services.settingsService || !services.viewerService)
        return undefined;
      try {
        const viewer =
          await services.viewerService.ensureViewer(authenticatedUser);
        const settingsWorkspaceId = workspaceId ?? viewer.workspace.id;
        workspaceId ??= settingsWorkspaceId;
        const settings = await services.settingsService.getWorkspaceSettings(
          authenticatedUser,
          settingsWorkspaceId,
        );
        return settings.defaultModel;
      } catch (error) {
        log.warn("model_resolve_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    })(),
  ]);
  if (threadResolutionFailed) {
    connectionManager.sendTo(connectionId, {
      type: "error",
      message: "Session not found or access denied",
    });
    return;
  }
  // Client-provided model takes priority over workspace default
  const resolvedModel = payload.model ?? model;
  if (!workspaceId && services.viewerService) {
    try {
      workspaceId = (
        await services.viewerService.ensureViewer(authenticatedUser)
      ).workspace.id;
    } catch {
      // A workspace-bound model will fail closed below; legacy models may continue.
    }
  }
  log.lap("resolve", { threadId: !!threadId, model: resolvedModel });

  const response = agentRuns.createRun(payload, {
    accessToken: authenticatedUser.accessToken,
    userId: authenticatedUser.id,
    ...(workspaceId ? { workspaceId } : {}),
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(threadId ? { threadId } : {}),
  });
  const runId = response.runId;
  log.lap("run_created", { runId });

  // Persist run metadata
  if (threadId && services.agentRunMetadataService) {
    try {
      await services.agentRunMetadataService.createAcceptedRun({
        createdBy: authenticatedUser.id,
        executionMode: "thinking",
        ...(resolvedModel ? { model: resolvedModel } : {}),
        runId,
        sessionId: payload.sessionId,
        threadId,
      });
    } catch (error) {
      agentRuns.cancelRun(runId, authenticatedUser.id);
      log.warn("run_persist_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      connectionManager.sendTo(connectionId, {
        type: "error",
        message: "Failed to persist agent run",
      });
      return;
    }
  }

  if (resolvedModel?.startsWith("workspace:")) {
    if (
      !workspaceId ||
      !threadId ||
      !services.agentRunMetadataService ||
      !services.providerSnapshotService
    ) {
      agentRuns.cancelRun(runId, authenticatedUser.id);
      connectionManager.sendTo(connectionId, {
        type: "error",
        message: "Workspace model execution is unavailable",
      });
      return;
    }
    try {
      await services.providerSnapshotService.createRunSnapshot({
        workspaceId,
        runId,
        modelRef: resolvedModel,
      });
    } catch {
      agentRuns.cancelRun(runId, authenticatedUser.id);
      await services.agentRunMetadataService
        .updateRun({
          runId,
          status: "failed",
          completedAt: new Date().toISOString(),
          errorCode: "provider_snapshot_invalid",
          errorMessage: "Workspace model execution could not be prepared.",
        })
        .catch(() => undefined);
      connectionManager.sendTo(connectionId, {
        type: "error",
        message: "Workspace model execution could not be prepared",
      });
      return;
    }
  }

  // Bind this connection to the canvas so events route correctly
  const canvasId = payload.canvasId ?? payload.conversationId;
  connectionManager.bindCanvas(connectionId, canvasId);

  // Send ACK to the specific connection that initiated the run.
  // Retry with short delays if the connection is temporarily unavailable
  // (e.g., brief disconnect/reconnect during page transitions).
  const ackMessage = {
    type: "command.ack",
    action: "agent.run",
    payload: response,
  };
  let ackSent = connectionManager.sendTo(connectionId, ackMessage);
  if (!ackSent) {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 500));
      ackSent = connectionManager.sendTo(connectionId, ackMessage);
      if (ackSent) break;
    }
  }
  log.lap("ack_sent", { runId, connectionId, delivered: ackSent });

  // Track active run so reconnecting clients can detect it
  connectionManager.setActiveRun(canvasId, runId);

  const keepAlive = setInterval(() => {
    connectionManager.sendTo(connectionId, { type: "keep-alive" });
  }, 15_000);

  // Accumulate assistant content blocks for server-side persistence
  const assistantText: string[] = [];
  const assistantBlocks: ContentBlock[] = [];
  const executionIdByToolCall = new Map<string, string>();

  try {
    let firstEvent = true;
    let firstModelOutput = true;
    for await (const event of agentRuns.streamRun(runId)) {
      let outboundEvent: StreamEvent = event;
      if (firstEvent) {
        log.lap("first_event", { runId, type: event.type });
        firstEvent = false;
      }
      if (
        firstModelOutput &&
        ((event.type === "message.delta" && event.delta.length > 0) ||
          event.type === "tool.started")
      ) {
        log.lap("first_model_output", { runId, type: event.type });
        firstModelOutput = false;
      }

      if (services.toolExecutionService) {
        try {
          if (event.type === "tool.started") {
            const execution = await services.toolExecutionService.recordStarted(
              {
                runId,
                requestedBy: authenticatedUser.id,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                ...(event.input ? { input: event.input } : {}),
                ...(event.planId && event.planStepId
                  ? { planId: event.planId, planStepId: event.planStepId }
                  : {}),
              },
            );
            executionIdByToolCall.set(event.toolCallId, execution.id);
            outboundEvent = {
              ...event,
              toolExecutionId: execution.id,
              retryable: execution.retryable,
            };
          } else if (event.type === "tool.completed") {
            const executionId = executionIdByToolCall.get(event.toolCallId);
            if (executionId) {
              await services.toolExecutionService.recordCompleted(executionId, {
                ...(event.output ? { output: event.output } : {}),
                ...(event.outputSummary
                  ? { outputSummary: event.outputSummary }
                  : {}),
                ...(event.artifacts ? { artifacts: event.artifacts } : {}),
              });
              outboundEvent = { ...event, toolExecutionId: executionId };
            }
          } else if (event.type === "tool.failed") {
            const executionId = executionIdByToolCall.get(event.toolCallId);
            if (executionId) {
              await services.toolExecutionService.recordFailed(
                executionId,
                event.error,
              );
              outboundEvent = { ...event, toolExecutionId: executionId };
            }
          } else if (
            event.type === "run.failed" ||
            event.type === "run.canceled"
          ) {
            await services.toolExecutionService.finishRunningForRun(
              runId,
              event.type === "run.failed" ? "failed" : "canceled",
              event.type === "run.failed"
                ? event.error.message
                : "Run was canceled.",
            );
          }
        } catch (ledgerError) {
          log.warn("tool_ledger_persist_failed", {
            runId,
            error:
              ledgerError instanceof Error
                ? ledgerError.message
                : String(ledgerError),
          });
        }
      }

      // Buffer for replay on reconnect
      services.eventBuffer?.push(canvasId, outboundEvent);

      // Broadcast to all viewers
      connectionManager.pushToCanvas(canvasId, outboundEvent);

      // Accumulate content for server-side persistence
      if (outboundEvent.type === "message.delta") {
        const lastBlock = assistantBlocks[assistantBlocks.length - 1];
        if (lastBlock && lastBlock.type === "text") {
          (lastBlock as { type: "text"; text: string }).text +=
            outboundEvent.delta;
        } else {
          assistantBlocks.push({ type: "text", text: outboundEvent.delta });
        }
        assistantText.push(outboundEvent.delta);
      } else if (outboundEvent.type === "thinking.delta") {
        const lastBlock = assistantBlocks[assistantBlocks.length - 1];
        if (lastBlock && lastBlock.type === "thinking") {
          lastBlock.thinking += outboundEvent.delta;
        } else {
          assistantBlocks.push({
            type: "thinking",
            thinking: outboundEvent.delta,
          });
        }
      } else if (outboundEvent.type === "plan.updated") {
        const nextPlan: PlanBlock = {
          type: "plan",
          planId: outboundEvent.planId,
          revision: outboundEvent.revision,
          steps: outboundEvent.steps,
        };
        const idx = assistantBlocks.findIndex(
          (block) =>
            block.type === "plan" && block.planId === outboundEvent.planId,
        );
        if (idx < 0) {
          assistantBlocks.push(nextPlan);
        } else {
          const current = assistantBlocks[idx] as PlanBlock;
          if (outboundEvent.revision >= current.revision)
            assistantBlocks[idx] = nextPlan;
        }
      } else if (outboundEvent.type === "tool.started") {
        assistantBlocks.push({
          type: "tool",
          ...(outboundEvent.toolExecutionId
            ? { toolExecutionId: outboundEvent.toolExecutionId }
            : {}),
          toolCallId: outboundEvent.toolCallId,
          toolName: outboundEvent.toolName,
          status: "running" as const,
          ...(outboundEvent.input ? { input: outboundEvent.input } : {}),
          ...(outboundEvent.retryable !== undefined
            ? { retryable: outboundEvent.retryable }
            : {}),
          ...(outboundEvent.planId && outboundEvent.planStepId
            ? {
                planId: outboundEvent.planId,
                planStepId: outboundEvent.planStepId,
              }
            : {}),
        });
      } else if (outboundEvent.type === "tool.completed") {
        const idx = assistantBlocks.findIndex(
          (b) =>
            b.type === "tool" &&
            (b as ToolBlock).toolCallId === outboundEvent.toolCallId,
        );
        if (idx >= 0) {
          assistantBlocks[idx] = {
            ...(assistantBlocks[idx] as ToolBlock),
            status: "completed" as const,
            ...(outboundEvent.output ? { output: outboundEvent.output } : {}),
            ...(outboundEvent.outputSummary
              ? { outputSummary: outboundEvent.outputSummary }
              : {}),
            ...(outboundEvent.artifacts
              ? { artifacts: outboundEvent.artifacts }
              : {}),
          };
        }
      } else if (outboundEvent.type === "tool.failed") {
        const idx = assistantBlocks.findIndex(
          (b) =>
            b.type === "tool" &&
            (b as ToolBlock).toolCallId === outboundEvent.toolCallId,
        );
        if (idx >= 0) {
          assistantBlocks[idx] = {
            ...(assistantBlocks[idx] as ToolBlock),
            status: "failed",
          };
        }
      } else if (
        outboundEvent.type === "run.failed" ||
        outboundEvent.type === "run.canceled"
      ) {
        const terminalStatus =
          outboundEvent.type === "run.failed" ? "failed" : "canceled";
        for (let i = 0; i < assistantBlocks.length; i += 1) {
          const block = assistantBlocks[i];
          if (block?.type === "tool" && block.status === "running") {
            assistantBlocks[i] = { ...block, status: terminalStatus };
          }
        }
      }
    }
    log.lap("stream_done", { runId });

    // ── Server-side assistant message persistence ──
    if (
      services.chatService &&
      (assistantText.length > 0 || assistantBlocks.length > 0)
    ) {
      try {
        await services.chatService.createMessage(
          authenticatedUser,
          payload.sessionId,
          {
            role: "assistant",
            content: assistantText.join(""),
            contentBlocks: assistantBlocks,
          },
        );
        log.lap("assistant_message_persisted", { runId });
      } catch (err) {
        log.warn("assistant_message_persist_failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (error) {
    log.error("stream_error", {
      runId,
      error: error instanceof Error ? error.message : "unknown",
    });
    const failedEvent = {
      type: "run.failed" as const,
      runId,
      error: {
        code: "run_failed" as const,
        message: error instanceof Error ? error.message : "Stream failed",
      },
      timestamp: new Date().toISOString(),
    };
    services.eventBuffer?.push(canvasId, failedEvent);
    connectionManager.pushToCanvas(canvasId, failedEvent);
  } finally {
    clearInterval(keepAlive);
    connectionManager.clearActiveRun(canvasId);
  }
}
