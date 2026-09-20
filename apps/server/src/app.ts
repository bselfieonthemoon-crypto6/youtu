import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { safeRequestLoggerOptions } from "./utils/request-logger.js";

import { createAgentRunService, resolveAgentRuntimeMode } from "./agent/runtime.js";
import type { MastraRunFactory } from "./agent/mastra-run-types.js";
import { createAgentTaskService } from "./features/agent-tasks/agent-task-service.js";
import { createAgentContextService } from "./features/agent-context/agent-context-service.js";
import { createPromptLibraryService } from "./features/prompt-library/prompt-library-service.js";
import {
  type RetryableReadToolExecutor,
  createRetryableReadToolExecutor,
} from "./agent/tools/read-tool-registry.js";
import {
  type ServerEnv,
  loadServerEnv,
  resolveDefaultAgentModel,
} from "./config/env.js";
import { createDestructiveConfirmationService } from "./features/agent-actions/destructive-confirmation-service.js";
import { createDurableActionConfirmationStore } from "./features/agent-actions/durable-action-confirmation-store.js";
import { createConfirmedActionAppliedHandler, createDurableDesignMutationExecutor } from "./agent/tools/design-tools.js";
import {
  type AgentRunMetadataService,
  createAgentRunMetadataService,
} from "./features/agent-runs/agent-run-service.js";
import {
  type ToolExecutionService,
  createToolExecutionService,
} from "./features/agent-runs/tool-execution-service.js";
import {
  type ViewerService,
  createViewerService,
} from "./features/bootstrap/ensure-user-foundation.js";
import {
  type BrandKitService,
  createBrandKitService,
} from "./features/brand-kit/brand-kit-service.js";
import {
  type CanvasService,
  createCanvasService,
} from "./features/canvas/canvas-service.js";
import {
  type ChatService,
  createChatService,
} from "./features/chat/chat-service.js";
import {
  type ThreadService,
  createThreadService,
} from "./features/chat/thread-service.js";
import {
  type CreditService,
  createCreditService,
} from "./features/credits/credit-service.js";
import {
  type TierGuard,
  createTierGuard,
} from "./features/credits/tier-guard.js";
import {
  type DesignCatalogAdminService,
  createDesignCatalogAdminService,
} from "./features/design-resources/design-catalog-admin-service.js";
import {
  type DesignCatalogReadService,
  createDesignCatalogReadService,
} from "./features/design-resources/design-catalog-read-service.js";
import {
  type DesignImportApiService,
  createDesignImportApiService,
} from "./features/design-resources/design-import-api-service.js";
import {
  type DesignResourceService,
  createDesignResourceService,
} from "./features/design-resources/design-resource-service.js";
import {
  type DesignTemplateService,
  createDesignTemplateService,
} from "./features/design-resources/design-template-service.js";
import { DesignExportService } from "./features/designs/design-export-service.js";
import {
  DesignOutboxService,
  createConnectionManagerDesignBroadcaster,
  createSupabaseDesignOutboxRepository,
  startDesignOutboxDispatcher,
} from "./features/designs/design-outbox-service.js";
import {
  DesignPreviewService,
  createSupabaseDesignPreviewRepository,
} from "./features/designs/design-preview-service.js";
import {
  type DesignService,
  createDesignService,
} from "./features/designs/design-service.js";
import {
  type ImageTextRecognizer,
  createImageTextRecognizer,
} from "./features/images/image-text-recognizer.js";
import {
  type LayerElementSuggester,
  createLayerElementSuggester,
} from "./features/images/layer-element-suggester.js";
import {
  type JobService,
  createJobService,
} from "./features/jobs/job-service.js";
import {
  type WorkspaceMemberService,
  createWorkspaceMemberService,
} from "./features/members/index.js";
import {
  createSupabaseCanvasAuthorizationCheck,
  createSupabaseRealtimeFanoutRepository,
  RealtimeFanoutService as DurableRealtimeFanoutService,
  startRealtimeFanoutDispatcher,
} from "./features/realtime/realtime-fanout-service.js";
import { createLemonSqueezyClient } from "./features/payments/lemon-squeezy-client.js";
import {
  type PaymentService,
  buildVariantMap,
  createPaymentService,
} from "./features/payments/payment-service.js";
import {
  type ProjectService,
  createProjectService,
} from "./features/projects/project-service.js";
import {
  type ProviderConfigService,
  type ProviderSnapshotService,
  type WorkspaceModelCatalogService,
  createProviderConfigService,
  createProviderSnapshotService,
  createWorkspaceModelCatalogService,
} from "./features/providers/index.js";
import {
  type SettingsService,
  createSettingsService,
} from "./features/settings/settings-service.js";
import {
  type UploadService,
  createUploadService,
} from "./features/uploads/upload-service.js";
import { registerAllProviders } from "./generation/providers/register-all.js";
import { registerBrandKitRoutes } from "./http/brand-kits.js";
import { registerCanvasRoutes } from "./http/canvases.js";
import { registerChatRoutes } from "./http/chat.js";
import { registerCreditRoutes } from "./http/credits.js";
import { registerDesignAsyncRoutes } from "./http/design-async.js";
import { registerDesignCatalogAdminRoutes } from "./http/design-catalog-admin.js";
import { registerDesignCatalogReadRoutes } from "./http/design-catalog-read.js";
import { registerDesignImportRoutes } from "./http/design-imports.js";
import { registerDesignResourceRoutes } from "./http/design-resources.js";
import { registerDesignTemplateRoutes } from "./http/design-templates.js";
import { registerDesignRoutes } from "./http/designs.js";
import { registerFontsRoutes } from "./http/fonts.js";
import { registerGenerateRoutes } from "./http/generate.js";
import { registerHealthRoutes } from "./http/health.js";
import { registerImageModelRoutes } from "./http/image-models.js";
import { registerImageProxyRoute } from "./http/image-proxy.js";
import { registerImageTextRoutes } from "./http/image-text.js";
import { registerImageLayerElementRoutes } from "./http/image-layer-elements.js";
import { registerJobRoutes } from "./http/jobs.js";
import { registerAdminOverviewRoutes } from "./http/admin-overview.js";
import { registerAdminAccessRoutes } from "./http/admin-access.js";
import { registerAdminUserRoutes } from "./http/admin-users.js";
import { registerAdminBillingRoutes } from "./http/admin-billing.js";
import { registerAdminSkillRoutes } from "./http/admin-skills.js";
import { registerAdminJobRoutes } from "./http/admin-jobs.js";
import { registerAdminChannelRoutes } from "./http/admin-channels.js";
import { registerAdminHomeContentRoutes } from "./http/admin-home-content.js";
import { createAdminOverviewService } from "./features/admin/admin-overview-service.js";
import { createAdminAccessService } from "./features/admin/admin-access-service.js";
import { createAdminUserService } from "./features/admin/admin-user-service.js";
import { createAdminBillingService } from "./features/admin/admin-billing-service.js";
import { createAdminSkillService } from "./features/admin/admin-skill-service.js";
import { createAdminJobService } from "./features/admin/admin-job-service.js";
import { createAdminChannelService } from "./features/admin/admin-channel-service.js";
import { createAdminHomeContentService } from "./features/admin/admin-home-content-service.js";
import {
  finalizeTerminalImageJobPlaceholder,
  finalizeTerminalVideoJobPlaceholder,
  type FinalizableJob,
} from "./features/jobs/job-canvas-finalizer.js";
import { registerNodeImageSubmissionRoutes } from "./http/node-image-submissions.js";
import { createNodeImageSubmissionService } from "./features/jobs/node-image-submission-service.js";
import { registerModelRoutes } from "./http/models.js";
import { registerPaymentWebhookRoute } from "./http/payments-webhook.js";
import { registerPaymentRoutes } from "./http/payments.js";
import { registerProjectRoutes } from "./http/projects.js";
import { registerPromptLibraryRoutes } from "./http/prompt-library.js";
import { registerProviderConfigRoutes } from "./http/provider-configs.js";
import { registerRunRoutes } from "./http/runs.js";
import { createAgentTargetScopeService } from "./features/agent-tasks/agent-target-scope-service.js";
import { registerSettingsRoutes } from "./http/settings.js";
import { registerMarketplaceRoutes } from "./http/skills-marketplace.js";
import { registerSkillRoutes } from "./http/skills.js";
import { evaluateSkillReadiness, catalogDependencyModels, skillCatalogTools } from "./features/skills/skill-readiness.js";
import { registerUploadRoutes } from "./http/uploads.js";
import { registerVideoModelRoutes } from "./http/video-models.js";
import { registerViewerRoutes } from "./http/viewer.js";
import { registerWorkspaceMemberRoutes } from "./http/workspace-members.js";
import { createPgmqClient } from "./queue/pgmq-client.js";
import { createAdminSupabaseClient } from "./supabase/admin.js";
import {
  type RequestAuthenticator,
  createSupabaseRequestAuthenticator,
  createUserSupabaseClientFactory,
} from "./supabase/user.js";
import { ConnectionManager } from "./ws/connection-manager.js";
import { CanvasEventBuffer } from "./ws/event-buffer.js";
import { registerWsRoute } from "./ws/handler.js";

