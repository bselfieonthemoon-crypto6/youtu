import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { createPromptLibraryService } from "../features/prompt-library/prompt-library-service.js";
import { createMastraImageTools } from "./mastra-image-tool.js";
import { createMastraToolkit } from "./mastra-toolkit.js";
import type { WorkspaceSkillEntry } from "./workspace-skills.js";
import { toolExecutionContext } from "./tools/tool-run-context.js";

const skillRoot = new URL("../../../../skills/", import.meta.url);

type ManifestSkill = {
  slug: string;
  description: string;
  version: string;
  metadata: Record<string, unknown>;
  requiredTools: string[];
};

/**
 * The native-board packages that required the retired manipulate_design tool
 * were removed from the catalog, so no installed manifest may depend on it.
 * Mastra filters that tool, so any package still needing it must fail this
 * contract rather than appear executable.
 */
const REMOVED_NATIVE_BOARD_SKILLS = new Set<string>([]);

/**
 * Mastra declares `execute` optional because a tool may be schema-only; the
 * toolkit's tools are all built with a handler, so the direct call goes through
 * this view. `list_skills` takes no arguments.
 */
function directTool(tool: { execute?: unknown }) {
  return tool as unknown as {
    execute: (input: Record<string, never>, context: ReturnType<typeof toolExecutionContext>) => Promise<unknown>;
  };
}

async function installedManifestSkills(): Promise<ManifestSkill[]> {
  const entries = await readdir(skillRoot, { withFileTypes: true });
  const skills = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const root = new URL(`${entry.name}/`, skillRoot);
    try {
      const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8")) as {
        slug?: unknown;
        description?: unknown;
        version?: unknown;
        metadata?: Record<string, unknown>;
      };
      const runtime = manifest.metadata?.loomic as { requiredTools?: unknown } | undefined;
      if (typeof manifest.slug !== "string" || manifest.slug !== entry.name || typeof manifest.description !== "string"
        || typeof manifest.version !== "string" || !manifest.metadata
        || !Array.isArray(runtime?.requiredTools) || !runtime.requiredTools.every(name => typeof name === "string"))
        throw new Error(`Invalid Skill manifest: ${entry.name}`);
      return { slug: manifest.slug, description: manifest.description, version: manifest.version,
        metadata: manifest.metadata, requiredTools: runtime.requiredTools };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }));
  return skills.filter((skill): skill is ManifestSkill => skill !== undefined)
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

function workspaceEntries(skills: readonly ManifestSkill[]): WorkspaceSkillEntry[] {
  return skills.map(skill => ({
    name: skill.slug, description: skill.description, version: skill.version,
    metadata: skill.metadata, content: "Catalog contract fixture.",
    path: `/workspace-skills/${skill.slug}/SKILL.md`, files: [],
    readiness: { status: "ready", reasons: [], models: [] },
  }));
}

function realMastraToolkit(skills: readonly ManifestSkill[]) {
  // Factories are production factories. Dependencies are inert because this
  // catalog test never invokes a side-effecting tool.
  const nativeImages = createMastraImageTools({
    createUserClient: vi.fn(() => ({})),
    submitter: { submit: vi.fn() } as never,
    availableImageModels: [],
  });
  return createMastraToolkit({
    mainToolDependencies: {
      createUserClient: vi.fn(() => ({})), availableImageModels: [], availableVideoModels: [],
      designTools: {} as never,
    },
    workspaceSkills: workspaceEntries(skills),
    promptLibraryService: createPromptLibraryService(),
    nativeImageTools: [nativeImages.generateImage, nativeImages.editImage],
  });
}

describe("installed Skill manifests against the real Mastra tool surface", () => {
  it("keeps every installed manifest dependency registered or explicitly unavailable", async () => {
    const skills = await installedManifestSkills();
    expect(skills).not.toHaveLength(0);

    const toolkit = realMastraToolkit(skills);
    const registered = new Set(toolkit.tools.map(tool => tool.id));
    const listed = await directTool(toolkit.tools.find(tool => tool.id === "list_skills")!).execute({}, toolExecutionContext({})) as {
      skills: Array<{ name: string; readiness?: { status: string; reasons: string[] } }>;
    };
    const readiness = new Map(listed.skills.map(skill => [skill.name, skill.readiness]));

    // These are registered by streamMastraDesignAgent rather than the toolkit:
    // discover_tools controls deferred schema loading and is never a Skill dependency.
    expect(registered).not.toContain("discover_tools");
    expect([...registered]).toEqual(expect.arrayContaining([
      "generate_image", "edit_image", "inspect_design", "get_design_objects",
      "search_prompt_library", "get_prompt_library_entry", "list_skills", "use_skill",
    ]));

    for (const skill of skills) {
      expect(readiness.has(skill.slug), `${skill.slug} must appear in list_skills`).toBe(true);
      const missing = skill.requiredTools.filter(tool => !registered.has(tool));
      if (!missing.length) {
        expect(readiness.get(skill.slug)?.status, skill.slug).not.toBe("unavailable");
        continue;
      }
      expect(REMOVED_NATIVE_BOARD_SKILLS, `${skill.slug} has an unregistered required tool: ${missing.join(", ")}`)
        .toContain(skill.slug);
      expect(readiness.get(skill.slug), skill.slug).toMatchObject({ status: "unavailable" });
    }

    const unavailable = [...readiness.entries()]
      .filter(([, value]) => value?.status === "unavailable")
      .map(([name]) => name)
      .sort();
    expect(unavailable).toEqual([...REMOVED_NATIVE_BOARD_SKILLS].sort());
  });
});
