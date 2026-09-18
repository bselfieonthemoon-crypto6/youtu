import { describe, expect, it, vi } from "vitest";

import { createMastraImageTools } from "./mastra-image-tool.js";
import { createMastraVideoTool } from "./mastra-video-tool.js";
import { createMastraImageStatusTools } from "./mastra-image-status-tools.js";
import { createMastraToolkit } from "./mastra-toolkit.js";
import type { MastraRunInput } from "./mastra-run-types.js";

const synthetic = vi.hoisted(() => ({
  bodies: [] as Array<Record<string, any>>,
  fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string"
      ? init.body
      : input instanceof Request
        ? await input.clone().text()
        : "{}";
    const body = JSON.parse(bodyText) as Record<string, any>;
    synthetic.bodies.push(body);
    const requestNumber = synthetic.bodies.length;
    const batches = [
      ["inspect_canvas", "inspect_design", "manipulate_canvas", "get_design_objects", "manipulate_design", "search_design_resources", "apply_design_template"],
      ["export_design", "list_designs", "get_brand_kit", "screenshot_canvas", "review_image_results", "compose_skills", "read_file"],
      ["get_prompt_library_entry", "cancel_image_job"],
    ];
    const names = batches[requestNumber - 1];
    if (requestNumber === 5) {
      return structuredResponse({
        decision: "no_write_required",
        reasonCode: "discussion",
      });
    }
    return names
      ? streamResponse([
          chunk({ role: "assistant", tool_calls: [{
            index: 0,
            id: `call_discover_${requestNumber}`,
            type: "function",
            function: {
              name: "discover_tools",
              arguments: JSON.stringify({ names }),
            },
          }] }),
          chunk({}, "tool_calls"),
        ])
      : streamResponse([
          chunk({ role: "assistant", content: "工具已就绪。" }),
          chunk({}, "stop"),
        ]);
  }),
}));

vi.mock("../security/safe-provider-fetch.js", () => ({
  createSafeProviderFetch: () => synthetic.fetch,
}));

