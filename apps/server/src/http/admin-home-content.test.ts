import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdminHomeContentListResponse,
  AdminHomeContentOverviewResponse,
} from "@loomic/shared";

import { AdminHomeContentError, type AdminHomeContentService } from "../features/admin/admin-home-content-service.js";
import { registerAdminHomeContentRoutes } from "./admin-home-content.js";

const user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.com", accessToken: "token", userMetadata: {} };
const CASE_ID = "branding-case";
const EXAMPLE_ID = "33333333-3333-4333-8333-333333333333";

const overview: AdminHomeContentOverviewResponse = {
  discovery: {
    categories: [{ key: "branding-design", label: "品牌设计", sortOrder: 0, isActive: true,
      updatedAt: "2026-09-01T00:00:00.000Z", itemCount: 1, activeItemCount: 1 }],
    itemCount: 8, activeItemCount: 8,
  },
  example: {
    categories: [{ key: "branding", label: "Branding", dataType: "Branding", accent: null, sortOrder: 0,
      isActive: true, updatedAt: "2026-09-01T00:00:00.000Z", itemCount: 6, activeItemCount: 6 }],
    itemCount: 36, activeItemCount: 36,
  },
};

const caseList: AdminHomeContentListResponse = {
  kind: "discovery_case",
  total: 1,
  items: [{
    id: CASE_ID, categoryKey: "branding-design", title: "品牌案例", coverImageUrl: "https://example.com/c.png",
    authorName: "Studio", authorAvatarUrl: "", caseUrl: "", seedPrompt: "请参考…", viewCount: 12, likeCount: 3,
    sortOrder: 0, isActive: true, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
    categoryIsActive: true,
  }],
};

const exampleList: AdminHomeContentListResponse = {
  kind: "example_example",
  total: 1,
  items: [{
    id: EXAMPLE_ID, categoryKey: "branding", title: "示例", prompt: "提示",
    imageUrls: ["https://example.com/a.png"],
    inputMentions: [{ name: "Logo", type: "image", imgSrc: "https://example.com/l.png" }],
    sortOrder: 0, isActive: true, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
    categoryIsActive: false,
  }],
};

function service(overrides: Partial<AdminHomeContentService> = {}): AdminHomeContentService {
  return {
    overview: vi.fn(async () => overview),
    list: vi.fn(async (_actor: string, filters) => (filters.kind === "discovery_case" ? caseList : exampleList)),
    upsertDiscoveryCase: vi.fn(async () => ({ id: CASE_ID, created: true, sortOrder: 1 })),
    upsertExample: vi.fn(async () => ({ id: EXAMPLE_ID, created: false, sortOrder: 4 })),
    upsertCategory: vi.fn(async () => ({ key: "branding", kind: "example_category", created: true, sortOrder: 6 })),
    setActive: vi.fn(async () => ({ hiddenItems: 3, wasActive: true })),
    reorderContent: vi.fn(async () => ({ ordered: 2 })),
    reorderCategories: vi.fn(async () => ({ ordered: 8 })),
    deleteContent: vi.fn(async () => undefined),
    ...overrides,
  };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

async function makeApp(adminHomeContentService: AdminHomeContentService, authenticated = true) {
  const app = Fastify();
  apps.push(app);
  await registerAdminHomeContentRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticated ? user : null) } as never,
    adminHomeContentService,
  });
  return app;
}

const caseBody = {
  caseId: null, categoryKey: "branding-design", title: "品牌案例", coverImageUrl: "https://example.com/c.png",
  authorName: "Studio", authorAvatarUrl: "", caseUrl: "", seedPrompt: "请参考…", isActive: true, reason: "新建案例",
};

const exampleBody = {
  exampleId: null, categoryKey: "branding", title: "示例", prompt: "提示",
  imageUrls: ["https://example.com/a.png"],
  inputMentions: [{ name: "Logo", type: "image", imgSrc: "https://example.com/l.png" }],
  isActive: true, reason: "新建示例",
};

