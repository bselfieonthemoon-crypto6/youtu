// @credits-system — Agent tool runtime with credit checks before image/video generation
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type {
  AgentExecutionMode,
  ImageAttachment,
  ImageGenerationPreference,
  MessageMention,
  RunCancelResponse,
  RunCreateRequest,
  RunCreateResponse,
  StreamEvent,
  VideoGenerationPreference,
} from "@loomic/shared";

import {
  type BillingErrorCode,
  type ImageQualityLevel,
  getPlanConfig,
  isExplicitImageCancellation,
  isExplicitImageConfirmationMessage,
} from "@loomic/shared";
import type { ServerEnv } from "../config/env.js";
import type { DestructiveConfirmationService } from "../features/agent-actions/destructive-confirmation-service.js";
import { createImageProposalStore } from "../features/agent-actions/image-proposal-store.js";
import { createImageGenerationConfirmationTool } from "./tools/image-generation-confirmation.js";
import { createDesignImageTargetValidator } from "./tools/design-image-target.js";
import type { AgentRunMetadataService } from "../features/agent-runs/agent-run-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  createCanvasElementId,
  insertImageElement,
  insertImageGenerationPlaceholder,
  insertVideoElement,
  markImageGenerationPlaceholderFailed,
} from "../features/canvas/canvas-element-writer.js";
import {
  type CreditService,
  CreditServiceError,
} from "../features/credits/credit-service.js";
import {
  type TierGuard,
  TierGuardError,
} from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import type {
  ProviderSnapshotService,
  WorkspaceModelCatalogService,
} from "../features/providers/index.js";
import type {
  AvailableModel,
  AvailableVideoModel,
} from "../generation/providers/registry.js";
import { safeDownload } from "../security/safe-download.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../supabase/user.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import { createPipelineLogger } from "../ws/logger.js";
import {
  optimizeAgentVisionAttachment,
  resolveAgentImageAttachment,
} from "./attachment-resolver.js";
import { analyzeAgentVisionAttachments } from "./attachment-vision-analyzer.js";
import { createAgentBackend } from "./backends/index.js";
import {
  type LoomicAgent,
  type LoomicAgentFactory,
  createDefaultModelSpecifier,
  createLoomicDeepAgent,
  createStreamingChatModel,
} from "./deep-agent.js";
import type { AgentPersistenceService } from "./persistence/index.js";
import { adaptDeepAgentStream } from "./stream-adapter.js";
import type { DesignToolDependencies } from "./tools/design-tools.js";
// execute 工具由 deepagents 内置提供（LocalShellBackend 作为 sandbox backend）
// 不需要自定义代码执行工具
import type { SubmitImageJobFn } from "./tools/image-generate.js";
import { buildCanvasSummaryForContext } from "./tools/inspect-canvas.js";
import type { SubmitVideoJobFn } from "./tools/video-generate.js";
import { resolveWorkspaceChatModel } from "./workspace-chat-model.js";
import {
  type WorkspaceSkillEntry,
  loadWorkspaceSkills,
} from "./workspace-skills.js";

/**
 * Build the text portion of a user message, appending <input_images> XML
 * tags when attachments are present so the LLM can reference them by assetId.
 */
export function buildUserMessage(
  prompt: string,
  attachments: ImageAttachment[],
  imageGenerationPreference?: ImageGenerationPreference,
  mentions: MessageMention[] = [],
  videoGenerationPreference?: VideoGenerationPreference,
  canvasSummary?: string | null,
): { text: string } {
  const xmlBlocks: string[] = [];

  // Canvas state context (auto-injected, not user-provided)
  if (canvasSummary) {
    xmlBlocks.push(`<canvas_state>\n${canvasSummary}\n</canvas_state>`);
  }

  const inputImagesXml = buildInputImagesXml(attachments);
  if (inputImagesXml) xmlBlocks.push(inputImagesXml);

  const imageGenerationPreferenceXml = buildImageGenerationPreferenceXml(
    imageGenerationPreference,
  );
  if (imageGenerationPreferenceXml)
    xmlBlocks.push(imageGenerationPreferenceXml);

  const videoGenerationPreferenceXml = buildVideoGenerationPreferenceXml(
    videoGenerationPreference,
  );
  if (videoGenerationPreferenceXml)
    xmlBlocks.push(videoGenerationPreferenceXml);

  const mentionXmlBlocks = buildMentionXmlBlocks(mentions);
  xmlBlocks.push(...mentionXmlBlocks);

  if (!xmlBlocks.length) return { text: prompt };
  return { text: `${prompt}\n\n${xmlBlocks.join("\n\n")}` };
}

function buildInputImagesXml(attachments: ImageAttachment[]): string | null {
  if (attachments.length === 0) return null;

  const imageXml = attachments
    .map((attachment, i) => {
      const nameAttr = attachment.name
        ? ` name="${escapeXmlAttribute(attachment.name)}"`
        : "";
      return `<image index="${i + 1}" asset_id="${escapeXmlAttribute(attachment.assetId)}" mime_type="${escapeXmlAttribute(attachment.mimeType)}"${nameAttr} />`;
    })
    .join("\n  ");

  return `<input_images count="${attachments.length}">\n  ${imageXml}\n</input_images>`;
}

function buildImageGenerationPreferenceXml(
  imageGenerationPreference?: ImageGenerationPreference,
): string | null {
  if (
    imageGenerationPreference?.mode !== "manual" ||
    imageGenerationPreference.models.length === 0
  ) {
    return null;
  }

  const modelXml = imageGenerationPreference.models
    .map(
      (model, i) =>
        `<preferred_model index="${i + 1}" id="${escapeXmlAttribute(model)}" />`,
    )
    .join("\n  ");

  return `<human_image_generation_preference mode="manual" count="${imageGenerationPreference.models.length}">\n  ${modelXml}\n</human_image_generation_preference>`;
}

function buildVideoGenerationPreferenceXml(
  videoGenerationPreference?: VideoGenerationPreference,
): string | null {
  if (
    videoGenerationPreference?.mode !== "manual" ||
    videoGenerationPreference.models.length === 0
  ) {
    return null;
  }

  const modelXml = videoGenerationPreference.models
    .map(
      (model, i) =>
        `<preferred_model index="${i + 1}" id="${escapeXmlAttribute(model)}" />`,
    )
    .join("\n  ");

  return `<human_video_generation_preference mode="manual" count="${videoGenerationPreference.models.length}">\n  ${modelXml}\n</human_video_generation_preference>`;
}