export type BuildAppOptions = {
  /** Explicit orchestration injection for isolated tests. Production defaults
   * to Mastra. */
  mastraRunFactory?: MastraRunFactory;
  /** Model ref override; the Mastra runtime resolves models from the snapshot. */
  agentModel?: string;
  agentRunMetadataService?: AgentRunMetadataService;
  toolExecutionService?: ToolExecutionService;
  retryReadTool?: RetryableReadToolExecutor;
  auth?: RequestAuthenticator;
  brandKitService?: BrandKitService;
  canvasService?: CanvasService;
  designService?: DesignService;
  designResourceService?: DesignResourceService;
  designTemplateService?: DesignTemplateService;
  designCatalogReadService?: DesignCatalogReadService;
  designCatalogAdminService?: DesignCatalogAdminService;
  designImportApiService?: DesignImportApiService;
  designPreviewService?: Pick<DesignPreviewService, "enqueue">;
  designExportService?: Pick<
    DesignExportService,
    "enqueue" | "enqueueWithReplay"
  >;
  designOutboxService?: Pick<
    DesignOutboxService,
    "publishBatch" | "reconcile"
  > | null;
  realtimeFanoutService?: Pick<
    DurableRealtimeFanoutService,
    "initialize" | "publishBatch" | "dispose"
  > | null;
  chatService?: ChatService;
  connectionManager?: ConnectionManager;
  creditService?: CreditService;
  env?: Partial<ServerEnv>;
  jobService?: JobService;
  paymentService?: PaymentService;
  tierGuard?: TierGuard;
  uploadService?: UploadService;
  mockEventDelayMs?: number;
  projectService?: ProjectService;
  providerConfigService?: ProviderConfigService;
  memberService?: WorkspaceMemberService;
  providerSnapshotService?: ProviderSnapshotService;
  workspaceModelCatalogService?: WorkspaceModelCatalogService;
  imageTextRecognizer?: ImageTextRecognizer;
  layerElementSuggester?: LayerElementSuggester;
  settingsService?: SettingsService;
  threadService?: ThreadService;
  viewerService?: ViewerService;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const env = loadServerEnv(options.env);
  // Parse at application construction even when a test injects a factory, so a
  // misspelled production runtime cannot quietly route requests to legacy.
  const configuredAgentRuntime = resolveAgentRuntimeMode();
  console.info("[agent-runtime]", { mode: configuredAgentRuntime });

  // Register generation providers (shared with worker.ts)
  registerAllProviders(env);

  const app = Fastify({
    logger: safeRequestLoggerOptions(),
  });
  void app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });
  void app.register(async (instance) => {
    await instance.register(websocket);
    await registerWsRoute(instance, {
      agentRuns,
      agentRunMetadataService,
      auth,
      canvasService,
      chatService,
      connectionManager,
      destructiveConfirmationService,
      eventBuffer,
      settingsService,
      threadService,
      toolExecutionService,
      retryReadTool,
      viewerService,
      providerSnapshotService,
      workspaceModelCatalogService,
    });
  });
  const auth = options.auth ?? createSupabaseRequestAuthenticator(env);
  const createUserClient = createUserSupabaseClientFactory(env);
  let adminClient: ReturnType<typeof createAdminSupabaseClient> | undefined;
  const getAdminClient = () => {
    adminClient ??= createAdminSupabaseClient(env);
    return adminClient;
  };
  const viewerService =
    options.viewerService ?? createViewerService({ getAdminClient });
  const projectService =
    options.projectService ??
    createProjectService({ createUserClient, viewerService });
  const brandKitService =
    options.brandKitService ?? createBrandKitService({ createUserClient });
  const canvasService =
    options.canvasService ?? createCanvasService({ createUserClient });
  const designService =
    options.designService ??
    createDesignService({ createUserClient, getAdminClient });
  const designResourceService =
    options.designResourceService ??
    createDesignResourceService({ createUserClient, getAdminClient });
  const designTemplateService =
    options.designTemplateService ??
    createDesignTemplateService({
      createUserClient,
      getAdminClient,
      designService,
    });
  const designCatalogReadService =
    options.designCatalogReadService ??
    createDesignCatalogReadService({ createUserClient });
  const designCatalogAdminService =
    options.designCatalogAdminService ??
    createDesignCatalogAdminService({ getAdminClient, createUserClient });
  const designImportApiService =
    options.designImportApiService ??
    createDesignImportApiService({ createUserClient, getAdminClient });
  const threadService =
    options.threadService ?? createThreadService({ createUserClient });
  const chatService =
    options.chatService ??
    createChatService({ createUserClient, threadService });
  const agentRunMetadataService =
    options.agentRunMetadataService ??
    createAgentRunMetadataService({ getAdminClient });
  const toolExecutionService =
    options.toolExecutionService ??
    createToolExecutionService({ createUserClient, getAdminClient });
  const providerConfigService =
    options.providerConfigService ??
    createProviderConfigService({ createUserClient, getAdminClient });
  const connectionManager =
    options.connectionManager ??
    new ConnectionManager({
      authorizeCanvas: createSupabaseCanvasAuthorizationCheck(getAdminClient),
      onAuthorizationError: (error) =>
        app.log.error(error, "Realtime canvas authorization failed closed"),
    });
  const memberService =
    options.memberService ??
    createWorkspaceMemberService({
      createUserClient,
      getAdminClient,
      onMembershipInvalidated: ({ workspaceId, userId }) => {
        connectionManager.revokeWorkspaceUser(workspaceId, userId);
      },
    });
  const workspaceModelCatalogService =
    options.workspaceModelCatalogService ??
    createWorkspaceModelCatalogService({ getAdminClient });
  const settingsService =
    options.settingsService ??
    createSettingsService({
      createUserClient,
      defaultModel: resolveDefaultAgentModel(env),
      workspaceModelCatalogService,
    });
  const providerSnapshotService =
    options.providerSnapshotService ??
    createProviderSnapshotService({ getAdminClient });
  const uploadService =
    options.uploadService ??
    createUploadService({ createUserClient, getAdminClient });
  const imageTextRecognizer =
    options.imageTextRecognizer ?? createImageTextRecognizer(env);
  const layerElementSuggester =
    options.layerElementSuggester ?? createLayerElementSuggester(env);
  const pgmq = env.supabaseDbUrl
    ? createPgmqClient(env.supabaseDbUrl)
    : undefined;
  const jobService =
    options.jobService ??
    (pgmq
      ? createJobService({
          createUserClient,
          getAdminClient,
          pgmq,
          providerSnapshotService,
        })
      : undefined);
  const creditService =
    options.creditService ?? createCreditService({ getAdminClient });
  const tierGuard = options.tierGuard ?? createTierGuard({ getAdminClient });

  // Payment service — only created when Lemon Squeezy is configured
  let paymentService: PaymentService | undefined = options.paymentService;
  if (!paymentService && env.lemonSqueezyApiKey && env.lemonSqueezyStoreId) {
    const lsClient = createLemonSqueezyClient({
      apiKey: env.lemonSqueezyApiKey,
      storeId: env.lemonSqueezyStoreId,
    });
    paymentService = createPaymentService({
      lemonSqueezy: lsClient,
      getAdminClient,
      variantMap: buildVariantMap(env),
      webOrigin: env.webOrigin,
    });
  }

  const designPreviewService =
    options.designPreviewService ??
    (pgmq
      ? new DesignPreviewService(
          createSupabaseDesignPreviewRepository(getAdminClient),
          {
            publish: async (message) => {
              await pgmq.send("design_preview_jobs", message);
            },
          },
        )
      : undefined);
  const designExportService =
    options.designExportService ??
    (jobService
      ? new DesignExportService(designService, jobService)
      : undefined);
  const retryReadTool =
    options.retryReadTool ??
    createRetryableReadToolExecutor({
      createUserClient,
      designTools: {
        designService,
        designResourceService,
        designTemplateService,
        ...(designExportService ? { designExportService } : {}),
      },
    });
  const designBroadcaster = createConnectionManagerDesignBroadcaster({
    getAdminClient,
    connections: connectionManager,
  });
  const designOutboxService =
    options.designOutboxService === null
      ? undefined
      : (options.designOutboxService ??
        (env.supabaseDbUrl
          ? new DesignOutboxService(
              createSupabaseDesignOutboxRepository(getAdminClient),
              {
                // The insert trigger has already committed the event to the
                // per-instance realtime log. This legacy dispatcher now only
                // settles the design outbox status; broadcasting here would
                // duplicate the durable fanout path on the claiming instance.
                broadcast: async () => undefined,
              },
            )
          : undefined));
  if (designOutboxService) {
    const stopDesignOutbox = startDesignOutboxDispatcher(designOutboxService, {
      onError: (error) => app.log.error(error, "Design outbox dispatch failed"),
    });
    app.addHook("onClose", async () => stopDesignOutbox());
  }
  const realtimeFanoutService =
    options.realtimeFanoutService === null
      ? undefined
      : (options.realtimeFanoutService ??
        (env.supabaseDbUrl
          ? new DurableRealtimeFanoutService(
              createSupabaseRealtimeFanoutRepository(getAdminClient),
              designBroadcaster,
              connectionManager,
            )
          : undefined));
  if (realtimeFanoutService) {
    let stopRealtimeFanout: (() => void) | undefined;
    // onReady completes before Fastify starts listening, so a peer cannot
    // connect a socket before this instance has atomically sampled its cursor.
    app.addHook("onReady", async () => {
      await realtimeFanoutService.initialize();
      stopRealtimeFanout = startRealtimeFanoutDispatcher(
        realtimeFanoutService,
        {
          onError: (error) =>
            app.log.error(error, "Realtime fanout dispatch failed"),
        },
      );
    });
    app.addHook("onClose", async () => {
      stopRealtimeFanout?.();
      await realtimeFanoutService.dispose().catch((error) => {
        app.log.error(error, "Realtime fanout unregister failed");
      });
    });
  }
  const eventBuffer = new CanvasEventBuffer();
  // The UI and Agent query the same curated corpus and source policy.
  const promptLibraryService = createPromptLibraryService();
  // Task snapshots support the current user turn only. Do not attach an
  // autonomy grant or register an automatic post-generation continuation.
  const taskService = createAgentTaskService({ getAdminClient });
  const destructiveConfirmationService = createDestructiveConfirmationService({
    durableActionStore: createDurableActionConfirmationStore(getAdminClient),
    executeDurableAction: createDurableDesignMutationExecutor({ designService, agentTaskService: taskService,
      ...(designPreviewService ? { designPreviewService } : {}) }),
    onConfirmedActionApplied: async event => {
      const current = await taskService.assertCurrentRun(event.originRunId);
      const designId = event.outcome.design_id;
      let service = taskService;
      if (current && typeof designId === "string" && (current.target.kind !== "design" || current.target.designId !== designId)) {
        const targets = await targetScopeService.listAuthorizedTargets({ userId: event.userId, task: current });
        const target = targets.find(item => item.kind === "design" && item.designId === designId);
        if (!target) throw new Error("agent_target_scope_forbidden");
        service = (await targetScopeService.resolveExecutionTask({ userId: event.userId, task: current, target, taskService })).service;
      }
      await createConfirmedActionAppliedHandler({ tasks: service })(event);
    },
  });
  const targetScopeService = createAgentTargetScopeService({ getAdminClient, taskService });
  setInterval(() => eventBuffer.cleanup(), 5 * 60 * 1000);
  const agentRuns = createAgentRunService({
    promptLibraryService,
    agentContextService: createAgentContextService({ getAdminClient }),
    ...(options.mastraRunFactory ? { mastraRunFactory: options.mastraRunFactory } : {}),
    agentRunMetadataService,
    connectionManager,
    createUserClient,
    destructiveConfirmationService,
    designTools: {
      designService,
      designResourceService,
      designTemplateService,
      ...(designExportService ? { designExportService } : {}),
      ...(designPreviewService ? { designPreviewService } : {}),
      destructiveConfirmationService,
    },
    ...(options.agentModel ? { model: options.agentModel } : {}),
    ...(options.mockEventDelayMs === undefined
      ? {}
      : { eventDelayMs: options.mockEventDelayMs }),
    env,
    ...(jobService ? { jobService } : {}),
    creditService,
    tierGuard,
    providerSnapshotService,
    workspaceModelCatalogService,
  });

  app.addHook("onRequest", async (request, reply) => {
    const corsResult = evaluateCors(request, env.webOrigin);

    if (!corsResult.allowed) {
      return reply.code(403).send({
        message: "Origin not allowed",
      });
    }

    if (corsResult.allowOrigin) {
      reply.header("access-control-allow-origin", corsResult.allowOrigin);
      reply.header("vary", "Origin");
    }

    if (corsResult.isBrowserRequest) {
      reply.header(
        "access-control-allow-methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      );
      reply.header(
        "access-control-allow-headers",
        resolveAllowedHeaders(
          request.headers["access-control-request-headers"],
        ),
      );
    }

    if (corsResult.isPreflight) {
      return reply.code(204).send();
    }
  });

  void registerHealthRoutes(app, env,
    options.mastraRunFactory ? "mastra"
      : configuredAgentRuntime);
  void registerPromptLibraryRoutes(app, { auth, promptLibraryService });
  void registerFontsRoutes(app, { env });
  void registerImageProxyRoute(app);
  void registerImageTextRoutes(app, {
    auth,
    canvasService,
    createUserClient,
    recognizer: imageTextRecognizer,
  });
  void registerImageLayerElementRoutes(app, {
    auth,
    canvasService,
    createUserClient,
    suggester: layerElementSuggester,
  });
  void registerRunRoutes(app, agentRuns, {
    agentRunMetadataService,
    auth,
    settingsService,
    threadService,
    viewerService,
    providerSnapshotService,
    workspaceModelCatalogService,
  });
  void registerViewerRoutes(app, {
    auth,
    createUserClient,
    creditService,
    viewerService,
  });
  void registerBrandKitRoutes(app, {
    auth,
    brandKitService,
  });
  void registerProjectRoutes(app, {
    auth,
    projectService,
  });
  void registerCanvasRoutes(app, {
    auth,
    canvasService,
  });
  void registerDesignRoutes(app, {
    auth,
    designService,
  });
  void registerDesignResourceRoutes(app, {
    auth,
    resourceService: designResourceService,
    uploadService,
  });
  void registerDesignTemplateRoutes(app, {
    auth,
    templateService: designTemplateService,
  });
  void registerDesignCatalogReadRoutes(app, {
    auth,
    catalogService: designCatalogReadService,
    uploadService,
  });
  void registerDesignCatalogAdminRoutes(app, {
    auth,
    service: designCatalogAdminService,
    uploadService,
  });
  void registerDesignImportRoutes(app, {
    auth,
    service: designImportApiService,
    uploadService,
    ...(env.designImportRoot ? { importRoot: env.designImportRoot } : {}),
  });
  if (designPreviewService && designExportService) {
    void registerDesignAsyncRoutes(app, {
      auth,
      previewService: designPreviewService,
      exportService: designExportService,
    });
  }
  void registerSettingsRoutes(app, {
    auth,
    settingsService,
    viewerService,
  });
  void registerProviderConfigRoutes(app, {
    auth,
    providerConfigService,
    viewerService,
  });
  void registerWorkspaceMemberRoutes(app, {
    auth,
    memberService,
    viewerService,
  });
  void registerModelRoutes(app, env, {
    auth,
    viewerService,
    workspaceModelCatalogService,
  });
  void registerImageModelRoutes(app, {
    auth,
    creditService,
    viewerService,
    workspaceModelCatalogService,
  });
  void registerVideoModelRoutes(app, {
    auth,
    creditService,
    viewerService,
    workspaceModelCatalogService,
  });
  void registerChatRoutes(app, {
    auth,
    chatService,
    // Present only when the queue is configured; scope is enforced inside.
    ...(jobService ? { jobService } : {}),
  });
  void registerUploadRoutes(app, {
    auth,
    uploadService,
    viewerService,
  });
  void registerGenerateRoutes(app, {
    auth,
    creditService,
    uploadService,
    viewerService,
    ...(jobService ? { jobService } : {}),
    ...(tierGuard ? { tierGuard } : {}),
  });
  void registerCreditRoutes(app, { auth, creditService, viewerService });
  // The worker settles a terminal job only while it is processing it; a job
  // canceled while queued would otherwise leave "生成中" on screen until the
  // throttled recovery scan ran (measured: 132-145s). Both the user-facing cancel
  // route and the console's cancel share this hook.
  const settleTerminalJob = async (jobId: string) => {
    const row = await jobService!.getJobAdmin(jobId) as FinalizableJob | null;
    if (!row) return false;
    const admin = getAdminClient();
    if (row.job_type === "video_generation") {
      return finalizeTerminalVideoJobPlaceholder(admin, row);
    }
    return finalizeTerminalImageJobPlaceholder(admin, row);
  };
  if (jobService) {
    void registerNodeImageSubmissionRoutes(app, {
      auth,
      service: createNodeImageSubmissionService({ createUserClient, getAdminClient, jobService,
        creditService, tierGuard, workspaceModelCatalogService }),
    });
    void registerJobRoutes(app, {
      auth,
      creditService,
      jobService,
      tierGuard,
      viewerService,
      createUserClient,
      workspaceModelCatalogService,
      settleTerminalJob,
    });
  }
  void registerSkillRoutes(app, { auth, createUserClient, viewerService,
    getSkillReadiness: async (user, rows) => {
      const viewer = await viewerService.ensureViewer(user);
      try {
        const models = catalogDependencyModels(await workspaceModelCatalogService.listPublished(user, viewer.workspace.id));
        return rows.map(row => evaluateSkillReadiness({ metadata: row.metadata, content: row.skill_content, models, tools: skillCatalogTools(configuredAgentRuntime) }));
      } catch {
        return rows.map(row => evaluateSkillReadiness({ metadata: row.metadata, content: row.skill_content, models: [], catalogUnavailable: true }));
      }
    },
  });
  void registerMarketplaceRoutes(app, {
    auth,
    createUserClient,
    viewerService,
  });
  // Read-only platform operations console. Registered unconditionally (unlike
  // the payment routes): it depends on nothing but the database, and a platform
  // admin should still be able to see job and channel health when payments are
  // not configured.
  void registerAdminOverviewRoutes(app, {
    auth,
    adminOverviewService: createAdminOverviewService({ getAdminClient }),
  });
  // Platform-admin access management and the audit trail. The writes go through
  // database functions that re-check the actor and write the audit row in the same
  // transaction, so this layer authorizes and translates errors, nothing more.
  void registerAdminAccessRoutes(app, {
    auth,
    adminAccessService: createAdminAccessService({ getAdminClient }),
  });
  // Platform-level user directory and cross-workspace membership management. The
  // membership writes are audited database functions (reason required, owner
  // membership immutable), so this layer only authorizes and validates.
  void registerAdminUserRoutes(app, {
    auth,
    adminUserService: createAdminUserService({ getAdminClient }),
  });
  // Plan and credit management, plus the per-workspace reconciliation view. The
  // writes move the balance through the same ledger the billing code reads, so a
  // generation charged later still reconciles against an admin adjustment.
  void registerAdminBillingRoutes(app, {
    auth,
    adminBillingService: createAdminBillingService({ getAdminClient }),
  });
  // Skill images for the platform catalog, plus the customer-facing published
  // read. Uploads land in the existing platform-assets bucket; the published read
  // is served through the server because that bucket has no authenticated policy.
  void registerAdminSkillRoutes(app, {
    auth,
    adminSkillService: createAdminSkillService({ getAdminClient }),
  });
  // Job inspection and disposition. Cancelling reuses the same settlement hook as
  // the user-facing cancel route, so a canceled job never keeps showing as live.
  void registerAdminJobRoutes(app, {
    auth,
    adminJobService: createAdminJobService({ getAdminClient }),
    settleTerminalJob,
  });
  // Channel health: the cross-workspace directory, one channel with its self-test
  // history, and failure rates by error code. Read-only, like the plan asks - the
  // console never edits another workspace's channel configuration.
  void registerAdminChannelRoutes(app, {
    auth,
    adminChannelService: createAdminChannelService({ getAdminClient }),
  });
  // Home content: the discovery and examples libraries, which until now only ever
  // changed through migrations and import scripts. Publish state is the RLS switch
  // the home page already reads; ordering travels through dedicated reorder calls
  // because the tables carry a unique index on (category_key, sort_order).
  void registerAdminHomeContentRoutes(app, {
    auth,
    adminHomeContentService: createAdminHomeContentService({ getAdminClient }),
  });

  // Payment routes — only registered when Lemon Squeezy is configured
  if (paymentService) {
    void registerPaymentRoutes(app, { auth, paymentService, viewerService });

    if (env.lemonSqueezyWebhookSecret) {
      // Webhook route is registered in an encapsulated plugin so the custom
      // content-type parser (needed for raw body access) does not leak to
      // other routes.
      void app.register(async (webhookScope) => {
        await registerPaymentWebhookRoute(webhookScope, {
          getAdminClient,
          paymentService: paymentService!,
          webhookSecret: env.lemonSqueezyWebhookSecret!,
        });
      });
    }
  }

  return app;
}

