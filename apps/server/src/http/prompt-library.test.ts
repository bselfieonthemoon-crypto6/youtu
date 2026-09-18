import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPromptLibraryService } from "../features/prompt-library/prompt-library-service.js";
import { registerPromptLibraryRoutes } from "./prompt-library.js";

const catalog = {
  version: "http-fixture",
  sources: [{ id: "source", name: "Source", url: "https://example.org/prompts", license: "MIT", attribution: "Authors", status: "available", note: "MIT attribution", entryCount: 1 }],
  items: [{ id: "one", title: "植物 Logo", prompt: "Full body [literal]", category: "Logo", tags: ["植物"], sourceId: "source", sourceUrl: "https://example.org/prompts/one", modelHints: ["gpt-image-2"], requiresReference: false, imageUrl: "https://images.example.org/one.webp", previewImageUrls: ["https://images.example.org/one.webp", "https://images.example.org/two.png"] }],
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function setup(options: { readCatalog?: () => Promise<string>; authError?: boolean } = {}) {
  const readCatalog = options.readCatalog ?? vi.fn(async () => JSON.stringify(catalog));
  const app = Fastify();
  apps.push(app);
  const authenticate = vi.fn(async (request: { headers: { authorization?: string } }) => {
    if (options.authError) throw new Error("Private auth failure");
    if (request.headers.authorization !== "Bearer valid-fixture") return null;
    return { id: "test-user", accessToken: "valid-fixture", email: "test@example.org", userMetadata: {} };
  });
  await registerPromptLibraryRoutes(app, { auth: { authenticate }, promptLibraryService: createPromptLibraryService({ readCatalog }) });
  return { app, readCatalog, authenticate };
}
const headers = { authorization: "Bearer valid-fixture" };

describe("GET /api/prompt-library", () => {
  it.each([undefined, "Bearer invalid", "Basic valid-fixture"])("requires valid bearer auth before loading catalog (%s)", async authorization => {
    const { app, readCatalog } = await setup();
    const response = await app.inject({ url: "/api/prompt-library", ...(authorization ? { headers: { authorization } } : {}) });
    expect(response.statusCode).toBe(401);
    expect(readCatalog).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("does not leak authentication errors or load catalog after failed auth", async () => {
    const { app, readCatalog } = await setup({ authError: true });
    const response = await app.inject({ url: "/api/prompt-library", headers });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("Private auth");
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it("returns complete attributed prompt data and explicit private caching policy", async () => {
    const { app } = await setup();
    const response = await app.inject({ url: "/api/prompt-library", headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({ version: "http-fixture", total: 1, nextOffset: null, items: [{ prompt: "Full body [literal]" }], categories: ["Logo"] });
    expect(response.body).not.toContain("valid-fixture");
    expect(response.body).not.toContain("test-user");
  });

  it("returns only reviewed image URLs without proxying images or forwarding user authentication", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("This route must not fetch remote images");
    });
    try {
      const { app } = await setup();
      const response = await app.inject({ url: "/api/prompt-library", headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().items[0]).toMatchObject({
        imageUrl: catalog.items[0]!.imageUrl,
        previewImageUrls: catalog.items[0]!.previewImageUrls,
      });
      expect(response.body).not.toContain("valid-fixture");
      expect(response.body).not.toContain("test-user");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("supports combined Chinese query/source/category and pagination parameters", async () => {
    const { app } = await setup();
    const params = new URLSearchParams({ q: "植物", source: "source", category: "Logo", offset: "0", limit: "48" });
    const response = await app.inject({ url: `/api/prompt-library?${params}`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect((await app.inject({ url: "/api/prompt-library?offset=1", headers })).json()).toMatchObject({ total: 1, items: [], nextOffset: null });
  });

  it.each([
    "q=one&q=two", "source=source&source=other", "category=Logo&category=Poster", "limit=1&limit=2", "offset=0&offset=1",
    "limit=0", "limit=49", "limit=-1", "limit=1.5", "limit=1e1", "limit=Infinity", "limit=", "offset=-1", "offset=1.5", "offset=1000001",
    `q=${"x".repeat(161)}`, `source=${"x".repeat(81)}`, `category=${"x".repeat(81)}`, "url=https://private.test/secret", "q[text]=logo",
    "imageUrl=https://private.test/secret", "previewImageUrls=https://private.test/secret", "workspaceId=another-workspace", "accessToken=private",
  ])("rejects invalid/multivalued query %s before loading data", async parameters => {
    const { app, readCatalog } = await setup();
    const response = await app.inject({ url: `/api/prompt-library?${parameters}`, headers });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it.each(["source=unknown", "category=unknown", "q=.*"])("safely returns empty matches for %s", async parameters => {
    const { app } = await setup();
    const response = await app.inject({ url: `/api/prompt-library?${parameters}`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [], total: 0, nextOffset: null, categories: ["Logo"] });
  });

  it.each(["malformed", JSON.stringify({ ...catalog, items: [{ ...catalog.items[0], prompt: "x".repeat(24001) }] })])("returns generic 503 for invalid snapshots", async raw => {
    const { app } = await setup({ readCatalog: async () => raw });
    const response = await app.inject({ url: "/api/prompt-library", headers });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: "prompt_library_unavailable", message: "提示词库暂时不可用，请稍后重试。" } });
    expect(response.body).not.toContain(raw);
  });

  it("exposes no mutation/import endpoint", async () => {
    const { app, readCatalog } = await setup();
    const response = await app.inject({ url: "/api/prompt-library", method: "POST", headers, payload: { url: "https://example.org/import" } });
    expect(response.statusCode).toBe(404);
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it.each(["image", "images", "proxy", "download"])("exposes no %s endpoint accepting an arbitrary remote URL", async path => {
    const { app, readCatalog } = await setup();
    const response = await app.inject({ url: `/api/prompt-library/${path}?url=https://private.test/secret`, headers });
    expect(response.statusCode).toBe(404);
    expect(readCatalog).not.toHaveBeenCalled();
  });
});
