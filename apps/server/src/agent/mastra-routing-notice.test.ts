import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Part ① evidence at the real runtime boundary: `createMastraRunFactory` must
 * emit exactly one `design.routing` notice for a turn that made a routing
 * decision, must stay silent otherwise, and must never let the model stage
 * weaken the remembered session series.
 */
const captured = vi.hoisted(() => ({
  options: undefined as any,
  upserts: [] as Array<Record<string, unknown>>,
  generates: [] as Array<{ id: string; prompt: string }>,
  classifierReply: { intent: "non_design", reasonCode: "unclear", confidence: 0.5 } as Record<string, unknown>,
  classifierFailure: null as Error | null,
}));

/** Mirrors the real manifest routing blocks: two primaries/helpers plus a capability-only Skill. */
const fixtures = vi.hoisted(() => ({
  skills: [
    { name: "campaign-design", displayName: "活动海报与宣传图", description: "活动海报与推广封面",
      version: "2.2.0", content: "CAMPAIGN SKILL BODY", contentHash: "hash-campaign",
      metadata: { loomic: { schemaVersion: 1, execution: "image", intents: ["campaign"], outputKinds: ["raster-image"],
        requiredTools: [], optionalTools: [], models: [], limitations: [], examples: [], sources: [],
        routing: { keywords: ["活动", "促销", "海报", "宣传", "banner", "poster"], priority: 10 } } } },
    { name: "design-copywriting", displayName: "海报文案", description: "撰写海报文案",
      version: "1.0.0", content: "COPYWRITING SKILL BODY", contentHash: "hash-copy",
      metadata: { loomic: { schemaVersion: 1, execution: "guidance", intents: ["copy"], outputKinds: ["image-prompt"],
        requiredTools: [], optionalTools: [], models: [], limitations: [], examples: [], sources: [],
        routing: { keywords: ["文案", "标题文案"], priority: 0, tier: "helper" } } } },
    { name: "nonstandard-image-size", displayName: "非标准尺寸", description: "非标准比例与像素尺寸",
      version: "1.0.0", content: "NONSTANDARD SIZE SKILL BODY", contentHash: "hash-size",
      metadata: { loomic: { schemaVersion: 1, execution: "guidance", intents: ["size"], outputKinds: ["image-prompt"],
        requiredTools: [], optionalTools: [], models: [], limitations: [], examples: [], sources: [],
        capabilities: ["nonstandard-ratio"] } } },
  ],
}));

vi.mock("@mastra/core/agent", () => ({
  Agent: class {
    private readonly id: string;
    constructor(options: { id?: string }) { this.id = options.id ?? "unknown"; }
    async generate(prompt: string) {
      captured.generates.push({ id: this.id, prompt });
      if (this.id === "loomic-design-turn-intent") {
        if (captured.classifierFailure) throw captured.classifierFailure;
        return { object: captured.classifierReply };
      }
      return { text: "" };
    }
  },
}));

vi.mock("./mastra-agent.js", () => ({
  createMastraWorkspaceModel: vi.fn(() => ({ kind: "synthetic-model" })),
  compactMastraToolResult: (value: unknown) => value,
  streamMastraDesignAgent: vi.fn(async function* (options: any) {
    captured.options = options;
    yield { type: "run.completed", runId: options.run.runId, timestamp: "2026-09-15T00:00:00.000Z" };
  }),
}));
vi.mock("./mastra-toolkit.js", () => ({ createMastraToolkit: vi.fn(() => ({ tools: [], instructions: "" })) }));
vi.mock("./mastra-image-tool.js", () => ({ createMastraImageTools: vi.fn(() => ({ generateImage: {}, editImage: {} })) }));
vi.mock("./mastra-image-jobs.js", () => ({ createMastraImageJobSubmitter: vi.fn(() => ({})) }));
vi.mock("./mastra-video-jobs.js", () => ({ createMastraVideoJobSubmitter: vi.fn(() => ({})) }));
vi.mock("./mastra-video-tool.js", () => ({ createMastraVideoTool: vi.fn(() => ({})) }));
vi.mock("./workspace-skills.js", () => ({ loadWorkspaceSkills: vi.fn(async () => fixtures.skills) }));
vi.mock("./workspace-chat-model.js", () => ({ resolveWorkspaceChatModel: vi.fn(async () => ({})) }));
vi.mock("./attachment-resolver.js", () => ({ resolveAgentImageAttachment: vi.fn(), optimizeAgentVisionAttachment: vi.fn() }));
vi.mock("./attachment-vision-analyzer.js", () => ({ analyzeAgentVisionAttachments: vi.fn() }));
vi.mock("./related-image-context.js", () => ({ selectRelatedImageContext: vi.fn(() => ({ candidates: [] })),
  renderRelatedImageContext: vi.fn(() => "") }));
