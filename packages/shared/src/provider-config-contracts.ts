import { z } from "zod";
import { modelContextProfileSchema } from "./model-context-contracts.js";

export const providerCapabilitySchema = z.enum([
  "text",
  "vision_input",
  "image_generation",
  "video_generation",
]);

export const providerModelModalitySchema = z.enum(["text", "image", "video"]);

export const providerConfigIdSchema = z.string().uuid();

const providerCapabilitiesSchema = z
  .array(providerCapabilitySchema)
  .max(4)
  .refine((items) => new Set(items).size === items.length, {
    message: "Capabilities must not contain duplicates.",
  });

const providerModelFields = {
  upstreamModelId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  modality: providerModelModalitySchema,
  enabled: z.boolean(),
  capabilities: providerCapabilitiesSchema.optional(),
  contextProfile: modelContextProfileSchema.nullable().optional(),
};

export const providerModelInputSchema = z.object(providerModelFields).strict();

export const workspaceProviderModelSchema = z
  .object({
    id: z.string().uuid().optional(),
    ...providerModelFields,
  })
  .strict();

const providerBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .url()
  .refine(
    (value) => /^https:\/\//i.test(value),
    "Provider base URL must use HTTPS.",
  );

const providerApiKeySchema = z.string().trim().min(8).max(4096);

export const providerConfigCreateRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    baseUrl: providerBaseUrlSchema,
    apiKey: providerApiKeySchema,
    enabled: z.boolean().optional(),
    models: z.array(providerModelInputSchema).max(500).optional(),
  })
  .strict();

export const providerConfigUpdateRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    baseUrl: providerBaseUrlSchema.optional(),
    apiKey: providerApiKeySchema.optional(),
    enabled: z.boolean().optional(),
    models: z.array(providerModelInputSchema).max(500).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one provider setting must be supplied.",
  });

/**
 * Read-only model discovery for an unsaved provider draft.  A config ID is
 * optional so an existing key may only be reused by the server when the draft
 * stays on that configuration's origin.
 */
export const providerModelDiscoveryDraftRequestSchema = z
  .object({
    baseUrl: providerBaseUrlSchema,
    apiKey: providerApiKeySchema.optional(),
    configId: providerConfigIdSchema.optional(),
  })
  .strict();

export const providerLastTestStatusSchema = z.enum([
  "never",
  "succeeded",
  "failed",
]);

export const providerConnectionErrorCodeSchema = z.enum([
  "provider_connection_failed",
  "provider_connection_timeout",
  "provider_auth_failed",
  "provider_redirect_not_allowed",
  "provider_response_too_large",
]);

export const workspaceProviderConfigSchema = z
  .object({
    id: providerConfigIdSchema,
    adapter: z.literal("openai_compatible"),
    displayName: z.string().min(1).max(100),
    baseUrl: providerBaseUrlSchema,
    enabled: z.boolean(),
    hasApiKey: z.boolean(),
    lastFour: z.string().min(1).max(4),
    models: z.array(workspaceProviderModelSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastTestedAt: z.string().datetime().nullable(),
    lastTestStatus: providerLastTestStatusSchema,
  })
  .strict();

export const providerConfigListResponseSchema = z
  .object({ configs: z.array(workspaceProviderConfigSchema) })
  .strict();

export const providerConfigResponseSchema = z
  .object({ config: workspaceProviderConfigSchema })
  .strict();

export const providerConnectionTestResponseSchema = z
  .object({
    ok: z.literal(true),
    testedAt: z.string().datetime(),
  })
  .strict();

export const providerModelDiscoveryResponseSchema = z
  .object({
    // Discovery is read-only and may return a provider's full bounded catalog.
    // Persisted selections remain capped at 500 by the create/update schemas.
    models: z.array(providerModelInputSchema).max(10_000),
  })
  .strict();

export const providerConfigErrorCodeSchema = z.enum([
  "provider_forbidden",
  "provider_not_found",
  "provider_invalid_request",
  "provider_conflict",
  "provider_persistence_failed",
  ...providerConnectionErrorCodeSchema.options,
]);

export const providerConfigErrorResponseSchema = z
  .object({
    error: z.object({
      code: providerConfigErrorCodeSchema,
      message: z.string().min(1),
    }),
  })
  .strict();

export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;
export type ProviderModelModality = z.infer<
  typeof providerModelModalitySchema
>;
export type ProviderModelInput = z.infer<typeof providerModelInputSchema>;
export type WorkspaceProviderModel = z.infer<
  typeof workspaceProviderModelSchema
>;
export type ProviderConfigCreateRequest = z.infer<
  typeof providerConfigCreateRequestSchema
>;
export type ProviderConfigUpdateRequest = z.infer<
  typeof providerConfigUpdateRequestSchema
>;
export type ProviderModelDiscoveryDraftRequest = z.infer<
  typeof providerModelDiscoveryDraftRequestSchema
>;
export type WorkspaceProviderConfig = z.infer<
  typeof workspaceProviderConfigSchema
>;
export type ProviderConfigListResponse = z.infer<
  typeof providerConfigListResponseSchema
>;
export type ProviderConfigResponse = z.infer<
  typeof providerConfigResponseSchema
>;
export type ProviderConnectionTestResponse = z.infer<
  typeof providerConnectionTestResponseSchema
>;
export type ProviderModelDiscoveryResponse = z.infer<
  typeof providerModelDiscoveryResponseSchema
>;
export type ProviderConnectionErrorCode = z.infer<
  typeof providerConnectionErrorCodeSchema
>;
export type ProviderConfigErrorCode = z.infer<
  typeof providerConfigErrorCodeSchema
>;
export type ProviderConfigErrorResponse = z.infer<
  typeof providerConfigErrorResponseSchema
>;
