import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdminAssetLargeObjectsResponse,
  AdminAssetOrphanListResponse,
  AdminAssetOverviewResponse,
  AdminAssetQueueResponse,
} from "@loomic/shared";

import { AdminStorageError, type AdminStorageService } from "../features/admin/admin-storage-service.js";
import { registerAdminStorageRoutes } from "./admin-storage.js";

const user = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.com", accessToken: "token", userMetadata: {} };
const ASSET = "55555555-5555-4555-8555-555555555555";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const assetRow = {
  id: ASSET, bucket: "workspace-assets", objectPath: "w/1/x.png",
  workspaceId: WORKSPACE, workspaceName: "765966283 Workspace", scope: "workspace",
  mimeType: "image/png", byteSize: 8227588, createdAt: "2026-09-12T05:03:02.995279+00:00",
  referenceCount: 0, confirmedOrphan: true,
  deletionPendingAt: null, gcEligibleAt: null, gcClaimedAt: null,
};

const overview: AdminAssetOverviewResponse = {
  totalObjects: 5735, totalBytes: 1436990476, pendingCount: 4, gcEligibleCount: 3, gcClaimedCount: 0,
  buckets: [{ bucket: "workspace-assets", scope: "workspace", objects: 5731, bytes: 1436990204,
    pendingCount: 0, gcEligibleCount: 3, claimedCount: 0 }],
  scopes: [{ scope: "workspace", objects: 5735, bytes: 1436990476 }],
  workspaces: [{ workspaceId: WORKSPACE, workspaceName: "765966283 Workspace", objects: 5695, bytes: 1409498984 }],
};

const orphans: AdminAssetOrphanListResponse = {
  total: 1307, pageConfirmed: true,
  objects: [{ ...assetRow, ageDays: 7 }],
};

const queue: AdminAssetQueueResponse = {
  kind: "pending_delete", total: 4,
  objects: [{ ...assetRow, deletionPendingAt: "2026-09-07T10:49:58.88+00:00" }],
};

const large: AdminAssetLargeObjectsResponse = { objects: [assetRow] };

function service(overrides: Partial<AdminStorageService> = {}): AdminStorageService {
  return {
    overview: vi.fn(async () => overview),
    orphanCandidates: vi.fn(async () => orphans),
    queue: vi.fn(async () => queue),
    largeObjects: vi.fn(async () => large),
    purgeOrphan: vi.fn(async () => ({ bucket: "workspace-assets", objectPath: "w/1/x.png" })),
    ...overrides,
  };
}

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

async function makeApp(adminStorageService: AdminStorageService, authenticated = true) {
  const app = Fastify();
  apps.push(app);
  await registerAdminStorageRoutes(app, {
    auth: { authenticate: vi.fn().mockResolvedValue(authenticated ? user : null) } as never,
    adminStorageService,
  });
  return app;
}

