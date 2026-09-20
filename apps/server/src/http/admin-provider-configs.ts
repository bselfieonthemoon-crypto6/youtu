import type { FastifyInstance, FastifyReply } from "fastify";

import {
  providerConfigCreateRequestSchema,
  providerConfigIdSchema,
  providerConfigListResponseSchema,
  providerConfigResponseSchema,
  providerConfigUpdateRequestSchema,
  providerConnectionTestResponseSchema,
  providerModelDiscoveryDraftRequestSchema,
  providerModelDiscoveryResponseSchema,
  providerConfigErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import type { ProviderConfigService } from "../features/providers/index.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import {
  toApiConfig,
  toServiceCreateInput,
  toServiceDraftDiscoveryInput,
  toServiceUpdateInput,
  isExplicitEmptyApiKey,
  connectionErrorMessage,
  sendProviderError,
} from "./provider-configs.js";

/**
 * The platform-wide provider channels.
 *
 * These are the channels every workspace falls back to, so they are deliberately
 * NOT workspace routes: the administrator configures them once and no workspace
 * has to be picked first. The service authorizes through an active
 * platform-admin check, and the database RPCs re-check the actor inside the write
 * transaction and record the change in admin_audit_events.
 *
 * A workspace may still keep its own channels as an override; those stay on
 * /api/workspace/provider-configs, which is unaffected by this file.
 */
export async function registerAdminProviderConfigRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    providerConfigService: ProviderConfigService;
  },
) {
  /** Platform scope is `null`: workspace_id IS NULL on the config tables. */
  const PLATFORM_SCOPE = null;

  app.get("/api/admin/provider-configs", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const configs = await options.providerConfigService.list(user, PLATFORM_SCOPE);
      return reply.code(200).send(
        providerConfigListResponseSchema.parse({ configs: configs.map(toApiConfig) }),
      );
    } catch (error) {
      return sendAdminProviderError(error, reply);
    }
  });

  app.post("/api/admin/provider-configs", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const payload = providerConfigCreateRequestSchema.parse(request.body);
      const config = await options.providerConfigService.create(
        user,
        PLATFORM_SCOPE,
        toServiceCreateInput(payload),
      );
      return reply.code(201).send(providerConfigResponseSchema.parse({ config: toApiConfig(config) }));
    } catch (error) {
      return sendAdminProviderError(error, reply);
    }
  });

  app.post("/api/admin/provider-configs/discover-models", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const payload = providerModelDiscoveryDraftRequestSchema.parse(request.body);
      const models = await options.providerConfigService.discoverDraftModels(
        user,
        PLATFORM_SCOPE,
        toServiceDraftDiscoveryInput(payload),
      );
      return reply.code(200).send(providerModelDiscoveryResponseSchema.parse({ models }));
    } catch (error) {
      return sendAdminProviderError(error, reply);
    }
  });

  app.put("/api/admin/provider-configs/:id", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const id = parseConfigId(request.params);
      const payload = providerConfigUpdateRequestSchema.parse(request.body);
      const config = await options.providerConfigService.update(
        user,
        PLATFORM_SCOPE,
        id,
        toServiceUpdateInput(payload),
      );
      return reply.code(200).send(providerConfigResponseSchema.parse({ config: toApiConfig(config) }));
    } catch (error) {
      return sendAdminProviderError(error, reply, isExplicitEmptyApiKey(request.body));
    }
  });

  app.delete("/api/admin/provider-configs/:id", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      await options.providerConfigService.delete(user, PLATFORM_SCOPE, parseConfigId(request.params));
      return reply.code(204).send();
    } catch (error) {
      return sendAdminProviderError(error, reply);
    }
  });

  app.post("/api/admin/provider-configs/:id/test", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const result = await options.providerConfigService.test(
        user,
        PLATFORM_SCOPE,
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
      return reply.code(200).send(providerConnectionTestResponseSchema.parse(result));
    } catch (error) {
      return sendAdminProviderError(error, reply);
    }
  });

  app.post("/api/admin/provider-configs/:id/discover-models", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return unauthenticated(reply);
      const models = await options.providerConfigService.discoverModels(
        user,
        PLATFORM_SCOPE,
        parseConfigId(request.params),
      );
      return reply.code(200).send(providerModelDiscoveryResponseSchema.parse({ models }));
    } catch (error) {
      return sendAdminProviderError(error, reply);
    }
  });
}

function parseConfigId(params: unknown) {
  return providerConfigIdSchema.parse((params as { id?: unknown }).id);
}

function unauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: { code: "unauthorized", message: "Missing or invalid bearer token." },
    }),
  );
}

function sendAdminProviderError(
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
  // ProviderConfigServiceError is mapped by the shared sender so the platform
  // routes cannot drift from the workspace routes' status/code contract.
  return sendProviderError(error, reply, explicitEmptyApiKey);
}

function isZodError(error: unknown): error is { issues: unknown[]; name: string } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}