function buildMentionXmlBlocks(mentions: MessageMention[]): string[] {
  const xmlBlocks: string[] = [];

  const mentionedModels = mentions.filter(
    (
      mention,
    ): mention is Extract<MessageMention, { mentionType: "image-model" }> =>
      mention.mentionType === "image-model",
  );
  if (mentionedModels.length > 0) {
    const modelXml = mentionedModels
      .map(
        (mention, i) =>
          `<model index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" display_name="${escapeXmlAttribute(mention.label)}" />`,
      )
      .join("\n  ");

    xmlBlocks.push(
      `<human_image_model_mentions count="${mentionedModels.length}">\n  ${modelXml}\n</human_image_model_mentions>`,
    );
  }

  const mentionedBrandKitAssets = mentions.filter(
    (
      mention,
    ): mention is Extract<MessageMention, { mentionType: "brand-kit-asset" }> =>
      mention.mentionType === "brand-kit-asset",
  );
  if (mentionedBrandKitAssets.length > 0) {
    const assetXml = mentionedBrandKitAssets
      .map((mention, i) => {
        const textContentAttr =
          mention.textContent != null
            ? ` text_content="${escapeXmlAttribute(mention.textContent)}"`
            : "";
        const fileUrlAttr =
          mention.fileUrl != null
            ? ` file_url="${escapeXmlAttribute(mention.fileUrl)}"`
            : "";
        return `<brand_kit_asset index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" type="${escapeXmlAttribute(mention.assetType)}" display_name="${escapeXmlAttribute(mention.label)}"${textContentAttr}${fileUrlAttr} />`;
      })
      .join("\n  ");

    xmlBlocks.push(
      `<human_brand_kit_mentions count="${mentionedBrandKitAssets.length}">\n  ${assetXml}\n</human_brand_kit_mentions>`,
    );
  }

  // Skill mentions — tell the agent to read and follow the mentioned skill
  const mentionedSkills = mentions.filter(
    (mention): mention is Extract<MessageMention, { mentionType: "skill" }> =>
      mention.mentionType === "skill",
  );
  if (mentionedSkills.length > 0) {
    const skillXml = mentionedSkills
      .map(
        (mention, i) =>
          `<skill index="${i + 1}" id="${escapeXmlAttribute(mention.id)}" name="${escapeXmlAttribute(mention.label)}" slug="${escapeXmlAttribute(mention.slug)}">\nThe user explicitly requested this skill. Read \`/workspace-skills/${mention.slug}/SKILL.md\` for full instructions and follow them.\n</skill>`,
      )
      .join("\n  ");
    xmlBlocks.push(
      `<human_skill_mentions count="${mentionedSkills.length}">\n  ${skillXml}\n</human_skill_mentions>`,
    );
  }

  return xmlBlocks;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Build a lookup map from assetId to base64 data URI.
 * Stored in configurable so tools can resolve assetId references.
 */
export function buildAttachmentDataMap(
  downloaded: Array<{ assetId: string; mimeType: string; base64: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const d of downloaded) {
    map[d.assetId] = `data:${d.mimeType};base64,${d.base64}`;
  }
  return map;
}

type RuntimeRunStatus =
  | "accepted"
  | "canceled"
  | "completed"
  | "failed"
  | "running";

type RuntimeRunRecord = RunCreateRequest & {
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

type CreateAgentRuntimeOptions = {
  agentPersistenceService?: AgentPersistenceService;
  agentFactory?: LoomicAgentFactory;
  agentRunMetadataService?: AgentRunMetadataService;
  connectionManager?: ConnectionManager;
  createUserClient?: (accessToken: string) => unknown;
  destructiveConfirmationService?: DestructiveConfirmationService;
  designTools?: DesignToolDependencies;
  creditService?: CreditService;
  env: ServerEnv;
  eventDelayMs?: number;
  jobService?: JobService;
  model?: BaseLanguageModel | string;
  now?: () => string;
  runIdFactory?: () => string;
  tierGuard?: TierGuard;
  viewerService?: ViewerService;
  providerSnapshotService?: ProviderSnapshotService;
  workspaceModelCatalogService?: WorkspaceModelCatalogService;
};

export type AgentRunService = ReturnType<typeof createAgentRunService>;

export function createAgentRunService(options: CreateAgentRuntimeOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const runs = new Map<string, RuntimeRunRecord>();
  const runIdFactory = options.runIdFactory ?? (() => randomUUID());

  const resolvedAgentFactory: LoomicAgentFactory =
    options.agentFactory ??
    ((agentOptions) =>
      createLoomicDeepAgent({
        ...agentOptions,
        ...(options.createUserClient
          ? { createUserClient: options.createUserClient }
          : {}),
        ...(options.destructiveConfirmationService
          ? {
              destructiveConfirmationService:
                options.destructiveConfirmationService,
            }
          : {}),
        ...(options.designTools ? { designTools: options.designTools } : {}),
      }));

  // ── Billing error helper: push WS event + abort run ──────────
  function pushBillingErrorAndAbort(
    run: { runId: string; conversationId: string; controller: AbortController },
    canvasId: string | undefined,
    opts: { connectionManager?: ConnectionManager },
    code: BillingErrorCode,
    message: string,
    extra?: {
      currentBalance?: number;
      requiredAmount?: number;
      plan?: string;
      dailyClaimed?: boolean;
    },
  ): void {
    const canvasTarget = canvasId ?? run.conversationId;
    if (!opts.connectionManager || !canvasTarget) {
      console.warn(
        `[billing] pushBillingErrorAndAbort: no connectionManager or canvasTarget, billing.error (${code}) not sent to client`,
      );
    } else {
      opts.connectionManager.pushToCanvas(canvasTarget, {
        type: "billing.error",
        runId: run.runId,
        timestamp: new Date().toISOString(),
        code,
        message,
        ...extra,
      });
    }
    if (!run.controller.signal.aborted) {
      run.controller.abort();
    }
  }

  return {
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
      input: RunCreateRequest,
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

      run.consumed = true;
      run.status = "running";

      const rlog = createPipelineLogger("runtime", { runId });

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
        yield failedEvent;
        return;
      }

      let persistence: Awaited<
        ReturnType<NonNullable<AgentPersistenceService["getPersistence"]>>
      > | null = null;
      let checkpointHistoryRecoveryNeeded = false;
      try {
        persistence =
          run.threadId && options.agentPersistenceService
            ? await options.agentPersistenceService.getPersistence()
            : null;
        if (run.threadId && persistence) {
          checkpointHistoryRecoveryNeeded =
            await repairCorruptedThreadCheckpoint(
              persistence.checkpointer,
              run.threadId,
            );
          if (checkpointHistoryRecoveryNeeded) {
            rlog.lap("checkpoint_history_recovery");
          }
        }
        rlog.lap("persistence_init");
      } catch (error) {
        const failedEvent = toFailedEvent(runId, now, error);
        run.status = "failed";
        await updatePersistedRunFailure(
          options.agentRunMetadataService,
          run,
          now,
          error,
        );
        yield failedEvent;
        return;
      }

      if (run.threadId && !persistence) {
        const failedEvent = toFailedEvent(
          runId,
          now,
          new Error("SUPABASE_DB_URL is required for persisted agent threads."),
        );
        run.status = "failed";
        await updatePersistedRunFailure(
          options.agentRunMetadataService,
          run,
          now,
          new Error("SUPABASE_DB_URL is required for persisted agent threads."),
        );
        yield failedEvent;
        return;
      }

      // Build submitImageJob / submitVideoJob closures for async jobs via PGMQ
      let submitImageJob: SubmitImageJobFn | undefined;
      let submitVideoJob: SubmitVideoJobFn | undefined;
      if (
        options.jobService &&
        options.createUserClient &&
        run.accessToken &&
        run.userId
      ) {
        const jobSvc = options.jobService;
        const createClient = options.createUserClient;
        const accessToken = run.accessToken;
        const userId = run.userId;
        const canvasId = run.canvasId;
        const sessionId = run.sessionId;
        const runId = run.runId;

        submitImageJob = async (input) => {
          const jobT0 = Date.now();
          const jobLap = (label: string, extra?: Record<string, unknown>) => {
            console.log(
              `[submitImageJob] ${label} +${Date.now() - jobT0}ms`,
              extra ? JSON.stringify(extra) : "",
            );
          };

          // Look up personal workspace directly — the viewer is already
          // bootstrapped from the normal auth flow, so we skip ensureViewer
          // to avoid its strict email validation on the profile schema.
          const client = createClient(accessToken) as UserSupabaseClient;
          let workspaceId = run.workspaceId;
          if (!workspaceId) {
            const { data: ws } = await client
              .from("workspaces")
              .select("id")
              .eq("type", "personal")
              .limit(1)
              .single();
            workspaceId = ws?.id;
          }
          if (!workspaceId) throw new Error("No authorized workspace found");

          const user: AuthenticatedUser = {
            id: userId,
            accessToken,
            email: "",
            userMetadata: {},
          };

          if (input.proposalId) {
            const { data: existing, error } = await client
              .from("background_jobs")
              .select("id,status,error_message,session_id,workspace_id")
              .eq("id", input.proposalId)
              .maybeSingle();
            if (error) throw new Error("读取已确认任务失败，请重试确认。");
            if (existing) {
              if (
                existing.session_id !== sessionId ||
                existing.workspace_id !== workspaceId
              )
                throw new Error("任务不属于当前对话");
              if (
                existing.status === "failed" ||
                existing.status === "canceled" ||
                existing.status === "dead_letter"
              )
                return {
                  jobId: existing.id,
                  error:
                    existing.error_message ??
                    "任务已取消，请重新创建方案后确认。",
                };
              if (existing.status === "queued")
                await jobSvc.commitImageJob(user, existing.id);
              return { jobId: existing.id, status: "processing" };
            }
          }

          // ── Tier guard + credit checks (same as HTTP route) ──
          const billingModel = await resolveWorkspaceBillingModel(
            options.workspaceModelCatalogService,
            user,
            workspaceId,
            input.model,
            "image",
          );
          let creditsCost = 0;
          if (options.creditService && options.tierGuard) {
            const sub =
              await options.creditService.getSubscription(workspaceId);
            const quality = (input.quality as ImageQualityLevel) ?? "hd";
            try {
              options.tierGuard.checkModelAccess(sub.plan, billingModel);
              options.tierGuard.checkResolution(sub.plan, quality);
              await options.tierGuard.checkConcurrency(workspaceId, sub.plan);
            } catch (err) {
              if (err instanceof TierGuardError) {
                pushBillingErrorAndAbort(
                  run,
                  canvasId,
                  options,
                  err.code,
                  err.message,
                );
                throw err;
              }
              throw err;
            }
            creditsCost = options.tierGuard.calculateCreditCost(
              billingModel,
              "image_generation",
              { quality },
            );
          }

          // ── Balance pre-check: stop run immediately if insufficient ──
          if (options.creditService && creditsCost > 0) {
            const balanceInfo =
              await options.creditService.getBalance(workspaceId);
            if (balanceInfo.balance < creditsCost) {
              pushBillingErrorAndAbort(
                run,
                canvasId,
                options,
                "insufficient_credits",
                "Insufficient credits",
                {
                  currentBalance: balanceInfo.balance,
                  requiredAmount: creditsCost,
                  plan: balanceInfo.plan,
                  dailyClaimed: balanceInfo.dailyClaimed,
                },
              );
              throw new Error("Insufficient credits");
            }
          }

          if (run.controller.signal.aborted)
            throw new Error("Run was canceled");
          const placeholderElementId =
            canvasId && !input.target
              ? (input.proposalId ?? createCanvasElementId())
              : undefined;
          const requestedPlacement =
            canvasId && input.placementX != null && input.placementY != null
              ? {
                  x: input.placementX,
                  y: input.placementY,
                  width: input.placementWidth ?? 512,
                  height: input.placementHeight ?? 512,
                }
              : undefined;
          const designTarget = input.target;
          const {
            job,
            replayed: jobReplayed,
            billingCommitted,
          } = await jobSvc.createJobWithReplay(user, {
            workspaceId,
            ...(input.proposalId ? { proposalId: input.proposalId } : {}),
            ...(designTarget
              ? { target: designTarget }
              : canvasId
                ? { canvasId }
                : {}),
            ...(sessionId ? { sessionId } : {}),
            jobType: "image_generation",
            deferEnqueue: true,
            providerBilling: {
              creditsCost,
              pricingVersion: "credits-v1",
              unit: "image",
            },
            payload: {
              prompt: input.prompt,
              title: input.title,
              model: input.model,
              aspect_ratio: input.aspectRatio,
              ...(input.quality ? { quality: input.quality } : {}),
              ...(canvasId && !designTarget
                ? { auto_finalize_canvas: true }
                : {}),
              ...(placeholderElementId
                ? { placeholder_element_id: placeholderElementId }
                : {}),
              ...(requestedPlacement
                ? {
                    placement_x: requestedPlacement.x,
                    placement_y: requestedPlacement.y,
                    placement_width: requestedPlacement.width,
                    placement_height: requestedPlacement.height,
                  }
                : {}),
              ...(input.inputImages ? { input_images: input.inputImages } : {}),
            },
          });

          if (sessionId && !jobReplayed) {
            const pendingBlocks = [
              {
                type: "tool",
                toolCallId: `job-result-${job.id}`,
                toolName: "generate_image",
                status: "running",
                input: {
                  title: input.title,
                  model: input.model,
                  aspectRatio: input.aspectRatio,
                },
                output: {
                  status: "queued",
                  jobId: job.id,
                  jobType: "image_generation",
                },
                outputSummary: "图片任务正在提交或排队",
              },
            ];
            const { error: pendingChatError } = await client
              .from("chat_messages")
              .upsert(
                {
                  id: job.id,
                  session_id: sessionId,
                  role: "assistant",
                  content: "图片任务正在提交或排队",
                  content_blocks: pendingBlocks,
                },
                { onConflict: "id" },
              );
            if (pendingChatError) {
              console.error(
                "[submitImageJob] failed to persist chat placeholder:",
                pendingChatError,
              );
            }
          }

          if (canvasId && placeholderElementId && !jobReplayed) {
            try {
              await insertImageGenerationPlaceholder(
                client,
                {
                  canvasId,
                  elementId: placeholderElementId,
                  sourceJobId: job.id,
                  prompt: input.prompt,
                  title: input.title,
                  model: input.model,
                  aspectRatio: input.aspectRatio,
                  quality: input.quality ?? "hd",
                },
                requestedPlacement,
              );
              options.connectionManager?.pushToCanvas(canvasId, {
                type: "canvas.sync" as const,
                runId,
                timestamp: new Date().toISOString(),
              });
              jobLap("canvas_placeholder_inserted", {
                elementId: placeholderElementId,
              });
            } catch (placeholderError) {
              await jobSvc.cancelJob(user, job.id).catch(() => {});
              throw placeholderError;
            }
          }

          const markPlaceholderFailed = async (message: string) => {
            if (!canvasId || !placeholderElementId) return;
            try {
              await markImageGenerationPlaceholderFailed(
                client,
                canvasId,
                placeholderElementId,
                message,
              );
              options.connectionManager?.pushToCanvas(canvasId, {
                type: "canvas.sync" as const,
                runId,
                timestamp: new Date().toISOString(),
              });
            } catch (placeholderError) {
              console.error(
                "[submitImageJob] failed to update placeholder:",
                placeholderError,
              );
            }
          };

          // The durable job exists, but no worker can see it until billing is
          // committed. This prevents a provider call racing ahead of payment.
          let billing:
            | {
                estimate: number;
                charged: number;
                balanceAfter: number;
                currency: "credits";
              }
            | undefined;
          let charged = false;
          if (run.controller.signal.aborted && !jobReplayed) {
            await jobSvc.cancelJob(user, job.id).catch(() => {});
            await markPlaceholderFailed("生成已取消");
            return { jobId: job.id, error: "Run was canceled" };
          }
          try {
            if (input.proposalId) {
              await jobSvc.commitImageJob(user, job.id);
              return { jobId: job.id, status: "processing" };
            }
            if (jobReplayed && job.status !== "queued") {
              jobLap("job_replayed", { jobId: job.id });
            } else {
              if (run.controller.signal.aborted)
                throw new Error("Run was canceled");
              if (
                options.creditService &&
                creditsCost > 0 &&
                !billingCommitted
              ) {
                const deduction = options.creditService.deductCreditsIdempotent
                  ? await options.creditService.deductCreditsIdempotent(
                      workspaceId,
                      userId,
                      creditsCost,
                      job.id,
                      `Image generation: ${input.model}`,
                    )
                  : {
                      transactionId: await options.creditService.deductCredits(
                        workspaceId,
                        userId,
                        creditsCost,
                        job.id,
                        `Image generation: ${input.model}`,
                      ),
                      chargedNew: true,
                    };
                const txId = deduction.transactionId;
                charged = deduction.chargedNew;
                if (run.controller.signal.aborted)
                  throw new Error("Run was canceled");
                await jobSvc.setCreditsInfo(job.id, creditsCost, txId);
                const balanceAfter = (
                  await options.creditService.getBalance(workspaceId)
                ).balance;
                billing = {
                  estimate: creditsCost,
                  charged: creditsCost,
                  balanceAfter,
                  currency: "credits",
                };
              }
              if (run.controller.signal.aborted)
                throw new Error("Run was canceled");
              await jobSvc.enqueueJob(user, job.id);
            }
          } catch (billingOrEnqueueError) {
            if (input.proposalId) {
              // The RPC may have committed despite a lost response. Never cancel
              // or refund an ambiguously acknowledged atomic submission.
              return { jobId: job.id, status: "processing" };
            }
            if (!jobReplayed)
              await jobSvc.cancelJob(user, job.id).catch(() => {});
            await markPlaceholderFailed(
              billingOrEnqueueError instanceof Error
                ? billingOrEnqueueError.message
                : "图片生成任务创建失败",
            );
            if (charged && options.creditService) {
              await options.creditService
                .refundCredits(
                  workspaceId,
                  userId,
                  creditsCost,
                  job.id,
                  "Auto-refund: job was not enqueued",
                )
                .catch((refundError) => {
                  console.error(
                    "[submitImageJob] failed to refund unqueued job:",
                    refundError,
                  );
                });
            }
            if (
              billingOrEnqueueError instanceof CreditServiceError &&
              billingOrEnqueueError.code === "insufficient_credits" &&
              options.creditService
            ) {
              const balanceInfo = await options.creditService
                .getBalance(workspaceId)
                .catch(() => null);
              pushBillingErrorAndAbort(
                run,
                canvasId,
                options,
                "insufficient_credits",
                billingOrEnqueueError.message,
                balanceInfo
                  ? {
                      currentBalance: balanceInfo.balance,
                      requiredAmount: creditsCost,
                      plan: balanceInfo.plan,
                      dailyClaimed: balanceInfo.dailyClaimed,
                    }
                  : { requiredAmount: creditsCost },
              );
            }
            throw billingOrEnqueueError;
          }
          jobLap("job_created", {
            jobId: job.id,
            creditsCost,
            sessionId,
            runId,
          });

          // Poll until terminal state
          // Worker image VT=120s, but Replicate calls can take 100s+ plus queue delay.
          const POLL_INTERVAL = 2000;
          const MAX_WAIT = 240_000; // 4 minutes
          const start = Date.now();
          let pollCount = 0;

          while (Date.now() - start < MAX_WAIT) {
            await delay(POLL_INTERVAL);
            pollCount++;

            if (run.controller.signal.aborted) {
              await jobSvc.cancelJob(user, job.id).catch(() => {});
              await markPlaceholderFailed("生成已取消");
              return {
                jobId: job.id,
                error: "Run was canceled",
                ...(billing ? { billing } : {}),
              };
            }

            const current = await jobSvc.getJobAdmin(job.id);

            if (current.status === "succeeded" && current.result) {
              const result = current.result as {
                signed_url?: string;
                asset_id?: string;
                object_path?: string;
                width?: number;
                height?: number;
                mime_type?: string;
              };
              jobLap("job_poll_done", { pollCount, status: "succeeded" });

              if (input.target) {
                const finalization = await jobSvc.getTargetFinalization(
                  user,
                  job.id,
                );
                if (
                  !finalization ||
                  finalization.status === "pending" ||
                  finalization.status === "running"
                ) {
                  continue;
                }
                const finalized =
                  finalization.result &&
                  typeof finalization.result === "object" &&
                  !Array.isArray(finalization.result)
                    ? finalization.result
                    : {};
                const finalizationStatus = finalization.status;
                if (finalizationStatus !== "completed") {
                  return {
                    jobId: job.id,
                    error:
                      finalization.error_message ??
                      `Design finalization ${finalizationStatus}`,
                    finalization_status: finalizationStatus,
                    ...(billing ? { billing } : {}),
                  };
                }
                return {
                  jobId: job.id,
                  imageUrl: result.signed_url ?? "",
                  width: result.width ?? 1024,
                  height: result.height ?? 1024,
                  mimeType: result.mime_type ?? "image/png",
                  design_id:
                    typeof finalized.design_id === "string"
                      ? finalized.design_id
                      : input.target.design_id,
                  ...(typeof finalized.object_id === "string"
                    ? { object_id: finalized.object_id }
                    : {}),
                  ...(typeof finalized.revision === "number"
                    ? { revision: finalized.revision }
                    : {}),
                  finalization_status: finalizationStatus,
                  ...(finalized.preview_status === "queued" ||
                  finalized.preview_status === "failed" ||
                  finalized.preview_status === "unavailable"
                    ? { preview_status: finalized.preview_status }
                    : {}),
                  ...(billing ? { billing } : {}),
                };
              }

              // Write element directly to canvas (backend-driven insertion)
              let elementId: string | undefined;
              if (canvasId && result.object_path && result.asset_id) {
                try {
                  const writerClient = createClient(
                    accessToken,
                  ) as UserSupabaseClient;
                  const explicitPlacement =
                    (input as any).placementX != null &&
                    (input as any).placementY != null
                      ? {
                          x: (input as any).placementX,
                          y: (input as any).placementY,
                          width: (input as any).placementWidth ?? 512,
                          height: (input as any).placementHeight ?? 512,
                        }
                      : undefined;

                  const insertResult = await insertImageElement(
                    writerClient,
                    {
                      canvasId,
                      sourceJobId: job.id,
                      assetId: result.asset_id,
                      objectPath: result.object_path,
                      width: result.width ?? 1024,
                      height: result.height ?? 1024,
                      mimeType: result.mime_type ?? "image/png",
                      title: input.title,
                      prompt: input.prompt,
                      model: input.model,
                      ...(input.quality ? { quality: input.quality } : {}),
                      ...(placeholderElementId
                        ? { replaceElementId: placeholderElementId }
                        : {}),
                    },
                    explicitPlacement,
                  );
                  elementId = insertResult.elementId;

                  // Notify connected frontends to refresh canvas
                  options.connectionManager?.pushToCanvas(canvasId, {
                    type: "canvas.sync" as const,
                    runId,
                    timestamp: new Date().toISOString(),
                  });
                  jobLap("canvas_element_inserted", { elementId });
                } catch (insertErr) {
                  // Graceful degradation: log error but still return result
                  console.error(
                    "[submitImageJob] canvas insert failed:",
                    insertErr,
                  );
                }
              }

              return {
                jobId: job.id,
                ...(elementId != null ? { elementId } : {}),
                imageUrl: result.signed_url ?? "",
                width: result.width ?? 1024,
                height: result.height ?? 1024,
                mimeType: result.mime_type ?? "image/png",
                ...(billing ? { billing } : {}),
              };
            }

            if (
              current.status === "dead_letter" ||
              current.status === "canceled"
            ) {
              jobLap("job_poll_done", { pollCount, status: current.status });
              await markPlaceholderFailed(
                current.error_message ?? `任务状态：${current.status}`,
              );
              return {
                jobId: job.id,
                error: current.error_message ?? `Job ${current.status}`,
                ...(billing ? { billing } : {}),
              };
            }

            // "failed" with attempts exhausted
            if (
              current.status === "failed" &&
              current.attempt_count >= current.max_attempts
            ) {
              jobLap("job_poll_done", {
                pollCount,
                status: "failed_max_retries",
              });
              await markPlaceholderFailed(
                current.error_message ?? "图片生成失败，请重试",
              );
              return {
                jobId: job.id,
                error: current.error_message ?? "Job failed after max retries",
                ...(billing ? { billing } : {}),
              };
            }
          }

          jobLap("job_poll_done", { pollCount, status: "timeout" });
          return {
            jobId: job.id,
            error: `Job timed out after ${MAX_WAIT / 1000}s`,
            ...(billing ? { billing } : {}),
          };
        };

        submitVideoJob = async (input) => {
          const jobT0 = Date.now();
          const jobLap = (label: string, extra?: Record<string, unknown>) => {
            console.log(
              `[submitVideoJob] ${label} +${Date.now() - jobT0}ms`,
              extra ? JSON.stringify(extra) : "",
            );
          };

          const client = createClient(accessToken) as UserSupabaseClient;
          const { data: ws } = await client
            .from("workspaces")
            .select("id")
            .eq("type", "personal")
            .limit(1)
            .single();
          if (!ws?.id) throw new Error("No personal workspace found");

          const user: AuthenticatedUser = {
            id: userId,
            accessToken,
            email: "",
            userMetadata: {},
          };

          // ── Tier guard + credit checks (same as HTTP route) ──
          const workspaceId = ws.id;
          const billingModel = await resolveWorkspaceBillingModel(
            options.workspaceModelCatalogService,
            user,
            workspaceId,
            input.model,
            "video",
          );
          let creditsCost = 0;
          if (options.creditService && options.tierGuard) {
            const sub =
              await options.creditService.getSubscription(workspaceId);
            try {
              options.tierGuard.checkModelAccess(sub.plan, billingModel);
              if (input.resolution) {
                options.tierGuard.checkVideoResolution(
                  sub.plan,
                  input.resolution as any,
                );
              }
              await options.tierGuard.checkConcurrency(workspaceId, sub.plan);
            } catch (err) {
              if (err instanceof TierGuardError) {
                pushBillingErrorAndAbort(
                  run,
                  canvasId,
                  options,
                  err.code,
                  err.message,
                );
                throw err;
              }
              throw err;
            }
            creditsCost = options.tierGuard.calculateCreditCost(
              billingModel,
              "video_generation",
              {
                ...(input.duration != null ? { duration: input.duration } : {}),
                ...(input.resolution
                  ? { resolution: input.resolution as any }
                  : {}),
              },
            );
          }

          // ── Balance pre-check: stop run immediately if insufficient ──
          if (options.creditService && creditsCost > 0) {
            const balanceInfo =
              await options.creditService.getBalance(workspaceId);
            if (balanceInfo.balance < creditsCost) {
              pushBillingErrorAndAbort(
                run,
                canvasId,
                options,
                "insufficient_credits",
                "Insufficient credits",
                {
                  currentBalance: balanceInfo.balance,
                  requiredAmount: creditsCost,
                  plan: balanceInfo.plan,
                  dailyClaimed: balanceInfo.dailyClaimed,
                },
              );
              throw new Error("Insufficient credits");
            }
          }

          if (run.controller.signal.aborted)
            throw new Error("Run was canceled");
          const job = await jobSvc.createJob(user, {
            workspaceId,
            ...(canvasId ? { canvasId } : {}),
            ...(sessionId ? { sessionId } : {}),
            jobType: "video_generation",
            deferEnqueue: true,
            providerBilling: {
              creditsCost,
              pricingVersion: "credits-v1",
              unit: "second",
            },
            payload: {
              prompt: input.prompt,
              model: input.model,
              ...(input.duration != null ? { duration: input.duration } : {}),
              ...(input.resolution ? { resolution: input.resolution } : {}),
              ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
              ...(input.inputImages ? { input_images: input.inputImages } : {}),
              ...(input.inputVideo ? { input_video: input.inputVideo } : {}),
              ...(input.enableAudio != null
                ? { enable_audio: input.enableAudio }
                : {}),
            },
          });

          let billing:
            | {
                estimate: number;
                charged: number;
                balanceAfter: number;
                currency: "credits";
              }
            | undefined;
          let charged = false;
          if (run.controller.signal.aborted) {
            await jobSvc.cancelJob(user, job.id).catch(() => {});
            return { jobId: job.id, error: "Run was canceled" };
          }
          try {
            if (run.controller.signal.aborted)
              throw new Error("Run was canceled");
            if (options.creditService && creditsCost > 0) {
              const txId = await options.creditService.deductCredits(
                workspaceId,
                userId,
                creditsCost,
                job.id,
                `Video generation: ${input.model}`,
              );
              charged = true;
              if (run.controller.signal.aborted)
                throw new Error("Run was canceled");
              await jobSvc.setCreditsInfo(job.id, creditsCost, txId);
              const balanceAfter = (
                await options.creditService.getBalance(workspaceId)
              ).balance;
              billing = {
                estimate: creditsCost,
                charged: creditsCost,
                balanceAfter,
                currency: "credits",
              };
            }
            if (run.controller.signal.aborted)
              throw new Error("Run was canceled");
            await jobSvc.enqueueJob(user, job.id);
          } catch (billingOrEnqueueError) {
            await jobSvc.cancelJob(user, job.id).catch(() => {});
            if (charged && options.creditService) {
              await options.creditService
                .refundCredits(
                  workspaceId,
                  userId,
                  creditsCost,
                  job.id,
                  "Auto-refund: job was not enqueued",
                )
                .catch((refundError) => {
                  console.error(
                    "[submitVideoJob] failed to refund unqueued job:",
                    refundError,
                  );
                });
            }
            if (
              billingOrEnqueueError instanceof CreditServiceError &&
              billingOrEnqueueError.code === "insufficient_credits" &&
              options.creditService
            ) {
              const balanceInfo = await options.creditService
                .getBalance(workspaceId)
                .catch(() => null);
              pushBillingErrorAndAbort(
                run,
                canvasId,
                options,
                "insufficient_credits",
                billingOrEnqueueError.message,
                balanceInfo
                  ? {
                      currentBalance: balanceInfo.balance,
                      requiredAmount: creditsCost,
                      plan: balanceInfo.plan,
                      dailyClaimed: balanceInfo.dailyClaimed,
                    }
                  : { requiredAmount: creditsCost },
              );
            }
            throw billingOrEnqueueError;
          }
          jobLap("job_created", {
            jobId: job.id,
            creditsCost,
            sessionId,
            runId,
          });

          // Poll until terminal state — video generation is slower.
          // Google Vertex Veo can take 300-500s; 600s gives enough headroom
          // to avoid poll timeout while worker is still processing.
          const POLL_INTERVAL = 3000;
          const MAX_WAIT = 600_000; // 10 minutes
          const start = Date.now();
          let pollCount = 0;

          while (Date.now() - start < MAX_WAIT) {
            await delay(POLL_INTERVAL);
            pollCount++;

            if (run.controller.signal.aborted) {
              await jobSvc.cancelJob(user, job.id).catch(() => {});
              return {
                jobId: job.id,
                error: "Run was canceled",
                ...(billing ? { billing } : {}),
              };
            }

            const current = await jobSvc.getJobAdmin(job.id);

            if (current.status === "succeeded" && current.result) {
              const result = current.result as {
                signed_url?: string;
                asset_id?: string;
                duration_seconds?: number;
                width?: number;
                height?: number;
                mime_type?: string;
              };
              jobLap("job_poll_done", { pollCount, status: "succeeded" });

              // Write element directly to canvas (backend-driven insertion)
              let elementId: string | undefined;
              if (canvasId && result.signed_url && result.asset_id) {
                try {
                  const writerClient = createClient(
                    accessToken,
                  ) as UserSupabaseClient;
                  const explicitPlacement =
                    (input as any).placementX != null &&
                    (input as any).placementY != null
                      ? {
                          x: (input as any).placementX,
                          y: (input as any).placementY,
                          width: (input as any).placementWidth ?? 640,
                          height: (input as any).placementHeight ?? 360,
                        }
                      : undefined;

                  const insertResult = await insertVideoElement(
                    writerClient,
                    {
                      canvasId,
                      sourceJobId: job.id,
                      assetId: result.asset_id,
                      signedUrl: result.signed_url,
                      width: result.width ?? 1280,
                      height: result.height ?? 720,
                      mimeType: result.mime_type ?? "video/mp4",
                      ...(result.duration_seconds != null
                        ? { durationSeconds: result.duration_seconds }
                        : {}),
                      title: (input as any).title,
                      prompt: input.prompt,
                    },
                    explicitPlacement,
                  );
                  elementId = insertResult.elementId;

                  // Notify connected frontends to refresh canvas
                  options.connectionManager?.pushToCanvas(canvasId, {
                    type: "canvas.sync" as const,
                    runId,
                    timestamp: new Date().toISOString(),
                  });
                  jobLap("canvas_element_inserted", { elementId });
                } catch (insertErr) {
                  // Graceful degradation: log error but still return result
                  console.error(
                    "[submitVideoJob] canvas insert failed:",
                    insertErr,
                  );
                }
              }

              return {
                jobId: job.id,
                ...(elementId != null ? { elementId } : {}),
                videoUrl: result.signed_url ?? "",
                width: result.width ?? 1280,
                height: result.height ?? 720,
                mimeType: result.mime_type ?? "video/mp4",
                ...(result.duration_seconds != null
                  ? { durationSeconds: result.duration_seconds }
                  : {}),
                ...(billing ? { billing } : {}),
              };
            }

            if (
              current.status === "dead_letter" ||
              current.status === "canceled"
            ) {
              jobLap("job_poll_done", { pollCount, status: current.status });
              return {
                jobId: job.id,
                error: current.error_message ?? `Job ${current.status}`,
                ...(billing ? { billing } : {}),
              };
            }

            if (
              current.status === "failed" &&
              current.attempt_count >= current.max_attempts
            ) {
              jobLap("job_poll_done", {
                pollCount,
                status: "failed_max_retries",
              });
              return {
                jobId: job.id,
                error: current.error_message ?? "Job failed after max retries",
                ...(billing ? { billing } : {}),
              };
            }
          }

          jobLap("job_poll_done", { pollCount, status: "timeout" });
          return {
            jobId: job.id,
            error: `Job timed out after ${MAX_WAIT / 1000}s`,
            ...(billing ? { billing } : {}),
          };
        };
      }

      // Explicit generation approval is a product action, not another model
      // planning turn. This path survives model outages and cannot rewrite the
      // frozen proposal. Short ambiguous replies remain with the conversational Agent.
      if (
        submitImageJob &&
        options.createUserClient &&
        run.accessToken &&
        run.sessionId &&
        run.canvasId &&
        !run.imageConfirmation &&
        !isExplicitImageCancellation(run.prompt) &&
        !isExplicitImageConfirmationMessage(run.prompt) &&
        /改|换|调整|不要|取消|不同意|重新|再来|再做|增加|删除|去掉|尺寸|比例/.test(
          run.prompt,
        )
      ) {
        const { error } = await (
          options.createUserClient(run.accessToken) as any
        ).rpc("loomic_invalidate_image_proposals", {
          p_session: run.sessionId,
          p_canvas: run.canvasId,
        });
        if (error) {
          const failure = new Error(
            "旧图片方案无法作废，已停止本轮操作，请稍后重试。",
          );
          run.status = "failed";
          await updatePersistedRunFailure(
            options.agentRunMetadataService,
            run,
            now,
            failure,
          );
          yield toFailedEvent(runId, now, failure);
          return;
        }
      }
      if (
        submitImageJob &&
        options.createUserClient &&
        options.destructiveConfirmationService &&
        run.accessToken &&
        run.userId &&
        run.sessionId &&
        run.canvasId &&
        (run.imageConfirmation ||
          /^(确认生成|确认并生成|开始生成|继续生成|取消生成)[。！!\s]*$/.test(
            run.prompt.trim(),
          ))
      ) {
        const context = {
          access_token: run.accessToken,
          user_id: run.userId,
          canvas_id: run.canvasId,
          session_id: run.sessionId,
          run_id: run.runId,
          workspace_id: run.workspaceId,
          user_prompt: run.prompt,
        };
        const store = createImageProposalStore(options.createUserClient);
        try {
          const latest = await store.latest(context);
          if (latest || run.imageConfirmation) {
            const toolCallId = randomUUID();
            const toolInput = run.imageConfirmation ?? {
              confirmationId: latest!.id,
              decision: run.prompt.startsWith("取消")
                ? ("cancel" as const)
                : ("confirm" as const),
            };
            yield {
              type: "run.started",
              runId,
              conversationId: run.conversationId,
              sessionId: run.sessionId,
              timestamp: now(),
            };
            yield {
              type: "tool.started",
              runId,
              toolCallId,
              toolName: "confirm_image_generation",
              input: toolInput,
              timestamp: now(),
            };
            const output = (await createImageGenerationConfirmationTool({
              confirmationService: options.destructiveConfirmationService,
              proposalStore: store,
              submitImageJob,
              validateDesignTarget: createDesignImageTargetValidator({
                createUserClient: options.createUserClient,
                ...(options.designTools
                  ? { designTools: options.designTools }
                  : {}),
              }),
            }).invoke(toolInput, { configurable: context })) as Record<
              string,
              unknown
            >;
            const summary =
              typeof output.summary === "string"
                ? output.summary
                : "图片任务状态已更新";
            const event: StreamEvent = {
              type: "tool.completed",
              runId,
              toolCallId,
              toolName: "confirm_image_generation",
              output,
              outputSummary: summary,
              timestamp: now(),
            };
            await syncPersistedRunFromEvent(
              options.agentRunMetadataService,
              run,
              event,
              now,
            );
            yield event;
            // The worker owns the job-result message; never overwrite it here.
            const { error: chatError } = await (
              options.createUserClient(run.accessToken) as UserSupabaseClient
            )
              .from("chat_messages")
              .upsert(
                {
                  id: runId,
                  session_id: run.sessionId,
                  role: "assistant",
                  content: summary,
                  content_blocks: [
                    {
                      type: "tool",
                      toolCallId,
                      toolName: "confirm_image_generation",
                      status: "completed",
                      output,
                      outputSummary: summary,
                    },
                  ] as any,
                },
                { onConflict: "id" },
              );
            if (chatError)
              console.warn(
                "[image-confirmation] Chat status persistence deferred:",
                chatError.message,
              );
            const completed: StreamEvent = {
              type: "run.completed",
              runId,
              timestamp: now(),
            };
            run.status = "completed";
            await syncPersistedRunFromEvent(
              options.agentRunMetadataService,
              run,
              completed,
              now,
            );
            yield completed;
            return;
          }
        } catch (error) {
          const failed = toFailedEvent(runId, now, error);
          run.status = "failed";
          await updatePersistedRunFailure(
            options.agentRunMetadataService,
            run,
            now,
            error,
          );
          yield failed;
          return;
        }
      }

      // Load workspace skills (user-installed skills from DB).
      // Done before backend creation so we know whether to add the
      // /workspace-skills/ Store route.
      let workspaceSkills: WorkspaceSkillEntry[] = [];
      let availableImageModels: AvailableModel[] = [];
      let availableVideoModels: AvailableVideoModel[] = [];
      if (run.canvasId && run.accessToken && options.createUserClient) {
        try {
          const wsClient = options.createUserClient(
            run.accessToken,
          ) as UserSupabaseClient;
          workspaceSkills = await loadWorkspaceSkills(wsClient, run.canvasId);
          rlog.lap("workspace_skills_loaded", {
            count: workspaceSkills.length,
          });
        } catch (err) {
          // Non-fatal: agent runs without workspace skills
          console.warn("[runtime] Failed to load workspace skills:", err);
        }
      }

      if (
        run.workspaceId &&
        run.userId &&
        run.accessToken &&
        options.workspaceModelCatalogService
      ) {
        try {
          const catalog =
            await options.workspaceModelCatalogService.listPublished(
              {
                id: run.userId,
                accessToken: run.accessToken,
                email: "",
                userMetadata: {},
              },
              run.workspaceId,
            );
          availableImageModels = catalog
            .filter((entry) => entry.model.modality === "image")
            .map((entry) => ({
              id: entry.model.id,
              displayName: entry.model.displayName,
              description: `${entry.model.providerDisplayName} 工作区图片模型`,
              provider: entry.model.providerDisplayName,
            }));
          availableVideoModels = catalog
            .filter((entry) => entry.model.modality === "video")
            .map((entry) => ({
              id: entry.model.id,
              displayName: entry.model.displayName,
              description: `${entry.model.providerDisplayName} 工作区视频模型`,
              provider: entry.model.providerDisplayName,
              capabilities: {
                textToVideo: true,
                imageToVideo: true,
                videoToVideo: false,
                audio: true,
              },
              limits: {
                maxDuration: 16,
                maxResolution: "1080p" as const,
                maxInputImages: 2,
              },
            }));
          rlog.lap("workspace_generation_models_loaded", {
            image: availableImageModels.length,
            video: availableVideoModels.length,
          });
        } catch (error) {
          console.warn(
            "[runtime] Failed to load workspace generation models:",
            error,
          );
        }
      }

      // Create backend — production uses StateBackend (no local shell).
      const backendResult = createAgentBackend(options.env, run.canvasId, {
        hasWorkspaceSkills: workspaceSkills.length > 0,
      });

      try {
        let agent: LoomicAgent;
        let resolvedModelForRun: BaseLanguageModel | string | undefined;
        try {
          let resolvedModel: BaseLanguageModel | string | undefined;
          if (run.modelOverride?.startsWith("workspace:")) {
            if (!run.workspaceId || !options.providerSnapshotService) {
              const error = new Error(
                "Workspace provider snapshot service is unavailable.",
              );
              (error as Error & { code?: string }).code =
                "provider_snapshot_invalid";
              throw error;
            }
            resolvedModel = await resolveWorkspaceChatModel({
              modelRef: run.modelOverride,
              providerSnapshotService: options.providerSnapshotService,
              runId: run.runId,
              workspaceId: run.workspaceId,
            });
          } else {
            resolvedModel = run.modelOverride
              ? run.modelOverride.includes(":")
                ? run.modelOverride
                : createDefaultModelSpecifier({ agentModel: run.modelOverride })
              : options.model;
          }
          resolvedModelForRun = resolvedModel;

          // Build persistImage closure using the user's Supabase client.
          // Client creation is deferred into the closure so it only runs
          // when an image is actually generated (avoids throwing in tests
          // that don't configure Supabase env vars).
          let persistImage:
            | ((url: string, mime: string, prompt: string) => Promise<string>)
            | undefined;
          if (options.createUserClient && run.accessToken) {
            const createClient = options.createUserClient;
            const accessToken = run.accessToken;
            persistImage = async (sourceUrl, mimeType, prompt) => {
              const client = createClient(accessToken) as UserSupabaseClient;
              const downloaded = await safeDownload(sourceUrl, {
                kind: "image",
                maxBytes: 30 * 1024 * 1024,
                timeoutMs: 60_000,
                maxRedirects: 2,
                allowDataUri: true,
                expectedMimeType: mimeType,
                allowedMimeTypes: [
                  "image/png",
                  "image/jpeg",
                  "image/webp",
                  "image/avif",
                ],
              });
              const buffer = downloaded.buffer;
              mimeType = downloaded.mimeType;
              const ext = mimeType === "image/webp" ? "webp" : "png";
              const slug = prompt
                .slice(0, 40)
                .replace(/[^a-zA-Z0-9]+/g, "-")
                .replace(/^-|-$/g, "");
              const fileName = `gen-${slug}-${Date.now()}.${ext}`;

              const { data: ws } = await client
                .from("workspaces")
                .select("id")
                .eq("type", "personal")
                .limit(1)
                .single();
              const workspaceId = ws?.id ?? "default";
              const objectPath = `${workspaceId}/${Date.now()}-${fileName}`;

              const { error: uploadError } = await client.storage
                .from("workspace-assets")
                .upload(objectPath, buffer, {
                  contentType: mimeType,
                  upsert: false,
                });
              if (uploadError)
                throw new Error(`Upload failed: ${uploadError.message}`);

              const { data: urlData, error: urlError } = await client.storage
                .from("workspace-assets")
                .createSignedUrl(objectPath, 900);
              if (urlError || !urlData?.signedUrl) {
                throw new Error("Failed to create private artifact URL");
              }

              return urlData.signedUrl;
            };
          }

          // Resolve brand kit ID from canvas → project in a single joined query
          let brandKitId: string | null = null;
          if (run.canvasId && run.accessToken && options.createUserClient) {
            try {
              const client = options.createUserClient(run.accessToken) as any;
              const { data: canvas } = await client
                .from("canvases")
                .select("project_id, projects!inner(brand_kit_id)")
                .eq("id", run.canvasId)
                .maybeSingle();
              brandKitId = canvas?.projects?.brand_kit_id ?? null;
            } catch (err) {
              // Fallback: joined query may fail if FK isn't exposed via PostgREST
              // In that case, try the two-step approach
              try {
                const client = options.createUserClient(run.accessToken) as any;
                const { data: c } = await client
                  .from("canvases")
                  .select("project_id")
                  .eq("id", run.canvasId)
                  .maybeSingle();
                if (c?.project_id) {
                  const { data: p } = await client
                    .from("projects")
                    .select("brand_kit_id")
                    .eq("id", c.project_id)
                    .maybeSingle();
                  brandKitId = p?.brand_kit_id ?? null;
                }
              } catch (err2) {
                console.warn("Failed to resolve brand kit ID:", err2);
              }
            }
          }

          rlog.lap("brand_kit_resolved");

          // Pre-write workspace skill SKILL.md files AND associated files
          // (scripts/, references/, assets/) into the Store so the agent can
          // read_file them via the /workspace-skills/ route.
          const store = persistence?.store;
          if (workspaceSkills.length > 0 && store && run.canvasId) {
            const storeNamespace = [
              "projects",
              run.canvasId,
              "workspace-skills",
            ];
            const now_ = new Date().toISOString();

            const writeOps: Promise<void>[] = [];
            for (const skill of workspaceSkills) {
              // Write SKILL.md
              writeOps.push(
                store.put(storeNamespace, `/${skill.name}/SKILL.md`, {
                  content: skill.content.split("\n"),
                  created_at: now_,
                  modified_at: now_,
                }),
              );
              // Write associated files (scripts/, references/, assets/)
              for (const file of skill.files) {
                writeOps.push(
                  store.put(storeNamespace, `/${skill.name}/${file.path}`, {
                    content: file.content.split("\n"),
                    created_at: now_,
                    modified_at: now_,
                  }),
                );
              }
            }

            await Promise.all(writeOps);
            const totalFiles = workspaceSkills.reduce(
              (sum, s) => sum + s.files.length,
              0,
            );
            rlog.lap("workspace_skills_stored", {
              count: workspaceSkills.length,
              files: totalFiles,
            });
          }

          agent = resolvedAgentFactory({
            backendResult,
            ...(brandKitId ? { brandKitId } : {}),
            ...(run.canvasId ? { canvasId: run.canvasId } : {}),
            ...(persistence ? { checkpointer: persistence.checkpointer } : {}),
            ...(options.connectionManager
              ? { connectionManager: options.connectionManager }
              : {}),
            ...(options.destructiveConfirmationService
              ? {
                  destructiveConfirmationService:
                    options.destructiveConfirmationService,
                }
              : {}),
            env: options.env,
            executionMode: run.executionMode,
            ...(resolvedModelForRun ? { model: resolvedModelForRun } : {}),
            ...(persistImage ? { persistImage } : {}),
            // execute 工具由 LocalShellBackend 自动提供，无需手动传递
            ...(submitImageJob ? { submitImageJob } : {}),
            ...(submitVideoJob ? { submitVideoJob } : {}),
            ...(persistence ? { store: persistence.store } : {}),
            ...(workspaceSkills.length > 0 ? { workspaceSkills } : {}),
            availableImageModels,
            availableVideoModels,
          });
          rlog.lap("agent_factory_done");
        } catch (error) {
          const failedEvent = toFailedEvent(runId, now, error);
          run.status = "failed";
          await updatePersistedRunFailure(
            options.agentRunMetadataService,
            run,
            now,
            error,
          );
          yield failedEvent;
          return;
        }

        let stream: AsyncIterable<unknown>;
        try {
          // Auto-inject canvas state summary so the agent has immediate awareness
          // of what's on the canvas without needing to call inspect_canvas first.
          let canvasSummary: string | null = null;
          let canvasContentForAttachments: Record<string, any> | null = null;
          if (run.canvasId && run.accessToken && options.createUserClient) {
            try {
              const canvasClient = options.createUserClient(
                run.accessToken,
              ) as any;
              const { data: canvasData } = await canvasClient
                .from("canvases")
                .select("content")
                .eq("id", run.canvasId)
                .single();
              if (canvasData?.content?.elements) {
                canvasContentForAttachments = canvasData.content as Record<
                  string,
                  any
                >;
                canvasSummary = buildCanvasSummaryForContext(
                  canvasData.content.elements as Array<Record<string, unknown>>,
                );
              }
            } catch {
              // Non-critical — agent can still call inspect_canvas manually
            }
          }

          const hasAttachments = run.attachments && run.attachments.length > 0;
          let userMessage: HumanMessage;
          let attachmentDataMap: Record<string, string> = {};

          if (hasAttachments) {
            // Resolve the original once. A lightweight derived image is sent
            // to the vision preprocessor, while tools retain the original.
            const attachmentClient =
              run.accessToken && options.createUserClient
                ? (options.createUserClient(
                    run.accessToken,
                  ) as UserSupabaseClient)
                : null;
            const resolvedAttachments = await Promise.all(
              run.attachments!.map(async (a) => {
                try {
                  if (!attachmentClient)
                    throw new Error("attachment_auth_required");
                  const resolved = await resolveAgentImageAttachment({
                    client: attachmentClient,
                    attachment: a,
                    canvasContent: canvasContentForAttachments,
                    ...(process.env.SUPABASE_URL
                      ? { supabaseUrl: process.env.SUPABASE_URL }
                      : {}),
                  });
                  return {
                    attachment: a,
                    original: {
                      assetId: a.assetId,
                      mimeType: resolved.mimeType,
                      base64: resolved.buffer.toString("base64"),
                    },
                    vision: await optimizeAgentVisionAttachment(resolved),
                  };
                } catch (error) {
                  console.warn(
                    `[runtime] Attachment rejected assetId=${a.assetId}: ${error instanceof Error ? error.message : "unknown"}`,
                  );
                  return null;
                }
              }),
            );

            const accepted = resolvedAttachments.filter(
              (item): item is NonNullable<typeof item> => item !== null,
            );
            const downloaded = accepted.map((item) => item.original);
            const visionInputs = accepted.map((item) => ({
              assetId: item.attachment.assetId,
              dataUri: `data:${item.vision.mimeType};base64,${item.vision.buffer.toString("base64")}`,
              ...(item.attachment.name ? { name: item.attachment.name } : {}),
            }));

            const acceptedAssetIds = new Set(
              downloaded.map((item) => item.assetId),
            );
            const acceptedAttachments = run.attachments!.filter((item) =>
              acceptedAssetIds.has(item.assetId),
            );

            // Build XML text tags for LLM to reference by assetId
            const { text: enrichedPrompt } = buildUserMessage(
              run.prompt,
              acceptedAttachments,
              run.imageGenerationPreference,
              run.mentions,
              run.videoGenerationPreference,
              canvasSummary,
            );

            // Build assetId → data URI map for tool-level resolution
            attachmentDataMap = buildAttachmentDataMap(downloaded);

            // Keep binary image content out of the DeepAgent checkpoint. A
            // lightweight no-tools vision pass converts it to durable text;
            // the original remains available to generation tools this turn.
            let visionAnalysis: string | null = null;
            try {
              const visionModel =
                typeof resolvedModelForRun === "object"
                  ? resolvedModelForRun
                  : createStreamingChatModel(
                      resolvedModelForRun ??
                        createDefaultModelSpecifier(options.env),
                      "fast",
                    );
              const analysisSignal = AbortSignal.any([
                run.controller.signal,
                AbortSignal.timeout(20_000),
              ]);
              visionAnalysis = await analyzeAgentVisionAttachments({
                images: visionInputs,
                model: visionModel,
                prompt: run.prompt,
                signal: analysisSignal,
              });
              rlog.lap("attachments_analyzed", {
                count: visionInputs.length,
                originalBytes: accepted.reduce(
                  (sum, item) => sum + item.original.base64.length,
                  0,
                ),
                visionBytes: visionInputs.reduce(
                  (sum, item) => sum + item.dataUri.length,
                  0,
                ),
              });
            } catch (error) {
              console.warn(
                `[runtime] Vision preprocessing failed; using optimized inline images: ${error instanceof Error ? error.message : "unknown"}`,
              );
            }

            userMessage = visionAnalysis
              ? new HumanMessage(
                  `${enrichedPrompt}\n\n<reference_image_analysis source="vision_preprocessor">\n${escapeXmlText(visionAnalysis)}\n</reference_image_analysis>`,
                )
              : new HumanMessage({
                  content: [
                    { type: "text" as const, text: enrichedPrompt },
                    ...visionInputs.map((image) => ({
                      type: "image_url" as const,
                      image_url: { url: image.dataUri },
                    })),
                  ],
                });
          } else {
            const { text: enrichedPrompt } = buildUserMessage(
              run.prompt,
              [],
              run.imageGenerationPreference,
              run.mentions,
              run.videoGenerationPreference,
              canvasSummary,
            );
            userMessage = new HumanMessage(enrichedPrompt);
          }

          let inputMessages: BaseMessage[] = [userMessage];
          if (
            checkpointHistoryRecoveryNeeded &&
            run.sessionId &&
            run.accessToken &&
            options.createUserClient
          ) {
            inputMessages = await loadPersistedConversationForRecovery({
              accessToken: run.accessToken,
              createUserClient: options.createUserClient,
              currentPrompt: run.prompt,
              sessionId: run.sessionId,
              userMessage,
            });
            rlog.lap("checkpoint_history_loaded", {
              count: inputMessages.length,
            });
          }

          rlog.lap("stream_call_start");
          stream = agent.streamEvents(
            {
              messages: inputMessages,
            },
            {
              ...(run.threadId ||
              run.canvasId ||
              run.accessToken ||
              run.userId ||
              run.prompt ||
              Object.keys(attachmentDataMap).length > 0
                ? {
                    configurable: {
                      ...(run.threadId ? { thread_id: run.threadId } : {}),
                      ...(run.canvasId ? { canvas_id: run.canvasId } : {}),
                      ...(run.accessToken
                        ? { access_token: run.accessToken }
                        : {}),
                      ...(run.userId ? { user_id: run.userId } : {}),
                      ...(run.workspaceId
                        ? { workspace_id: run.workspaceId }
                        : {}),
                      run_id: run.runId,
                      ...(run.sessionId ? { session_id: run.sessionId } : {}),
                      ...(run.prompt ? { user_prompt: run.prompt } : {}),
                      ...(Object.keys(attachmentDataMap).length > 0
                        ? { user_attachment_map: attachmentDataMap }
                        : {}),
                    },
                  }
                : {}),
              signal: run.controller.signal,
              version: "v2",
            },
          );
          rlog.lap("stream_call_returned");
        } catch (error) {
          const failedEvent = toFailedEvent(runId, now, error);
          run.status = "failed";
          await updatePersistedRunFailure(
            options.agentRunMetadataService,
            run,
            now,
            error,
          );
          yield failedEvent;
          return;
        }

        try {
          for await (const event of adaptDeepAgentStream({
            conversationId: run.conversationId,
            now,
            runId,
            sessionId: run.sessionId,
            signal: run.controller.signal,
            stream,
          })) {
            run.status = mapEventToStatus(event);
            try {
              await syncPersistedRunFromEvent(
                options.agentRunMetadataService,
                run,
                event,
                now,
              );
            } catch (error) {
              const failedEvent = toFailedEvent(runId, now, error);
              run.status = "failed";
              yield failedEvent;
              return;
            }
            yield event;

            if (!isTerminalEvent(event) && options.eventDelayMs) {
              try {
                await delay(options.eventDelayMs, undefined, {
                  signal: run.controller.signal,
                });
              } catch {
                run.status = "canceled";
                yield {
                  runId,
                  timestamp: now(),
                  type: "run.canceled",
                };
                return;
              }
            }
          }
        } catch (streamError) {
          // Catch DB / checkpoint errors that bubble up from the LangGraph stream
          // (e.g. Supabase circuit-breaker, connection pool exhaustion).
          // Instead of crashing the process, yield a clean failure event.
          console.error(
            "[agent-runtime] Stream iteration failed:",
            streamError,
          );
          const failedEvent = toFailedEvent(runId, now, streamError);
          run.status = "failed";
          await updatePersistedRunFailure(
            options.agentRunMetadataService,
            run,
            now,
            streamError,
          ).catch((persistErr) =>
            console.error(
              "[agent-runtime] Failed to persist run failure:",
              persistErr,
            ),
          );
          yield failedEvent;
          return;
        }
      } finally {
        if (backendResult.sandboxDir) {
          rm(backendResult.sandboxDir, { recursive: true, force: true }).catch(
            (err) => console.warn("[sandbox] cleanup failed:", err.message),
          );
        }
      }
    },
  };
}

