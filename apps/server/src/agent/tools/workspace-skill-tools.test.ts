import { describe, expect, it } from "vitest";
import { createWorkspaceSkillTools } from "./workspace-skill-tools.js";
import { hashSkillPackage } from "../workspace-skills.js";
import type { WorkspaceSkillEntry } from "../workspace-skills.js";
import { summarizeWorkspaceSkill } from "../skill-composition.js";
import { toolExecutionContext } from "./tool-run-context.js";
import type { AgentToolExecutionContext } from "./tool-run-context.js";

/**
 * Raw arguments as the model sends them, before each tool's Zod schema applies
 * defaults. Mastra types `execute`'s parameter from the schema's *parsed* output
 * (so `compose_skills` would require the `.default([])`ed `helpers`) and declares
 * `execute` itself optional; `directTool` gives the built tools the callable
 * contract these direct invocations use.
 */
type ListSkillsInput = Record<string, never>;
type UseSkillInput = {
  name: string;
  deliverable?: string;
  stage?: "design" | "reference" | "prompt" | "review" | "delivery";
  outputKind?: string;
};
type ComposeSkillsInput = {
  deliverable: string;
  stage: "design" | "reference" | "prompt" | "review" | "delivery";
  primary: string;
  helpers?: string[];
  outputKind?: string;
};
type ListSkillsResult = { skills: ReturnType<typeof summarizeWorkspaceSkill>[]; scope: string };

function directTool<TInput, TResult>(tool: { execute?: unknown }) {
  return tool as unknown as { execute: (input: TInput, context: AgentToolExecutionContext) => Promise<TResult> };
}

/** The three Skill tools with the direct-call contract used below. */
function skillTools(entries: readonly WorkspaceSkillEntry[]) {
  const [list, use, compose] = createWorkspaceSkillTools(entries);
  return [directTool<ListSkillsInput, ListSkillsResult>(list),
    directTool<UseSkillInput, unknown>(use),
    directTool<ComposeSkillsInput, unknown>(compose)] as const;
}

