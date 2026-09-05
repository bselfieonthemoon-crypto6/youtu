import { describe, expect, it } from "vitest";

import {
  providerConfigCreateRequestSchema,
  providerConfigErrorResponseSchema,
  providerConfigUpdateRequestSchema,
  providerModelInputSchema,
  workspaceProviderConfigSchema,
} from "./provider-config-contracts.js";

describe("provider config contracts", () => {
  it("requires a non-empty API key when creating a provider", () => {
    const base = { displayName: "Gateway", baseUrl: "https://api.example.com/v1" };
    expect(providerConfigCreateRequestSchema.safeParse(base).success).toBe(false);
    expect(
      providerConfigCreateRequestSchema.safeParse({ ...base, apiKey: "   " }).success,
    ).toBe(false);
    expect(
      providerConfigCreateRequestSchema.safeParse({ ...base, apiKey: "secret-key" }).success,
    ).toBe(true);
  });

  it("only permits HTTPS provider base URLs", () => {
    expect(
      providerConfigCreateRequestSchema.safeParse({
        displayName: "Gateway",
        baseUrl: "http://api.example.com/v1",
        apiKey: "secret-key",
      }).success,
    ).toBe(false);
  });

  it("allows update without rotating a key but rejects an empty key", () => {
    expect(
      providerConfigUpdateRequestSchema.safeParse({ displayName: "New name" }).success,
    ).toBe(true);
    expect(providerConfigUpdateRequestSchema.safeParse({ apiKey: "" }).success).toBe(false);
    expect(providerConfigUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it("only accepts the closed capability set", () => {
    const model = {
      upstreamModelId: "vision-model",
      displayName: "Vision model",
      modality: "text",
      enabled: true,
    };
    expect(
      providerModelInputSchema.safeParse({
        ...model,
        capabilities: ["text", "vision_input"],
      }).success,
    ).toBe(true);
    expect(
      providerModelInputSchema.safeParse({
        ...model,
        capabilities: ["audio_generation"],
      }).success,
    ).toBe(false);
  });

  it("never accepts secret fields in a provider response", () => {
    const response = {
      id: "10000000-0000-4000-8000-000000000001",
      adapter: "openai_compatible",
      displayName: "Gateway",
      baseUrl: "https://api.example.com/v1",
      enabled: true,
      hasApiKey: true,
      lastFour: "cret",
      models: [],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      lastTestedAt: null,
      lastTestStatus: "never",
    };
    expect(workspaceProviderConfigSchema.safeParse(response).success).toBe(true);
    expect(
      workspaceProviderConfigSchema.safeParse({ ...response, apiKey: "secret" }).success,
    ).toBe(false);
    expect(
      workspaceProviderConfigSchema.safeParse({ ...response, secretId: "vault-id" }).success,
    ).toBe(false);
  });

  it("defines stable connection failure error bodies", () => {
    expect(
      providerConfigErrorResponseSchema.parse({
        error: {
          code: "provider_connection_timeout",
          message: "Provider connection test timed out.",
        },
      }).error.code,
    ).toBe("provider_connection_timeout");
  });
});