export async function repairCorruptedThreadCheckpoint(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
): Promise<boolean> {
  const tuple = await retryTransientCheckpointOperation(
    () =>
      checkpointer.getTuple({
        configurable: { thread_id: threadId },
      }),
    "read",
  );
  // A session can retain durable chat rows after its graph checkpoint has
  // been removed. Signal the caller to rebuild graph context from those rows.
  if (!tuple) return true;
  const channelValues = tuple?.checkpoint.channel_values as
    | { messages?: unknown[] }
    | undefined;
  const hasCorruptedMessage = channelValues?.messages?.some((message) => {
    if (!message || typeof message !== "object") return false;
    const serialized = message as {
      id?: unknown;
      lc?: unknown;
      type?: unknown;
    };
    return (
      (serialized.lc === 1 &&
        serialized.type === "not_implemented" &&
        Array.isArray(serialized.id) &&
        serialized.id.includes("messages")) ||
      containsLegacyStringImageUrl(message)
    );
  });

  if (!hasCorruptedMessage) return false;

  console.warn(
    `[runtime] Resetting incompatible LangGraph checkpoint for thread ${threadId}`,
  );
  await retryTransientCheckpointOperation(
    () => checkpointer.deleteThread(threadId),
    "delete",
  );
  return true;
}

/**
 * Older checkpoints may contain the permissive `image_url: "data:..."`
 * content shape. Strict OpenAI-compatible providers reject the entire
 * conversation when that historical message is replayed, even if the current
 * request uses the correct `{ url }` shape.
 */
