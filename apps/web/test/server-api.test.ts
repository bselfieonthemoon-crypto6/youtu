// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProject,
  createProviderConfig,
  deleteProviderConfig,
  discoverProviderModels,
  createRun,
  fetchAgentRunDetail,
  fetchProjects,
  fetchProviderConfigs,
  fetchSessionRuns,
  fetchVideoModels,
  fetchViewer,
  restoreJobToCanvas,
  testProviderConnection,
  updateProviderConfig,
} from "../src/lib/server-api";
import { AgentRunResponseParseError } from "../src/lib/agent-run-history";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe("authenticated server API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });

  it("fetchViewer sends bearer token and returns viewer response", async () => {
    const viewer = {
      profile: {
        id: "u1",
        email: "a@b.com",
        displayName: "A",
        avatarUrl: null,
      },
      workspace: { id: "w1", name: "W", type: "personal", ownerUserId: "u1" },
      membership: { workspaceId: "w1", userId: "u1", role: "owner" },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => viewer,
    });

    const result = await fetchViewer("token_abc");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/viewer",
      expect.objectContaining({
        headers: { Authorization: "Bearer token_abc" },
      }),
    );
    expect(result.profile.id).toBe("u1");
  });

  it("restores an existing generated job to the canvas with bearer auth", async () => {
    const restored = {
      jobId: "job/with spaces",
      canvasId: "canvas-1",
      elementId: "element-1",
      inserted: true,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => restored,
    });

    await expect(restoreJobToCanvas("token_abc", restored.jobId)).resolves.toEqual(restored);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/jobs/job%2Fwith%20spaces/restore-to-canvas",
      {
        method: "POST",
        headers: { Authorization: "Bearer token_abc" },
      },
    );
  });

  it("createRun sends bearer auth when access token is provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        runId: "run_123",
        sessionId: "session_123",
        conversationId: "conversation_123",
        status: "accepted",
      }),
    });

    await createRun(
      {
        sessionId: "session_123",
        conversationId: "conversation_123",
        prompt: "Hello",
      },
      { accessToken: "token_abc" },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/agent/runs",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer token_abc",
          "content-type": "application/json",
        },
      }),
    );
  });

  it("createRun keeps demo calls unauthenticated by default", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        runId: "run_123",
        sessionId: "session_123",
        conversationId: "conversation_123",
        status: "accepted",
      }),
    });

    await createRun({
      sessionId: "session_123",
      conversationId: "conversation_123",
      prompt: "Hello",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/agent/runs",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      }),
    );
  });

  it("createProject sends POST with bearer token and handles 201", async () => {
    const project = {
      project: {
        id: "p1",
        name: "Test",
        slug: "test",
        description: null,
        workspace: { id: "w1", name: "W", type: "personal", ownerUserId: "u1" },
        primaryCanvas: { id: "c1", name: "Main Canvas", isPrimary: true },
        createdAt: "2026-03-23T00:00:00Z",
        updatedAt: "2026-03-23T00:00:00Z",
      },
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => project,
    });

    const result = await createProject("token_abc", { name: "Test" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/projects",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token_abc",
          "content-type": "application/json",
        }),
      }),
    );
    expect(result.project.id).toBe("p1");
  });

  it("fetchProjects sends bearer token and returns list", async () => {
    const list = { projects: [{ id: "p1", name: "Test", slug: "test" }] };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => list,
    });

    const result = await fetchProjects("token_abc");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/projects",
      expect.objectContaining({
        headers: { Authorization: "Bearer token_abc" },
      }),
    );
    expect(result.projects).toHaveLength(1);
  });

  it("fetchVideoModels preserves capability, limits, and verified pricing metadata", async () => {
    const payload = {
      models: [
        {
          id: "metaso/minimax-h3",
          displayName: "MiniMax H3 (Metaso)",
          description: "Metaso H3",
          provider: "metaso",
          creditCost: 51,
          capabilities: {
            textToVideo: true,
            imageToVideo: true,
            videoToVideo: false,
            audio: false,
          },
          limits: {
            maxDuration: 15,
            allowedDurations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            maxResolution: "1080p",
            maxInputImages: 2,
          },
          pricing: {
            currency: "CNY",
            billingUnit: "generated_second",
            providerPointsName: "H3 points",
            evidenceDate: "2026-08-19",
            rates: [
              {
                resolution: "720p",
                displayResolution: "768P",
                providerPointsPerSecond: 10.2,
                cnyPerSecond: { min: 0.0897, max: 0.1102 },
              },
            ],
          },
        },
      ],
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const result = await fetchVideoModels();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/video-models",
    );
    expect(result.models[0]).toMatchObject({
      id: "metaso/minimax-h3",
      creditCost: 51,
      limits: { maxDuration: 15, maxInputImages: 2 },
      pricing: { evidenceDate: "2026-08-19" },
    });
  });

  it("createProject throws ApiApplicationError with code on 409", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: "project_slug_taken", message: "Slug taken." },
      }),
    });

    await expect(createProject("token_abc", { name: "Dup" })).rejects.toThrow(
      "Slug taken.",
    );
    try {
      await createProject("token_abc", { name: "Dup" });
    } catch (err) {
      expect((err as { code?: string }).code).toBe("project_slug_taken");
    }
  });

  it("fetchViewer throws ApiAuthError on 401", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { code: "unauthorized", message: "Bad token." },
      }),
    });

    await expect(fetchViewer("expired")).rejects.toThrow("unauthorized");
  });

  it("fetchProjects throws ApiAuthError on 401", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { code: "unauthorized", message: "Bad token." },
      }),
    });

    await expect(fetchProjects("expired")).rejects.toThrow("unauthorized");
  });

  it("fetches a cursor-paginated session run history with bearer auth", async () => {
    const page = {
      runs: [makeRunSummary()],
      nextCursor: "created-at/run-id",
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => page });

    await expect(
      fetchSessionRuns("token_abc", "session/with spaces", {
        cursor: "created-at/run-id",
        limit: 20,
      }),
    ).resolves.toEqual(page);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/chat/sessions/session%2Fwith%20spaces/runs?cursor=created-at%2Frun-id&limit=20",
      { headers: { Authorization: "Bearer token_abc" } },
    );
  });

  it("rejects invalid run-history pagination before making a request", async () => {
    await expect(
      fetchSessionRuns("token_abc", "session-1", { limit: 51 }),
    ).rejects.toThrow(RangeError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches and strips unknown internal fields from a run detail", async () => {
    const summary = makeRunSummary();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        run: {
          ...summary,
          threadId: "must-not-leak",
          checkpoint: { secret: true },
          tools: [
            {
              id: "tool-1",
              toolCallId: "call-1",
              toolName: "generate_image",
              status: "completed",
              retryable: false,
              attempt: 1,
              retryOf: null,
              startedAt: "2026-09-01T00:00:01.000Z",
              finishedAt: "2026-09-01T00:00:02.000Z",
              output: { secret: true },
            },
          ],
        },
      }),
    });

    const detail = await fetchAgentRunDetail(
      "token_abc",
      "session/1",
      "run/1",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/chat/sessions/session%2F1/runs/run%2F1",
      { headers: { Authorization: "Bearer token_abc" } },
    );
    expect(detail).not.toHaveProperty("threadId");
    expect(detail).not.toHaveProperty("checkpoint");
    expect(detail.tools[0]).not.toHaveProperty("output");
  });

  it("rejects a malformed successful run-history response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ runs: [{ ...makeRunSummary(), status: "unknown" }], nextCursor: null }),
    });

    await expect(fetchSessionRuns("token_abc", "session-1")).rejects.toBeInstanceOf(
      AgentRunResponseParseError,
    );
  });

  it("preserves top-level not-found messages from run history routes", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: "Run not found or access denied." }),
    });

    await expect(
      fetchAgentRunDetail("token_abc", "session-1", "missing"),
    ).rejects.toMatchObject({
      code: "http_404",
      message: "Run not found or access denied.",
    });
  });

  it("sends authenticated provider create/update/test requests", async () => {
    const provider = makeProviderConfig();
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ config: provider }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ config: provider }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, testedAt: "2026-09-01T01:00:00.000Z" }) });

    await createProviderConfig("token_abc", {
      displayName: "Gateway",
      baseUrl: "https://api.example.com/v1",
      apiKey: "write-only-key",
      models: [],
    });
    expect(mockFetch).toHaveBeenNthCalledWith(1, "http://localhost:3001/api/workspace/provider-configs", expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer token_abc", "content-type": "application/json" },
      body: expect.stringContaining("write-only-key"),
    }));

    await updateProviderConfig("token_abc", provider.id, { displayName: "Renamed" });
    expect(JSON.parse(mockFetch.mock.calls[1]?.[1]?.body as string)).toEqual({ displayName: "Renamed" });

    await testProviderConnection("token_abc", provider.id);
    expect(mockFetch).toHaveBeenNthCalledWith(3, `http://localhost:3001/api/workspace/provider-configs/${provider.id}/test`, {
      method: "POST",
      headers: { Authorization: "Bearer token_abc" },
    });
  });

  it("strictly rejects provider responses that contain API key material", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ configs: [{ ...makeProviderConfig(), apiKey: "must-not-leak" }] }),
    });
    await expect(fetchProviderConfigs("token_abc")).rejects.toThrow();
  });

  it("discovers provider models with bearer authentication", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ models: [] }) });
    await discoverProviderModels("token_abc", "provider/one");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/workspace/provider-configs/provider%2Fone/discover-models",
      { method: "POST", headers: { Authorization: "Bearer token_abc" } },
    );
  });

  it("deletes a provider config with bearer auth and no request body", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204 });
    await deleteProviderConfig("token_abc", "provider/one");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/workspace/provider-configs/provider%2Fone",
      { method: "DELETE", headers: { Authorization: "Bearer token_abc" } },
    );
  });
});

function makeRunSummary() {
  return {
    runId: "run-1",
    sessionId: "session-1",
    status: "completed",
    executionMode: "fast",
    model: "model-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: "2026-09-01T00:00:01.000Z",
    completedAt: "2026-09-01T00:00:02.000Z",
    durationMs: 1000,
    error: null,
    toolCounts: {
      total: 1,
      running: 0,
      completed: 1,
      failed: 0,
      canceled: 0,
    },
  };
}

function makeProviderConfig() {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    adapter: "openai_compatible",
    displayName: "Gateway",
    baseUrl: "https://api.example.com/v1",
    enabled: true,
    hasApiKey: true,
    lastFour: "abcd",
    models: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastTestedAt: null,
    lastTestStatus: "never",
  };
}
