import { randomUUID } from "node:crypto";
import { resolveChatSelection } from "../features/providers/resolve-chat-selection.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";

import {
  clarificationRequestSchema,
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
import type { AgentRunService, RoutedRunCreateRequest } from "../agent/runtime.js";
import { appendImageRefusalCorrection } from "../agent/mastra-refusal-notice.js";
import {
  buildDesignTurnRecord,
  formatDesignTurnRecord,
  type DesignTurnDetectedInput,
} from "../agent/design-turn-record.js";
import type { RetryableReadToolExecutor } from "../agent/tools/read-tool-registry.js";
import type { DestructiveConfirmationService } from "../features/agent-actions/destructive-confirmation-service.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import type { ToolExecutionService } from "../features/agent-runs/tool-execution-service.js";
import { ToolExecutionServiceError } from "../features/agent-runs/tool-execution-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CanvasService } from "../features/canvas/canvas-service.js";
import type { ChatService } from "../features/chat/chat-service.js";
import type { ThreadService } from "../features/chat/thread-service.js";
import type {
  ProviderSnapshotService,
  WorkspaceModelCatalogService,
} from "../features/providers/index.js";
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
  workspaceModelCatalogService?: WorkspaceModelCatalogService;
};

const PRE_AUTH_MAX_MESSAGES = 32;
// A permitted Agent image can be 20 MiB before base64 expansion. Keep the
// pre-auth bound above that normal first-frame size while remaining well below
// ws' default 100 MiB maxPayload.
const PRE_AUTH_MAX_BYTES = 32 * 1024 * 1024;
const PRE_AUTH_TIMEOUT_MS = 15_000;

type PreAuthMessageBuffer = {
  activate(handler: (raw: RawData) => Promise<void>): boolean;
  discard(): void;
};

/** Install synchronously in the upgrade callback so the first client frame is
 * never lost while async authentication is in flight. Buffered frames are not
 * executable until activate is called after successful authentication. */
function createPreAuthMessageBuffer(
  socket: WebSocket,
): PreAuthMessageBuffer {
  let buffered: RawData[] = [];
  let bufferedBytes = 0;
  let discarded = false;
  let authenticationTimer: NodeJS.Timeout | undefined;

  const discard = () => {
    if (authenticationTimer) {
      clearTimeout(authenticationTimer);
      authenticationTimer = undefined;
    }
    if (discarded) return;
    discarded = true;
    buffered = [];
    bufferedBytes = 0;
    socket.off("message", onEarlyMessage);
    socket.off("close", discard);
    socket.off("error", discard);
  };
  const onEarlyMessage = (raw: RawData) => {
    if (discarded) return;
    const nextBytes = bufferedBytes + rawDataByteLength(raw);
    if (
      buffered.length >= PRE_AUTH_MAX_MESSAGES ||
      nextBytes > PRE_AUTH_MAX_BYTES
    ) {
      discard();
      if (socket.readyState === 1) {
        socket.close(1009, "Pre-authentication message limit exceeded");
      }
      return;
    }
    buffered.push(raw);
    bufferedBytes = nextBytes;
  };

  socket.on("message", onEarlyMessage);
  socket.once("close", discard);
  socket.once("error", discard);
  authenticationTimer = setTimeout(() => {
    discard();
    if (socket.readyState === 1) {
      socket.close(4008, "Authentication timed out");
    }
  }, PRE_AUTH_TIMEOUT_MS);
  authenticationTimer.unref();

  return {
    activate(handler) {
      if (discarded || socket.readyState !== 1) {
        discard();
        return false;
      }
      const pending = buffered;
      buffered = [];
      bufferedBytes = 0;
      const enqueue = (raw: RawData) => {
        // Preserve arrival order for synchronous parsing/dispatch, but do not
        // await a long-running command here: cancel and rpc.response frames
        // must remain able to overtake an in-flight agent.run completion.
        void handler(raw).catch(() => undefined);
      };

      // Listener changes and draining are synchronous, so a newly arriving
      // frame cannot overtake any frame copied from the pre-auth buffer.
      socket.on("message", enqueue);
      socket.off("message", onEarlyMessage);
      socket.off("close", discard);
      socket.off("error", discard);
      if (authenticationTimer) {
        clearTimeout(authenticationTimer);
        authenticationTimer = undefined;
      }
      discarded = true;
      for (const raw of pending) enqueue(raw);
      return true;
    },
    discard,
  };
}

