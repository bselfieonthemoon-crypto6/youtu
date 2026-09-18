import { describe, expect, it } from "vitest";
import { modelContextProfileSchema } from "./model-context-contracts.js";
import { providerModelInputSchema } from "./provider-config-contracts.js";

const profile = { contextWindowTokens: 128000, maxInputTokens: 128000, maxOutputTokens: 16000,
  profileSource: "verified gateway documentation", verifiedAt: "2026-09-09T01:00:00Z", profileVersion: "v1" };
describe("model context metadata", () => {
  it("keeps unknown capacity distinct from configured capacity and accepts clearing it", () => {
    const model = { upstreamModelId: "gateway-alias", displayName: "Model", modality: "text", enabled: true };
    expect(providerModelInputSchema.parse(model)).not.toHaveProperty("contextProfile");
    expect(providerModelInputSchema.parse({ ...model, contextProfile: profile }).contextProfile).toEqual(profile);
    expect(providerModelInputSchema.parse({ ...model, contextProfile: null }).contextProfile).toBeNull();
  });
  it("rejects impossible, incomplete, unverified and unknown fields", () => {
    for (const value of [{ ...profile, maxInputTokens: 200000 }, { ...profile, maxOutputTokens: 128000 },
      { ...profile, contextWindowTokens: 1000 }, { ...profile, verifiedAt: "yesterday" },
      { ...profile, profileSource: "unverified" }, { ...profile, profileSource: " UNVERIFIED " },
      { ...profile, apiKey: "never allowed" }, {}]) {
      expect(modelContextProfileSchema.safeParse(value).success).toBe(false);
    }
  });
});
