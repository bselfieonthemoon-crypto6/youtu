import { describe, expect, it } from "vitest";
import { agentCollaborationSettingsSchema, defaultAgentCollaborationSettings } from "./agent-collaboration-contracts.js";
import { workspaceSettingsSchema } from "./contracts.js";
import { workspaceSettingsUpdateRequestSchema } from "./http.js";

describe("agent collaboration configuration", () => {
  it("has bounded defaults without mutating subsequent readers", () => {
    const first = defaultAgentCollaborationSettings();
    first.roleModels.reference_analysis = "changed";
    expect(defaultAgentCollaborationSettings()).toMatchObject({ enabled: true, maxParallel: 2, maxTasksPerRun: 6, roleModels: { reference_analysis: null } });
  });
  it.each([{ maxParallel: 4 }, { maxParallel: 0 }, { maxTasksPerRun: 9 }, { timeoutMs: 9000 }, { timeoutMs: 120001 }, { enabled: "yes" }, { arbitrary: true }])("rejects invalid limits %j", value => {
    expect(agentCollaborationSettingsSchema.safeParse(value).success).toBe(false);
  });
  it("rejects raw/provider names and cross-role injection", () => {
    expect(agentCollaborationSettingsSchema.safeParse({ roleModels: { design_review: "apiyi:any" } }).success).toBe(false);
    expect(agentCollaborationSettingsSchema.safeParse({ roleModels: { super_agent: null } }).success).toBe(false);
  });
  it("accepts workspace model aliases and legacy settings updates", () => {
    const alias = "workspace:12345678-1234-4123-8123-123456789012";
    expect(agentCollaborationSettingsSchema.parse({ roleModels: { design_review: alias } }).roleModels.design_review).toBe(alias);
    expect(workspaceSettingsSchema.parse({ defaultModel: "legacy" }).agentCollaboration).toBeUndefined();
  });
  it("rejects nested partial updates instead of silently resetting stored configuration", () => {
    expect(workspaceSettingsUpdateRequestSchema.safeParse({ agentCollaboration: { enabled: false } }).success).toBe(false);
    const complete = defaultAgentCollaborationSettings(); complete.enabled = false;
    expect(workspaceSettingsUpdateRequestSchema.parse({ agentCollaboration: complete })).toEqual({ agentCollaboration: complete });
  });
  it("canonicalizes valid uppercase aliases before persistence", () => {
    const config = defaultAgentCollaborationSettings();
    config.roleModels.design_review = "workspace:ABCDEFAB-1234-4123-8123-123456789ABC";
    expect(workspaceSettingsUpdateRequestSchema.parse({ agentCollaboration: config }).agentCollaboration?.roleModels.design_review)
      .toBe("workspace:abcdefab-1234-4123-8123-123456789abc");
  });
});