function rawDataByteLength(raw: RawData): number {
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (Array.isArray(raw)) {
    return raw.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return raw.byteLength;
}

function rawDataToText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf-8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf-8");
  return Buffer.from(raw).toString("utf-8");
}

export async function registerWsRoute(
  app: FastifyInstance,
  options: RegisterWsOptions,
) {
  const { agentRuns, connectionManager } = options;

  app.get(
    "/api/ws",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      const preAuthMessages = createPreAuthMessageBuffer(socket);
      const url = new URL(request.url, `http://${request.headers.host}`);
      const token = url.searchParams.get("token");

      if (!token || !options.auth) {
        preAuthMessages.discard();
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
        preAuthMessages,
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
  preAuthMessages: PreAuthMessageBuffer,
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
      preAuthMessages.discard();
      socket.close(4001, "Unauthorized");
      return;
    }
    authenticatedUser = user;
    log.info("connected", { userId: user.id });
  } catch (err) {
    log.warn("auth_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    preAuthMessages.discard();
    socket.close(4001, "Unauthorized");
    return;
  }

  if (socket.readyState !== 1) {
    preAuthMessages.discard();
    return;
  }

  // The client ID is only a diagnostic/reconnect hint. Every socket receives a
  // fresh server identity so collisions and late callbacks cannot cross generations.
  const urlForParams = new URL(_request.url, `http://${_request.headers.host}`);
  const requestedConnectionId =
    urlForParams.searchParams.get("connectionId") || randomUUID();
  const connectionId = connectionManager.register(
    requestedConnectionId,
    authenticatedUser.id,
    socket,
  );

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

  const handleMessage = async (raw: RawData) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToText(raw));
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const obj = parsed as Record<string, unknown>;

    if (obj.type === "rpc.response") {
      try {
        const rpcResponse = wsRpcResponseSchema.parse(parsed);
        connectionManager.handleRpcResponse(
          connectionId,
          {
            type: rpcResponse.type,
            id: rpcResponse.id,
            ...(rpcResponse.result !== undefined
              ? { result: rpcResponse.result }
              : {}),
            ...(rpcResponse.error !== undefined
              ? { error: rpcResponse.error }
              : {}),
          },
          socket,
        );
      } catch {
        // Ignore malformed RPC responses
      }
      return;
    }

    if (obj.type === "command") {
      const requestId =
        typeof obj.requestId === "string" && obj.requestId.length <= 128
          ? obj.requestId
          : undefined;
      const fail = (code: string, message: string) =>
        connectionManager.sendTo(connectionId, {
          type: "error",
          action: obj.action,
          ...(requestId ? { requestId } : {}),
          code,
          message,
        });
      try {
        let msg;
        try {
          msg = wsCommandSchema.parse(parsed);
        } catch {
          fail("invalid_command", "请求格式不正确，请刷新后重试。");
          return;
        }

        // A long-lived socket must not keep using its expired handshake token.
        // Validate refreshed credentials and forbid switching the socket's owner.
        const refreshedToken =
          typeof obj.accessToken === "string"
            ? obj.accessToken
            : msg.action === "agent.run"
              ? msg.payload.accessToken
              : undefined;
        let commandUser = authenticatedUser;
        if (refreshedToken) {
          const fresh = await options.auth!.authenticate({
            headers: { authorization: `Bearer ${refreshedToken}` },
          });
          if (!fresh || fresh.id !== authenticatedUser.id) {
            fail(
              "authentication_required",
              "登录状态已失效，请重新登录后再试。",
            );
            return;
          }
          commandUser = fresh;
        }
        if (msg.action === "agent.run") {
          const p = msg.payload;
          await handleRunCommand(
            commandUser,
            connectionId,
            {
              sessionId: p.sessionId,
              conversationId: p.conversationId,
              ...(p.userMessageId ? { userMessageId: p.userMessageId } : {}),
              prompt: p.prompt,
              ...(p.canvasSelection !== undefined ? { canvasSelection: p.canvasSelection } : {}),
              ...(p.activeDesignId ? { activeDesignId: p.activeDesignId } : {}),
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
            requestId,
          );
        } else if (msg.action === "agent.cancel") {
          log.info("run_cancel", {
            userId: authenticatedUser.id,
            runId: msg.payload.runId,
          });
          const cancelResult = agentRuns.cancelRun(
            msg.payload.runId,
            commandUser.id,
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
          await handleConfirmedAction(
            commandUser,
            connectionId,
            canvasId,
            msg.payload,
            confirmationService,
            connectionManager,
          );
        } else if (msg.action === "agent.retry_tool") {
          await handleRetryTool(
            commandUser,
            connectionId,
            msg.payload,
            options,
            connectionManager,
          );
        } else if (msg.action === "canvas.resume") {
          const p = msg.payload;
          await resumeOwnedCanvas(
            commandUser,
            connectionId,
            p.canvasId,
            p.lastSeq,
            socket,
            options,
            connectionManager,
            log,
          );
        }
      } catch (error) {
        log.warn("command_failed", {
          action: obj.action,
          error: error instanceof Error ? error.name : "unknown",
        });
        fail(
          "command_failed",
          "操作启动失败，请稍后重试；若已有生成任务，请先查看任务状态。",
        );
      }
    }
  };

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

  if (!preAuthMessages.activate(handleMessage)) {
    clearInterval(pingInterval);
    connectionManager.remove(connectionId);
  }
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
      await connectionManager.sendToAuthorized(connectionId, {
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
        workspaceId: context.workspaceId,
      });
      const outputSummary = `Retried ${execution.toolName} successfully.`;
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
    await connectionManager.sendToAuthorized(connectionId, {
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
      const canceled = await service.cancel({
        confirmationId: payload.confirmationId,
        userId: user.id,
        canvasId,
      });
      if (!canceled) {
        await connectionManager.sendToAuthorized(connectionId, {
          type: "command.ack",
          action: "agent.confirm_action",
          payload: {
            confirmationId: payload.confirmationId,
            status: "failed",
            code: "confirmation_not_cancelable",
            message: "该确认不存在、已经处理或当前无法取消。",
          },
        });
        return;
      }
      await connectionManager.sendToAuthorized(connectionId, {
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
      context: { user },
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
      await connectionManager.sendToAuthorized(connectionId, {
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
          void connectionManager.sendToAuthorized(connectionId, {
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
          // The click was already acknowledged as `accepted`, so this terminal answer is
          // the only thing that can tell the card the action did NOT happen. It must
          // therefore carry a user-readable reason instead of the raw internal message.
          const confirmationCode =
            error && typeof error === "object" && "code" in error
              ? String((error as { code: unknown }).code)
              : null;
          void connectionManager.sendToAuthorized(connectionId, {
            type: "command.ack",
            action: "agent.confirm_action",
            payload: {
              confirmationId: payload.confirmationId,
              status: "failed",
              code: "confirmation_execution_failed",
              message:
                confirmationCode === "confirmation_stale"
                  ? "画布内容在确认后已发生变化，本次操作未执行。请重新发起。"
                  : confirmationCode === "confirmation_expired"
                    ? "确认已过期，本次操作未执行。请重新发起。"
                    : error instanceof Error
                      ? sanitizeErrorForClient(error)
                      : "图片生成失败，请重试。",
            },
          });
        });
      return;
    }

    pushCanvasSync();
    await connectionManager.sendToAuthorized(connectionId, {
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
    await connectionManager.sendToAuthorized(connectionId, {
      type: "command.ack",
      action: "agent.confirm_action",
      payload: {
        confirmationId: payload.confirmationId,
        status: "failed",
        code,
        message: sanitizeErrorForClient(error),
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
  let workspaceId: string | undefined;
  try {
    if (!options.canvasService)
      throw new Error("Canvas authorization unavailable");
    await options.canvasService.getCanvas(user, canvasId);
    if (options.canvasService.getCanvasWorkspaceId) {
      workspaceId = await options.canvasService.getCanvasWorkspaceId(user, canvasId);
    }
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
  connectionManager.bindCanvas(connectionId, canvasId, workspaceId);

  const missed = options.eventBuffer?.getAfter(canvasId, lastSeq) ?? [];
  const activeRun = connectionManager.getActiveRun(canvasId);
  await connectionManager.sendToAuthorized(connectionId, {
    type: "command.ack",
    action: "canvas.resume",
    payload: {
      canvasId,
      latestSeq: options.eventBuffer?.getLatestSeq(canvasId) ?? 0,
      activeRunId: activeRun?.runId ?? null,
      activeSessionId: activeRun?.sessionId ?? null,
      replayed: missed.length,
    },
  });

  for (const entry of missed) {
    await connectionManager.sendToAuthorized(connectionId, {
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
  requestId?: string,
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
        action: "agent.run",
        ...(requestId ? { requestId } : {}),
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
      action: "agent.run",
      ...(requestId ? { requestId } : {}),
      message: "Session not found or access denied",
    });
    return;
  }
  // Client-provided model takes priority over workspace default
  let resolvedModel: string | undefined;
  if (!workspaceId && services.viewerService) {
    try {
      workspaceId = (
        await services.viewerService.ensureViewer(authenticatedUser)
      ).workspace.id;
    } catch {
      // A workspace-bound model will fail closed below; legacy models may continue.
    }
  }
    try {
      resolvedModel = await resolveChatSelection({ user: authenticatedUser,
        ...(workspaceId ? { workspaceId } : {}),
        ...(payload.model ? { requested: payload.model } : {}),
        ...(model ? { defaultModel: model } : {}),
        ...(services.workspaceModelCatalogService ? { catalog: services.workspaceModelCatalogService } : {}),
      });
    } catch {
      connectionManager.sendTo(connectionId, {
        type: "error",
        action: "agent.run",
        ...(requestId ? { requestId } : {}),
        message: "The selected text model is not available in this workspace.",
      });
      return;
    }
  log.lap("resolve", { threadId: !!threadId, model: resolvedModel });

  let routedPayload: RoutedRunCreateRequest;
  try {
    routedPayload = typeof agentRuns.routeTaskSubmission === "function"
      ? await agentRuns.routeTaskSubmission(payload, authenticatedUser.id)
      : payload;
  } catch {
    connectionManager.sendTo(connectionId, { type: "error", action: "agent.run", ...(requestId ? { requestId } : {}),
      message: "当前需求已变化，未发送这条补充。请刷新后重试。" });
    return;
  }
  const response = agentRuns.createRun(routedPayload, {
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
        prompt: payload.prompt,
        ...(payload.userMessageId ? { requestMessageId: payload.userMessageId } : {}),
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
        action: "agent.run",
        ...(requestId ? { requestId } : {}),
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
        action: "agent.run",
        ...(requestId ? { requestId } : {}),
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
        action: "agent.run",
        ...(requestId ? { requestId } : {}),
        message: "Workspace model execution could not be prepared",
      });
      return;
    }
  }

  // Bind this connection to the canvas so events route correctly
  const canvasId = payload.canvasId ?? payload.conversationId;
  connectionManager.bindCanvas(connectionId, canvasId, workspaceId);

  // Send ACK to the specific connection that initiated the run.
  // Retry with short delays if the connection is temporarily unavailable
  // (e.g., brief disconnect/reconnect during page transitions).
  const ackMessage = {
    type: "command.ack",
    action: "agent.run",
    ...(requestId ? { requestId } : {}),
    payload: response,
  };
  let ackSent = await connectionManager.sendToAuthorized(connectionId, ackMessage);
  if (!ackSent) {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 500));
      ackSent = await connectionManager.sendToAuthorized(connectionId, ackMessage);
      if (ackSent) break;
    }
  }
  log.lap("ack_sent", { runId, connectionId, delivered: ackSent });

  // Track active run so reconnecting clients can detect it
  // Session identity comes from the accepted server run, not the raw request.
  connectionManager.setActiveRun(canvasId, runId, response.sessionId);

  const keepAlive = setInterval(() => {
    connectionManager.sendTo(connectionId, { type: "keep-alive" });
  }, 15_000);

  // Accumulate assistant content blocks for server-side persistence
  const assistantText: string[] = [];
  const assistantBlocks: ContentBlock[] = [];
  const executionIdByToolCall = new Map<string, string>();
  /**
   * The DETECTED layer of this turn, quoted from the run's own `design.routing`
   * event as it passes through. It is read here rather than re-derived, so the
   * turn record can never disagree with the notice the user already saw, and it
   * stays `undefined` for a turn where the router published nothing.
   */
  let detectedTurnIntent: DesignTurnDetectedInput | undefined;

  try {
    let firstEvent = true;
    let firstModelOutput = true;
    for await (const event of agentRuns.streamRun(runId)) {
      let outboundEvent: StreamEvent = event;
      if (firstEvent) {
        log.lap("first_event", { runId, type: event.type });
        firstEvent = false;
      }
      // The DETECTED layer of this turn: the router's verdict, captured verbatim
      // as it goes past so the turn record quotes the notice the user already
      // saw instead of re-deriving (or contradicting) it.
      if (outboundEvent.type === "design.routing") {
        detectedTurnIntent = {
          intent: outboundEvent.intent,
          reasonCode: outboundEvent.reasonCode,
          source: outboundEvent.source,
          confidence: outboundEvent.confidence,
        };
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

      // A terminal event can immediately trigger canvas.resume in the browser.
      // Remove this run before publishing it, not after chat persistence/finally.
      if (outboundEvent.type === "run.completed" || outboundEvent.type === "run.failed" || outboundEvent.type === "run.canceled")
        connectionManager.clearActiveRun(canvasId, runId);

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
        if (outboundEvent.toolName === "ask_clarification") {
          const parsed = clarificationRequestSchema.safeParse(outboundEvent.output);
          if (parsed.success && !assistantBlocks.some(block =>
            block.type === "clarification" && block.clarificationId === outboundEvent.toolCallId)) {
            assistantBlocks.push({
              type: "clarification",
              version: 1,
              clarificationId: outboundEvent.toolCallId,
              questions: parsed.data.questions,
            });
          }
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
            // Runtime-owned terminal paths (for example sparse-logo
            // clarification) can persist their streaming message before this
            // generic collector finishes.  Use the run identity here as well
            // so the second persistence attempt is idempotent.
            id: runId,
            role: "assistant",
            content: assistantText.join(""),
            contentBlocks: assistantBlocks,
          },
        );
        log.lap("assistant_message_persisted", { runId });
        // ── Per-turn two-layer record ──────────────────────────────────────────
        // The one seam where both layers are on hand at once: the router's
        // verdict was captured above, and the run's OWN tool receipts are the
        // `assistantBlocks` that were just persisted. The record is emitted only
        // after that persistence succeeded, so it can never describe a turn whose
        // message does not exist. It comes after `run.completed` in the stream,
        // which is why it is also pushed into the event buffer: a client that had
        // already left the run's stream still receives it on reconnect.
        //
        // It reports, never acts: it creates no job, charges nothing, grants
        // nothing, and its `summary`/`detail` are rendered only in the existing
        // advanced mode on the client.
        try {
          const turnRecord = buildDesignTurnRecord({
            runId,
            ...(detectedTurnIntent ? { detected: detectedTurnIntent } : {}),
            contentBlocks: assistantBlocks,
          });
          const display = formatDesignTurnRecord(turnRecord);
          const turnEvent: StreamEvent = {
            type: "design.turn",
            runId,
            timestamp: new Date().toISOString(),
            summary: display.summary,
            ...(display.detail ? { detail: display.detail } : {}),
          };
          console.info("[design-turn-record]", {
            runId,
            detectedIntent: turnRecord.detectedIntent,
            executedAction: turnRecord.executed.kind,
            ...(turnRecord.executed.kind === "unknown" ? { executedCode: turnRecord.executed.code } : {}),
            ...(turnRecord.executed.kind === "refused" ? { executedCode: turnRecord.executed.code } : {}),
            executionJobIds: turnRecord.summary.executionJobIds,
            deliveredAssetIds: turnRecord.summary.deliveredAssetIds,
          });
          services.eventBuffer?.push(canvasId, turnEvent);
          connectionManager.pushToCanvas(canvasId, turnEvent);
        } catch (recordError) {
          // Never fail the run's own persistence because the record could not be
          // built. A missing record is a missing diagnostic, not a lost turn.
          log.warn("design_turn_record_failed", {
            runId,
            error: recordError instanceof Error ? recordError.message : String(recordError),
          });
        }
        // A run whose image submission was refused before contact but whose
        // closing text promises that it is under way just wrote a false last
        // line. The refusal receipt is right here in this run's blocks, so the
        // server — not the model — restores the truth: the correction is
        // APPENDED after the message above (rewriting it in place would keep its
        // original position, the trap `appendSettledNotice` documents) under a
        // run-derived id, so a replay cannot append it twice.
        try {
          const corrected = await appendImageRefusalCorrection({
            runId,
            contentBlocks: assistantBlocks,
            append: message =>
              services.chatService!.createMessage(
                authenticatedUser,
                payload.sessionId,
                message,
              ),
          });
          if (corrected) log.lap("refusal_correction_appended", { runId });
        } catch (correctionError) {
          // Never fail the run's own persistence because the correction failed.
          log.warn("refusal_correction_failed", {
            runId,
            error:
              correctionError instanceof Error
                ? correctionError.message
                : String(correctionError),
          });
        }
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
    connectionManager.clearActiveRun(canvasId, runId);
    services.eventBuffer?.push(canvasId, failedEvent);
    connectionManager.pushToCanvas(canvasId, failedEvent);
  } finally {
    clearInterval(keepAlive);
    connectionManager.clearActiveRun(canvasId, runId);
  }
}
