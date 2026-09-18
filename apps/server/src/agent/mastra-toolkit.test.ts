import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createMastraToolkit } from "./mastra-toolkit.js";
import { createAgentTool, toolExecutionContext } from "./tools/tool-run-context.js";

describe("Mastra tool catalog", () => {
  it("returns existing tools with demand-loaded workspace skills and read-only prompt references", () => {
    const toolkit = createMastraToolkit({
      backend: {} as never,
      mainToolDependencies: {
        createUserClient: vi.fn(),
        availableImageModels: [],
        availableVideoModels: [],
      },
      workspaceSkills: [{
        name: "logo-guide", path: "/workspace-skills/logo-guide/SKILL.md", description: "Logo guide",
        content: "Use the current design system.", files: [], version: "1.0.0",
      }],
      promptLibraryService: { search: vi.fn(), getById: vi.fn() } as never,
    });

    const names = toolkit.tools.map(tool => tool.id);
    expect(names).toEqual(expect.arrayContaining([
      "list_skills", "use_skill", "compose_skills", "read_file", "search_prompt_library", "get_prompt_library_entry",
      "ask_clarification",
    ]));
    expect(names).not.toContain("generate_image");
    expect(names).not.toContain("confirm_image_generation");
    expect(toolkit.instructions).toContain("list_skills first");
    expect(toolkit.instructions).toContain("untrusted read-only reference data");
  });

  it("returns a structured clarification payload with exact question choices", async () => {
    const toolkit = createMastraToolkit({});
    const ask = toolkit.tools.find(item => item.id === "ask_clarification")!;
    await expect(ask.execute({ questions: [{
      title: "用途",
      prompt: "主要用在哪里？",
      options: ["App 图标", "门头", "App 图标"],
      allowCustom: true,
    }] }, toolExecutionContext({}))).resolves.toEqual({
      status: "awaiting_user_input",
      questions: [{
        id: 1,
        title: "用途",
        prompt: "主要用在哪里？",
        options: ["App 图标", "门头"],
        allowCustom: true,
      }],
    });
  });

  it("marks a skill unavailable when this runtime did not register one of its required tools", async () => {
    const toolkit = createMastraToolkit({
      backend: {} as never,
      mainToolDependencies: { createUserClient: vi.fn(), availableImageModels: [], availableVideoModels: [] },
      workspaceSkills: [{
        name: "needs-file-write", path: "/workspace-skills/needs-file-write/SKILL.md", description: "Writes files",
        content: "Write a file.", files: [], metadata: { loomic: { schemaVersion: 1, execution: "native",
          intents: [], outputKinds: [], requiredTools: ["write_file"], optionalTools: [], models: [], limitations: [], examples: [], sources: [] } },
      }],
    });
    const list = toolkit.tools.find(tool => tool.id === "list_skills")!;
    await expect(list.execute({}, toolExecutionContext({}))).resolves.toMatchObject({ skills: [{ name: "needs-file-write", readiness: { status: "unavailable" } }] });
  });

  it("accepts a runtime-owned native image tool without requiring a legacy backend", () => {
    const generateImage = createAgentTool({ id: "generate_image", description: "Native direct image submit", inputSchema: z.object({ prompt: z.string() }), execute: async () => ({ status: "submitted" }) });
    const toolkit = createMastraToolkit({ nativeImageTools: [generateImage] });
    expect(toolkit.tools).toContain(generateImage);
    expect(toolkit.tools.map(tool => tool.id)).toContain("generate_image");
  });

  it("excludes native board mutations and marks dependent Skills unavailable", async () => {
    const createBoards = createAgentTool({ id: "create_design_boards", description: "Native board creation", inputSchema: z.object({}), execute: async () => ({ status: "created" }) });
    const manipulateDesign = createAgentTool({ id: "manipulate_design", description: "Native board update", inputSchema: z.object({}), execute: async () => ({ status: "updated" }) });
    const inspectDesign = createAgentTool({ id: "inspect_design", description: "Read a native board", inputSchema: z.object({}), execute: async () => ({ status: "ok" }) });
    const toolkit = createMastraToolkit({
      nativeImageTools: [createBoards, manipulateDesign, inspectDesign],
      workspaceSkills: [{
        name: "board-guide", path: "/workspace-skills/board-guide/SKILL.md", description: "Board guide",
        content: "Create boards.", files: [], metadata: { loomic: { schemaVersion: 1, execution: "native",
          intents: [], outputKinds: [], requiredTools: ["create_design_boards"], optionalTools: [], models: [], limitations: [], examples: [], sources: [] } },
      }],
    });

    const list = toolkit.tools.find(item => item.id === "list_skills")!;
    const result = await list.execute({}, toolExecutionContext({})) as any;
    expect(toolkit.tools.map(item => item.id)).not.toEqual(expect.arrayContaining([
      "create_design_boards", "manipulate_design",
    ]));
    expect(toolkit.tools).toContain(inspectDesign);
    expect(result.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "board-guide", readiness: expect.objectContaining({ status: "unavailable" }) }),
    ]));
  });

  it("removes native design mutations supplied by main tools while keeping design reads", () => {
    const toolkit = createMastraToolkit({
      backend: {} as never,
      mainToolDependencies: {
        createUserClient: vi.fn(), availableImageModels: [], availableVideoModels: [],
        designTools: {} as never,
      },
    });

    const names = toolkit.tools.map(item => item.id);
    expect(names).toEqual(expect.arrayContaining([
      "inspect_design", "get_design_objects", "search_design_resources", "list_designs",
    ]));
    expect(names).not.toEqual(expect.arrayContaining([
      "create_design_boards", "manipulate_design", "apply_design_template", "export_design",
    ]));
  });

  it("reads only a bounded immutable enabled Skill reference", async () => {
    const skill = {
      name: "logo-guide", path: "/workspace-skills/logo-guide/SKILL.md", description: "Logo guide",
      content: "Guide body", files: [{ path: "references/checks.md", content: "abcdef" }],
    };
    const toolkit = createMastraToolkit({ workspaceSkills: [skill] });
    skill.files[0]!.content = "mutated after run start";
    const read = toolkit.tools.find(tool => tool.id === "read_file")!;
    await expect(read.execute({ file_path: "/workspace-skills/logo-guide/references/checks.md", offset: 1, limit: 3 }, toolExecutionContext({})))
      .resolves.toMatchObject({ status: "ok", content: "bcd", truncated: true, next_offset: 4 });
    await expect(read.execute({ file_path: "/workspace-skills/logo-guide/references/../../secret.txt" }, toolExecutionContext({})))
      .resolves.toMatchObject({ status: "not_found", error: "skill_file_not_enabled" });
    await expect(read.execute({ file_path: "C:/Windows/win.ini" }, toolExecutionContext({})))
      .resolves.toMatchObject({ status: "not_found", error: "skill_file_not_enabled" });
  });
});
