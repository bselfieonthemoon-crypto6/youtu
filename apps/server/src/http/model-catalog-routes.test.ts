import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerImageModelRoutes } from "./image-models.js";
import { registerModelRoutes } from "./models.js";
import { registerVideoModelRoutes } from "./video-models.js";

const user = { id: "user-1", email: "user@example.com", accessToken: "token", userMetadata: {} };
const catalogEntries = [
  entry("10000000-0000-4000-8000-000000000001", "text", "Workspace Text", "custom-text", ["text"]),
  entry("20000000-0000-4000-8000-000000000002", "image", "Workspace Image", "gpt-image-2", ["image_generation"]),
  entry("30000000-0000-4000-8000-000000000003", "video", "Workspace Video", "custom-video", ["video_generation"]),
];

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("workspace model catalog routes", () => {
  it("returns env-only catalogs anonymously and enriches all three for the current workspace", async () => {
    const catalog = { listPublished: vi.fn(async () => catalogEntries), resolvePublishedModel: vi.fn() };
    const auth = { authenticate: vi.fn(async (request: { headers: Record<string, unknown> }) => request.headers.authorization ? user : null) };
    const viewer = { ensureViewer: vi.fn(async () => ({ workspace: { id: "workspace-current" } })) };
    const credits = { getBalance: vi.fn(async () => ({ plan: "pro" })) };
    const app = Fastify(); apps.push(app);
    await registerModelRoutes(app, { apiYiApiKey: "env-key" } as never, { auth: auth as never, viewerService: viewer as never, workspaceModelCatalogService: catalog as never });
    await registerImageModelRoutes(app, { auth: auth as never, viewerService: viewer as never, creditService: credits as never, workspaceModelCatalogService: catalog as never });
    await registerVideoModelRoutes(app, { auth: auth as never, viewerService: viewer as never, creditService: credits as never, workspaceModelCatalogService: catalog as never });

    for (const url of ["/api/models", "/api/image-models", "/api/video-models"]) {
      const anonymous = await app.inject({ method: "GET", url });
      expect(anonymous.statusCode).toBe(200);
      expect(anonymous.body).not.toContain("workspace:");
    }
    expect(catalog.listPublished).not.toHaveBeenCalled();

    const text = await app.inject({ method: "GET", url: "/api/models", headers: { authorization: "Bearer token" } });
    const image = await app.inject({ method: "GET", url: "/api/image-models", headers: { authorization: "Bearer token" } });
    const video = await app.inject({ method: "GET", url: "/api/video-models", headers: { authorization: "Bearer token" } });
    expect(text.json().models).toEqual(expect.arrayContaining([expect.objectContaining({ id: catalogEntries[0]!.model.id, source: "workspace", providerDisplayName: "Workspace Gateway" })]));
    expect(image.json().models).toEqual(expect.arrayContaining([expect.objectContaining({ id: catalogEntries[1]!.model.id, description: "工作区供应商计费", supportsExact2K: true })]));
    expect(video.json().models).toEqual(expect.arrayContaining([expect.objectContaining({ id: catalogEntries[2]!.model.id, description: "工作区供应商计费" })]));
    expect(catalog.listPublished).toHaveBeenCalledWith(user, "workspace-current");
    for (const body of [text.body, image.body, video.body]) {
      expect(body).not.toContain("providerConfigId");
      expect(body).not.toContain("baseUrl");
      expect(body).not.toContain("apiKey");
      expect(body).not.toContain("upstreamModelId");
    }
  });

  it("publishes a configured provider model even when it shares an old environment model id", async () => {
    const duplicate = entry("40000000-0000-4000-8000-000000000004", "text", "Duplicate", "gemini-3.1-flash-lite", ["text"]);
    duplicate.model.providerDisplayName = "APIYI";
    const catalog = { listPublished: vi.fn(async () => [duplicate]), resolvePublishedModel: vi.fn() };
    const app = Fastify(); apps.push(app);
    await registerModelRoutes(app, { apiYiApiKey: "env-key" } as never, {
      auth: { authenticate: async () => user } as never,
      viewerService: { ensureViewer: async () => ({ workspace: { id: "workspace-current" } }) } as never,
      workspaceModelCatalogService: catalog as never,
    });
    const response = await app.inject({ method: "GET", url: "/api/models", headers: { authorization: "Bearer token" } });
    expect(response.json().models).toEqual([
      expect.objectContaining({ id: duplicate.model.id, name: "Duplicate", source: "workspace" }),
    ]);
  });

  it("does not publish any environment-backed models", async () => {
    const app = Fastify(); apps.push(app);
    await registerModelRoutes(app, {
      apiYiApiKey: "apiyi-key",
      openAIApiKey: "legacy-openai-key",
      googleApiKey: "legacy-google-key",
    } as never);

    const response = await app.inject({ method: "GET", url: "/api/models" });
    expect(response.statusCode).toBe(200);
    expect(response.json().models).toEqual([]);
  });

  // "Nothing is published in this workspace" and "the catalog could not be read" need
  // different actions from the user, so they must not be the same response. The picker
  // rendered both as an empty control with no explanation.
  it("reports an unreadable catalog as a failure, not as an empty workspace catalog", async () => {
    const catalog = {
      listPublished: vi.fn(async () => { throw new Error("relation does not exist"); }),
      resolvePublishedModel: vi.fn(),
    };
    const app = Fastify(); apps.push(app);
    await registerModelRoutes(app, { apiYiApiKey: "env-key" } as never, {
      auth: { authenticate: async () => user } as never,
      viewerService: { ensureViewer: async () => ({ workspace: { id: "workspace-current" } }) } as never,
      workspaceModelCatalogService: catalog as never,
    });
    await registerImageModelRoutes(app, {
      auth: { authenticate: async () => user } as never,
      viewerService: { ensureViewer: async () => ({ workspace: { id: "workspace-current" } }) } as never,
      creditService: { getBalance: async () => ({ plan: "pro" }) } as never,
      workspaceModelCatalogService: catalog as never,
    });

    for (const url of ["/api/models", "/api/image-models"]) {
      const response = await app.inject({ method: "GET", url, headers: { authorization: "Bearer token" } });
      expect(response.statusCode).toBe(503);
      // No empty catalog is claimed, and no internal detail leaks.
      expect(response.json()).not.toHaveProperty("models");
      expect(response.body).not.toContain("relation does not exist");
    }
  });

  it("reports an unreadable workspace bootstrap as a failure too", async () => {
    const app = Fastify(); apps.push(app);
    await registerModelRoutes(app, { apiYiApiKey: "env-key" } as never, {
      auth: { authenticate: async () => user } as never,
      viewerService: { ensureViewer: async () => { throw new Error("kaboom"); } } as never,
      workspaceModelCatalogService: { listPublished: vi.fn(async () => []), resolvePublishedModel: vi.fn() } as never,
    });

    const response = await app.inject({ method: "GET", url: "/api/models", headers: { authorization: "Bearer token" } });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("kaboom");
  });

  // An anonymous visitor is not signed in, so an empty list is a fact about the request,
  // not a failure - this must keep returning 200.
  it("still answers an unauthenticated catalog read with an empty list", async () => {
    const catalog = { listPublished: vi.fn(async () => catalogEntries), resolvePublishedModel: vi.fn() };
    const app = Fastify(); apps.push(app);
    await registerModelRoutes(app, { apiYiApiKey: "env-key" } as never, {
      auth: { authenticate: async () => null } as never,
      viewerService: { ensureViewer: vi.fn() } as never,
      workspaceModelCatalogService: catalog as never,
    });

    const response = await app.inject({ method: "GET", url: "/api/models" });
    expect(response.statusCode).toBe(200);
    expect(response.json().models).toEqual([]);
    expect(catalog.listPublished).not.toHaveBeenCalled();
  });
});

function entry(catalogKey: string, modality: "text" | "image" | "video", displayName: string, upstreamModelId: string, capabilities: Array<"text" | "image_generation" | "video_generation">) {
  return {
    model: { id: `workspace:${catalogKey}`, displayName, providerDisplayName: "Workspace Gateway", modality, capabilities, source: "workspace" as const },
    upstreamModelId,
  };
}