type CorsResult = {
  allowed: boolean;
  allowOrigin: string | null;
  isBrowserRequest: boolean;
  isPreflight: boolean;
};

function evaluateCors(request: FastifyRequest, webOrigin: string): CorsResult {
  const origin = request.headers.origin;
  const isPreflight =
    request.method === "OPTIONS" &&
    typeof request.headers["access-control-request-method"] === "string";

  if (!origin) {
    return {
      allowed: true,
      allowOrigin: null,
      isBrowserRequest: false,
      isPreflight,
    };
  }

  if (isAllowedWebOrigin(origin, webOrigin)) {
    return {
      allowed: true,
      allowOrigin: origin,
      isBrowserRequest: true,
      isPreflight,
    };
  }

  if (origin === "null" && isLoopbackHost(request.headers.host)) {
    return {
      allowed: true,
      allowOrigin: origin,
      isBrowserRequest: true,
      isPreflight,
    };
  }

  return {
    allowed: false,
    allowOrigin: null,
    isBrowserRequest: true,
    isPreflight,
  };
}

/**
 * Treat localhost and numeric loopback addresses as aliases in local
 * development, while still requiring the configured protocol and port.
 * Production origins continue to require an exact match.
 */
export function isAllowedWebOrigin(origin: string, webOrigin: string) {
  if (origin === webOrigin) {
    return true;
  }

  try {
    const candidate = new URL(origin);
    const configured = new URL(webOrigin);
    return (
      isLoopbackHostname(candidate.hostname) &&
      isLoopbackHostname(configured.hostname) &&
      candidate.protocol === configured.protocol &&
      candidate.port === configured.port
    );
  } catch {
    return false;
  }
}

function resolveAllowedHeaders(requestHeaders: string | undefined) {
  return requestHeaders?.trim() || "Content-Type";
}

function isLoopbackHost(host: string | undefined) {
  if (!host) {
    return false;
  }

  if (host.startsWith("[")) {
    return host.startsWith("[::1]");
  }

  const [hostname] = host.split(":");
  return isLoopbackHostname(hostname ?? "");
}

function isLoopbackHostname(hostname: string) {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  );
}
