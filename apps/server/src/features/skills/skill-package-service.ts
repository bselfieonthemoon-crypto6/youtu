import { randomUUID } from "node:crypto";
import {
  skillCreateRequestSchema, skillUpdateRequestSchema, skillDetailSchema,
  type SkillCreateRequest, type SkillUpdateRequest, type SkillDetail,
} from "@loomic/shared";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { parseSkillManifest, type ImportedSkill } from "./skill-import-service.js";

export class SkillPackageError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 500, public readonly databaseCode?: string) {
    super(message); this.name = "SkillPackageError";
  }
}

export function stableSkillSlug(name: string, id = randomUUID()): string {
  const prefix = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "") || "skill";
  return `${prefix}-${id}`;
}

/** Plain Markdown is supported for self-authored skills. Frontmatter, when supplied, must be real. */
export function validateSkillInstructions(content: string): void {
  if (!content.trim()) throw new SkillPackageError("skill_invalid_package", "Skill instructions must not be empty.", 400);
  if (content.trimStart().startsWith("---")) parseSkillManifest(content);
}

function databaseFailure(error: { code?: string; message?: string }): never {
  const message = error.message ?? "";
  // Keep only the machine code for server diagnostics; database messages may
  // include submitted instruction text and must not be copied into responses.
  if (error.code === "42501") throw new SkillPackageError("skill_forbidden", "Only a workspace owner or admin can manage installations; private packages require access.", 403, error.code);
  if (message.includes("skill_not_found")) throw new SkillPackageError("skill_not_found", "Skill not found or not editable by this user.", 404, error.code);
  if (error.code === "23505") throw new SkillPackageError("skill_conflict", "This package conflicts with an existing skill or file path.", 409, error.code);
  if (error.code === "22023" || error.code === "23514") throw new SkillPackageError("skill_invalid_package", "Invalid skill package: check non-empty instructions, safe unique file paths and package size limits.", 400, error.code);
  throw new SkillPackageError("skill_save_failed", "Unable to confirm that the complete skill package was saved. Refresh the skill list before retrying.", 500, error.code);
}

export function mapSkillRow(row: Record<string, any>) {
  return {
    id: row.id, name: row.name, slug: row.slug, description: row.description,
    author: row.author, version: row.version, category: row.category, iconName: row.icon_name,
    source: row.source, isFeatured: row.is_featured, metadata: row.metadata ?? {},
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
export function mapSkillFileRow(row: Record<string, any>) {
  return { id: row.id, filePath: row.file_path, content: row.content, mimeType: row.mime_type, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function mapSkillDetailRow(row: Record<string, any>, files: Array<Record<string, any>>): SkillDetail {
  return skillDetailSchema.parse({ ...mapSkillRow(row), license: row.license, skillContent: row.skill_content,
    createdBy: row.created_by, sourceUrl: row.source_url ?? null, packageName: row.package_name ?? null,
    files: files.map(mapSkillFileRow) });
}

export function createSkillPackageService(client: UserSupabaseClient) {
  async function save(skillId: string | null, workspaceId: string | null, payload: Record<string, unknown>): Promise<SkillDetail> {
    const { data, error } = await (client as any).rpc("save_skill_package", {
      p_skill_id: skillId, p_workspace_id: workspaceId, p_payload: payload,
    });
    if (error) databaseFailure(error);
    if (!data?.skill || !Array.isArray(data.files)) throw new SkillPackageError("skill_save_failed", "The server did not return the saved package.");
    return mapSkillDetailRow(data.skill, data.files);
  }
  return {
    async create(workspaceId: string, input: SkillCreateRequest) {
      const payload = skillCreateRequestSchema.parse(input);
      validateSkillInstructions(payload.skillContent);
      return save(null, workspaceId, { ...payload, slug: stableSkillSlug(payload.name) });
    },
    async import(workspaceId: string, imported: ImportedSkill, packageName?: string) {
      const manifest = parseSkillManifest(imported.skillContent);
      const payload = skillCreateRequestSchema.parse({ name: manifest.name, description: manifest.description,
        category: "custom", skillContent: imported.skillContent, files: imported.files });
      return save(null, workspaceId, { ...payload, slug: stableSkillSlug(payload.name),
        author: manifest.author ?? "unknown", version: manifest.version ?? "1.0", license: manifest.license ?? null,
        // Provenance is informational, never executable permissions or a trust assertion.
        metadata: { ...manifest.metadata, source_url: imported.sourceUrl, ...(packageName ? { package_name: packageName } : {}) },
        sourceUrl: imported.sourceUrl, packageName: packageName ?? null });
    },
    async update(skillId: string, input: SkillUpdateRequest) {
      const payload = skillUpdateRequestSchema.parse(input);
      if (payload.skillContent !== undefined) validateSkillInstructions(payload.skillContent);
      return save(skillId, null, payload);
    },
    async install(workspaceId: string, skillId: string, enabled = true) {
      const { error } = await (client as any).rpc("install_skill_package", { p_workspace_id: workspaceId, p_skill_id: skillId, p_enabled: enabled });
      if (error) databaseFailure(error);
    },
  };
}
