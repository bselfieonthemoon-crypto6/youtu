import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { LoomicAgentFactory } from "./agent/deep-agent.js";
import {
  type AgentPersistenceService,
  createAgentPersistenceService,
} from "./agent/persistence/index.js";
import { createAgentRunService } from "./agent/runtime.js";
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
  type JobService,
  createJobService,
} from "./features/jobs/job-service.js";
import {
  type WorkspaceMemberService,
  createWorkspaceMemberService,
} from "./features/members/index.js";
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
import { registerJobRoutes } from "./http/jobs.js";
import { registerModelRoutes } from "./http/models.js";
import { registerPaymentWebhookRoute } from "./http/payments-webhook.js";
import { registerPaymentRoutes } from "./http/payments.js";
import { registerProjectRoutes } from "./http/projects.js";
import { registerProviderConfigRoutes } from "./http/provider-configs.js";
import { registerRunRoutes } from "./http/runs.js";
import { registerSettingsRoutes } from "./http/settings.js";
import { registerMarketplaceRoutes } from "./http/skills-marketplace.js";
import { registerSkillRoutes } from "./http/skills.js";
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
  agentFactory?: LoomicAgentFactory;
  agentModel?: BaseLanguageModel | string;
  agentPersistenceService?: AgentPersistenceService;
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
  settingsService?: SettingsService;
  threadService?: ThreadService;
  viewerService?: ViewerService;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const env = loadServerEnv(options.env);

  // Register generation providers (shared with worker.ts)
  registerAllProviders(env);

  const app = Fastify({
    logger: { level: "info" },
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
  const agentPersistenceService =
    options.agentPersistenceService ?? createAgentPersistenceService(env);
  const settingsService =
    options.settingsService ??
    createSettingsService({
      createUserClient,
      defaultModel: resolveDefaultAgentModel(env),
    });
  const providerConfigService =
    options.providerConfigService ??
    createProviderConfigService({ createUserClient, getAdminClient });
  const memberService =
    options.memberService ??
    createWorkspaceMemberService({ createUserClient, getAdminClient });
  const workspaceModelCatalogService =
    options.workspaceModelCatalogService ??
    createWorkspaceModelCatalogService({ getAdminClient });
  const providerSnapshotService =
    options.providerSnapshotService ??
    createProviderSnapshotService({ getAdminClient });
  const uploadService =
    options.uploadService ??
    createUploadService({ createUserClient, getAdminClient });
  const imageTextRecognizer =
    options.imageTextRecognizer ?? createImageTextRecognizer(env);
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

  const connectionManager =
    options.connectionManager ?? new ConnectionManager();
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
  const designOutboxService =
    options.designOutboxService === null
      ? undefined
      : (options.designOutboxService ??
        (env.supabaseDbUrl
          ? new DesignOutboxService(
              createSupabaseDesignOutboxRepository(getAdminClient),
              createConnectionManagerDesignBroadcaster({
                getAdminClient,
                connections: connectionManager,
              }),
            )
          : undefined));
  if (designOutboxService) {
    const stopDesignOutbox = startDesignOutboxDispatcher(designOutboxService, {
      onError: (error) => app.log.error(error, "Design outbox dispatch failed"),
    });
    app.addHook("onClose", async () => stopDesignOutbox());
  }
  const eventBuffer = new CanvasEventBuffer();
  const destructiveConfirmationService = createDestructiveConfirmationService();
  setInterval(() => eventBuffer.cleanup(), 5 * 60 * 1000);
  const agentRuns = createAgentRunService({
    agentPersistenceService,
    ...(options.agentFactory ? { agentFactory: options.agentFactory } : {}),
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
    viewerService,
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

  void registerHealthRoutes(app, env);
  void registerFontsRoutes(app, { env });
  void registerImageProxyRoute(app);
  void registerImageTextRoutes(app, {
    auth,
    canvasService,
    createUserClient,
    recognizer: imageTextRecognizer,
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
  if (jobService) {
    void registerJobRoutes(app, {
      auth,
      creditService,
      jobService,
      tierGuard,
      viewerService,
      createUserClient,
      workspaceModelCatalogService,
    });
  }
  void registerSkillRoutes(app, { auth, createUserClient, viewerService });
  void registerMarketplaceRoutes(app, {
    auth,
    createUserClient,
    viewerService,
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
