import { describe, expect, it, vi } from "vitest";
import { defaultAgentCollaborationSettings } from "@loomic/shared";
import { createSettingsService } from "./settings-service.js";

const user = { id: "user-a", accessToken: "token-a", email: "", userMetadata: {} };
const alias = "workspace:12345678-1234-4123-8123-123456789012";
function fixture(role: string | null = "owner", accessible = true) {
  const saved: Record<string, unknown> = { default_model: "apiyi:default", agent_collaboration: defaultAgentCollaborationSettings() };
  const writes: unknown[] = [];
  const from = vi.fn((table: string) => {
    const query: any = {
      select: vi.fn(() => query), eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: table === "workspace_members" ? (role ? { role } : null) : saved, error: null })),
      upsert: vi.fn(async (patch: Record<string, unknown>) => { writes.push(patch); Object.assign(saved, patch); return { error: null }; }),
    };
    return query;
  });
  const resolve = vi.fn(async () => accessible ? { capabilities: ["text"] } : null);
  const service = createSettingsService({ createUserClient: vi.fn(() => ({ from })) as any, defaultModel: "apiyi:default", workspaceModelCatalogService: { resolvePublishedModel: resolve } as any });
  return { service, saved, writes, resolve };
}
describe("workspace Agent collaboration settings", () => {
  it("persists independent role models without changing the main model", async () => {
    const f = fixture();
    const config = defaultAgentCollaborationSettings(); config.roleModels.design_review = alias;
    const result = await f.service.updateWorkspaceSettings(user, "workspace-a", { agentCollaboration: config });
    expect(result).toEqual({ defaultModel: "apiyi:default", agentCollaboration: config });
    expect(f.writes[0]).not.toHaveProperty("default_model");
    expect(f.resolve).toHaveBeenCalledWith(user, "workspace-a", alias, "text");
  });
  it("updates main model without resetting role settings", async () => {
    const f = fixture();
    (f.saved.agent_collaboration as any).maxParallel = 1;
    expect((await f.service.updateWorkspaceSettings(user, "workspace-a", { defaultModel: alias })).agentCollaboration?.maxParallel).toBe(1);
    expect(f.writes[0]).not.toHaveProperty("agent_collaboration");
  });
  it.each(["member", null])("denies nonmanager %s before mutations", async role => {
    const f = fixture(role);
    await expect(f.service.updateWorkspaceSettings(user, "workspace-a", { agentCollaboration: defaultAgentCollaborationSettings() })).rejects.toMatchObject({ code: "settings_forbidden", statusCode: 403 });
    expect(f.writes).toHaveLength(0);
  });
  it("denies inaccessible/cross-workspace role model without any write", async () => {
    const f = fixture("owner", false); const config = defaultAgentCollaborationSettings(); config.roleModels.reference_analysis = alias;
    await expect(f.service.updateWorkspaceSettings(user, "workspace-a", { agentCollaboration: config })).rejects.toMatchObject({ code: "settings_model_not_accessible" });
    expect(f.writes).toHaveLength(0);
  });
  it("deduplicates validation of the same role model", async () => {
    const f = fixture(); const config = defaultAgentCollaborationSettings();
    config.roleModels.reference_analysis = alias; config.roleModels.design_review = alias;
    await f.service.updateWorkspaceSettings(user, "workspace-a", { agentCollaboration: config });
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });
  it("allows disabling without losing now-unpublished model selections", async () => {
    const f = fixture("owner", false); const config = defaultAgentCollaborationSettings();
    config.enabled = false; config.roleModels.design_review = alias;
    expect((await f.service.updateWorkspaceSettings(user, "workspace-a", { agentCollaboration: config })).agentCollaboration).toEqual(config);
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it("rejects an incomplete nested section before overwriting existing configuration", async () => {
    const f = fixture(); (f.saved.agent_collaboration as any).roleModels.design_review = alias;
    await expect(f.service.updateWorkspaceSettings(user, "workspace-a", { agentCollaboration: { enabled: false } as any })).rejects.toMatchObject({ name: "ZodError" });
    expect(f.writes).toEqual([]); expect((f.saved.agent_collaboration as any).roleModels.design_review).toBe(alias);
  });
  it("passes canonical aliases to catalog validation and stores them consistently", async () => {
    const f = fixture(); const config = defaultAgentCollaborationSettings();
    config.roleModels.design_review = "workspace:ABCDEFAB-1234-4123-8123-123456789ABC";
    const result = await f.service.updateWorkspaceSettings(user, "workspace-a", { agentCollaboration: config });
    expect(result.agentCollaboration?.roleModels.design_review).toBe("workspace:abcdefab-1234-4123-8123-123456789abc");
    expect(f.resolve).toHaveBeenCalledWith(user, "workspace-a", "workspace:abcdefab-1234-4123-8123-123456789abc", "text");
  });
  it("never silently replaces an invalid default with another model", async () => {
    const f = fixture("owner", false);
    await expect(f.service.updateWorkspaceSettings(user, "workspace-a", { defaultModel: "apiyi:arbitrary" })).rejects.toMatchObject({ code: "settings_model_not_accessible" });
    expect(f.writes).toHaveLength(0);
  });
});