vi.mock("./mastra-history-attachments.js", () => ({ loadMastraHistoricalUploads: vi.fn(async () => []) }));
vi.mock("./mastra-image-status-tools.js", () => ({
  createMastraImageJobScopeQuery: vi.fn(() => (query: any) => query),
  createMastraImageStatusTools: vi.fn(() => ({ getImageStatus: {}, cancelImageJob: {} })),
}));
vi.mock("./mastra-image-source-grounding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mastra-image-source-grounding.js")>();
  return { ...actual, buildMastraImageSourceCandidates: vi.fn(() => []),
    createMastraExplicitImageSourceResolver: vi.fn(() => vi.fn()),
    createMastraImageSourceGrounder: vi.fn(() => vi.fn()),
    createMastraImageSourceMaterializer: vi.fn(() => ({})), createMastraImageSourceReviewer: vi.fn(() => ({})) };
});

import { createMastraRunFactory } from "./mastra-runtime.js";

const ids = {
  run: "00000000-0000-4000-8000-000000000001", conversation: "00000000-0000-4000-8000-000000000002",
  session: "00000000-0000-4000-8000-000000000003", current: "00000000-0000-4000-8000-000000000004",
  user: "00000000-0000-4000-8000-000000000005", workspace: "00000000-0000-4000-8000-000000000006",
  canvas: "00000000-0000-4000-8000-000000000007", project: "00000000-0000-4000-8000-000000000008",
};

function client() {
  const chain = (result: any): any => {
    const value = Promise.resolve(result);
    const query: any = { select: () => query, eq: () => query, order: () => query, in: () => query,
      limit: () => query, is: () => query, maybeSingle: () => value, single: () => value,
      range: (from: number, to: number) => Promise.resolve({ ...result,
        data: Array.isArray(result.data) ? result.data.slice(from, to + 1) : result.data }),
      upsert: (row: Record<string, unknown>) => { captured.upserts.push(row); return Promise.resolve({ error: null }); },
      then: value.then.bind(value) };
    return query;
  };
  return {
    from(table: string) {
      if (table === "canvases") return chain({ data: { id: ids.canvas, project_id: ids.project, content: { elements: [] } }, error: null });
      if (table === "chat_sessions") return chain({ data: { id: ids.session, canvas_id: ids.canvas }, error: null });
      if (table === "projects") return chain({ data: { id: ids.project, workspace_id: ids.workspace, brand_kit_id: null }, error: null });
      if (table === "chat_messages") return chain({ data: [], error: null });
      // A remembered series with a sticky Skill, so the "must not overwrite"
      // guarantees have real state to protect.
      if (table === "session_design_context") return chain({ data: { active_skill: "campaign-design",
        active_skill_hash: "hash-campaign", series: { style: "深海蓝", sizes: ["1:1"] },
        awaiting_clarification: false }, error: null });
      return chain({ data: [], error: null, count: 0 });
    },
  };
}

async function runTurn(prompt: string, mentions: any[] = []) {
  captured.upserts = [];
  captured.generates = [];
  captured.options = undefined;
  const factory = createMastraRunFactory({
    env: {},
    createUserClient: vi.fn(() => client()),
    providerSnapshotService: { resolveRunSnapshot: vi.fn(async () => ({ modality: "text", capabilities: ["text"],
      catalogKey: "chat", upstreamModelId: "test", baseUrl: "https://test.invalid/v1", apiKey: "test" })) },
    workspaceModelCatalogService: { listPublished: vi.fn(async () => []) }, jobService: {},
  } as any);
  const events: any[] = [];
  for await (const event of await factory({ runId: ids.run, conversationId: ids.conversation, sessionId: ids.session,
    userMessageId: ids.current, userId: ids.user, workspaceId: ids.workspace, canvasId: ids.canvas,
    accessToken: "test-token", prompt, executionMode: "fast", attachments: [], mentions,
    signal: new AbortController().signal })) events.push(event);
  return events;
}

