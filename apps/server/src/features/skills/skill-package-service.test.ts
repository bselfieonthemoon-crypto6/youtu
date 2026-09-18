import { describe, expect, it, vi } from "vitest";
import { isSafeSkillFilePath, skillCreateRequestSchema, skillUpdateRequestSchema } from "@loomic/shared";
import { createSkillPackageService, stableSkillSlug, validateSkillInstructions } from "./skill-package-service.js";

const stamp = "2026-09-09T00:00:00.000Z";
const skillId = "8a67c134-c49e-4a42-aae8-b1258f97fa6b";
const workspaceId = "7f0cf8ce-36b2-4524-9cb3-7fc5c1ef3cd0";
const input = { name: "测试技能", description: "明确范围的原始技能", category: "design" as const, skillContent: "# 用法\n保留用户要求，按需读取参考资料。" };
function makeService(error: { code: string; message: string } | null = null) {
  const rpc = vi.fn(async (_name: string, params: any) => ({
    error,
    data: error ? null : {
      skill: { id: skillId, name: input.name, description: input.description,
        author: "user", version: "1.0", category: "design", icon_name: null, source: "user", is_featured: false,
        metadata: {}, created_at: stamp, updated_at: stamp, license: null, skill_content: input.skillContent,
        created_by: "e9a9b5ae-a278-4a5d-9e08-609a4b73de21", ...params.p_payload, slug: "original-stable-id" },
      files: [],
    },
  }));
  return { rpc, service: createSkillPackageService({ rpc } as any) };
}

describe("atomic skill package service", () => {
  it("creates content, references and installation in one RPC", async () => {
    const { rpc, service } = makeService();
    await service.create(workspaceId, { ...input, files: [{ filePath: "references/指南.md", content: "原始资料" }] });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("save_skill_package", expect.objectContaining({ p_skill_id: null, p_workspace_id: workspaceId,
      p_payload: expect.objectContaining({ skillContent: input.skillContent, files: [{ filePath: "references/指南.md", content: "原始资料" }] }) }));
  });

  it("rename does not regenerate slug; omitted files stay omitted and [] explicitly clears", async () => {
    const { rpc, service } = makeService();
    const renamed = await service.update(skillId, { name: "新名称" });
    expect(renamed.slug).toBe("original-stable-id");
    expect(rpc.mock.calls[0]![1]).toEqual({ p_skill_id: skillId, p_workspace_id: null, p_payload: { name: "新名称" } });
    await service.update(skillId, { files: [] });
    expect(rpc.mock.calls[1]![1].p_payload).toEqual({ files: [] });
  });

  it.each([
    ["42501", "permission denied", 403, "skill_forbidden"],
    ["22023", "skill_not_found", 404, "skill_not_found"],
    ["23505", "duplicate", 409, "skill_conflict"],
    ["22023", "skill_invalid_files", 400, "skill_invalid_package"],
    ["XX000", "database failure", 500, "skill_save_failed"],
  ])("does not return success when the transaction reports %s", async (code, message, statusCode, expectedCode) => {
    const { rpc, service } = makeService({ code: String(code), message: String(message) });
    await expect(service.create(workspaceId, input)).rejects.toMatchObject({ code: expectedCode, statusCode });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed content and unsafe/duplicate files before any write", async () => {
    const { rpc, service } = makeService();
    await expect(service.create(workspaceId, { ...input, files: [{ filePath: "references/../secret", content: "x" }] })).rejects.toThrow();
    await expect(service.create(workspaceId, { ...input, files: [{ filePath: "references/A.md", content: "x" }, { filePath: "references/a.md", content: "y" }] })).rejects.toThrow();
    await expect(service.create(workspaceId, { ...input, skillContent: "---\nname: missing-description\n---\nbody" })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("import trusts parsed SKILL.md identity, not a supplied stale manifest", async () => {
    const { rpc, service } = makeService();
    const skillContent = "---\nname: actual-skill\ndescription: A precise trigger\n---\nRead the real instructions.";
    await service.import(workspaceId, { manifest: { name: "fake-name", description: "fake-description" }, skillContent,
      files: [], sourceUrl: "https://github.com/example/skill" });
    expect(rpc.mock.calls[0]![1].p_payload).toMatchObject({ name: "actual-skill", description: "A precise trigger" });
  });

  it("installs and toggles with the requested workspace and skill identity", async () => {
    const { rpc, service } = makeService();
    await service.install(workspaceId, skillId, false);
    expect(rpc).toHaveBeenCalledWith("install_skill_package", { p_workspace_id: workspaceId, p_skill_id: skillId, p_enabled: false });
  });
});

describe("skill package contracts", () => {
  it("generates portable stable identifiers even when truncation lands on a separator", () => {
    for (const name of ["中文设计", "a".repeat(59) + " " + "tail", "--- Design ---"]) {
      const slug = stableSkillSlug(name, skillId);
      expect(slug.length).toBeLessThanOrEqual(100);
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slug).toContain(skillId);
    }
  });

  it("permits original plain Markdown without requiring external-package frontmatter", () => {
    expect(() => validateSkillInstructions(input.skillContent)).not.toThrow();
    expect(() => validateSkillInstructions(" \n\t")).toThrow();
  });

  it.each(["../x", "references/../x", "references/./x", "references//x", "references/a\\b", "references/a%2fb", "references/a:b", "references/a?b", "references/NUL.txt", "assets/COM1.png", "scripts/trailing. ", "references/a\0b"])("rejects unsafe portable path %j", path => {
    expect(isSafeSkillFilePath(path)).toBe(false);
  });

  it("preserves Unicode and spaces in valid references", () => {
    expect(isSafeSkillFilePath("references/品牌 字体/中文.md")).toBe(true);
  });

  it("enforces UTF-8 byte and aggregate budgets, not JS character lengths", () => {
    expect(skillCreateRequestSchema.safeParse({ ...input, skillContent: "中".repeat(90000) }).success).toBe(false);
    const content = "a".repeat(2 * 1024 * 1024);
    expect(skillCreateRequestSchema.safeParse({ ...input, files: Array.from({ length: 4 }, (_, i) => ({ filePath: `references/${i}.md`, content })) }).success).toBe(false);
    expect(skillUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(skillUpdateRequestSchema.safeParse({ slug: "changed" }).success).toBe(false);
  });
});