import { createMastraWorkspaceModel, streamMastraDesignAgent } from "./mastra-agent.js";

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl_synthetic",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-v4-flash-vision-exp",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function streamResponse(chunks: unknown[]) {
  const text = `${chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function structuredResponse(object: unknown) {
  return new Response(JSON.stringify({
    id: "chatcmpl_execution_requirement",
    object: "chat.completion",
    created: 1,
    model: "deepseek-v4-flash-vision-exp",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(object) },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Mastra SDK tool schema compatibility", () => {
  it("prepares the complete real tool inventory for DeepSeek and demand-loads design schemas", async () => {
    synthetic.bodies.length = 0;
    synthetic.fetch.mockClear();
    const createUserClient = vi.fn();
    const designTools = {
      designService: { get: vi.fn(), mutate: vi.fn(), create: vi.fn() },
      designResourceService: { list: vi.fn() },
      designTemplateService: { get: vi.fn() },
    } as never;
    const image = createMastraImageTools({
      createUserClient,
      submitter: { submit: vi.fn() },
      availableImageModels: [{ id: "workspace:image", provider: "synthetic", upstreamModelId: "image-1",
        displayName: "Synthetic image", description: "Synthetic image" }],
    });
    const video = createMastraVideoTool({
      createUserClient,
      submitter: { submit: vi.fn() },
      availableVideoModels: [{ id: "workspace:video", provider: "synthetic", displayName: "Synthetic video", description: "Synthetic video",
        capabilities: { textToVideo: true, imageToVideo: true, videoToVideo: false, audio: true },
        limits: { maxDuration: 10, allowedDurations: [5, 10], maxResolution: "1080p", maxInputImages: 1 } }],
    });
    const status = createMastraImageStatusTools({
      jobService: { getConversationImageJob: vi.fn(), cancelJobAdmin: vi.fn() },
      user: { id: "00000000-0000-4000-8000-000000000001", accessToken: "token", email: "", userMetadata: {} },
      scope: { userId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003",
        canvasId: "00000000-0000-4000-8000-000000000004", liveDesignIds: new Set<string>() },
    });
    const toolkit = createMastraToolkit({
      mainToolDependencies: {
        createUserClient,
        designTools,
        availableVideoModels: [],
        brandKitId: "00000000-0000-4000-8000-000000000010",
        connectionManager: { requestCanvasScreenshot: vi.fn() } as never,
        visionModel: { invoke: vi.fn() } as never,
        currentUserPrompt: "检查并创建画板",
      },
      workspaceSkills: [{
        name: "canvas-design",
        path: "/workspace-skills/canvas-design/SKILL.md",
        description: "Canvas design guide",
        content: "Inspect the design before creating boards.",
        files: [{ path: "references/layout.md", content: "Keep spacing consistent." }],
        metadata: { loomic: { schemaVersion: 1, execution: "native", intents: [], outputKinds: [],
          requiredTools: ["inspect_design"], optionalTools: [], models: [], limitations: [], examples: [], sources: [] } },
      }],
      promptLibraryService: { search: vi.fn(), getById: vi.fn() } as never,
      nativeImageTools: [image.generateImage, image.editImage, video, status.getImageStatus, status.cancelImageJob],
    });
    const names = toolkit.tools.map(item => item.id);
    expect(names).toEqual(expect.arrayContaining([
      "inspect_canvas", "manipulate_canvas",
      "inspect_design", "get_design_objects", "search_design_resources", "list_designs",
      "generate_image", "edit_image", "list_skills", "use_skill", "compose_skills", "read_file",
      "generate_video",
      "get_image_status", "cancel_image_job",
      "search_prompt_library", "get_prompt_library_entry", "get_brand_kit", "screenshot_canvas", "review_image_results",
    ]));
    expect(new Set(names).size).toBe(names.length);
    // This is intentionally a cross-version test: existing shared contracts
    // remain Zod 3 while Mastra-native tools use the server's Zod 4 runtime.
    // Mastra normalizes the schema to a Standard Schema view over the original.
    expect(toolkit.tools.some(item => "_def" in (item.inputSchema as object) && !("_zod" in (item.inputSchema as object)))).toBe(true);
    expect(toolkit.tools.some(item => "_zod" in (item.inputSchema as object))).toBe(true);

    const run: MastraRunInput = {
      runId: "00000000-0000-4000-8000-000000000001",
      conversationId: "00000000-0000-4000-8000-000000000002",
      sessionId: "00000000-0000-4000-8000-000000000003",
      prompt: "检查并创建画板",
      executionMode: "thinking",
      attachments: [],
      mentions: [],
      signal: new AbortController().signal,
    };
    const model = createMastraWorkspaceModel({
      baseUrl: "https://synthetic.invalid/v1",
      apiKey: "synthetic-only",
      upstreamModelId: "deepseek-v4-flash-vision-exp",
    });
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run,
      model,
      messages: [{ role: "user", content: run.prompt }],
      tools: toolkit.tools,
      configurable: {},
      instructions: toolkit.instructions,
      maxOutputTokens: 1_000,
    })) events.push(event);

    expect(synthetic.fetch).toHaveBeenCalledTimes(5);
    expect(synthetic.bodies[0]?.model).toBe("deepseek-v4-flash-vision-exp");
    expect(synthetic.bodies[0]?.thinking).toEqual({ type: "disabled" });
    expect(synthetic.bodies[0]?.response_format).toBeUndefined();
    expect(synthetic.bodies[0]?.messages?.[0]?.content).not.toContain("Return only a valid JSON object");
    const initialNames = toolNames(synthetic.bodies[0]);
    expect(initialNames).toContain("discover_tools");
    expect(initialNames).not.toContain("inspect_design");
    const loadedNames = toolNames(synthetic.bodies[3]);
    for (const name of ["create_design_boards", "manipulate_design", "apply_design_template", "export_design", "arrange_design_boards"])
      expect(loadedNames).not.toContain(name);
    const imageSchema = (synthetic.bodies[0]?.tools ?? []).find((t: any) => t.function?.name === "generate_image")?.function?.parameters;
    // Explicitly forbidden legacy fields remain rejectable, not silently stripped.
    // Zod's optional never is transported as the unsatisfiable `not: {}` schema.
    expect(imageSchema.properties.target).toMatchObject({ not: {} });
    expect(loadedNames).toEqual(expect.arrayContaining(names));
    expect(loadedNames).toContain("discover_tools");
    const requirementCheck = synthetic.bodies[4];
    expect(toolNames(requirementCheck)).toEqual([]);
    expect(requirementCheck?.max_tokens).toBe(300);
    expect(requirementCheck?.response_format).toBeUndefined();
    const requirementMessages = JSON.stringify(requirementCheck?.messages);
    expect(requirementMessages).toMatch(/JSON/i);
    expect(requirementMessages).toContain("writeToolNames");
    expect(requirementMessages).toContain("no_write_required");
    expect(JSON.stringify(requirementCheck)).not.toContain("access_token");
    expect(JSON.stringify(requirementCheck).length).toBeLessThan(40_000);
    expect(events.some(event => event.type === "run.failed")).toBe(false);
  });
});

function toolNames(body: Record<string, any> | undefined): string[] {
  return (body?.tools ?? []).map((item: any) => item?.function?.name ?? item?.name).filter(Boolean);
}
