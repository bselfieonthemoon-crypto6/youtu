import { beforeEach, describe, expect, it, vi } from "vitest";

const constructorSpy = vi.hoisted(() => vi.fn());
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: class {
    constructor(options: unknown) {
      constructorSpy(options);
    }
  },
}));

import { resolveWorkspaceChatModel } from "./workspace-chat-model.js";

const modelRef = "workspace:11111111-1111-4111-8111-111111111111";

beforeEach(() => constructorSpy.mockClear());

describe("workspace chat model resolution", () => {
  it("builds a run-scoped client from the immutable snapshot", async () => {
    await resolveWorkspaceChatModel({
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

    expect(constructorSpy).toHaveBeenCalledWith({
      model: "gemini-3.1-flash-lite",
      apiKey: "secret-for-this-run",
      configuration: { baseURL: "https://gateway.example.test/v1" },
      streaming: true,
      streamUsage: false,
    });
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
    expect(constructorSpy).not.toHaveBeenCalled();
  });
});
