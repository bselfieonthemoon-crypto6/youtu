import { describe, expect, it, vi } from "vitest";
import { createProjectService } from "./project-service.js";

const user = { id: "owner", email: "test@example.invalid", accessToken: "test", userMetadata: {} };
function fixture(canvasRows: object[], error: object | null = null) {
  const rows: Record<string, unknown> = {
    workspaces: { id: "workspace", name: "Workspace", type: "personal", owner_user_id: user.id },
    projects: ["empty", "normal", "fallback"].map(id => ({ id, name: id, slug: id,
      description: null, created_at: "2026-09-11", updated_at: "2026-09-11", thumbnail_path: null })),
    canvases: canvasRows,
  };
  const queries: Record<string, any> = {};
  const from = vi.fn((table: string) => {
    const query: any = { then: (resolve: any) => Promise.resolve({ data: rows[table], error: table === "canvases" ? error : null }).then(resolve) };
    for (const method of ["select", "eq", "is", "in", "order", "limit", "maybeSingle"]) query[method] = vi.fn(() => query);
    queries[table] = query;
    return query;
  });
  const service = createProjectService({ createUserClient: (() => ({ from })) as any, viewerService: {} as any });
  return { service, queries, from };
}
const canvas = (id: string, project_id: string, is_primary = true) => ({ id, project_id, is_primary, name: id });

describe("project listing with removed canvases", () => {
  it("omits empty projects and retains a deterministic non-primary fallback without writing", async () => {
    const f = fixture([canvas("main", "normal"), canvas("oldest", "fallback", false), canvas("newer", "fallback", false)]);
    const result = await f.service.listProjects(user);
    expect(result.map(p => p.id)).toEqual(["normal", "fallback"]);
    expect(result.map(p => p.primaryCanvas.id)).toEqual(["main", "oldest"]);
    expect(result[1]!.primaryCanvas.isPrimary).toBe(false);
    expect(f.queries.canvases.order.mock.calls).toEqual([
      ["is_primary", { ascending: false }], ["created_at", { ascending: true }], ["id", { ascending: true }],
    ]);
    expect(f.from.mock.calls.map(call => call[0])).toEqual(["workspaces", "projects", "canvases"]);
  });
  it("returns an empty list when all last canvases have been deleted", async () => {
    await expect(fixture([]).service.listProjects(user)).resolves.toEqual([]);
  });
  it("does not hide database errors as an empty list", async () => {
    await expect(fixture([], { message: "query unavailable" }).service.listProjects(user))
      .rejects.toMatchObject({ code: "project_query_failed", statusCode: 500 });
  });
});
