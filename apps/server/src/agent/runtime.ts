// @credits-system — Agent tool runtime with credit checks before image/video generation
import { randomUUID } from "node:crypto";

import type {
  AgentExecutionMode,
  ImageGenerationPreference,
  RunCancelResponse,
  RunCreateRequest,
  RunCreateResponse,
  StreamEvent,
  VideoGenerationPreference,
} from "@loomic/shared";
import type { ServerEnv } from "../config/env.js";
import type { PromptLibraryService } from "../features/prompt-library/prompt-library-service.js";
import type { DestructiveConfirmationService } from "../features/agent-actions/destructive-confirmation-service.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import type {
  ProviderSnapshotService,
  WorkspaceModelCatalogService,
} from "../features/providers/index.js";
import { sanitizeRunErrorForClient } from "../utils/error-sanitizer.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import type { AgentContextScope, AgentContextService } from "../features/agent-context/agent-context-service.js";
import { integrateMastraRunStream } from "./mastra-run-integration.js";
import type { MastraRunFactory, MastraRunInput } from "./mastra-run-types.js";
import type { DesignToolDependencies } from "./tools/design-tools.js";

import { buildImageGenerationModelConstraint } from "./image-generation-model-constraint.js";
export { buildImageGenerationModelConstraint };

type RuntimeRunStatus =
  | "accepted"
  | "canceled"
  | "completed"
  | "failed"
  | "running";

export type RoutedRunCreateRequest = RunCreateRequest;

type RuntimeRunRecord = RoutedRunCreateRequest & {
  contextScope?: AgentContextScope;
  accessToken?: string;
  consumed: boolean;
  controller: AbortController;
  executionMode: AgentExecutionMode;
  modelOverride?: string;
  runId: string;
  status: RuntimeRunStatus;
  threadId?: string;
  userId?: string;
  workspaceId?: string;
};

/**
 * Mastra is the only supported production agent runtime. The legacy runtime was
 * retired; a `legacy` value or any typo must fail fast rather than select dead
 * code. The return type stays a union for the internal test/embedding seam.
 */
export function resolveAgentRuntimeMode(
  source: NodeJS.ProcessEnv = process.env,
): "mastra" {
  const configured = source.LOOMIC_AGENT_RUNTIME?.trim().toLowerCase();
  if (!configured || configured === "mastra") return "mastra";
  if (configured === "legacy") {
    throw new Error(
      'LOOMIC_AGENT_RUNTIME=legacy is retired; Mastra is the only supported agent runtime. Remove the variable or set it to "mastra".',
    );
  }
  throw new Error(
    `Invalid LOOMIC_AGENT_RUNTIME=${JSON.stringify(source.LOOMIC_AGENT_RUNTIME)}. Expected "mastra".`,
  );
}

function toMastraRunInput(run: RuntimeRunRecord): MastraRunInput {
  return {
    runId: run.runId,
    conversationId: run.conversationId,
    sessionId: run.sessionId,
    prompt: run.prompt,
    executionMode: run.executionMode,
    attachments: (run.attachments ?? []).map(attachment => ({ ...attachment })),
    mentions: (run.mentions ?? []).map(mention => ({ ...mention })),
    signal: run.controller.signal,
    ...(run.canvasId ? { canvasId: run.canvasId } : {}),
    ...(run.userMessageId ? { userMessageId: run.userMessageId } : {}),
    ...(run.userId ? { userId: run.userId } : {}),
    ...(run.workspaceId ? { workspaceId: run.workspaceId } : {}),
    ...(run.accessToken ? { accessToken: run.accessToken } : {}),
    ...(run.threadId ? { threadId: run.threadId } : {}),
    ...(run.modelOverride ? { model: run.modelOverride } : {}),
    ...(run.canvasSelection ? {
      canvasSelection: { elementIds: [...run.canvasSelection.elementIds] },
    } : {}),
    ...(run.activeDesignId ? { activeDesignId: run.activeDesignId } : {}),
    ...(run.imageGenerationPreference ? {
      imageGenerationPreference: { ...run.imageGenerationPreference },
    } : {}),
    ...(run.videoGenerationPreference ? {
      videoGenerationPreference: { ...run.videoGenerationPreference },
    } : {}),
  };
}

export type CreateAgentRuntimeOptions = {
  promptLibraryService?: PromptLibraryService;
  agentContextService?: AgentContextService;
  /** Explicit test/embedding override. Production loads the Mastra factory. */
  mastraRunFactory?: MastraRunFactory;
  agentRunMetadataService?: AgentRunMetadataService;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => unknown;
  destructiveConfirmationService?: DestructiveConfirmationService;
  designTools?: DesignToolDependencies;
  creditService?: CreditService;
  env: ServerEnv;
  eventDelayMs?: number;
  jobService?: JobService;
  /** Model ref override; model objects are never accepted here. */
  model?: string;
  now?: () => string;
  runIdFactory?: () => string;
  tierGuard?: TierGuard;
  providerSnapshotService?: ProviderSnapshotService;
  workspaceModelCatalogService?: WorkspaceModelCatalogService;
};

