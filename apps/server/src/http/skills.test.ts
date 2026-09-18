import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSkillRoutes, type SkillRouteOptions } from "./skills.js";

const id = "de893edc-1497-4132-8b20-e3ae6b7bda70";
const userId = "000b9d04-cd46-44f4-9d2c-d2b10fbb6ec6";
const workspaceId = "701dcfdc-c285-429c-b80f-d786c517b066";
const timestamp = "2026-09-09T00:00:00.000Z";
const input = { name: "Focused skill", description: "Only the requested task", category: "design", skillContent: "Read instructions and preserve user scope." };
const row = { id, name: input.name, description: input.description, slug: "focused-skill-stable", category: "design",
  skill_content: input.skillContent, author: "user", source: "user", version: "1.0", created_by: userId,
  metadata: {}, icon_name: null, is_featured: false, license: null, created_at: timestamp, updated_at: timestamp };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function fixture(options: { authenticated?: boolean; rpcError?: Record<string, string>; queryError?: boolean; readinessError?: boolean } = {}) {
  const app = Fastify({ logger: false }); apps.push(app);
  const rpc = vi.fn(async () => ({ data: options.rpcError ? null : { skill: row, files: [] }, error: options.rpcError ?? null }));
  const builder: any = {};
  for (const method of ["select", "eq", "order", "maybeSingle"]) builder[method] = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: options.queryError ? { message: "Database disconnected" } : null });
  const from = vi.fn(() => builder);
  const authenticate = vi.fn(async () => options.authenticated === false ? null : { id: userId, accessToken: "test-only" });
  const routeOptions = {
    auth: { authenticate }, createUserClient: () => ({ rpc, from }),
    viewerService: { ensureViewer: async () => ({ workspace: { id: workspaceId } }) },
    getSkillReadiness: async () => {
      if (options.readinessError) throw new Error("Capability catalog offline");
      return [{ status: "limited", reasons: ["User-authored workflow"], models: [] }];
    },
  } as unknown as SkillRouteOptions;
  await registerSkillRoutes(app, routeOptions); await app.ready();
  return { app, rpc, from };
}

describe("Skills HTTP outcomes", () => {
  it("returns a saved package only after its single atomic RPC succeeds", async () => {
    const { app, rpc } = await fixture();
    const response = await app.inject({ method: "POST", url: "/api/skills", payload: input });
    expect(response.statusCode).toBe(201);
    expect(response.json().skill).toMatchObject({ id, slug: row.slug, readiness: { status: "limited" } });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("save_skill_package", expect.objectContaining({ p_workspace_id: workspaceId }));
  });

  it("readiness inspection cannot report a committed save as a failed creation", async () => {
    const { app } = await fixture({ readinessError: true });
    const response = await app.inject({ method: "POST", url: "/api/skills", payload: input });
    expect(response.statusCode).toBe(201);
    expect(response.json().skill.readiness.status).toBe("unavailable");
  });

  it.each([
    ["42501", "permission denied", 403, "skill_forbidden"],
    ["22023", "invalid files", 400, "skill_invalid_package"],
    ["23505", "duplicate file", 409, "skill_conflict"],
    ["XX000", "complete transaction failed", 500, "skill_save_failed"],
  ])("reports RPC failure %s rather than returning a half-success", async (code, message, expected, publicCode) => {
    const { app, rpc } = await fixture({ rpcError: { code: String(code), message: String(message) } });
    const response = await app.inject({ method: "POST", url: "/api/skills", payload: input });
    expect(response.statusCode).toBe(expected);
    expect(response.json().skill).toBeUndefined();
    expect(response.json().error.code).toBe(publicCode);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("does not expose an authentication-free registry or accept unauthenticated writes", async () => {
    const { app, rpc, from } = await fixture({ authenticated: false });
    for (const url of ["/api/skills", "/api/workspaces/skills"]) expect((await app.inject(url)).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/skills", payload: input })).statusCode).toBe(401);
    expect(rpc).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
  });

  it("validates write IDs and payloads before invoking the database", async () => {
    const { app, rpc } = await fixture();
    for (const payload of [{ ...input, skillContent: " " }, { ...input, files: [{ filePath: "references/../secret", content: "bad" }] }]) {
      expect((await app.inject({ method: "POST", url: "/api/skills", payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "PUT", url: "/api/skills/not-an-id", payload: { name: "New" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/workspaces/skills/" + id, payload: { enabled: "false" } })).statusCode).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a workspace query failure is an error, not an empty installed list", async () => {
    const { app } = await fixture({ queryError: true });
    const response = await app.inject("/api/workspaces/skills");
    expect(response.statusCode).toBe(500);
    expect(response.json()).not.toHaveProperty("skills");
  });

  it("forwards a disabled toggle without changing the package identity", async () => {
    const { app, rpc } = await fixture();
    expect((await app.inject({ method: "PATCH", url: "/api/workspaces/skills/" + id, payload: { enabled: false } })).statusCode).toBe(204);
    expect(rpc).toHaveBeenCalledWith("install_skill_package", { p_workspace_id: workspaceId, p_skill_id: id, p_enabled: false });
  });
});
