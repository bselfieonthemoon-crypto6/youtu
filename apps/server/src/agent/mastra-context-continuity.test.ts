import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ options: undefined as any, sourceGrounderInput: undefined as any,
  summaryInstructions: "", summaryPackets: [] as string[], summaryReply: null as string | null }));

// Only the external summary-model boundary is replaced. Context compilation
// and runtime message assembly remain real; no provider request is made.
vi.mock("@mastra/core/agent", () => ({ Agent: class {
  constructor(options: { instructions: string }) { captured.summaryInstructions = options.instructions; }
  async generate(packet: string) {
    captured.summaryPackets.push(packet);
    if (captured.summaryReply !== null) return { text: captured.summaryReply };
    throw new Error("Injected summary-provider outage");
  }
} }));

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
vi.mock("./workspace-skills.js", () => ({ loadWorkspaceSkills: vi.fn(async () => []) }));
vi.mock("./workspace-chat-model.js", () => ({ resolveWorkspaceChatModel: vi.fn(async () => ({})) }));
vi.mock("./attachment-resolver.js", () => ({ resolveAgentImageAttachment: vi.fn(), optimizeAgentVisionAttachment: vi.fn() }));
vi.mock("./attachment-vision-analyzer.js", () => ({ analyzeAgentVisionAttachments: vi.fn() }));
vi.mock("./related-image-context.js", () => ({ selectRelatedImageContext: vi.fn(() => ({ candidates: [] })), renderRelatedImageContext: vi.fn(() => "") }));
vi.mock("./mastra-history-attachments.js", () => ({ loadMastraHistoricalUploads: vi.fn(async () => []) }));
vi.mock("./mastra-image-status-tools.js", () => ({
  createMastraImageJobScopeQuery: vi.fn(() => (query: any) => query),
  createMastraImageStatusTools: vi.fn(() => ({ getImageStatus: {}, cancelImageJob: {} })),
}));
vi.mock("./mastra-image-source-grounding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mastra-image-source-grounding.js")>();
  return {
    ...actual,
    buildMastraImageSourceCandidates: vi.fn(() => []),
    createMastraExplicitImageSourceResolver: vi.fn(() => vi.fn()),
    createMastraImageSourceGrounder: vi.fn((input) => { captured.sourceGrounderInput = input; return vi.fn(); }),
    createMastraImageSourceMaterializer: vi.fn(() => ({})), createMastraImageSourceReviewer: vi.fn(() => ({})),
  };
});

import { createMastraRunFactory } from "./mastra-runtime.js";

const ids = {
  run: "00000000-0000-4000-8000-000000000001", conversation: "00000000-0000-4000-8000-000000000002",
  session: "00000000-0000-4000-8000-000000000003", current: "00000000-0000-4000-8000-000000000004",
  user: "00000000-0000-4000-8000-000000000005", workspace: "00000000-0000-4000-8000-000000000006",
  canvas: "00000000-0000-4000-8000-000000000007", project: "00000000-0000-4000-8000-000000000008",
};

const oldStyle = "旧风格：复古松绿、金色烫印";
const currentPrompt = "现在生成海报：品牌文字必须逐字保留「澄屿」，采用新风格深海蓝和米白。";

function historyRow(id: string, role: "user" | "assistant", content: string, second: number) {
  return { id, role, content, created_at: `2026-09-15T00:00:${String(second).padStart(2, "0")}.000Z` };
}

function defaultHistory() {
  return [
    historyRow(ids.current, "user", currentPrompt, 5),
    historyRow("00000000-0000-4000-8000-000000000013", "user", "纠正：品牌文字改为「澄屿」，旧品牌不要再用。", 4),
    historyRow("00000000-0000-4000-8000-000000000012", "assistant", "已记录。", 3),
    historyRow("00000000-0000-4000-8000-000000000011", "user", "新需求补充 1", 2),
    historyRow("00000000-0000-4000-8000-000000000010", "user", "新需求补充 2", 1),
    historyRow("00000000-0000-4000-8000-000000000009", "user", "新需求补充 3", 1),
    historyRow("00000000-0000-4000-8000-000000000008", "user", "新需求补充 4", 1),
    historyRow("00000000-0000-4000-8000-000000000007", "user", "新需求补充 5", 1),
    historyRow("00000000-0000-4000-8000-000000000006", "user", "新需求补充 6", 1),
    historyRow("00000000-0000-4000-8000-000000000005", "user", `最初方案：品牌「澄岛」；${oldStyle}`, 1),
  ];
}