describe("admin home content routes", () => {
  it("requires authentication on every route", async () => {
    const adminHomeContentService = service();
    const app = await makeApp(adminHomeContentService, false);
    const calls = [
      { method: "GET", url: "/api/admin/home-content/overview" },
      { method: "GET", url: "/api/admin/home-content/items?kind=discovery_case" },
      { method: "POST", url: "/api/admin/home-content/discovery-cases", payload: caseBody },
      { method: "POST", url: "/api/admin/home-content/examples", payload: exampleBody },
      { method: "POST", url: "/api/admin/home-content/categories", payload: { kind: "discovery_category", key: "k", label: "L", dataType: null, accent: null, isActive: true, reason: "原因" } },
      { method: "POST", url: "/api/admin/home-content/active", payload: { kind: "discovery_case", entityId: CASE_ID, isActive: false, reason: "下架" } },
      { method: "POST", url: "/api/admin/home-content/reorder", payload: { kind: "discovery_case", categoryKey: "branding-design", orderedIds: [CASE_ID], reason: "排序" } },
      { method: "POST", url: "/api/admin/home-content/category-order", payload: { kind: "discovery_category", orderedKeys: ["a"], reason: "排序" } },
      { method: "POST", url: "/api/admin/home-content/delete", payload: { kind: "discovery_case", entityId: CASE_ID, reason: "删除" } },
    ] as const;
    for (const call of calls) {
      const response = await app.inject(call as never);
      expect(response.statusCode, call.url).toBe(401);
    }
    expect(adminHomeContentService.overview).not.toHaveBeenCalled();
    expect(adminHomeContentService.upsertDiscoveryCase).not.toHaveBeenCalled();
  });

  it("returns the overview with both libraries", async () => {
    const app = await makeApp(service());
    const response = await app.inject({ method: "GET", url: "/api/admin/home-content/overview" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(overview);
  });

  it("lists one kind at a time and rejects anything else", async () => {
    const adminHomeContentService = service();
    const app = await makeApp(adminHomeContentService);
    const response = await app.inject({ method: "GET",
      url: "/api/admin/home-content/items?kind=example_example&categoryKey=branding&active=false&query=%E7%A4%BA%E4%BE%8B&limit=10&offset=5" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(exampleList);
    expect(adminHomeContentService.list).toHaveBeenCalledWith(user.id, {
      kind: "example_example", categoryKey: "branding", active: false, query: "示例", limit: 10, offset: 5,
    });

    for (const url of ["/api/admin/home-content/items", "/api/admin/home-content/items?kind=wat",
      "/api/admin/home-content/items?kind=discovery_case&active=maybe",
      "/api/admin/home-content/items?kind=discovery_case&limit=0",
      "/api/admin/home-content/items?kind=discovery_case&limit=500",
      "/api/admin/home-content/items?kind=discovery_case&offset=-1"]) {
      const bad = await app.inject({ method: "GET", url });
      expect(bad.statusCode, url).toBe(400);
      expect(bad.json(), url).toMatchObject({ error: { code: "admin_invalid_request" } });
    }
  });

  it("creates a discovery case and refuses an incomplete one", async () => {
    const adminHomeContentService = service();
    const app = await makeApp(adminHomeContentService);
    const ok = await app.inject({ method: "POST", url: "/api/admin/home-content/discovery-cases", payload: caseBody });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: CASE_ID, created: true, sortOrder: 1 });
    expect(adminHomeContentService.upsertDiscoveryCase).toHaveBeenCalledWith(user.id, caseBody);

    for (const payload of [
      { ...caseBody, title: "" },
      { ...caseBody, coverImageUrl: "not-a-url" },
      { ...caseBody, reason: "短" },
      { ...caseBody, sortOrder: 3 },
      { ...caseBody, categoryKey: "" },
    ]) {
      const bad = await app.inject({ method: "POST", url: "/api/admin/home-content/discovery-cases", payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("validates an example's images and mentions", async () => {
    const adminHomeContentService = service();
    const app = await makeApp(adminHomeContentService);
    const ok = await app.inject({ method: "POST", url: "/api/admin/home-content/examples", payload: exampleBody });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: EXAMPLE_ID, created: false, sortOrder: 4 });

    for (const payload of [
      { ...exampleBody, imageUrls: ["not-a-url"] },
      { ...exampleBody, imageUrls: ["https://example.com/a.png", ""] },
      { ...exampleBody, inputMentions: [{ name: "Logo", type: "video", imgSrc: "https://example.com/l.png" }] },
      { ...exampleBody, inputMentions: [{ name: "", type: "image", imgSrc: "https://example.com/l.png" }] },
      { ...exampleBody, exampleId: "not-a-uuid" },
    ]) {
      const bad = await app.inject({ method: "POST", url: "/api/admin/home-content/examples", payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("keeps the category key to the slug shape the database enforces", async () => {
    const adminHomeContentService = service();
    const app = await makeApp(adminHomeContentService);
    const ok = await app.inject({ method: "POST", url: "/api/admin/home-content/categories",
      payload: { kind: "example_category", key: "branding", label: "Branding", dataType: "Branding", accent: "special", isActive: true, reason: "改分类" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ key: "branding", kind: "example_category", created: true, sortOrder: 6 });

    for (const payload of [
      { kind: "discovery_category", key: "Branding", label: "L", dataType: null, accent: null, isActive: true, reason: "原因" },
      { kind: "discovery_category", key: "-branding", label: "L", dataType: null, accent: null, isActive: true, reason: "原因" },
      { kind: "wat", key: "branding", label: "L", dataType: null, accent: null, isActive: true, reason: "原因" },
      { kind: "discovery_category", key: "branding", label: "L", dataType: null, accent: "loud", isActive: true, reason: "原因" },
    ]) {
      const bad = await app.inject({ method: "POST", url: "/api/admin/home-content/categories", payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("requires a uuid entity id for the uuid-backed kinds but not for slugs", async () => {
    const adminHomeContentService = service();
    const app = await makeApp(adminHomeContentService);
    const slugToggle = await app.inject({ method: "POST", url: "/api/admin/home-content/active",
      payload: { kind: "discovery_case", entityId: CASE_ID, isActive: false, reason: "下架案例" } });
    expect(slugToggle.statusCode).toBe(200);
    expect(slugToggle.json()).toEqual({ kind: "discovery_case", id: CASE_ID, isActive: false, wasActive: true, hiddenItems: 3 });

    const uuidToggle = await app.inject({ method: "POST", url: "/api/admin/home-content/active",
      payload: { kind: "example_example", entityId: "not-a-uuid", isActive: false, reason: "下架示例" } });
    expect(uuidToggle.statusCode).toBe(400);
    expect(adminHomeContentService.setActive).toHaveBeenCalledTimes(1);

    // Deleting a category is not offered at all: the contract only knows the two
    // entry kinds, so the request never reaches the service.
    const categoryDelete = await app.inject({ method: "POST", url: "/api/admin/home-content/delete",
      payload: { kind: "discovery_category", entityId: "branding-design", reason: "删除分类" } });
    expect(categoryDelete.statusCode).toBe(400);
    expect(adminHomeContentService.deleteContent).not.toHaveBeenCalled();
  });

  it("reorders entries and categories, refusing an empty or duplicated list", async () => {
    const adminHomeContentService = service();
    const app = await makeApp(adminHomeContentService);
    const content = await app.inject({ method: "POST", url: "/api/admin/home-content/reorder",
      payload: { kind: "example_example", categoryKey: "branding", orderedIds: [EXAMPLE_ID], reason: "排序" } });
    expect(content.statusCode).toBe(200);
    expect(content.json()).toEqual({ kind: "example_example", categoryKey: "branding", ordered: 2 });

    const categories = await app.inject({ method: "POST", url: "/api/admin/home-content/category-order",
      payload: { kind: "discovery_category", orderedKeys: ["a", "b"], reason: "排序" } });
    expect(categories.statusCode).toBe(200);
    expect(categories.json()).toEqual({ kind: "discovery_category", ordered: 8 });

    for (const [url, payload] of [
      ["/api/admin/home-content/reorder", { kind: "discovery_case", categoryKey: "k", orderedIds: [], reason: "排序" }],
      ["/api/admin/home-content/reorder", { kind: "discovery_case", categoryKey: "k", orderedIds: [CASE_ID], reason: "短" }],
      ["/api/admin/home-content/category-order", { kind: "discovery_category", orderedKeys: [], reason: "排序" }],
    ] as const) {
      const bad = await app.inject({ method: "POST", url, payload });
      expect(bad.statusCode, url).toBe(400);
    }
  });

  it("deletes an entry with a reason", async () => {
    const adminHomeContentService = service();
    const app = await makeApp(adminHomeContentService);
    const response = await app.inject({ method: "POST", url: "/api/admin/home-content/delete",
      payload: { kind: "discovery_case", entityId: CASE_ID, reason: "删除重复案例" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: "discovery_case", id: CASE_ID, deleted: true });
    expect(adminHomeContentService.deleteContent).toHaveBeenCalledWith(user.id,
      { kind: "discovery_case", entityId: CASE_ID, reason: "删除重复案例" });
  });

  it("maps refusals to their status without leaking the raw message", async () => {
    for (const [code, status] of [["admin_category_not_found", 404], ["admin_content_not_found", 404],
      ["admin_invalid_order", 400], ["admin_unsupported_target", 400], ["platform_admin_required", 403]] as const) {
      const app = await makeApp(service({
        upsertDiscoveryCase: vi.fn(async () => { throw new AdminHomeContentError(code, "该分类不存在。", status); }),
      }));
      const response = await app.inject({ method: "POST", url: "/api/admin/home-content/discovery-cases", payload: caseBody });
      expect(response.statusCode, code).toBe(status);
      expect(response.json(), code).toMatchObject({ error: { code } });
    }
  });

  it("maps an unexpected failure to 500 without leaking the internal message", async () => {
    const app = await makeApp(service({
      overview: vi.fn(async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); }),
    }));
    const response = await app.inject({ method: "GET", url: "/api/admin/home-content/overview" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "admin_write_failed" } });
    expect(response.body).not.toContain("10.0.0.5");
  });
});
