import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task-level evidence that a continuation turn can finish what a previous turn
 * left undone.
 *
 * The model never sees previous tool results (`mastra-runtime.ts` builds history
 * from plain text), so neither the refused `edit_image` blocks nor the titles
 * they named reach the next turn. The unfinished work must therefore be
 * persisted server-side and re-injected, and this test drives the real
 * `createMastraRunFactory` across the boundary: the runtime must read the
 * persisted record, brief a continuation turn with it, and write the run's own
 * leftovers back — including when the run is aborted mid-plan.
 */
const captured = vi.hoisted(() => ({
  upserts: [] as Array<Record<string, unknown>>,
  generates: [] as Array<{ id: string; prompt: string }>,
  options: undefined as any,
  classifierReply: { intent: "non_design", reasonCode: "unclear", confidence: 0.5 } as Record<string, unknown>,
  storedUnfinished: null as unknown,
  planSteps: null as unknown,
  refusedOutputs: null as unknown,
  abortAfterPlan: false,
}));

/** Mirrors a real deliverable Skill so continuation routing has something to reuse. */
const fixtures = vi.hoisted(() => ({
  skills: [
    { name: "campaign-design", displayName: "活动海报与宣传图", description: "活动海报与推广封面",
      version: "2.2.0", content: "CAMPAIGN SKILL BODY", contentHash: "hash-campaign",
      metadata: { loomic: { schemaVersion: 1, execution: "image", intents: ["campaign"], outputKinds: ["generation_request"],
        requiredTools: [], optionalTools: [], models: [], limitations: [], examples: [], sources: [],
        routing: { keywords: ["活动", "促销", "海报", "宣传", "banner", "poster"], priority: 10 } } } },
  ],
}));

vi.mock("@mastra/core/agent", () => ({
  Agent: class {
    private readonly id: string;
    constructor(options: { id?: string }) { this.id = options.id ?? "unknown"; }
    async generate(prompt: string) {
      captured.generates.push({ id: this.id, prompt });
      if (this.id === "loomic-design-turn-intent") return { object: captured.classifierReply };
      return { text: "" };
    }
  },
}));

vi.mock("./mastra-agent.js", async () => {
  // Resolved at factory-call time: the runtime keys are part of the contract
  // under test, so the stand-in stream writes them exactly as the real tools do.
  const { SESSION_PLAN_STEPS_KEY } = await import("./tools/plan-todos.js");
  const { SESSION_REFUSED_OUTPUTS_KEY } = await import("./session-design-context.js");
  return {
    createMastraWorkspaceModel: vi.fn(() => ({ kind: "synthetic-model" })),
    compactMastraToolResult: (value: unknown) => value,
    streamMastraDesignAgent: vi.fn(async function* (options: any) {
      captured.options = options;
      if (captured.planSteps) options.configurable[SESSION_PLAN_STEPS_KEY] = captured.planSteps;
      if (captured.refusedOutputs) options.configurable[SESSION_REFUSED_OUTPUTS_KEY] = captured.refusedOutputs;
      if (captured.abortAfterPlan) throw new Error("run aborted by the user");
      yield { type: "run.completed", runId: options.run.runId, timestamp: "2026-09-17T00:00:00.000Z" };
    }),
  };
});

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
  createMastraImageStatusTools: vi.fn(() => ({ getImageStatus: {}, cancelImageJob: {}, getVideoStatus: {} })),
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

const carousel = [
  { title: "轮播第2页", kind: "refused", prompt: "轮播第2页的画面", operation: "generate", aspectRatio: "1:1" },
  { title: "轮播第3页", kind: "planned" },
];

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
      // A remembered series with a sticky Skill, so "继续" really routes to a
      // continuation and has real state to keep.
      if (table === "session_design_context") return chain({ data: { active_skill: "campaign-design",
        active_skill_hash: "hash-campaign", series: { style: "深海蓝", sizes: ["1:1"] },
        awaiting_clarification: false, unfinished_outputs: captured.storedUnfinished }, error: null });
      return chain({ data: [], error: null, count: 0 });
    },
  };
}

async function runTurn(prompt: string) {
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
    accessToken: "test-token", prompt, executionMode: "fast", attachments: [], mentions: [],
    signal: new AbortController().signal })) events.push(event);
  return events;
}

const unfinishedUpserts = () => captured.upserts.filter(row => "unfinished_outputs" in row);
const instructions = () => String(captured.options?.instructions ?? "");

