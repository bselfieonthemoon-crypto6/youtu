import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminSkillPreview } from "@loomic/shared";

import { AdminSkillError, type AdminSkillService } from "../features/admin/admin-skill-service.js";
import { registerAdminSkillRoutes } from "./admin-skills.js";

const user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.com", accessToken: "token", userMetadata: {} };
const SKILL = "87e79614-8f4b-4530-8003-6e4bab97c993";
const PREVIEW = "11111111-1111-4111-8111-111111111111";

const preview: AdminSkillPreview = {
  id: PREVIEW, skillId: SKILL, role: "cover", caption: "封面", sortOrder: 0, status: "draft",
  assetObjectId: "22222222-2222-4222-8222-222222222222", mimeType: "image/png", byteSize: 4,
  createdBy: user.id, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z",
  imageUrl: "https://signed.test/cover.png",
};

const catalogEntry = {
  id: SKILL, slug: "logo-design", name: "Logo 与品牌标识", displayName: null, category: "design",
  source: "system", version: "2.2.0", iconName: "shapes", outputKinds: ["raster-image"],
  enabledWorkspaces: 32, installCount: 32, previewCount: 1, publishedPreviewCount: 0, hasPublishedCover: false,
};

function service(overrides: Partial<AdminSkillService> = {}): AdminSkillService {
  return {
    listSkills: vi.fn(async () => ({ skills: [catalogEntry] })),
    listPreviews: vi.fn(async () => ({ previews: [preview] })),
    attachPreview: vi.fn(async () => preview),
    publishPreview: vi.fn(async () => undefined),
    unpublishPreview: vi.fn(async () => undefined),
    deletePreview: vi.fn(async () => undefined),
    reorderPreviews: vi.fn(async () => undefined),
    listPublishedPreviews: vi.fn(async () => ({ previews: [{
      id: PREVIEW, role: "cover" as const, caption: "封面", imageUrl: "https://signed.test/cover.png" }] })),
    listPublishedPreviewGroups: vi.fn(async (slugs: readonly string[]) => ({ groups: slugs.map(slug => ({
      slug, cover: { id: PREVIEW, role: "cover" as const, caption: "封面", imageUrl: "https://signed.test/cover.png" },
      examples: [] })) })),
    ...overrides,
  };
}