export type AgentRunService = ReturnType<typeof createAgentRunService>;

export function createAgentRunService(options: CreateAgentRuntimeOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const runs = new Map<string, RuntimeRunRecord>();
  const runIdFactory = options.runIdFactory ?? (() => randomUUID());
  let mastraRunFactoryPromise: Promise<MastraRunFactory> | undefined;

  function getMastraRunFactory(): Promise<MastraRunFactory> {
    if (options.mastraRunFactory) return Promise.resolve(options.mastraRunFactory);
    // Never cache a rejected import: a transient load failure must not brick
    // the runtime for the rest of the process lifetime.
    if (!mastraRunFactoryPromise) {
      mastraRunFactoryPromise = import("./mastra-runtime.js")
        .then(module => module.createMastraRunFactory(options))
        .catch(error => {
          mastraRunFactoryPromise = undefined;
          throw error;
        });
    }
    return mastraRunFactoryPromise;
  }

  return {
    // Mastra reloads current authenticated facts for every turn; durable task
    // routing state is intentionally not inherited.
    async routeTaskSubmission(input: RunCreateRequest, _userId: string): Promise<RoutedRunCreateRequest> {
      return input;
    },

    async createAutonomousRun(input: unknown): Promise<RunCreateResponse> {
      // Legacy callers cannot revive unattended work through old grants.
      void input;
      throw Object.assign(new Error("无人值守执行已移除，请通过对话发起操作。"), { code: "autonomous_execution_removed" });
    },

    /** @deprecated Result continuation is retired; callers should keep chatting. */
    async createResultContinuationRun(input: unknown): Promise<RunCreateResponse> {
      void input;
      throw Object.assign(new Error("结果自动续跑已移除，请继续对话。"), { code: "result_continuation_removed" });
    },

    async getDesignTask(_userId: string, _sessionId: string) {
      // Durable design tasks are retired with the legacy runtime.
      return null;
    },

    async prepareDesignTask(_runId: string) {
      // HTTP and WebSocket transports retain this compatibility call. Task
      // binding now happens inside the Mastra run, so this is a no-op.
    },

    cancelRun(
      runId: string,
      requesterUserId?: string,
    ): RunCancelResponse | null {
      const run = runs.get(runId);
      if (!run) {
        return null;
      }
      if (requesterUserId && run.userId !== requesterUserId) {
        return null;
      }

      if (!run.controller.signal.aborted) {
        run.controller.abort();
      }

      run.status = "canceled";
      return {
        runId,
        status: "canceled",
      };
    },

    createRun(
      input: RoutedRunCreateRequest,
      runOptions?: {
        accessToken?: string;
        model?: string;
        threadId?: string;
        userId?: string;
        workspaceId?: string;
      },
    ): RunCreateResponse {
      const runId = runIdFactory();
      const { accessToken: _ignoredAccessToken, ...runInput } = input;

      runs.set(runId, {
        ...runInput,
        ...(runOptions?.accessToken
          ? { accessToken: runOptions.accessToken }
          : {}),
        consumed: false,
        controller: new AbortController(),
        executionMode: "thinking",
        ...(runOptions?.model ? { modelOverride: runOptions.model } : {}),
        ...(runOptions?.threadId ? { threadId: runOptions.threadId } : {}),
        ...(runOptions?.userId ? { userId: runOptions.userId } : {}),
        ...(runOptions?.workspaceId
          ? { workspaceId: runOptions.workspaceId }
          : {}),
        runId,
        status: "accepted",
      });

      return {
        conversationId: input.conversationId,
        runId,
        sessionId: input.sessionId,
        status: "accepted",
      };
    },

    hasRun(runId: string) {
      return runs.has(runId);
    },

    async *streamRun(runId: string): AsyncGenerator<StreamEvent> {
      const run = runs.get(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      if (run.consumed) {
        return;
      }
      // This invocation owns the record; release it on every exit path so
      // prompts and access tokens do not accumulate for the process lifetime.
      let owned = false;
      try {
        owned = true;
        if (run.controller.signal.aborted) {
          run.status = "canceled";
          const canceled: StreamEvent = { type: "run.canceled", runId, timestamp: now() };
          await syncPersistedRunFromEvent(
            options.agentRunMetadataService,
            run,
            canceled,
            now,
          ).catch(() => undefined);
          yield canceled;
          return;
        }

        run.consumed = true;
        run.status = "running";

        try {
          await updatePersistedRunStatus(
            options.agentRunMetadataService,
            run,
            "running",
            { startedAt: now() },
          );
        } catch (error) {
          const failedEvent = toFailedEvent(runId, now, error);
          run.status = "failed";
          await updatePersistedRunFailure(
            options.agentRunMetadataService,
            run,
            now,
            error,
          ).catch(() => undefined);
          yield failedEvent;
          return;
        }
        try {
          const factory = await getMastraRunFactory();
          const input = toMastraRunInput(run);
          const stream = await factory(input);
          for await (const event of integrateMastraRunStream({
            input,
            stream,
            ...(options.eventDelayMs ? { eventDelayMs: options.eventDelayMs } : {}),
            onEvent: async event => {
              run.status = mapEventToStatus(event);
              // Persistence is best-effort: a transient metadata write failure
              // must never downgrade a completed turn into a client-visible
              // run.failed (the agent turn and any job already happened).
              try {
                await syncPersistedRunFromEvent(
                  options.agentRunMetadataService,
                  run,
                  event,
                  now,
                );
              } catch (persistError) {
                console.error("[agent-runtime] Failed to persist run event:", persistError);
              }
            },
          })) {
            yield event;
          }
        } catch (error) {
          if (run.controller.signal.aborted) {
            const canceled: StreamEvent = { type: "run.canceled", runId, timestamp: now() };
            run.status = "canceled";
            await syncPersistedRunFromEvent(
              options.agentRunMetadataService,
              run,
              canceled,
              now,
            ).catch(() => undefined);
            yield canceled;
            return;
          }
          const failed = toFailedEvent(runId, now, error);
          run.status = "failed";
          await updatePersistedRunFailure(
            options.agentRunMetadataService,
            run,
            now,
            error,
          ).catch(persistError => {
            console.error("[agent-runtime] Failed to persist Mastra run failure:", persistError);
          });
          yield failed;
        }
        return;
      } finally {
        if (owned) runs.delete(runId);
      }
    },
  };
}
function mapEventToStatus(event: StreamEvent): RuntimeRunStatus {
  switch (event.type) {
    case "run.canceled":
      return "canceled";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    default:
      return "running";
  }
}

function toFailedEvent(
  runId: string,
  now: () => string,
  error: unknown,
): StreamEvent {
  const publicError = sanitizeRunErrorForClient(error);
  // Context wrappers may contain source text. Log only their stable public code.
  console.error(`[runtime] Agent run failed for run ${runId}:`, publicError.details ? publicError : error);

  return {
    error: publicError,
    runId,
    timestamp: now(),
    type: "run.failed",
  };
}

async function updatePersistedRunStatus(
  agentRunMetadataService: AgentRunMetadataService | undefined,
  run: RuntimeRunRecord,
  status: "running" | "completed",
  options?: {
    completedAt?: string;
    startedAt?: string;
  },
) {
  if (!agentRunMetadataService || !run.threadId) {
    return;
  }

  await agentRunMetadataService.updateRun({
    ...(options?.completedAt ? { completedAt: options.completedAt } : {}),
    ...(options?.startedAt ? { startedAt: options.startedAt } : {}),
    runId: run.runId,
    status,
  });
}

async function updatePersistedRunFailure(
  agentRunMetadataService: AgentRunMetadataService | undefined,
  run: RuntimeRunRecord,
  now: () => string,
  error: unknown,
) {
  if (!agentRunMetadataService || !run.threadId) {
    return;
  }

  const failure = sanitizeRunErrorForClient(error);
  await agentRunMetadataService.updateRun({
    completedAt: now(),
    errorCode: failure.details?.reasonCode ?? failure.code,
    errorMessage: failure.message,
    runId: run.runId,
    status: "failed",
  });
}

async function syncPersistedRunFromEvent(
  agentRunMetadataService: AgentRunMetadataService | undefined,
  run: RuntimeRunRecord,
  event: StreamEvent,
  now: () => string,
) {
  if (event.type === "run.completed") {
    await updatePersistedRunStatus(agentRunMetadataService, run, "completed", {
      completedAt: now(),
    });
    return;
  }

  if (event.type === "run.failed") {
    await updatePersistedRunFailure(
      agentRunMetadataService,
      run,
      now,
      Object.assign(new Error(event.error.message), { code: event.error.details?.reasonCode ?? event.error.code }),
    );
    return;
  }

  if (event.type === "run.canceled") {
    await agentRunMetadataService?.updateRun({
      completedAt: now(),
      runId: run.runId,
      status: "canceled",
    });
  }
}