describe("admin storage routes", () => {
  it("requires authentication on all five routes", async () => {
    const adminStorageService = service();
    const app = await makeApp(adminStorageService, false);
    for (const url of ["/api/admin/storage/overview", "/api/admin/storage/orphans",
      "/api/admin/storage/queue?kind=pending_delete", "/api/admin/storage/large-objects"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }
    const purge = await app.inject({ method: "POST", url: "/api/admin/storage/orphans/purge",
      payload: { assetId: ASSET, reason: "清理孤儿" } });
    expect(purge.statusCode).toBe(401);
    expect(adminStorageService.overview).not.toHaveBeenCalled();
    expect(adminStorageService.purgeOrphan).not.toHaveBeenCalled();
  });

  it("returns the occupancy overview and rejects a bad workspace limit", async () => {
    const adminStorageService = service();
    const app = await makeApp(adminStorageService);
    const response = await app.inject({ method: "GET", url: "/api/admin/storage/overview?workspaceLimit=5" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(overview);
    expect(adminStorageService.overview).toHaveBeenCalledWith(user.id, 5);

    for (const url of ["/api/admin/storage/overview?workspaceLimit=0", "/api/admin/storage/overview?workspaceLimit=101",
      "/api/admin/storage/overview?workspaceLimit=abc"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }
  });

  it("passes orphan filters through and rejects malformed ones", async () => {
    const adminStorageService = service();
    const app = await makeApp(adminStorageService);
    const response = await app.inject({ method: "GET",
      url: `/api/admin/storage/orphans?bucket=workspace-assets&workspaceId=${WORKSPACE}&minBytes=1024&limit=10&offset=20` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(orphans);
    expect(adminStorageService.orphanCandidates).toHaveBeenCalledWith(user.id, {
      bucket: "workspace-assets", workspaceId: WORKSPACE, minBytes: 1024, limit: 10, offset: 20,
    });

    for (const url of ["/api/admin/storage/orphans?workspaceId=nope", "/api/admin/storage/orphans?minBytes=-1",
      "/api/admin/storage/orphans?limit=0", "/api/admin/storage/orphans?limit=101", "/api/admin/storage/orphans?offset=-1"]) {
      const bad = await app.inject({ method: "GET", url });
      expect(bad.statusCode, url).toBe(400);
      expect(bad.json(), url).toMatchObject({ error: { code: "admin_invalid_request" } });
    }
    expect(adminStorageService.orphanCandidates).toHaveBeenCalledTimes(1);
  });

  it("requires a queue kind and maps an unknown one from the service", async () => {
    const adminStorageService = service();
    const app = await makeApp(adminStorageService);
    expect((await app.inject({ method: "GET", url: "/api/admin/storage/queue" })).statusCode).toBe(400);

    const ok = await app.inject({ method: "GET", url: "/api/admin/storage/queue?kind=pending_delete&limit=5" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(queue);

    const unknown = await makeApp(service({
      queue: vi.fn(async () => { throw new AdminStorageError("admin_unknown_kind", "请求的队列类型不受支持。", 400); }),
    }));
    const response = await unknown.inject({ method: "GET", url: "/api/admin/storage/queue?kind=wat" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "admin_unknown_kind" } });
  });

  it("bounds the large-object ranking", async () => {
    const adminStorageService = service();
    const app = await makeApp(adminStorageService);
    const response = await app.inject({ method: "GET", url: "/api/admin/storage/large-objects?limit=3" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(large);
    expect(adminStorageService.largeObjects).toHaveBeenCalledWith(user.id, 3);
    expect((await app.inject({ method: "GET", url: "/api/admin/storage/large-objects?limit=51" })).statusCode).toBe(400);
  });

  it("purges one orphan and echoes what was removed", async () => {
    const adminStorageService = service();
    const app = await makeApp(adminStorageService);
    const response = await app.inject({ method: "POST", url: "/api/admin/storage/orphans/purge",
      payload: { assetId: ASSET, reason: " 确认无引用 " } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assetId: ASSET, bucket: "workspace-assets", objectPath: "w/1/x.png", deleted: true });
    expect(adminStorageService.purgeOrphan).toHaveBeenCalledWith(user.id,
      { assetId: ASSET, reason: "确认无引用" });

    for (const payload of [{ assetId: "not-a-uuid", reason: "清理孤儿" }, { assetId: ASSET, reason: "短" },
      { assetId: ASSET, reason: "清理孤儿", extra: true }]) {
      const bad = await app.inject({ method: "POST", url: "/api/admin/storage/orphans/purge", payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(adminStorageService.purgeOrphan).toHaveBeenCalledTimes(1);
  });

  it("maps refusals to their status without leaking the raw message", async () => {
    for (const [code, status] of [["admin_asset_not_found", 404], ["admin_asset_referenced", 409],
      ["admin_asset_not_pending", 409], ["platform_admin_required", 403]] as const) {
      const app = await makeApp(service({
        purgeOrphan: vi.fn(async () => { throw new AdminStorageError(code, "该存储对象不存在。", status); }),
      }));
      const response = await app.inject({ method: "POST", url: "/api/admin/storage/orphans/purge",
        payload: { assetId: ASSET, reason: "清理孤儿" } });
      expect(response.statusCode, code).toBe(status);
      expect(response.json(), code).toMatchObject({ error: { code } });
    }
  });

  it("maps an unexpected failure to 500 without leaking the internal message", async () => {
    const app = await makeApp(service({
      overview: vi.fn(async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); }),
    }));
    const response = await app.inject({ method: "GET", url: "/api/admin/storage/overview" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "admin_write_failed" } });
    expect(response.body).not.toContain("10.0.0.5");
  });
});
