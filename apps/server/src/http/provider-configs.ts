import type { FastifyInstance, FastifyReply } from "fastify";

import {
  providerConfigCreateRequestSchema,
  providerModelDiscoveryDraftRequestSchema,
  providerConfigErrorResponseSchema,
  providerConfigIdSchema,
  providerConfigListResponseSchema,
  providerConfigResponseSchema,
  providerConfigUpdateRequestSchema,
  providerConnectionTestResponseSchema,
  providerModelDiscoveryResponseSchema,
  unauthenticatedErrorResponseSchema,
  type ProviderCapability,
  type ProviderConfigCreateRequest,
  type ProviderModelDiscoveryDraftRequest,
  type ProviderConfigUpdateRequest,
  type WorkspaceProviderConfig,
} from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  ProviderConfigServiceError,
  type ProviderConfigService,
  type ProviderModelInput,
  type WorkspaceProviderConfigView,
} from "../features/providers/index.js";
import type { RequestAuthenticator } from "../supabase/user.js";

export async function registerProviderConfigRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    providerConfigService: ProviderConfigService;
    viewerService: ViewerService;
  },
) {
  app.get("/api/workspace/provider-configs", async (request, reply) => {
    try {
      const context = await resolveContext(request, reply, options);
      if (!context) return;
      const configs = await options.providerConfigService.list(
        context.user,
        context.workspaceId,
      );
      return reply.code(200).send(
        providerConfigListResponseSchema.parse({
          configs: configs.map(toApiConfig),
        }),
      );
    } catch (error) {
      return sendProviderError(error, reply);
    }
  });

  app.post("/api/workspace/provider-configs", async (request, reply) => {
    try {
      const context = await resolveContext(request, reply, options);
      if (!context) return;
      const payload = providerConfigCreateRequestSchema.parse(request.body);
      const config = await options.providerConfigService.create(
        context.user,
        context.workspaceId,
        toServiceCreateInput(payload),
      );
      return reply
        .code(201)
        .send(providerConfigResponseSchema.parse({ config: toApiConfig(config) }));
    } catch (error) {
      return sendProviderError(error, reply);
    }
  });

  app.post(
    "/api/workspace/provider-configs/discover-models",
    async (request, reply) => {
      try {
        const context = await resolveContext(request, reply, options);
        if (!context) return;
        const payload = providerModelDiscoveryDraftRequestSchema.parse(request.body);
        const models = await options.providerConfigService.discoverDraftModels(
          context.user,
          context.workspaceId,
          toServiceDraftDiscoveryInput(payload),
        );
        return reply.code(200).send(
          providerModelDiscoveryResponseSchema.parse({ models }),
        );
      } catch (error) {
        return sendProviderError(error, reply);
      }
    },
  );

  app.put("/api/workspace/provider-configs/:id", async (request, reply) => {
    try {
      const context = await resolveContext(request, reply, options);
      if (!context) return;
      const id = parseConfigId(request.params);
      const payload = providerConfigUpdateRequestSchema.parse(request.body);
      const config = await options.providerConfigService.update(
        context.user,
        context.workspaceId,
        id,
        toServiceUpdateInput(payload),
      );
      return reply
        .code(200)
        .send(providerConfigResponseSchema.parse({ config: toApiConfig(config) }));
    } catch (error) {
      return sendProviderError(error, reply, isExplicitEmptyApiKey(request.body));
    }
  });

  app.delete("/api/workspace/provider-configs/:id", async (request, reply) => {
    try {
      const context = await resolveContext(request, reply, options);
      if (!context) return;
      await options.providerConfigService.delete(
        context.user,
        context.workspaceId,
        parseConfigId(request.params),
      );
      return reply.code(204).send();
    } catch (error) {
      return sendProviderError(error, reply);
    }
  });

  app.post(
    "/api/workspace/provider-configs/:id/test",
    async (request, reply) => {
      try {
        const context = await resolveContext(request, reply, options);
        if (!context) return;
        const result = await options.providerConfigService.test(
          context.user,
          context.workspaceId,
          parseConfigId(request.params),
        );
        if (!result.ok) {
          const code = result.errorCode ?? "provider_connection_failed";
          return reply
            .code(code === "provider_connection_timeout" ? 504 : 502)
            .send(
              providerConfigErrorResponseSchema.parse({
                error: { code, message: connectionErrorMessage(code) },
              }),
            );
        }
        return reply
          .code(200)
          .send(providerConnectionTestResponseSchema.parse(result));
      } catch (error) {
        return sendProviderError(error, reply);
      }
    },
  );

  app.post(
    "/api/workspace/provider-configs/:id/discover-models",
    async (request, reply) => {
      try {
        const context = await resolveContext(request, reply, options);
        if (!context) return;
        const models = await options.providerConfigService.discoverModels(
          context.user,
          context.workspaceId,
          parseConfigId(request.params),
        );
        return reply.code(200).send(providerModelDiscoveryResponseSchema.parse({ models }));
      } catch (error) {
        return sendProviderError(error, reply);
      }
    },
  );
}

