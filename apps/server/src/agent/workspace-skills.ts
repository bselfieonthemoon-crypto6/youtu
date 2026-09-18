import type { UserSupabaseClient } from "../supabase/user.js";
import { createHash } from "node:crypto";
import { isImageSkillMimeType, isSafeSkillFilePath, type SkillReadiness } from "@loomic/shared";

/**
 * A file bundled with a skill (scripts/, references/, assets/).
 */
export interface SkillFileEntry {
  /** Relative path, e.g. "scripts/analyze.py" */
  path: string;
  /** Raw file content */
  content: string;
}

/**
 * Metadata for a workspace skill loaded from the database. File paths are
 * validated with the same canonical rule the import/package services enforce,
 * so anything that reaches this loader is already known to be a safe relative
 * path under scripts/, references/ or assets/.
 */
export interface WorkspaceSkillEntry {
  id?: string;
  version?: string;
  metadata?: Record<string, unknown>;
  contentHash?: string;
  readiness?: SkillReadiness;
  /** Skill slug (used as directory name in virtual path) */
  name: string;
  /** Human-readable catalog name accepted as a selection alias. */
  displayName?: string;
  /** Human-readable description for the system prompt */
  description: string;
  /** Virtual path where the agent can read_file the full SKILL.md content */
  path: string;
  /** Raw SKILL.md content stored in the database */
  content: string;
  /** Associated files (scripts, references, assets) */
  files: SkillFileEntry[];
}

/**
 * Load enabled skills (both system and user-created) for a given canvas.
 *
 * Resolves the canvas → project → workspace chain, then fetches all
 * skills installed and enabled in that workspace. Only skills with
 * non-empty `skill_content` are returned.
 */
export async function loadWorkspaceSkills(
  userClient: UserSupabaseClient,
  canvasId: string,
): Promise<WorkspaceSkillEntry[]> {
  // Step 1: Resolve canvas → project → workspace
  const workspaceId = await resolveWorkspaceId(userClient, canvasId);
  if (!workspaceId) return [];

  // Step 2: Query enabled workspace skills with full skill data
  // NOTE: workspace_skills / skills tables may not yet be in the generated
  // Supabase types — use `as any` to bypass PostgREST type checking.
  const { data: rows, error } = await (userClient as any)
    .from("workspace_skills")
    .select(
      "skill:skills(id, slug, name, description, version, skill_content, metadata)",
    )
    .eq("workspace_id", workspaceId)
    .eq("enabled", true);

  if (error) throw new Error("Workspace skills could not be loaded.");
  if (!rows?.length) return [];

  // Step 3: Batch-load associated files for all enabled skills
  const skillIds = (rows as any[])
    .map((r: any) => r.skill?.id)
    .filter((id: unknown): id is string => typeof id === "string");

  const filesBySkillId = new Map<string, SkillFileEntry[]>();
  if (skillIds.length > 0) {
    const { data: fileRows, error: fileError } = await (userClient as any)
      .from("skill_files")
      .select("skill_id, file_path, content, mime_type")
      .in("skill_id", skillIds);
    if (fileError) throw new Error("Workspace skill references could not be loaded.");

    if (fileRows?.length) {
      for (const fr of fileRows as Array<{ skill_id: string; file_path: string; content: string; mime_type: string | null }>) {
        // Image references are base64 previews for the library UI; the agent
        // skill snapshot is text-only, so they are intentionally excluded.
        if (fr.mime_type && isImageSkillMimeType(fr.mime_type)) continue;
        const existing = filesBySkillId.get(fr.skill_id) ?? [];
        existing.push({ path: fr.file_path, content: fr.content });
        filesBySkillId.set(fr.skill_id, existing);
      }
    }
  }

  // Step 4: Map to WorkspaceSkillEntry, filtering out skills without DB content
  return (rows as Array<{ skill: Record<string, unknown> | null }>)
    .map((row: { skill: Record<string, unknown> | null }): WorkspaceSkillEntry | null => {
      const skill = row.skill;
      if (!skill?.skill_content) {
        if (skill?.slug) {
          console.warn(
            `[workspace-skills] Skill "${skill.slug}" is enabled but has empty content — skipping`,
          );
        }
        return null;
      }
      const slug = skill.slug as string;
      const files = filesBySkillId.get(skill.id as string) ?? [];
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || typeof skill.skill_content !== "string" ||
        !skill.skill_content.trim() || files.some(file => !isSafeSkillFilePath(file.path))) return null;
      return {
        id: skill.id as string,
        version: String(skill.version ?? "1.0"),
        metadata: (skill.metadata ?? {}) as Record<string, unknown>,
        contentHash: hashSkillPackage(skill.skill_content, files),
        name: slug,
        displayName: typeof skill.name === "string" && skill.name.trim()
          ? skill.name.trim()
          : slug,
        description: skill.description as string,
        path: `/workspace-skills/${slug}/SKILL.md`,
        content: skill.skill_content as string,
        files,
      };
    })
    .filter((entry): entry is WorkspaceSkillEntry => entry !== null);
}

export function hashSkillPackage(content: string, files: readonly SkillFileEntry[]): string {
  return createHash("sha256").update(JSON.stringify({
    content: content.replace(/\r\n/g, "\n"),
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => ({
      path: file.path, content: file.content.replace(/\r\n/g, "\n"),
    })),
  })).digest("hex");
}

/**
 * Resolve canvas ID → workspace ID via the canvas → project join.
 */
async function resolveWorkspaceId(
  client: UserSupabaseClient,
  canvasId: string,
): Promise<string | null> {
  // Try joined query first (single round-trip)
  try {
    const { data } = await client
      .from("canvases")
      .select("project:projects(workspace_id)")
      .eq("id", canvasId)
      .maybeSingle();

    const project = data?.project as { workspace_id?: string } | null;
    if (project?.workspace_id) return project.workspace_id;
  } catch {
    // FK may not be exposed via PostgREST — fall back to two-step
  }

  // Two-step fallback
  try {
    const { data: canvas } = await client
      .from("canvases")
      .select("project_id")
      .eq("id", canvasId)
      .maybeSingle();

    if (!canvas?.project_id) return null;

    const { data: project } = await client
      .from("projects")
      .select("workspace_id")
      .eq("id", canvas.project_id)
      .maybeSingle();

    return (project?.workspace_id as string) ?? null;
  } catch {
    return null;
  }
}