function containsLegacyStringImageUrl(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== "object") return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.some(visit);

    const record = candidate as Record<string, unknown>;
    if (record.type === "image_url" && typeof record.image_url === "string") {
      return true;
    }
    return Object.values(record).some(visit);
  };
  return visit(value);
}

async function retryTransientCheckpointOperation<T>(
  operation: () => Promise<T>,
  operationName: string,
): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        !isTransientCheckpointConnectionError(error) ||
        attempt === maxAttempts
      ) {
        throw error;
      }
      console.warn(
        `[runtime] Checkpoint ${operationName} connection failed; retrying (${attempt}/${maxAttempts - 1})`,
      );
      await delay(150 * attempt);
    }
  }
  throw new Error("Checkpoint operation retry exhausted");
}

export function isTransientCheckpointConnectionError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code.toUpperCase() : "";
  const message =
    typeof value?.message === "string" ? value.message.toLowerCase() : "";
  return (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "57P01",
      "57P02",
      "57P03",
    ].includes(code) ||
    [
      "connection terminated unexpectedly",
      "connection terminated",
      "connection closed unexpectedly",
      "connection timeout",
      "socket hang up",
    ].some((fragment) => message.includes(fragment))
  );
}

async function loadPersistedConversationForRecovery(input: {
  accessToken: string;
  createUserClient: (accessToken: string) => unknown;
  currentPrompt: string;
  sessionId: string;
  userMessage: HumanMessage;
}): Promise<BaseMessage[]> {
  const client = input.createUserClient(
    input.accessToken,
  ) as UserSupabaseClient;
  const { data, error } = await client
    .from("chat_messages")
    .select("role, content, created_at")
    .eq("session_id", input.sessionId)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const history: Array<{ content: string; role: "assistant" | "user" }> = [];
  for (const row of data ?? []) {
    if ((row.role !== "assistant" && row.role !== "user") || !row.content) {
      continue;
    }
    const previous = history.at(-1);
    if (previous?.role === row.role && previous.content === row.content)
      continue;
    history.push({ content: row.content, role: row.role });
  }

  const normalizedCurrentPrompt = normalizeRecoveryPrompt(input.currentPrompt);
  while (
    history.at(-1)?.role === "user" &&
    normalizeRecoveryPrompt(history.at(-1)?.content ?? "") ===
      normalizedCurrentPrompt
  ) {
    history.pop();
  }

  const recovered = history
    .slice(-30)
    .map((message) =>
      message.role === "assistant"
        ? new AIMessage(message.content)
        : new HumanMessage(message.content),
    );
  recovered.push(input.userMessage);
  return recovered;
}