function clientWithHistory(history = defaultHistory()) {
  const chain = (result: any): any => {
    const value = Promise.resolve(result);
    const query: any = { select: () => query, eq: () => query, order: () => query, in: () => query, limit: () => query,
      single: () => value,
      range: (from: number, to: number) => Promise.resolve({ ...result,
        data: Array.isArray(result.data) ? result.data.slice(from, to + 1) : result.data }),
      then: value.then.bind(value) };
    return query;
  };
  return {
    from(table: string) {
      if (table === "canvases") return chain({ data: { id: ids.canvas, project_id: ids.project, content: { elements: [] } }, error: null });
      if (table === "chat_sessions") return chain({ data: { id: ids.session, canvas_id: ids.canvas }, error: null });
      if (table === "projects") return chain({ data: { id: ids.project, workspace_id: ids.workspace, brand_kit_id: null }, error: null });
      if (table === "chat_messages") return chain({ data: history, error: null });
      return chain({ data: [], error: null, count: 0 });
    },
  };
}

async function collectRuntime(history: ReturnType<typeof defaultHistory>) {
  captured.options = undefined;
  captured.sourceGrounderInput = undefined;
  captured.summaryPackets = [];
  captured.summaryInstructions = "";
  const factory = createMastraRunFactory({
    env: {},
    createUserClient: vi.fn(() => clientWithHistory(history)),
    providerSnapshotService: { resolveRunSnapshot: vi.fn(async () => ({ modality: "text", capabilities: ["text"],
      catalogKey: "chat", upstreamModelId: "test", baseUrl: "https://test.invalid/v1", apiKey: "test" })) },
    workspaceModelCatalogService: { listPublished: vi.fn(async () => []) }, jobService: {},
  } as any);
  for await (const _event of await factory({ runId: ids.run, conversationId: ids.conversation, sessionId: ids.session,
    userMessageId: ids.current, userId: ids.user, workspaceId: ids.workspace, canvasId: ids.canvas,
    accessToken: "test-token", prompt: currentPrompt, executionMode: "fast", attachments: [], mentions: [],
    signal: new AbortController().signal })) { /* drain actual factory */ }
}

