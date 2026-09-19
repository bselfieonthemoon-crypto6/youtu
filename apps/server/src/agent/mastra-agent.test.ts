import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { compactMastraStepToolContext, compactMastraToolResult, mergeReadSkillSlugs, streamMastraDesignAgent } from "./mastra-agent.js";
import { createContextBudget } from "./context-budget.js";
import { createMastraImageTools, type MastraImageSubmitContext } from "./mastra-image-tool.js";
import { createMastraToolkit } from "./mastra-toolkit.js";
import { createAgentTool } from "./tools/tool-run-context.js";

function textStream(text: string) {
  return new Response(
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function structuredResponse(object: unknown) {
  return new Response(JSON.stringify({
    id: "classification", object: "chat.completion", created: 1, model: "test",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(object) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { headers: { "content-type": "application/json" } });
}

describe("dispatch closure: which guides the run actually read", () => {
  it("accumulates reads in order, deduplicated and bounded", () => {
    expect(mergeReadSkillSlugs(undefined, ["logo-design"])).toEqual(["logo-design"]);
    // A guide read again, or named twice in one composition, is one entry.
    expect(mergeReadSkillSlugs(["logo-design"], ["logo-design", "design-review"]))
      .toEqual(["logo-design", "design-review"]);
    // Earliest first, so the primary a turn settled on stays at the front.
    expect(mergeReadSkillSlugs(["a", "b"], ["c"])).toEqual(["a", "b", "c"]);
    // Bounded: a run cannot build an unbounded diagnostic record.
    expect(mergeReadSkillSlugs(Array.from({ length: 8 }, (_, i) => `s${i}`), ["extra"]))
      .toHaveLength(8);
    expect(mergeReadSkillSlugs(Array.from({ length: 8 }, (_, i) => `s${i}`), ["extra"])![0]).toBe("s0");
  });

  it("ignores an empty or malformed read list rather than clearing what was recorded", () => {
    // Nothing new read must leave the caller's state untouched, which is what lets
    // the runtime treat a missing record as "nothing was read".
    expect(mergeReadSkillSlugs(["a"], [])).toBeUndefined();
    expect(mergeReadSkillSlugs(["a"], [undefined, "", null as never, 42 as never])).toBeUndefined();
    // A malformed earlier value is ignored, not thrown on.
    expect(mergeReadSkillSlugs("not-an-array", ["a"])).toEqual(["a"]);
    expect(mergeReadSkillSlugs([1, null, "ok"], ["a"])).toEqual(["ok", "a"]);
  });
});

describe("Mastra real SDK stream bridge (synthetic transport, not provider E2E)", () => {
  it("rejects an oversized final wire packet before calling the provider", async () => {
    const providerFetch = vi.fn(async () => textStream("不应调用"));
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: providerFetch }).chatModel("test");
    const budget = createContextBudget({ contextWindowTokens: 8_192, maxInputTokens: 1_024,
      maxOutputTokens: 256, profileSource: "test", verifiedAt: "2026-09-16T00:00:00Z" });
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run: { runId: "wire-overflow", sessionId: "session", conversationId: "conversation",
        prompt: "生成", executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "超".repeat(2_000) }], configurable: {},
      maxOutputTokens: 256, tools: [], contextBudget: budget,
    })) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({
      type: "run.failed",
      error: expect.objectContaining({
        code: "run_failed",
        details: expect.objectContaining({ reasonCode: "agent_context_budget_exceeded" }),
      }),
    }));
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("allows a short packet when the provider can accommodate the fixed agent instructions", async () => {
    const providerFetch = vi.fn(async () => textStream("可以继续。"));
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: providerFetch }).chatModel("test");
    const budget = createContextBudget({ contextWindowTokens: 32_000, maxInputTokens: 16_000,
      maxOutputTokens: 1_000, profileSource: "test", verifiedAt: "2026-09-16T00:00:00Z" });

    for await (const _event of streamMastraDesignAgent({
      run: { runId: "wire-short", sessionId: "session", conversationId: "conversation",
        prompt: "继续", executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "继续" }], configurable: {},
      maxOutputTokens: 1_000, tools: [], contextBudget: budget, writeRepairEnabled: false,
    })) { /* exhaust the stream */ }

    expect(providerFetch).toHaveBeenCalledOnce();
  });
  it("marks a current approximate-size run only after the actual enabled Skill returns loaded", async () => {
    // The package declares a composition role/stage so the compose variant can lead
    // the design stage, exactly as a real package does.
    const toolkit = createMastraToolkit({ workspaceSkills: [{
      name: "nonstandard-image-size", path: "/workspace-skills/nonstandard-image-size/SKILL.md",
      description: "Approximate native size", content: "FULL CURRENT GUIDE", files: [], version: "1.1.0",
      metadata: { loomic: { schemaVersion: 1, execution: "image", intents: ["sizing"], outputKinds: ["raster-image"],
        requiredTools: [], optionalTools: [], models: [], limitations: [], examples: [], sources: [],
        composition: { role: "workflow", stages: ["design"] } } },
    }] });
    const toolStream = (name: string, args: string, id: string) => new Response(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test",
        choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
    // `read` is how the model loads one guide; `compose` is the path the agent
    // instructions encourage and the only one that can load a primary with helpers.
    // Both must enable the same capability, or a model that followed the documented
    // flow had its paid submission refused as if it had read nothing.
    for (const load of ["none", "read", "compose"] as const) {
      // `compose_skills` is not resident, so the model has to activate it first.
      const plan = load === "none" ? ["list_skills"]
        : load === "read" ? ["list_skills", "use_skill"]
        : ["list_skills", "discover_tools", "compose_skills"];
      let calls = 0;
      const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
        fetch: async () => {
          calls += 1;
          if (calls <= plan.length) {
            const step = plan[calls - 1];
            if (step === "list_skills") return toolStream("list_skills", "{}", "call_list");
            if (step === "use_skill") return toolStream("use_skill", '{"name":"nonstandard-image-size"}', "call_guide");
            if (step === "discover_tools")
              return toolStream("discover_tools", '{"names":["compose_skills"]}', "call_discover");
            return toolStream("compose_skills",
              '{"deliverable":"尺寸图","stage":"design","primary":"nonstandard-image-size"}', "call_compose");
          }
          if (calls === plan.length + 1) return textStream("已读取目录。");
          return structuredResponse({ decision: "no_write_required", reasonCode: "clarification" });
        },
      }).chatModel("test");
      const configurable: Record<string, unknown> = { run_id: "size-run" };
      const completed = [];
      for await (const event of streamMastraDesignAgent({
        run: { runId: "size-run", sessionId: "session", conversationId: "conversation",
          prompt: "做一张 656:176 的图，尺寸差不多就好", executionMode: "fast",
          attachments: [], mentions: [], signal: new AbortController().signal },
        model, messages: [{ role: "user", content: "做一张 656:176 的图，尺寸差不多就好" }],
        configurable, maxOutputTokens: 1_000, tools: toolkit.tools as any, instructions: toolkit.instructions,
        skillMetadata: { "nonstandard-image-size": { capabilities: ["nonstandard-ratio"], attachWorkspaceLibrary: false } },
      })) if (event.type === "tool.completed") completed.push(event.toolName);
      expect(completed, load).toEqual(plan);
      expect(configurable.nonstandard_size_skill_loaded_run_id, load).toBe(load === "none" ? undefined : "size-run");
      // A composition adopts its PRIMARY for session stickiness; a bare listing must
      // not, and neither may a helper overwrite it.
      expect(configurable.session_loaded_skill_slug, load)
        .toBe(load === "none" ? undefined : "nonstandard-image-size");
      expect(configurable.session_read_skill_slugs, load)
        .toEqual(load === "none" ? undefined : ["nonstandard-image-size"]);
    }
  });
  it("loads the complete background-removal Skill for an existing-image cutout before any paid image call", async () => {
    const guide = "FULL BACKGROUND REMOVAL GUIDE: keep original asset and verify transparent PNG alpha";
    const toolkit = createMastraToolkit({ workspaceSkills: [{
      name: "background-removal", path: "/workspace-skills/background-removal/SKILL.md",
      description: "Existing-image background removal", content: guide, files: [], version: "2.1.0",
    }] });
    const calls: any[] = [];
    const toolStream = (name: string, args: string, id: string) => new Response(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test",
        choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        if (calls.length === 1) return toolStream("list_skills", "{}", "call_list");
        if (calls.length === 2) return toolStream("use_skill", '{"name":"background-removal"}', "call_guide");
        if (calls.length === 3) return textStream("已读取去背景技能，先核对原图和可用模型。");
        return structuredResponse({ decision: "no_write_required", reasonCode: "clarification" });
      },
    }).chatModel("test");
    const paidSubmit = vi.fn(async () => ({ status: "processing" }));
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run: { runId: "cutout", sessionId: "session", conversationId: "conversation",
        prompt: "把我这张产品图的背景抠掉，交付透明 PNG", executionMode: "fast",
        attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "把我这张产品图的背景抠掉，交付透明 PNG" }],
      configurable: {}, maxOutputTokens: 1_000,
      tools: [...toolkit.tools, createAgentTool({ id: "edit_image", description: "Paid image edit", inputSchema: z.object({}).strict(), execute: paidSubmit })], instructions: toolkit.instructions,
    })) events.push(event);
    const completed = events.filter(event => event.type === "tool.completed");
    expect(completed.map(event => event.toolName))
      .toEqual(["list_skills", "use_skill"]);
    expect(completed.find(event => event.toolName === "use_skill")?.output)
      .toMatchObject({ status: "loaded", instructions: guide });
    expect(JSON.stringify(calls[2].messages)).toContain(guide);
    expect(paidSubmit).not.toHaveBeenCalled();
    const instructions = calls[0].messages.filter((message: any) => message.role === "system")
      .map((message: any) => message.content).join("\n");
    expect(instructions).toContain('use_skill({name:"background-removal"})');
    expect(instructions).toContain("仅讨论去背景方法、明确说不做、只要画板透明导出");
    expect(instructions).toContain("sourceUsage=edit，background=transparent，outputFormat=png");
  });
  it("documents the bounded nonstandard-size Skill trigger and native image boundary", async () => {
    const calls: any[] = [];
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return calls.length === 1 ? textStream("请说明需要的尺寸。")
          : structuredResponse({ decision: "no_write_required", reasonCode: "discussion" });
      },
    }).chatModel("test");
    for await (const _event of streamMastraDesignAgent({
      run: { runId: "nonstandard-size", sessionId: "session", conversationId: "conversation",
        prompt: "先讨论 1400:500 尺寸，不生成", executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "先讨论 1400:500 尺寸，不生成" }], configurable: {}, maxOutputTokens: 1_000,
      tools: [createAgentTool({ id: "generate_image", description: "Submit an image", inputSchema: z.object({}), execute: vi.fn() })],
    })) { /* drain */ }
    const instructions = calls[0].messages.filter((message: any) => message.role === "system")
      .map((message: any) => message.content).join("\n");
    // The runtime documents the trigger + server gate only; sizing method lives
    // in the Skill body (preloaded/loaded on demand).
    expect(instructions).toContain('use_skill({name:"nonstandard-image-size"})');
    expect(instructions).toContain("常规预设比例");
    expect(instructions).toContain("服务端会核对本轮技能回执与近似授权，未加载或未授权会被拒绝");
    expect(instructions).toContain("近似授权只在同一任务微调中沿用，新请求不继承");
  });
  it("executes one tool, preserves its receipt, then streams the response", async () => {
    const log = vi.spyOn(console, "info");
    const calls: any[] = [];
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        const chunks = calls.length === 1 ? [
          { delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_image", type: "function", function: { name: "generate_image", arguments: '{"title":"logo"}' } }] }, finish_reason: null },
          { delta: {}, finish_reason: "tool_calls" },
        ] : [{ delta: { role: "assistant", content: "已提交。" }, finish_reason: null }, { delta: {}, finish_reason: "stop" }];
        return new Response(chunks.map(choice => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, ...choice }] })}\n\n`).join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } });
      },
    }).chatModel("test");
    const execute = vi.fn(async () => ({ status: "processing", jobId: "job-1" }));
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run: { runId: "run-1", sessionId: "session-1", conversationId: "conversation-1", prompt: "确认生成", executionMode: "fast",
        attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "确认生成" }], configurable: { user_id: "owner" }, maxOutputTokens: 1000,
      contextBudget: createContextBudget(),
      tools: [createAgentTool({ id: "generate_image", description: "Submit an image", inputSchema: z.object({ title: z.string() }), execute: execute })],
    })) events.push(event);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    const discovery = calls[0].tools.find((t: any) => t.function.name === "discover_tools");
    expect(discovery.function.description).not.toContain("Submit an image");
    expect(calls[0].tools.find((t: any) => t.function.name === "generate_image").function.description).toBe("Submit an image");
    const sentInstructions = calls[0].messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
    expect(sentInstructions).toContain("保留原文、原语言和拼写");
    expect(sentInstructions).toContain("未被采纳的助手建议不能覆盖确认清单");
    expect(events.some(e => e.type === "tool.completed" && e.output?.jobId === "job-1")).toBe(true);
    expect(events.some(e => e.type === "message.delta" && e.delta === "已提交。")).toBe(true);
    expect(events.at(-1)?.type).toBe("run.completed");
    const budgetLog = log.mock.calls.find(([tag]) => tag === "[mastra-context-budget]")?.[1] as any;
    expect(budgetLog).toMatchObject({ schemaEstimateAvailable: true,
      estimateScope: "initial_messages_system_and_all_registered_tool_schemas",
      inputCeilingTokens: createContextBudget().inputCeilingTokens });
    expect(budgetLog.estimatedInputTokens).toBeGreaterThan(0);
    expect(JSON.stringify(budgetLog)).not.toContain("确认生成");
    expect(JSON.stringify(budgetLog)).not.toContain("Submit an image");
    log.mockRestore();
  });
  it("keeps deferred tools discoverable and enables them on the next SDK step", async () => {
    const calls: any[] = [];
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        if (calls.length === 4) return structuredResponse({ decision: "no_write_required", reasonCode: "discussion" });
        if (calls.length === 3) return textStream("Found the reference.");
        const name = calls.length === 1 ? "discover_tools" : "lookup_reference";
        const args = calls.length === 1 ? '{"names":["lookup_reference"]}' : '{}';
        return new Response(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test",
          choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls.length}`, type: "function", function: { name, arguments: args } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } });
      },
    }).chatModel("test");
    const lookup = vi.fn(async () => ({ assetId: "reference-1" }));
    for await (const _event of streamMastraDesignAgent({
      run: { runId: "discovery", sessionId: "session", conversationId: "conversation", prompt: "Find the reference", executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "Find the reference" }], configurable: {}, maxOutputTokens: 1000,
      tools: [createAgentTool({ id: "lookup_reference", description: "Find a prior image by its asset identity", inputSchema: z.object({}), execute: lookup })],
    })) { /* drain SDK stream */ }
    expect(calls).toHaveLength(4);
    expect(calls[0].tools.some((t: any) => t.function.name === "lookup_reference")).toBe(false);
    expect(calls[0].tools.find((t: any) => t.function.name === "discover_tools").function.description).toContain("lookup_reference: Find a prior image by its asset identity");
    expect(calls[1].tools.some((t: any) => t.function.name === "lookup_reference")).toBe(true);
    expect(lookup).toHaveBeenCalledOnce();
  });
  it("corrects a no-tool success draft and performs one semantically required write recovery", async () => {
    const calls: any[] = [];
    const streamResponse = (choices: any[]) => new Response(
      choices.map(choice => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1,
        model: "test", choices: [{ index: 0, ...choice }] })}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        if (calls.length === 1) return streamResponse([
          { delta: { role: "assistant", content: "Submitted fake-job without a tool." }, finish_reason: null },
          { delta: {}, finish_reason: "stop" },
        ]);
        if (calls.length === 2) return new Response(JSON.stringify({
          id: "classification", object: "chat.completion", created: 1, model: "test",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
            decision: "write_required", writeToolNames: ["generate_image"], reasonCode: "create",
          }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), { headers: { "content-type": "application/json" } });
        if (calls.length === 3) return streamResponse([
          { delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_recovery", type: "function",
            function: { name: "generate_image", arguments: '{"title":"poster"}' } }] }, finish_reason: null },
          { delta: {}, finish_reason: "tool_calls" },
        ]);
        return streamResponse([
          { delta: { role: "assistant", content: "The real task is processing." }, finish_reason: null },
          { delta: {}, finish_reason: "stop" },
        ]);
      },
    }).chatModel("test");
    const execute = vi.fn(async () => ({ status: "processing", jobId: "real-job" }));
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run: { runId: "run-recovery", sessionId: "session", conversationId: "conversation",
        prompt: "Create the poster now", executionMode: "fast", attachments: [], mentions: [],
        signal: new AbortController().signal },
      model, messages: [
        { role: "assistant", content: "A poisoned historical claim says fake-old-job is still processing." },
        { role: "user", content: "Create the poster now\n<current_context>{\"imageExecutionState\":{\"verified\":true,\"activeCount\":0}}</current_context>" },
      ], configurable: {}, maxOutputTokens: 1_000,
      tools: [createAgentTool({ id: "generate_image", description: "Submit an image", inputSchema: z.object({ title: z.string() }), execute: execute })],
    })) events.push(event);

    expect(calls).toHaveLength(4);
    expect(calls[1]?.tools).toBeUndefined();
    expect(JSON.stringify(calls[1])).toContain("imageExecutionState");
    expect(JSON.stringify(calls[1])).toContain("untrusted_for_execution_facts");
    expect(calls[2]?.tool_choice).toBe("required");
    expect(execute).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", toolName: "generate_image",
      output: expect.objectContaining({ jobId: "real-job" }) }));
    expect(events.some(event => event.type === "message.delta" && event.delta.includes("fake-job"))).toBe(true);
    const correctionIndex = events.findIndex(event => event.type === "message.delta" && event.messageId.startsWith("execution-correction-"));
    const writeIndex = events.findIndex(event => event.type === "tool.started" && event.toolName === "generate_image");
    expect(correctionIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeGreaterThan(correctionIndex);
    expect(events.some(event => event.type === "message.delta" && event.delta === "The real task is processing.")).toBe(true);
  });
  it("logs the disabled repair path without making a checker or recovery call", async () => {
    const prompt = "Create a private poster";
    const calls: any[] = [];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return textStream("I have started it without a tool.");
      },
    }).chatModel("test");
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run: { runId: "run-repair-disabled", sessionId: "session", conversationId: "conversation", prompt,
        executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: prompt }], configurable: {}, maxOutputTokens: 1_000,
      writeRepairEnabled: false, writeRepairToolChoice: false,
      tools: [createAgentTool({ id: "generate_image", description: "Submit an image", inputSchema: z.object({}), execute: vi.fn() })],
    })) events.push(event);

    expect(calls).toHaveLength(1);
    expect(events.some(event => event.type === "message.delta" && event.messageId.startsWith("execution-"))).toBe(false);
    expect(info).toHaveBeenCalledWith("[mastra-write-repair]", expect.objectContaining({
      runId: "run-repair-disabled", stage: "skipped_disabled", decision: "not_checked", result: "none",
      writeToolNames: ["generate_image"], skipReason: "write_repair_disabled",
    }));
    expect(JSON.stringify(info.mock.calls)).not.toContain(prompt);
    info.mockRestore();
  });
  it("can retain recovery while omitting the required first-step tool choice", async () => {
    const calls: any[] = [];
    const streamResponse = (choices: any[]) => new Response(
      choices.map(choice => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1,
        model: "test", choices: [{ index: 0, ...choice }] })}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        if (calls.length === 1) return streamResponse([
          { delta: { role: "assistant", content: "Claimed completion without a receipt." }, finish_reason: null },
          { delta: {}, finish_reason: "stop" },
        ]);
        if (calls.length === 2) return structuredResponse({
          decision: "write_required", writeToolNames: ["generate_image"], reasonCode: "create",
        });
        if (calls.length === 3) return streamResponse([
          { delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_optional", type: "function",
            function: { name: "generate_image", arguments: "{}" } }] }, finish_reason: null },
          { delta: {}, finish_reason: "tool_calls" },
        ]);
        return streamResponse([
          { delta: { role: "assistant", content: "The task is processing." }, finish_reason: null },
          { delta: {}, finish_reason: "stop" },
        ]);
      },
    }).chatModel("test");
    for await (const _event of streamMastraDesignAgent({
      run: { runId: "run-optional-tool-choice", sessionId: "session", conversationId: "conversation", prompt: "Create it",
        executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "Create it" }], configurable: {}, maxOutputTokens: 1_000,
      writeRepairToolChoice: false,
      tools: [createAgentTool({ id: "generate_image", description: "Submit an image", inputSchema: z.object({}), execute: vi.fn(async () => ({ status: "processing" })) })],
    })) { /* drain */ }

    expect(calls).toHaveLength(4);
    expect(calls[2]?.tool_choice).not.toBe("required");
    expect(info).toHaveBeenCalledWith("[mastra-write-repair]", expect.objectContaining({
      runId: "run-optional-tool-choice", stage: "recovery", decision: "write_required", result: "write_started",
    }));
    info.mockRestore();
  });
  it("logs a failed recovery stream before preserving its error", async () => {
    const calls: any[] = [];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        if (calls.length === 1) return textStream("Claimed completion without a receipt.");
        if (calls.length === 2) return structuredResponse({
          decision: "write_required", writeToolNames: ["generate_image"], reasonCode: "create",
        });
        throw new Error("recovery transport failure");
      },
    }).chatModel("test");
    const sdkError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run: { runId: "run-recovery-failed", sessionId: "session", conversationId: "conversation", prompt: "Create it",
        executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "Create it" }], configurable: {}, maxOutputTokens: 1_000,
      tools: [createAgentTool({ id: "generate_image", description: "Submit an image", inputSchema: z.object({}), execute: vi.fn() })],
    })) events.push(event);

    // Bounded retry for the CHAT model: the failing recovery attempt is issued
    // 1 + 2 times, so 2 preparatory calls (main attempt + write-repair
    // classifier) followed by 3 recovery attempts. Asserting the exact count
    // keeps the retry budget deliberate: a transient gateway 5xx no longer kills
    // the turn on the first try, but it must never become unbounded either.
    expect(calls).toHaveLength(5);
    expect(events).toContainEqual(expect.objectContaining({ type: "run.failed", runId: "run-recovery-failed" }));
    expect(info).toHaveBeenCalledWith("[mastra-write-repair]", expect.objectContaining({
      runId: "run-recovery-failed", stage: "recovery", decision: "write_required", result: "none",
      writeToolNames: ["generate_image"], skipReason: "recovery_stream_failed",
    }));
    info.mockRestore();
    sdkError.mockRestore();
  });
  it("ends a required-write recovery truthfully when the corrective continuation still calls no write tool", async () => {
    const calls: any[] = [];
    const streamText = (text: string) => new Response(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test",
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        if (calls.length === 2) return new Response(JSON.stringify({
          id: "classification", object: "chat.completion", created: 1, model: "test",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
            decision: "write_required", writeToolNames: ["generate_image"], reasonCode: "create",
          }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), { headers: { "content-type": "application/json" } });
        return streamText(calls.length === 1 ? "fabricated submission" : "still fabricated");
      },
    }).chatModel("test");
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run: { runId: "run-no-receipt", sessionId: "session", conversationId: "conversation",
        prompt: "Create it", executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "Create it" }], configurable: {}, maxOutputTokens: 1_000,
      tools: [createAgentTool({ id: "generate_image", description: "Submit an image", inputSchema: z.object({}), execute: vi.fn() })],
    })) events.push(event);

    const text = events.filter(event => event.type === "message.delta").map(event => event.delta).join("");
    expect(calls).toHaveLength(3);
    // The internal write-receipt check speaks to the user in plain language: it
    // must never claim completion, and it must not promise work it cannot keep.
    expect(text).toContain("我先确认这一步是否真的执行成功");
    expect(text).toContain("这次没有执行成功");
    expect(text).not.toContain("写入工具回执");
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  // `toolChoice: "required"` alone was satisfiable by an unrelated read-only tool
  // call, after which the model could answer with text and no write — the shape of
  // the "I have no permission to delete" incident on a turn the runtime itself
  // classified as write_required.
  it("offers the corrective run only the write tools the checker named", async () => {
    const calls: any[] = [];
    const streamText = (text: string) => new Response(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test",
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        if (calls.length === 2) return new Response(JSON.stringify({
          id: "classification", object: "chat.completion", created: 1, model: "test",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
            decision: "write_required", writeToolNames: ["manipulate_canvas"], reasonCode: "delete",
          }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), { headers: { "content-type": "application/json" } });
        return streamText("no write performed");
      },
    }).chatModel("test");
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run: { runId: "run-write-only", sessionId: "session", conversationId: "conversation",
        prompt: "Delete that image from my canvas", executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "Delete that image from my canvas" }], configurable: {}, maxOutputTokens: 1_000,
      tools: [
        createAgentTool({ id: "manipulate_canvas", description: "Change the canvas", inputSchema: z.object({}), execute: vi.fn() }),
        createAgentTool({ id: "get_image_status", description: "Read a job", inputSchema: z.object({}), execute: vi.fn() }),
      ],
    })) events.push(event);

    // Calls: 1 = main attempt, 2 = write-repair classifier, 3+ = corrective run.
    const recoveryTools = (calls[2]?.tools ?? []).map((tool: { function?: { name?: string } }) => tool.function?.name);
    expect(recoveryTools).toEqual(["manipulate_canvas"]);
    expect(calls[2]?.tool_choice).toBe("required");
    // The main attempt keeps its resident toolset, where the canvas writer is
    // demand-loaded: it becomes available exactly for the corrective first step.
    const mainTools = (calls[0]?.tools ?? []).map((tool: { function?: { name?: string } }) => tool.function?.name);
    expect(mainTools).toContain("get_image_status");
    expect(mainTools).not.toContain("manipulate_canvas");
  });
  it("does not force a write when an underspecified request receives a necessary clarification", async () => {
    const calls: any[] = [];
    const execute = vi.fn();
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return calls.length === 1 ? textStream("What brand text should the logo contain?")
          : structuredResponse({ decision: "no_write_required", reasonCode: "clarification" });
      },
    }).chatModel("test");
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run: { runId: "run-clarify", sessionId: "session", conversationId: "conversation",
        prompt: "Generate a logo", executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "Generate a logo" }], configurable: {}, maxOutputTokens: 1_000,
      tools: [createAgentTool({ id: "generate_image", description: "Submit an image", inputSchema: z.object({}), execute: execute })],
    })) events.push(event);

    expect(calls).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
    expect(events.some(event => event.type === "message.delta" && event.messageId.startsWith("execution-correction-"))).toBe(false);
  });
  it("does not run write recovery after a structured clarification tool call", async () => {
    const calls: any[] = [];
    const streamResponse = (choices: any[]) => new Response(
      choices.map(choice => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1,
        model: "test", choices: [{ index: 0, ...choice }] })}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        if (calls.length === 1) return streamResponse([
          { delta: { role: "assistant", tool_calls: [{ index: 0, id: "ask-1", type: "function",
            function: { name: "ask_clarification", arguments: JSON.stringify({ questions: [{
              title: "品牌名称", prompt: "Logo 上显示什么文字？", options: [], allowCustom: true,
            }] }) } }] }, finish_reason: null },
          { delta: {}, finish_reason: "tool_calls" },
        ]);
        return streamResponse([{ delta: {}, finish_reason: "stop" }]);
      },
    }).chatModel("test");
    const ask = vi.fn(async (input) => ({ status: "awaiting_user_input", questions: input.questions.map((q: any, index: number) => ({ id: index + 1, ...q })) }));
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run: { runId: "run-structured-clarify", sessionId: "session", conversationId: "conversation",
        prompt: "Generate a logo", executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "Generate a logo" }], configurable: {}, maxOutputTokens: 1_000,
      tools: [createAgentTool({ id: "ask_clarification", description: "Ask structured questions", inputSchema: z.object({ questions: z.array(z.object({ title: z.string(), prompt: z.string(), options: z.array(z.string()), allowCustom: z.boolean() })) }), execute: ask })],
    })) events.push(event);

    expect(calls).toHaveLength(2);
    expect(ask).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.completed", toolName: "ask_clarification" }));
    expect(events.some(event => event.type === "message.delta" && event.messageId.startsWith("execution-correction-"))).toBe(false);
  });
  it("skips semantic repair when the exact current request exceeds its bounded input ceiling", async () => {
    const calls: any[] = [];
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return textStream("Please clarify."); },
    }).chatModel("test");
    const prompt = `${"context ".repeat(1_100)}do not generate`;
    for await (const _event of streamMastraDesignAgent({
      run: { runId: "run-long", sessionId: "session", conversationId: "conversation", prompt,
        executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: prompt }], configurable: {}, maxOutputTokens: 1_000,
      tools: [createAgentTool({ id: "generate_image", description: "Submit an image", inputSchema: z.object({}), execute: vi.fn() })],
    })) { /* drain */ }
    expect(calls).toHaveLength(1);
  });
  it("does not recover through a tool name that is absent from the registered write catalog", async () => {
    const calls: any[] = [];
    const execute = vi.fn();
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return calls.length === 1 ? textStream("Done without a tool.")
          : structuredResponse({ decision: "write_required", writeToolNames: ["not_registered"], reasonCode: "create" });
      },
    }).chatModel("test");
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run: { runId: "run-invalid-tool", sessionId: "session", conversationId: "conversation", prompt: "Create it",
        executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "Create it" }], configurable: {}, maxOutputTokens: 1_000,
      tools: [createAgentTool({ id: "generate_image", description: "Submit an image", inputSchema: z.object({}), execute: execute })],
    })) events.push(event);
    expect(calls).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
    expect(events.some(event => event.type === "message.delta" && event.messageId.startsWith("execution-correction-"))).toBe(false);
  });
  it("falls back to an explicit no-receipt note without logging raw reviewer errors", async () => {
    let call = 0;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sdkError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async () => {
        call += 1;
        if (call === 1) return textStream("Unverified result.");
        throw Object.assign(new Error("SECRET_PROVIDER_HEADER"), { code: "review_unavailable" });
      },
    }).chatModel("test");
    const events = [];
    for await (const event of streamMastraDesignAgent({
      run: { runId: "run-review-fallback", sessionId: "session", conversationId: "conversation", prompt: "Create it",
        executionMode: "fast", attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "Create it" }], configurable: {}, maxOutputTokens: 1_000,
      tools: [createAgentTool({ id: "generate_image", description: "Submit an image", inputSchema: z.object({}), execute: vi.fn() })],
    })) events.push(event);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Error:review_unavailable"));
    expect(JSON.stringify(warning.mock.calls)).not.toContain("SECRET_PROVIDER_HEADER");
    expect(events.some(event => event.type === "message.delta" && event.messageId.startsWith("execution-check-unavailable-"))).toBe(true);
    warning.mockRestore();
    sdkError.mockRestore();
  });
  it("removes binary carriers from model-facing results", () => {
    expect(compactMastraToolResult({ assetId: "a", inputImages: ["data:image/png;base64,AAA"], nested: { image: "data:image/png;base64,AAA" } }))
      .toEqual({ assetId: "a", nested: { image: "[binary asset omitted; use assetId]" } });
  });
  it("caps per-step tool context by complete newest call/result pairs without a run-depleting quota", () => {
    const message = (id: string, result: unknown) => ({
      id: `message-${id}`, role: "assistant" as const, createdAt: new Date(),
      content: { format: 2 as const, parts: [
        { type: "tool-invocation" as const, toolInvocation: { toolCallId: id, toolName: "inspect_canvas",
          state: "call" as const, args: { query: id } } },
        { type: "tool-invocation" as const, toolInvocation: { toolCallId: id, toolName: "inspect_canvas",
          state: "result" as const, result } },
      ] },
    });
    const current = { id: "current", role: "user" as const, createdAt: new Date(),
      content: { format: 2 as const, parts: [{ type: "text" as const, text: "exact current request" }] } };
    const projected = compactMastraStepToolContext([
      message("old", { rows: "o".repeat(20_000) }),
      message("new", { rows: "n".repeat(20_000) }),
      current,
    ] as any, { totalBytes: 2_000, resultBytes: 1_200, argsBytes: 300 });
    const invocations = projected.flatMap(item => item.content.parts)
      .filter((part: any) => part.type === "tool-invocation") as any[];
    expect(invocations.map(part => part.toolInvocation.toolCallId)).toEqual(["new", "new"]);
    expect(new TextEncoder().encode(JSON.stringify(invocations)).byteLength).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(invocations)).toContain("truncated");
    expect(projected.some(item => item.id === current.id)).toBe(true);

    const later = compactMastraStepToolContext([message("later", { rows: [1, 2] })] as any,
      { totalBytes: 2_000, resultBytes: 1_200, argsBytes: 300 });
    expect(JSON.stringify(later)).toContain('"rows":[1,2]');
  });

  it("never compacts away a Skill method the model deliberately loaded", () => {
    // A guide read is the ONLY way method text reaches the model now that the
    // runtime stopped preloading bodies, so an OLD guide read must survive even a
    // budget tiny enough to drop newer non-guide calls. Dropping it would leave the
    // model composing a prompt from a guide it can no longer see.
    const call = (id: string, toolName: string, result: unknown) => ({
      id: `message-${id}`, role: "assistant" as const, createdAt: new Date(),
      content: { format: 2 as const, parts: [
        { type: "tool-invocation" as const, toolInvocation: { toolCallId: id, toolName,
          state: "result" as const, result } },
      ] },
    });
    const projected = compactMastraStepToolContext([
      call("guide", "use_skill", { status: "loaded", instructions: "GUIDE-METHOD" }),
      call("composed", "compose_skills", { status: "composed",
        primary: { name: "campaign-design", instructions: "COMPOSED-METHOD" }, helpers: [] }),
      call("canvas-1", "inspect_canvas", { rows: "x".repeat(5_000) }),
      call("canvas-2", "inspect_canvas", { rows: "y".repeat(5_000) }),
    ] as any, { totalBytes: 2_000, resultBytes: 1_200, argsBytes: 300 });
    const kept = projected.flatMap(item => item.content.parts)
      .filter((part: any) => part.type === "tool-invocation") as any[];
    // Both read tools, because both deliver guide bodies.
    expect(kept.some(part => part.toolInvocation.toolCallId === "guide")).toBe(true);
    expect(JSON.stringify(kept)).toContain("GUIDE-METHOD");
    expect(kept.some(part => part.toolInvocation.toolCallId === "composed")).toBe(true);
    expect(JSON.stringify(kept)).toContain("COMPOSED-METHOD");
  });

  it("sizes the default result budget so a real guide composition arrives whole", () => {
    const composed = {
      status: "composed", authority: "method_suggestions_only", executed: false,
      primary: { name: "game-promo-visuals", instructions: "主".repeat(2_600) },
      helpers: [{ name: "product-visual", instructions: "助".repeat(1_000) }],
    };
    const message = {
      id: "compose", role: "assistant" as const, createdAt: new Date(),
      content: { format: 2 as const, parts: [
        { type: "tool-invocation" as const, toolInvocation: { toolCallId: "c", toolName: "compose_skills",
          state: "result" as const, result: composed } },
      ] },
    };
    // The previous 10 000-byte cap replaced a composition of this size with a raw
    // JSON slice: a half guide presented to the model as method text.
    const underOldCap = JSON.stringify(compactMastraStepToolContext([message] as any,
      { resultBytes: 10_000 }));
    expect(underOldCap).toContain("truncated");
    // The default budget must carry it whole, because a guide cannot be re-derived
    // and re-reading burns a step.
    const whole = JSON.stringify(compactMastraStepToolContext([message] as any));
    expect(whole).toContain("助".repeat(1_000));
    expect(whole).not.toContain("truncated");
  });
  it("precompiles native generate/edit target schemas for the DeepSeek model identifier", async () => {
    const calls: any[] = [];
    const model = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        if (calls.length === 2) return new Response(JSON.stringify({
          id: "classification", object: "chat.completion", created: 1, model: "deepseek-v4-flash-vision-exp",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant",
            content: JSON.stringify({ decision: "no_write_required", reasonCode: "question" }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }), { headers: { "content-type": "application/json" } });
        return new Response(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1,
          model: "deepseek-v4-flash-vision-exp", choices: [{ index: 0, delta: { role: "assistant", content: "已理解。" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash-vision-exp", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } });
      },
    }).chatModel("deepseek-v4-flash-vision-exp");
    const submit = vi.fn(async (_context: MastraImageSubmitContext, _input: unknown) => ({ jobId: "job-1", status: "processing" as const }));
    const images = createMastraImageTools({ createUserClient: vi.fn(), submitter: { submit }, availableImageModels: [{
      id: "workspace:image", provider: "test", upstreamModelId: "image", displayName: "Image", description: "",
    }] });
    const inventory = createAgentTool({ id: "inspect_canvas", description: "Board inventory", inputSchema: z.object({}).strict(), execute: async () => ({ objects: [] }) });
    for await (const _event of streamMastraDesignAgent({
      run: { runId: "run-2", sessionId: "session-2", conversationId: "conversation-2", prompt: "查看画板", executionMode: "fast",
        attachments: [], mentions: [], signal: new AbortController().signal },
      model, messages: [{ role: "user", content: "查看画板" }], maxOutputTokens: 1000,
      configurable: { user_id: "owner", workspace_id: "workspace", canvas_id: "canvas", session_id: "session-2", run_id: "run-2", access_token: "token" },
      tools: [images.generateImage, images.editImage, inventory],
    })) { /* schema construction happens before the first streamed event */ }
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0]?.tools)).toContain("edit_image");
    expect(calls[1]?.tools).toBeUndefined();
  });
});