function normalizeRecoveryPrompt(value: string): string {
  return value.trim().replace(/[\s。.!！?？]+$/u, "");
}

function isTerminalEvent(event: StreamEvent) {
  return (
    event.type === "run.canceled" ||
    event.type === "run.completed" ||
    event.type === "run.failed"
  );
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
  // Log full error detail server-side
  console.error(`[runtime] Agent run failed for run ${runId}:`, error);

  return {
    error: {
      code: "run_failed",
      message: sanitizeErrorForClient(error),
    },
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

  await agentRunMetadataService.updateRun({
    completedAt: now(),
    errorCode: "run_failed",
    errorMessage: sanitizeErrorForClient(error),
    runId: run.runId,
    status: "failed",
  });
}

async function resolveWorkspaceBillingModel(
  catalog: WorkspaceModelCatalogService | undefined,
  user: AuthenticatedUser,
  workspaceId: string,
  modelRef: string,
  modality: "image" | "video",
) {
  if (!modelRef.startsWith("workspace:")) return modelRef;
  const resolved = catalog
    ? await catalog.resolvePublishedModel(user, workspaceId, modelRef, modality)
    : null;
  if (!resolved) {
    const error = new Error(
      "Workspace model is unavailable or has not passed its connection test.",
    );
    (error as Error & { code?: string }).code = "provider_snapshot_invalid";
    throw error;
  }
  return resolved.upstreamModelId;
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
      new Error(event.error.message),
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