async function resolveContext(
  request: Parameters<RequestAuthenticator["authenticate"]>[0],
  reply: FastifyReply,
  options: {
    auth: RequestAuthenticator;
    viewerService: ViewerService;
  },
) {
  const user = await options.auth.authenticate(request);
  if (!user) {
    sendUnauthenticated(reply);
    return null;
  }
  const viewer = await options.viewerService.ensureViewer(user);
  return { user, workspaceId: viewer.workspace.id };
}

function parseConfigId(params: unknown) {
  const id = (params as { id?: unknown }).id;
  return providerConfigIdSchema.parse(id);
}

export function toServiceCreateInput(payload: ProviderConfigCreateRequest) {
  return {
    displayName: payload.displayName,
    baseUrl: payload.baseUrl,
    apiKey: payload.apiKey,
    ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
    ...(payload.models ? { models: payload.models.map(toServiceModel) } : {}),
  };
}

export function toServiceUpdateInput(payload: ProviderConfigUpdateRequest) {
  return {
    ...(payload.displayName !== undefined
      ? { displayName: payload.displayName }
      : {}),
    ...(payload.baseUrl !== undefined ? { baseUrl: payload.baseUrl } : {}),
    ...(payload.apiKey !== undefined ? { apiKey: payload.apiKey } : {}),
    ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
    ...(payload.models ? { models: payload.models.map(toServiceModel) } : {}),
  };
}

export function toServiceDraftDiscoveryInput(payload: ProviderModelDiscoveryDraftRequest) {
  return {
    baseUrl: payload.baseUrl,
    ...(payload.apiKey !== undefined ? { apiKey: payload.apiKey } : {}),
    ...(payload.configId !== undefined ? { configId: payload.configId } : {}),
  };
}

function toServiceModel(model: {
  upstreamModelId: string;
  displayName: string;
  modality: "text" | "image" | "video";
  enabled: boolean;
  capabilities?: ProviderCapability[] | undefined;
}): ProviderModelInput {
  return {
    upstreamModelId: model.upstreamModelId,
    displayName: model.displayName,
    modality: model.modality,
    enabled: model.enabled,
    ...(model.capabilities ? { capabilities: model.capabilities } : {}),
  };
}

export function toApiConfig(view: WorkspaceProviderConfigView): WorkspaceProviderConfig {
  return {
    id: view.id,
    adapter: "openai_compatible",
    displayName: view.displayName,
    baseUrl: view.baseUrl,
    enabled: view.enabled,
    hasApiKey: view.hasApiKey,
    lastFour: view.lastFour,
    models: view.models.map((model) => ({
      id: model.id,
      upstreamModelId: model.upstreamModelId,
      displayName: model.displayName,
      modality: model.modality,
      enabled: model.enabled,
      ...(model.capabilities ? { capabilities: model.capabilities } : {}),
    })),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    lastTestedAt: view.lastTestedAt,
    lastTestStatus: view.lastTestStatus,
  };
}

function sendUnauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

export function sendProviderError(
  error: unknown,
  reply: FastifyReply,
  explicitEmptyApiKey = false,
) {
  if (isZodError(error)) {
    return reply.code(explicitEmptyApiKey ? 400 : 422).send(
      providerConfigErrorResponseSchema.parse({
        error: {
          code: "provider_invalid_request",
          message: "Invalid provider configuration request.",
        },
      }),
    );
  }
  if (error instanceof ProviderConfigServiceError) {
    const status =
      error.code === "provider_invalid_request" ? 422 : error.statusCode;
    return reply.code(status).send(
      providerConfigErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  return reply.code(500).send(
    providerConfigErrorResponseSchema.parse({
      error: {
        code: "provider_persistence_failed",
        message: "Unable to process provider configuration.",
      },
    }),
  );
}

export function isExplicitEmptyApiKey(body: unknown) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  if (!Object.prototype.hasOwnProperty.call(body, "apiKey")) return false;
  return typeof (body as { apiKey?: unknown }).apiKey === "string" &&
    (body as { apiKey: string }).apiKey.trim().length === 0;
}

export function connectionErrorMessage(code: string) {
  switch (code) {
    case "provider_connection_timeout":
      return "Provider connection test timed out.";
    case "provider_auth_failed":
      return "Provider authentication failed.";
    case "provider_redirect_not_allowed":
      return "Provider returned a disallowed redirect.";
    case "provider_response_too_large":
      return "Provider returned an oversized response.";
    default:
      return "Provider connection test failed.";
  }
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