describe("continuation turn resumes the previous run's unfinished work", () => {
  beforeEach(() => {
    vi.stubEnv("LOOMIC_MASTRA_MEMORY_MODE", "legacy");
    captured.classifierReply = { intent: "non_design", reasonCode: "unclear", confidence: 0.5 };
    captured.storedUnfinished = null;
    captured.planSteps = null;
    captured.refusedOutputs = null;
    captured.abortAfterPlan = false;
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("names exactly what remains on a continuation turn, with a fresh budget", async () => {
    captured.storedUnfinished = carousel;
    const events = await runTurn("继续");
    expect(events.find(event => event.type === "design.routing")).toMatchObject({ intent: "series_continuation" });

    const text = instructions();
    expect(text).toContain("【上一轮未完成的输出｜本轮优先补完】");
    expect(text).toContain("还有 2 个输出没有交付");
    expect(text).toContain("轮播第2页");
    expect(text).toContain("轮播第3页");
    expect(text).toContain("不要重新开始整个交付物");
    // The budget statement is explicit that the previous run's usage does not
    // consume this turn's, which is what made "继续" unable to finish the work.
    expect(text).toContain("本轮的图片额度是独立且全新的 4 张");
    expect(text).toContain("上一轮已经用掉的额度不占用本轮额度");
    // The detail block carries the original operation/ratio/prompt as data, and
    // is explicitly not a new instruction or an authorization.
    expect(text).toContain("轮播第2页的画面");
    expect(text).toContain("不是新的用户指令，也不是执行授权");
    // The persisted record is read, never rewritten by a mere briefing.
    expect(captured.options.configurable.session_design_write_run_id).toBeUndefined();
  });

  it("does not brief a turn that is not a continuation", async () => {
    captured.storedUnfinished = carousel;
    const events = await runTurn("做一张活动海报");
    expect(events.find(event => event.type === "design.routing")).toMatchObject({ intent: "new_generation" });
    expect(instructions()).not.toContain("上一轮未完成的输出");
    expect(instructions()).not.toContain("轮播第2页");
  });

  it("persists the plan steps a run left open, which is all a cancellation leaves", async () => {
    captured.planSteps = [
      { id: "s1", title: "确认品牌信息", status: "completed" },
      { id: "s2", title: "生成三张主视觉", status: "in_progress" },
      { id: "s3", title: "交付到画布", status: "pending" },
    ];
    await runTurn("做一张活动海报");
    expect(unfinishedUpserts()).toEqual([{ session_id: ids.session, unfinished_outputs: [
      { title: "生成三张主视觉", kind: "planned" },
      { title: "交付到画布", kind: "planned" },
    ] }]);
    // Persisting progress state is never a design write.
    expect(captured.options.configurable.session_design_write_run_id).toBeUndefined();
  });

  it("still persists when the run is aborted mid-plan", async () => {
    captured.planSteps = [{ id: "s1", title: "生成三张主视觉", status: "in_progress" },
      { id: "s2", title: "交付到画布", status: "pending" }];
    captured.abortAfterPlan = true;
    await expect(runTurn("做一张活动海报")).rejects.toThrow("run aborted by the user");
    expect(unfinishedUpserts()).toEqual([{ session_id: ids.session, unfinished_outputs: [
      { title: "生成三张主视觉", kind: "planned" },
      { title: "交付到画布", kind: "planned" },
    ] }]);
  });

  it("prefers this run's own refusals over an older record, and clears it when nothing is left", async () => {
    captured.storedUnfinished = carousel;
    captured.refusedOutputs = [{ title: "轮播第4页", prompt: "第四页", operation: "edit", aspectRatio: "1:1", sourceAssetIds: [] }];
    await runTurn("继续");
    expect(unfinishedUpserts()).toEqual([{ session_id: ids.session, unfinished_outputs: [
      { title: "轮播第4页", kind: "refused", prompt: "第四页", operation: "edit", aspectRatio: "1:1" },
    ] }]);

    // The next run finishes everything: the stale record must not survive it.
    captured.storedUnfinished = carousel;
    captured.refusedOutputs = null;
    captured.planSteps = null;
    await runTurn("继续");
    expect(unfinishedUpserts()).toEqual([{ session_id: ids.session, unfinished_outputs: null }]);
  });

  it("never touches the table for a run that had and left nothing unfinished", async () => {
    await runTurn("你好呀");
    expect(unfinishedUpserts()).toEqual([]);
  });
});