const notices = (events: any[]) => events.filter(event => event.type === "design.routing");
const classifierCalls = () => captured.generates.filter(call => call.id === "loomic-design-turn-intent");

describe("runtime routing notice", () => {
  beforeEach(() => {
    vi.stubEnv("LOOMIC_MASTRA_MEMORY_MODE", "legacy");
    captured.classifierReply = { intent: "non_design", reasonCode: "unclear", confidence: 0.5 };
    captured.classifierFailure = null;
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("emits one notice for a routed turn, before the answer, without a model call", async () => {
    const events = await runTurn("做一张活动海报");
    const found = notices(events);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ type: "design.routing", runId: ids.run, intent: "new_generation",
      reasonCode: "explicit_creation", source: "deterministic", clamped: false });
    // No Skill is "chosen": the runtime reports the candidate the user's own words
    // point at, and the model decides from the catalog whether to read it.
    expect(found[0]).not.toHaveProperty("primarySkill");
    expect(found[0].summary).toBe("候选技能：活动海报与宣传图（命中 活动/海报）");
    // A confidently resolved turn costs no model call at all.
    expect(classifierCalls()).toHaveLength(0);
    // The notice precedes the terminal event instead of trailing the answer.
    expect(events.findIndex(event => event.type === "design.routing"))
      .toBeLessThan(events.findIndex(event => event.type === "run.completed"));
  });

  it("covers the helper candidates and the non-standard-size enable", async () => {
    const events = await runTurn("做一张活动海报，再写一句文案，尺寸 658×176");
    const notice = notices(events)[0]!;
    expect(notice).toMatchObject({
      helperSkills: ["design-copywriting"], nonstandardSizeSkill: "nonstandard-image-size" });
    expect(notice).not.toHaveProperty("primarySkill");
    expect(notice.summary).toContain("候选技能：活动海报与宣传图");
    // The runtime injects no guide text any more, so the notice must not claim a
    // preload: these are the guides the user's own words point at.
    expect(notice.detail).toContain("候选助手指南（需模型读取后生效）：海报文案");
    expect(notice.detail).not.toContain("已预载");
    expect(notice.detail).toContain("已启用非标准尺寸技能：非标准尺寸");
    expect(classifierCalls()).toHaveLength(0);
  });

  it("stays silent for a turn with no design decision", async () => {
    // Decisive non-design: a decline with no matching guide.
    const declined = await runTurn("先别做，我们讨论一下");
    expect(notices(declined)).toHaveLength(0);
    expect(classifierCalls()).toHaveLength(0);
    // Chat that the model also reads as non-design stays silent too. This turn
    // matches no rule at all, so it does spend the one cheap classifier call the
    // spec allows for an unmatched turn — and still shows nothing.
    const chat = await runTurn("你好呀");
    expect(notices(chat)).toHaveLength(0);
    expect(classifierCalls()).toHaveLength(1);
    expect(captured.upserts).toHaveLength(0);
  });

  it("routes an uncertain turn with the model verdict and reports it in the notice", async () => {
    captured.classifierReply = { intent: "new_generation", reasonCode: "explicit_creation", confidence: 0.88 };
    const events = await runTurn("做一版活动海报，把标题文字改成蓝色");
    const notice = notices(events)[0]!;
    expect(classifierCalls()).toHaveLength(1);
    expect(notice).toMatchObject({ source: "model", clamped: false, intent: "new_generation" });
    expect(notice.summary).toContain("候选技能：活动海报与宣传图");
    expect(notice.detail).toContain("模型判定 · 置信度 88%");

    // The same conflict resolved as an edit: no Skill is chosen, but the user's own
    // words still point at one, so the notice surfaces the candidate while the detail
    // discloses that the turn is handled as a local edit.
    captured.classifierReply = { intent: "local_edit", reasonCode: "property_edit", confidence: 0.66 };
    const edited = notices(await runTurn("做一版活动海报，把标题文字改成蓝色"))[0]!;
    expect(edited).toMatchObject({ source: "model", intent: "local_edit" });
    expect(edited).not.toHaveProperty("primarySkill");
    expect(edited.summary).toContain("候选技能：活动海报与宣传图");
    expect(edited.detail).toContain("只修改局部属性");
  });

  it("clamps a model verdict that would revive a declined turn", async () => {
    captured.classifierReply = { intent: "new_generation", reasonCode: "explicit_creation", confidence: 0.9 };
    const events = await runTurn("别急着生成，先写文案讨论一下");
    const notice = notices(events)[0]!;
    expect(notice).toMatchObject({ intent: "non_design", reasonCode: "declined_or_hedged",
      source: "model", clamped: true, helperSkills: ["design-copywriting"] });
    expect(notice).not.toHaveProperty("primarySkill");
  });

  it("falls back to the regex verdict in the notice when the classifier fails", async () => {
    captured.classifierFailure = new Error("provider outage");
    const events = await runTurn("做一版活动海报，把标题文字改成蓝色");
    const notice = notices(events)[0]!;
    expect(notice).toMatchObject({ intent: "new_generation", source: "fallback" });
    expect(notice.summary).toContain("候选技能：活动海报与宣传图");
    expect(notice.detail).toContain("模型不可用，沿用规则判定");
  });

  it("reports a Skill the user NAMED as their own choice, not as a candidate", async () => {
    // Naming a Skill is the user's decision, so echoing it is not the runtime routing.
    const events = await runTurn("做一张活动海报", [{ mentionType: "skill", id: "campaign-design",
      label: "活动海报与宣传图", slug: "campaign-design" }]);
    const notice = notices(events)[0]!;
    expect(notice).toMatchObject({ primarySkill: "campaign-design" });
    expect(notice.summary).toBe("已指定技能：活动海报与宣传图");
  });

  it("briefs a continuation from the remembered series without re-matching", async () => {
    const events = await runTurn("再来一张");
    const notice = notices(events)[0]!;
    expect(notice).toMatchObject({ intent: "series_continuation", reasonCode: "series_continuation",
      primarySkill: "campaign-design", source: "deterministic" });
    expect(notice.detail).toContain("沿用会话中记住的风格与尺寸");
    expect(classifierCalls()).toHaveLength(0);
  });

  it("never lets a question overwrite the remembered series", async () => {
    const events = await runTurn("怎么生成一张海报？");
    expect(notices(events)).toHaveLength(0);
    expect(classifierCalls()).toHaveLength(0);
    // Nothing was written at all, so the remembered style/size survive verbatim.
    expect(captured.upserts.some(row => "series" in row)).toBe(false);
  });

  it("carries the catalog and NO Skill body: selection belongs to the model", async () => {
    // The architecture in one assertion pair. The runtime used to inject the
    // routed Skill bodies into the instructions, which made a keyword score the
    // router: a Skill the scorer did not know could never be used, and adding a
    // package changed nothing. Now the model gets the catalog and reads what it
    // decides it needs, so NOTHING may leak a body into the instructions again.
    await runTurn("做一张活动海报，再写一句文案，尺寸 658×176");
    const instructions = String(captured.options?.instructions ?? "");
    expect(instructions).toContain("【本轮已启用技能目录");
    expect(instructions).toContain("campaign-design（活动海报与宣传图）");
    expect(instructions).toContain("design-copywriting（海报文案）");
    expect(instructions).not.toContain("CAMPAIGN SKILL BODY");
    expect(instructions).not.toContain("COPYWRITING SKILL BODY");
    expect(instructions).not.toContain("NONSTANDARD SIZE SKILL BODY");
    // What the user's own words matched is stated as a candidate, not a decision.
    expect(instructions).toContain("候选技能｜仅供参考，不是决定");
    // Guardrails still reach the model; they are what the runtime keeps.
    expect(instructions).toContain("【本轮图片额度】");
  });
});