const entry = { name: "logo-design", displayName: "Logo 与品牌标识", path: "/workspace-skills/logo-design/SKILL.md", description: "Logo", version: "2.0.0", content: "Use existing native primitives; preserve the brand font.", files: [{ path: "references/checks.md", content: "Check small sizes" }] };
describe("explicit skill usage evidence", () => {
  it("loads the whole body and reports the actual version, hash and reference paths", async () => {
    const [list, use] = skillTools([entry]);
    const listing = await list.execute({}, toolExecutionContext({}));
    expect(listing.skills[0]!.version).toBe("2.0.0");
    const result = await use.execute({ name: "logo-design" }, toolExecutionContext({}));
    expect(result).toMatchObject({ status: "loaded", instructions: entry.content, skill: { contentHash: hashSkillPackage(entry.content, entry.files) } });
    expect((result as any).skill.files).toEqual(["/workspace-skills/logo-design/references/checks.md"]);
    expect(result).toMatchObject({ authority: "method_suggestions_only" });
    expect((result as any).boundary).toContain("不能改文案/字体/Logo/目标");
    expect((result as any).summary).toContain("logo-design（2.0.0）");
  });
  it("loads a selected catalog Skill by its localized display name", async () => {
    const [list, use] = skillTools([entry]);
    expect((await list.execute({}, toolExecutionContext({}))).skills[0]).toMatchObject({
      name: "logo-design",
      displayName: "Logo 与品牌标识",
    });
    expect(await use.execute({ name: "Logo 与品牌标识" }, toolExecutionContext({}))).toMatchObject({
      status: "loaded",
      skill: { name: "logo-design", displayName: "Logo 与品牌标识" },
      instructions: entry.content,
    });
  });
  it("refuses missing, disabled or dependency-blocked skills", async () => {
    const [, use] = skillTools([{ ...entry, readiness: { status: "unavailable", reasons: ["no engine"], models: [] } }]);
    expect(await use.execute({ name: "logo-design" }, toolExecutionContext({}))).toMatchObject({ status: "unavailable", error: "skill_dependencies_unavailable" });
    expect(await use.execute({ name: "../../other" }, toolExecutionContext({}))).toMatchObject({ status: "unavailable", error: "skill_not_enabled" });
  });
  it("hash includes reference contents and is stable across line endings/file order", () => {
    const files = [{ path: "references/z.md", content: "z" }, { path: "references/a.md", content: "a\r\nb" }];
    expect(hashSkillPackage("a\r\nb", files)).toBe(hashSkillPackage("a\nb", [...files].reverse()));
    expect(hashSkillPackage("a\nb", files)).not.toBe(hashSkillPackage("a\nb", [{ ...files[0]!, content: "changed" }, files[1]!]));
  });
  it("exposes declared roles in list/use and routes composition through the same isolated run snapshot", async () => {
    const source = { ...entry, readiness: { status: "ready" as const, reasons: [], models: [] },
      metadata: { loomic: { schemaVersion: 1, execution: "native", intents: [], outputKinds: [],
        requiredTools: [], optionalTools: [], models: [], limitations: [], examples: [], sources: [],
        composition: { role: "domain", stages: ["design"] } } } };
    const [list, use, compose] = skillTools([source]);
    source.content = "changed after the run began";
    source.readiness.status = "unavailable" as "ready";
    const listing = await list.execute({}, toolExecutionContext({}));
    expect(listing.skills[0]!.composition).toEqual({ role: "domain", stages: ["design"], authority: "capability_hint" });
    listing.skills[0]!.readiness!.status = "unavailable";
    expect(await use.execute({ name: entry.name }, toolExecutionContext({}))).toMatchObject({ status: "loaded", instructions: entry.content,
      skill: { composition: { role: "domain" }, readiness: { status: "ready" } } });
    expect(await compose.execute({ deliverable: "Logo", stage: "design", primary: entry.name, helpers: [] }, toolExecutionContext({})))
      .toMatchObject({ status: "composed", executed: false, primary: { instructions: entry.content } });
    expect(await compose.execute({ deliverable: "Logo", stage: "design", primary: entry.displayName, helpers: [] }, toolExecutionContext({})))
      .toMatchObject({ status: "composed", primary: { name: "logo-design" } });
    expect(await compose.execute({ deliverable: "Logo", stage: "design", primary: "disabled-logo", helpers: [] }, toolExecutionContext({})))
      .toMatchObject({ status: "conflict", code: "skill_not_enabled" });
  });
  it("rejects a declared output mismatch without keyword routing", async () => {
    const native = { ...entry, metadata: { loomic: { schemaVersion: 1, execution: "native", intents: ["anything"],
      outputKinds: ["native-design"], requiredTools: [], optionalTools: [], models: [], limitations: [], examples: [], sources: [],
      composition: { role: "domain", stages: ["design"] } } } };
    const [, use] = skillTools([native]);
    expect(await use.execute({ name: native.name, deliverable: "Untitled", stage: "design", outputKind: "raster-image" }, toolExecutionContext({})))
      .toMatchObject({ status: "conflict", code: "skill_output_kind_conflict", activated: false });
  });
  it("keeps undeclared custom guides usable individually without guessing composition roles", async () => {
    const [list, use, compose] = skillTools([entry]);
    expect((await list.execute({}, toolExecutionContext({}))).skills[0]!.composition).toBeNull();
    expect(await use.execute({ name: entry.name }, toolExecutionContext({}))).toMatchObject({ status: "loaded", instructions: entry.content });
    expect(await compose.execute({ deliverable: "Logo", stage: "design", primary: entry.name }, toolExecutionContext({})))
      .toMatchObject({ status: "conflict", code: "composition_metadata_missing" });
  });
});