/** Minimal multipart body so the upload route is exercised, not bypassed. */
function multipartBody(fields: Record<string, string>, file?: { name: string; type: string; content: Buffer }) {
  const boundary = "----loomicSkillPreviewBoundary";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n`));
    parts.push(file.content);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

async function makeApp(adminSkillService: AdminSkillService, authenticated = true) {
  const app = Fastify();
  apps.push(app);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await registerAdminSkillRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticated ? user : null) } as never,
    adminSkillService,
  });
  await app.ready();
  return app;
}

describe("admin skill routes", () => {
  it("requires authentication on every route", async () => {
    const adminSkillService = service();
    const app = await makeApp(adminSkillService, false);
    const routes = [
      ["GET", "/api/admin/skills", undefined],
      ["GET", `/api/admin/skills/${SKILL}/previews`, undefined],
      ["POST", `/api/admin/skills/${SKILL}/previews`, undefined],
      ["POST", `/api/admin/skills/${SKILL}/previews/${PREVIEW}/publish`, { reason: "上线" }],
      ["POST", `/api/admin/skills/${SKILL}/previews/${PREVIEW}/unpublish`, { reason: "下架" }],
      ["DELETE", `/api/admin/skills/${SKILL}/previews/${PREVIEW}`, { reason: "删除" }],
      ["POST", `/api/admin/skills/${SKILL}/previews/order`, { orderedPreviewIds: [PREVIEW], reason: "排序" }],
      ["GET", "/api/skills/logo-design/previews", undefined],
      ["GET", "/api/skill-previews?slugs=logo-design", undefined],
    ] as const;
    for (const [method, url, payload] of routes) {
      const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(adminSkillService.listSkills).not.toHaveBeenCalled();
    expect(adminSkillService.attachPreview).not.toHaveBeenCalled();
    expect(adminSkillService.listPublishedPreviews).not.toHaveBeenCalled();
  });

  it("lists the catalog with a bounded limit", async () => {
    const adminSkillService = service();
    const app = await makeApp(adminSkillService);
    const ok = await app.inject({ method: "GET", url: "/api/admin/skills?query=logo&limit=10" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ skills: [catalogEntry] });
    expect(adminSkillService.listSkills).toHaveBeenCalledWith(user.id, { query: "logo", limit: 10 });

    for (const url of ["/api/admin/skills?limit=0", "/api/admin/skills?limit=1000"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }
  });

  it("rejects a malformed skill id before the service", async () => {
    const adminSkillService = service();
    const app = await makeApp(adminSkillService);
    const response = await app.inject({ method: "GET", url: "/api/admin/skills/not-a-uuid/previews" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "admin_invalid_request" } });
    expect(adminSkillService.listPreviews).not.toHaveBeenCalled();
  });

  it("returns previews including drafts for the console", async () => {
    const app = await makeApp(service());
    const response = await app.inject({ method: "GET", url: `/api/admin/skills/${SKILL}/previews` });
    expect(response.statusCode).toBe(200);
    expect(response.json().previews[0]).toMatchObject({ id: PREVIEW, status: "draft", role: "cover" });
  });

  it("uploads a preview with the file, role, caption and reason", async () => {
    const adminSkillService = service();
    const app = await makeApp(adminSkillService);
    const { payload, contentType } = multipartBody({ role: "cover", caption: " 首页封面 ", reason: "上线封面" },
      { name: "cover.png", type: "image/png", content: png() });
    const response = await app.inject({ method: "POST", url: `/api/admin/skills/${SKILL}/previews`,
      headers: { "content-type": contentType }, payload });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ preview });
    const call = (adminSkillService.attachPreview as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1]).toMatchObject({ skillId: SKILL, role: "cover", caption: "首页封面", reason: "上线封面", mimeType: "image/png" });
    expect((call[1] as { buffer: Buffer }).buffer.equals(png())).toBe(true);
  });

  it("refuses an upload without a file, with an unknown role or without a reason", async () => {
    const adminSkillService = service();
    const app = await makeApp(adminSkillService);
    const noFile = multipartBody({ role: "cover", reason: "上线封面" });
    expect((await app.inject({ method: "POST", url: `/api/admin/skills/${SKILL}/previews`,
      headers: { "content-type": noFile.contentType }, payload: noFile.payload })).statusCode).toBe(400);

    for (const fields of [{ role: "banner", reason: "上线封面" }, { role: "cover", reason: "x" }]) {
      const body = multipartBody(fields, { name: "a.png", type: "image/png", content: png() });
      const response = await app.inject({ method: "POST", url: `/api/admin/skills/${SKILL}/previews`,
        headers: { "content-type": body.contentType }, payload: body.payload });
      expect(response.statusCode, JSON.stringify(fields)).toBe(400);
    }
    expect(adminSkillService.attachPreview).not.toHaveBeenCalled();
  });

  it("publishes, unpublishes, deletes and reorders with a reason", async () => {
    const adminSkillService = service();
    const app = await makeApp(adminSkillService);
    const publish = await app.inject({ method: "POST", url: `/api/admin/skills/${SKILL}/previews/${PREVIEW}/publish`,
      payload: { reason: " 上线 " } });
    expect(publish.statusCode).toBe(200);
    expect(publish.json()).toEqual({ previewId: PREVIEW, status: "published" });
    expect(adminSkillService.publishPreview).toHaveBeenCalledWith(user.id, { previewId: PREVIEW, reason: "上线" });

    const unpublish = await app.inject({ method: "POST", url: `/api/admin/skills/${SKILL}/previews/${PREVIEW}/unpublish`,
      payload: { reason: "下架" } });
    expect(unpublish.statusCode).toBe(200);
    expect(unpublish.json()).toEqual({ previewId: PREVIEW, status: "draft" });

    const removed = await app.inject({ method: "DELETE", url: `/api/admin/skills/${SKILL}/previews/${PREVIEW}`,
      payload: { reason: "删除" } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ previewId: PREVIEW, deleted: true });

    const reordered = await app.inject({ method: "POST", url: `/api/admin/skills/${SKILL}/previews/order`,
      payload: { orderedPreviewIds: [PREVIEW], reason: "排序" } });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json()).toEqual({ skillId: SKILL, ordered: 1 });
    expect(adminSkillService.reorderPreviews).toHaveBeenCalledWith(user.id,
      { skillId: SKILL, orderedPreviewIds: [PREVIEW], reason: "排序" });
  });

  it("rejects a bad preview id, a short reason and a malformed order list", async () => {
    const adminSkillService = service();
    const app = await makeApp(adminSkillService);
    expect((await app.inject({ method: "POST", url: `/api/admin/skills/${SKILL}/previews/not-a-uuid/publish`,
      payload: { reason: "上线" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/admin/skills/${SKILL}/previews/${PREVIEW}/publish`,
      payload: { reason: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/admin/skills/${SKILL}/previews/${PREVIEW}/publish`,
      payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/admin/skills/${SKILL}/previews/order`,
      payload: { orderedPreviewIds: [], reason: "排序" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/admin/skills/${SKILL}/previews/order`,
      payload: { orderedPreviewIds: ["nope"], reason: "排序" } })).statusCode).toBe(400);
    expect(adminSkillService.publishPreview).not.toHaveBeenCalled();
    expect(adminSkillService.reorderPreviews).not.toHaveBeenCalled();
  });

  it("serves published previews to any signed-in user and validates the slug", async () => {
    const adminSkillService = service();
    const app = await makeApp(adminSkillService);
    const ok = await app.inject({ method: "GET", url: "/api/skills/logo-design/previews" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ previews: [{ id: PREVIEW, role: "cover", caption: "封面",
      imageUrl: "https://signed.test/cover.png" }] });
    expect(adminSkillService.listPublishedPreviews).toHaveBeenCalledWith("logo-design");

    expect((await app.inject({ method: "GET", url: "/api/skills/not a slug!/previews" })).statusCode).toBe(400);
  });

  it("serves a bounded batch of published previews for a page of cards", async () => {
    const adminSkillService = service();
    const app = await makeApp(adminSkillService);
    const ok = await app.inject({ method: "GET", url: "/api/skill-previews?slugs=logo-design,json-image-prompt" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().groups.map((group: { slug: string }) => group.slug))
      .toEqual(["logo-design", "json-image-prompt"]);
    expect(adminSkillService.listPublishedPreviewGroups)
      .toHaveBeenCalledWith(["logo-design", "json-image-prompt"]);

    // An empty or oversized list is the caller's mistake, not a 500.
    for (const url of ["/api/skill-previews", "/api/skill-previews?slugs=",
      `/api/skill-previews?slugs=${Array.from({ length: 51 }, (_, index) => `s-${index}`).join(",")}`]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json(), url).toMatchObject({ error: { code: "admin_invalid_request" } });
    }
  });

  it("maps a service refusal to its status and never leaks the raw message", async () => {
    for (const [code, status] of [["admin_skill_not_found", 404], ["admin_preview_not_found", 404],
      ["admin_invalid_asset", 400], ["admin_invalid_order", 400]] as const) {
      const app = await makeApp(service({
        publishPreview: vi.fn(async () => { throw new AdminSkillError(code, "该技能图片不存在。", status); }),
      }));
      const response = await app.inject({ method: "POST", url: `/api/admin/skills/${SKILL}/previews/${PREVIEW}/publish`,
        payload: { reason: "上线" } });
      expect(response.statusCode, code).toBe(status);
      expect(response.json(), code).toMatchObject({ error: { code } });
    }
  });

  it("maps an unexpected failure to 500 without leaking the internal message", async () => {
    const app = await makeApp(service({
      listSkills: vi.fn(async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); }),
    }));
    const response = await app.inject({ method: "GET", url: "/api/admin/skills" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "admin_write_failed" } });
    expect(response.body).not.toContain("10.0.0.5");
  });
});