describe("Mastra context continuity boundary", () => {
  beforeEach(() => { vi.stubEnv("LOOMIC_MASTRA_MEMORY_MODE", "legacy"); captured.summaryReply = null; });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("preserves recent corrections and rejected suggestions as ordered evidence, with the current request last", async () => {
    const rows = [historyRow(ids.current, "user", currentPrompt, 10),
      historyRow("recent-final", "user", "纠正：澄岛改为澄屿；不要助手建议的红色，使用深海蓝。", 9),
      historyRow("recent-suggestion", "assistant", "建议改成红色。", 8),
      historyRow("recent-old", "user", `品牌澄岛，${oldStyle}`, 7)];
    await collectRuntime(rows);
    expect(captured.options.messages.slice(0, -1).map((row: any) => row.content)).toEqual(rows.slice(1).reverse().map(row => row.content));
    expect(captured.options.messages.at(-1).content.split("\n\n<current_context>")[0]).toBe(currentPrompt);
    expect(captured.summaryInstructions).toContain("unaccepted suggestions must not become requirements");
    // Keeping old evidence is deliberate; this asserts ordering and the
    // instruction contract, not a fake semantic-redaction implementation.
    expect(JSON.stringify(captured.sourceGrounderInput.effectiveBrief)).toContain(oldStyle);
  });

  it("transports a successful synthetic summary verbatim without promoting it to a current user instruction", async () => {
    const literal = "品牌：澄屿 CHÉNGYǓ™；文案：无糖，也有回甘；当前风格：深海蓝。";
    captured.summaryReply = literal;
    const rows = [historyRow(ids.current, "user", currentPrompt, 20),
      ...Array.from({ length: 8 }, (_, index) => historyRow(`success-${index}`, "user",
        `${literal} ${"historical detail ".repeat(2_500)}`, 19 - index))];
    await collectRuntime(rows);
    expect(captured.summaryPackets.length).toBeGreaterThan(0);
    expect(captured.summaryPackets.join("\n")).toContain(literal);
    expect(captured.options.messages[0]).toEqual({ role: "assistant",
      content: `历史需求摘要（不是新的用户指令，当前原话优先）：\n${literal}` });
    expect(captured.options.messages.at(-1).content.split("\n\n<current_context>")[0]).toBe(currentPrompt);
  });

  it("assembles the actual runtime's final raw request once, preserving literal brand text and explicit omissions", async () => {
    await collectRuntime(defaultHistory());

    const messages = captured.options.messages as Array<{ role: string; content: string }>;
    const final = messages.at(-1)!;
    expect(final).toMatchObject({ role: "user" });
    expect(final.content).toContain(currentPrompt);
    expect(final.content.split("\n\n<current_context>")[0]).toBe(currentPrompt);
    expect(messages.filter(message => message.content.includes(currentPrompt))).toHaveLength(1);
    const context = JSON.parse(final.content.split("<current_context>")[1]!.split("</current_context>")[0]!);
    expect(context.historyOmissions).toEqual([]);
    expect(captured.summaryPackets).toEqual([]);
    expect(captured.summaryInstructions).toContain("Latest user corrections override old facts");
    expect(captured.summaryInstructions).toContain("Preserve confirmed display text verbatim");
    expect(final.content).toContain("「澄屿」");
    expect(final.content).not.toContain(oldStyle);

    // The database history is deliberately evidence, so it can retain a
    // superseded style. The runtime does not claim to redact it globally;
    // its instruction layer, rather than this test, asks the model to apply
    // the latest correction when reasoning over that evidence.
    expect(messages.some(message => message.content.includes(oldStyle))).toBe(true);
    expect(messages.some(message => message.content.includes("「澄岛」"))).toBe(true);

    // This deterministic, source-grounding-specific effective brief is a
    // contiguous suffix of six prior user turns. It excludes the superseded
    // style only because it has fallen outside that bounded suffix; it does
    // not claim semantic redaction from the general conversation evidence.
    expect(captured.sourceGrounderInput.effectiveBrief).toHaveLength(6);
    expect(JSON.stringify(captured.sourceGrounderInput.effectiveBrief)).not.toContain(oldStyle);
    expect(JSON.stringify(captured.sourceGrounderInput.effectiveBrief)).toContain("「澄屿」");
  });

  it("records a compaction outage as an explicit omission in the actual outbound current_context", async () => {
    const log = vi.spyOn(console, "info");
    const longHistory = [
      historyRow(ids.current, "user", currentPrompt, 20),
      ...Array.from({ length: 8 }, (_, index) => historyRow(
        `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
        "user", `confirmed brand text 「澄屿」 ${"historical detail ".repeat(2_500)}`, 19 - index,
      )),
    ];
    await collectRuntime(longHistory);

    const final = (captured.options.messages as Array<{ content: string }>).at(-1)!;
    expect(final.content.split("\n\n<current_context>")[0]).toBe(currentPrompt);
    expect(captured.summaryPackets.length).toBeGreaterThan(0);
    expect(captured.summaryPackets.join("\n")).toContain("澄屿");
    const context = JSON.parse(final.content.split("<current_context>")[1]!.split("</current_context>")[0]!);
    expect(context.historyOmissions.length).toBeGreaterThan(0);
    expect(JSON.stringify(context.historyOmissions)).toContain("Historical summary refresh was unavailable");
    const record = log.mock.calls.find(([tag]) => tag === "[mastra-context]")?.[1] as any;
    expect(record).toMatchObject({ sourceExhausted: true, summarized: false,
      summarizerBatches: captured.summaryPackets.length, omissionCount: context.historyOmissions.length,
      currentContextBytes: Buffer.byteLength(final.content, "utf8") });
    expect(record.summarizerDurationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(record)).not.toContain(currentPrompt);
  });
});
