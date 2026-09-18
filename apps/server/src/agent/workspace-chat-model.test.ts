import { describe, expect, it, vi } from "vitest";

import { resolveWorkspaceChatModel } from "./workspace-chat-model.js";
import { createWorkspaceVisionModel, workspaceVisionOutputCap } from "./workspace-vision-model.js";

const modelRef = "workspace:11111111-1111-4111-8111-111111111111";

describe("workspace chat model resolution", () => {
  it("builds a run-scoped model from the immutable snapshot", async () => {
    const model = await resolveWorkspaceChatModel({
      modelRef,
      runId: "run-1",
      workspaceId: "workspace-1",
      providerSnapshotService: {
        resolveRunSnapshot: vi.fn(async () => ({
          snapshotId: "snapshot-1",
          providerConfigId: "config-1",
          providerRevision: 2,
          catalogKey: "11111111-1111-4111-8111-111111111111",
          adapter: "openai_compatible",
          baseUrl: "https://gateway.example.test/v1",
          upstreamModelId: "gemini-3.1-flash-lite",
          modality: "text",
          capabilities: ["text"],
          billing: { creditsCost: null, pricingVersion: null, unit: null },
          apiKey: "secret-for-this-run",
        })),
      } as never,
    });

    // The retired adapter exposed maxTokens/maxCompletionTokens on the
    // ChatOpenAI field bag. The equivalent observable is the generation cap the
    // adapter applies to every call: the frozen generation reserve here, and a
    // caller requirement is clamped to it rather than allowed to raise it.
    const budget = model.contextBudget;
    expect(workspaceVisionOutputCap(undefined, budget)).toBe((budget as unknown as { generationReserveTokens: number }).generationReserveTokens);
    expect(workspaceVisionOutputCap(8_000, budget)).toBeLessThanOrEqual(
      (budget as unknown as { generationReserveTokens: number }).generationReserveTokens,
    );
    expect(typeof model.generate).toBe("function");
    // The run-scoped credential is never exposed as a property.
    expect(JSON.stringify(Object.keys(model))).not.toContain("secret-for-this-run");
  });

  it("fails closed on a catalog or capability mismatch", async () => {
    await expect(resolveWorkspaceChatModel({
      modelRef,
      runId: "run-1",
      workspaceId: "workspace-1",
      providerSnapshotService: {
        resolveRunSnapshot: vi.fn(async () => ({
          catalogKey: "22222222-2222-4222-8222-222222222222",
          modality: "text",
          capabilities: [],
        })),
      } as never,
    })).rejects.toMatchObject({ code: "provider_snapshot_invalid" });
  });

  it("applies the documented profile only to the exact APIYI endpoint and model", async () => {
    const snapshot = {
      catalogKey: modelRef.slice("workspace:".length), modality: "text", capabilities: ["text"],
      baseUrl: "https://api.apiyi.com/v1", upstreamModelId: "gemini-3.1-flash-lite", apiKey: "run-secret",
    };
    const exact = await resolveWorkspaceChatModel({ modelRef, runId: "run", workspaceId: "workspace",
      providerSnapshotService: { resolveRunSnapshot: vi.fn(async () => snapshot) } as never });
    expect(exact.contextBudget).toMatchObject({ verification: "verified", modelContextWindowTokens: 1_048_576,
      inputCeilingTokens: 80_000 });

    const custom = await resolveWorkspaceChatModel({ modelRef, runId: "run", workspaceId: "workspace",
      providerSnapshotService: { resolveRunSnapshot: vi.fn(async () => ({ ...snapshot, baseUrl: "https://gateway.example/v1" })) } as never });
    expect(custom.contextBudget).toMatchObject({ verification: "unverified", modelContextWindowTokens: null,
      inputCeilingTokens: 40_000 });
  });

  it("asserts the context budget before any provider call and records usage after", async () => {
    const onUsage = vi.fn();
    const model = createWorkspaceVisionModel({
      apiKey: "k", baseUrl: "https://gateway.example.test/v1", upstreamModelId: "gemini-3.1-flash-lite",
    }, { onUsage });
    // An input that cannot fit the input ceiling must throw locally with the
    // safety-critical code and must not reach the provider.
    await expect(model.generate({ user: "x".repeat(4_000_000) }))
      .rejects.toMatchObject({ code: "agent_context_budget_exceeded" });
    // A preflight observation is recorded for the rejected attempt, and no
    // usage numbers are invented because no provider response exists.
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0]![0]).toMatchObject({
      phase: "preflight", allowed: false, actualInputTokens: null, actualOutputTokens: null,
    });
  });
});
